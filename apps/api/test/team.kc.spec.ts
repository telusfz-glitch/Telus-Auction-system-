import { randomUUID } from 'crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AddressInfo } from 'net';
import type { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { AuditService } from '../src/audit/audit.service';
import type { Principal } from '../src/auth/principal';
import { BidsService } from '../src/bids/bids.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { KeycloakAdmin, generatePassword } from '../src/identity/keycloak-admin';
import { TeamService } from '../src/team/team.service';
import { asStaff, custP, resetDb, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const ISSUER = process.env.TEST_KEYCLOAK_ISSUER;            // e.g. http://localhost:8080/realms/telus
const SECRET = process.env.TEST_KEYCLOAK_ADMIN_SECRET;      // the telus-api-admin client secret
// Master-realm administrator, used only to plant fixtures the service account is (correctly) not allowed to create.
const MASTER_USER = process.env.TEST_KEYCLOAK_MASTER_USER ?? 'kcadmin';
const MASTER_PASSWORD = process.env.TEST_KEYCLOAK_MASTER_PASSWORD ?? 'kcadminpw';
const enabled = !!ADMIN_URL && !!APP_URL && !!ISSUER && !!SECRET;
if (!enabled && process.env.REQUIRE_KEYCLOAK_TESTS) {
  it('Keycloak tests are REQUIRED but TEST_KEYCLOAK_ISSUER / TEST_KEYCLOAK_ADMIN_SECRET / DB env are not set', () => { throw new Error('env missing'); });
}

const id = (n: number) => `f0f0f0f0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2) };
const AU = id(101);
const LOT = id(201);
const run = randomUUID().slice(0, 8);   // unique emails per run: Keycloak users outlive the DB reset
const email = (who: string) => `${who}-${run}@team.test`;

(enabled ? describe : describe.skip)('Customer team logins — real Keycloak Admin API + real Postgres', () => {
  let admin: Pool, db: DbService, team: TeamService, kc: KeycloakAdmin, bids: BidsService;
  const env = { DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISSUER, KEYCLOAK_ADMIN_CLIENT_ID: 'telus-api-admin', KEYCLOAK_ADMIN_CLIENT_SECRET: SECRET,
    TEAM_USER_REQUIRED_ACTIONS: 'UPDATE_PASSWORD,CONFIGURE_TOTP' } as Env;
  const kcAdminUrl = ISSUER!.replace(/\/realms\/([^/]+)$/, '/admin/realms/$1');
  const svcToken = async () => (await (await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'telus-api-admin', client_secret: SECRET! }),
  })).json()).access_token as string;
  const kcGet = async (path: string) => (await fetch(`${kcAdminUrl}${path}`, { headers: { authorization: `Bearer ${await svcToken()}` } })).json();
  const masterToken = async () => (await (await fetch(`${ISSUER!.replace(/\/realms\/[^/]+$/, '')}/realms/master/protocol/openid-connect/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: MASTER_USER, password: MASTER_PASSWORD }),
  })).json()).access_token as string;
  /** Raw Admin API call AS THE SERVICE ACCOUNT (bypassing the API's own guard rails) — returns the HTTP status. */
  const svcRaw = async (method: string, path: string, body?: unknown) => (await fetch(`${kcAdminUrl}${path}`, {
    method, headers: { authorization: `Bearer ${await svcToken()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })).status;
  const created: string[] = [];
  let firstAdmin: Principal, firstAdminRow: any, bidderRow: any;

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    db = new DbService(env);
    kc = new KeycloakAdmin(env);
    team = new TeamService(db, new AuditService(), kc);
    bids = new BidsService(db, new AuditService());
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES ('${CU.A}','Alpha','a@x.ae','active'), ('${CU.B}','Beta','b@x.ae','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ('${CU.A}', 1000000), ('${CU.B}', 1000000);
        INSERT INTO auctions (id, number, name, status, start_at, close_at) VALUES ('${AU}','T-1','Team','live', now() - interval '1 hour', now() + interval '1 hour');
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES ('${AU}','${CU.A}', now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES ('${LOT}','${AU}','1','lot',1,100);`);
    });
  });
  afterAll(async () => {
    const t = await masterToken();
    for (const sub of created) await fetch(`${kcAdminUrl}/users/${sub}`, { method: 'DELETE', headers: { authorization: `Bearer ${t}` } });
    await db?.onModuleDestroy();
    await admin?.end();
  });

  it('generated temporary passwords always satisfy the realm password policy', () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(20);
      expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it('staff create the first administrator: Keycloak user bound to the customer, role granted, first-login actions set', async () => {
    firstAdminRow = await team.create(staffP, { email: email('boss'), firstName: 'Bo', lastName: 'Ss', role: 'customer_admin' }, CU.A);
    created.push(firstAdminRow.keycloak_sub);
    expect(firstAdminRow).toMatchObject({ customer_id: CU.A, role: 'customer_admin', status: 'active', email: email('boss') });
    expect(firstAdminRow.temporaryPassword).toHaveLength(20);
    const u = await kcGet(`/users/${firstAdminRow.keycloak_sub}`);
    expect(u).toMatchObject({ username: email('boss'), enabled: true, attributes: { customer_id: [CU.A] } });
    expect(u.requiredActions.sort()).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
    expect((await kcGet(`/users/${firstAdminRow.keycloak_sub}/role-mappings/realm`)).map((r: any) => r.name)).toContain('customer_admin');
    // the temporary password is never stored
    expect(JSON.stringify((await admin.query('SELECT * FROM audit_logs')).rows)).not.toContain(firstAdminRow.temporaryPassword);
    firstAdmin = custP(CU.A, 'customer_admin', firstAdminRow.keycloak_sub);
  });

  it('a customer admin adds a bidder to THEIR company; non-admins cannot; duplicates are refused', async () => {
    bidderRow = await team.create(firstAdmin, { email: email('bidder'), firstName: 'Bid', lastName: 'Der', role: 'customer_bidder' });
    created.push(bidderRow.keycloak_sub);
    expect(bidderRow.customer_id).toBe(CU.A);
    expect((await kcGet(`/users/${bidderRow.keycloak_sub}`)).attributes.customer_id).toEqual([CU.A]);
    await expect(team.create(custP(CU.A, 'customer_bidder', 'x'), { email: email('nope'), firstName: 'N', lastName: 'O', role: 'customer_viewer' }))
      .rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    await expect(team.create(firstAdmin, { email: email('bidder'), firstName: 'Bid', lastName: 'Der', role: 'customer_viewer' }))
      .rejects.toMatchObject({ response: { code: 'EMAIL_UNAVAILABLE' } });
    expect((await team.list(firstAdmin)).map((u: any) => u.email).sort()).toEqual([email('bidder'), email('boss')]);
    expect(await team.list(custP(CU.B, 'customer_admin', 'b-admin'))).toEqual([]);   // RLS: B sees none of A's logins
  });

  it('role change and suspension reach Keycloak; a suspended login cannot bid even with a still-valid token', async () => {
    const updated = await team.update(firstAdmin, bidderRow.id, { role: 'customer_viewer' });
    expect(updated.role).toBe('customer_viewer');
    const roles = (await kcGet(`/users/${bidderRow.keycloak_sub}/role-mappings/realm`)).map((r: any) => r.name);
    expect(roles).toContain('customer_viewer');
    expect(roles).not.toContain('customer_bidder');

    await team.update(firstAdmin, bidderRow.id, { role: 'customer_bidder', status: 'suspended' });
    expect((await kcGet(`/users/${bidderRow.keycloak_sub}`)).enabled).toBe(false);
    const stale = custP(CU.A, 'customer_bidder', bidderRow.keycloak_sub);   // an access token issued before the suspension
    await expect(bids.place(stale, { lotId: LOT, amount: 100, idempotencyKey: randomUUID() })).rejects.toMatchObject({ response: { code: 'LOGIN_SUSPENDED' } });

    await team.update(firstAdmin, bidderRow.id, { status: 'active' });
    expect((await kcGet(`/users/${bidderRow.keycloak_sub}`)).enabled).toBe(true);
    await expect(bids.place(stale, { lotId: LOT, amount: 100, idempotencyKey: randomUUID() })).resolves.toMatchObject({ replayed: false });
  });

  it('guard rails: no self-changes, the last administrator stays, other companies are invisible', async () => {
    await expect(team.update(firstAdmin, firstAdminRow.id, { role: 'customer_viewer' })).rejects.toMatchObject({ response: { code: 'CANNOT_CHANGE_SELF' } });
    await expect(team.update(staffP, firstAdminRow.id, { status: 'suspended' })).rejects.toMatchObject({ response: { code: 'LAST_ADMIN' } });
    await expect(team.update(custP(CU.B, 'customer_admin', 'b-admin'), bidderRow.id, { status: 'suspended' }))
      .rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    await expect(asStaff(admin, async (c) => { await c.query(`UPDATE customer_users SET keycloak_sub = 'other' WHERE id = $1`, [bidderRow.id]); }))
      .rejects.toThrow(/CUSTOMER_USER_IDENTITY_IMMUTABLE/);
    await expect(db.withPrincipal(firstAdmin, (c) => c.query('DELETE FROM customer_users'))).rejects.toMatchObject({ code: '42501' });
  });

  it('Keycloak itself confines the service account: no staff access, no staff roles, no users outside the customers group', async () => {
    const t = await masterToken();
    const res = await fetch(`${kcAdminUrl}/users`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: email('boss-staff'), email: email('boss-staff'), firstName: 'B', lastName: 'S', enabled: true }) });
    const staffSub = res.headers.get('location')!.split('/').pop()!;
    created.push(staffSub);
    const role = async (name: string) => (await fetch(`${kcAdminUrl}/roles/${name}`, { headers: { authorization: `Bearer ${t}` } })).json();
    await fetch(`${kcAdminUrl}/users/${staffSub}/role-mappings/realm`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify([await role('super_admin')]) });

    // Everything below is attempted with the raw service-account token — as an attacker holding its secret would.
    expect(await svcRaw('GET', `/users/${staffSub}`)).toBe(403);
    expect(await svcRaw('PUT', `/users/${staffSub}`, { enabled: false })).toBe(403);
    expect(await svcRaw('PUT', `/users/${staffSub}/reset-password`, { type: 'password', value: 'Pwned-Passw0rd!2026', temporary: false })).toBe(403);
    expect(await svcRaw('DELETE', `/users/${staffSub}/role-mappings/realm`, [await role('super_admin')])).toBe(403);
    expect(await svcRaw('PUT', `/users/${staffSub}/groups/c0570000-0000-4000-8000-000000000001`, undefined)).toBe(403);
    expect(await svcRaw('POST', `/users/${firstAdminRow.keycloak_sub}/role-mappings/realm`, [await role('super_admin')])).toBe(403);
    expect(await svcRaw('POST', `/users/${firstAdminRow.keycloak_sub}/role-mappings/realm`, [await role('finance')])).toBe(403);
    expect(await svcRaw('POST', '/users', { username: email('outside'), email: email('outside'), firstName: 'O', lastName: 'X', enabled: true })).toBe(403);
    expect(await svcRaw('PUT', '', { bruteForceProtected: false })).toBe(403);
    expect(await svcRaw('POST', '/clients', { clientId: `evil-${run}` })).toBe(403);
    const visible = (await kcGet('/users?max=200')).map((u: any) => u.username);
    expect(visible).not.toContain(email('boss-staff'));                          // staff are invisible to it
    expect(visible).toContain(email('boss'));
  });

  it('the service-account wrapper refuses to touch a staff account or another customer\'s user, and never grants staff roles', async () => {
    // A Keycloak user claiming customer A but holding super_admin (planted by a Keycloak administrator).
    const t = await masterToken();
    const res = await fetch(`${kcAdminUrl}/users`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
      body: JSON.stringify({ username: email('staffy'), email: email('staffy'), firstName: 'S', lastName: 'T', enabled: true, attributes: { customer_id: [CU.A] } }) });
    const staffSub = res.headers.get('location')!.split('/').pop()!;
    created.push(staffSub);
    const role = await (await fetch(`${kcAdminUrl}/roles/super_admin`, { headers: { authorization: `Bearer ${t}` } })).json();
    await fetch(`${kcAdminUrl}/users/${staffSub}/role-mappings/realm`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify([role]) });

    await expect(kc.setEnabled(staffSub, CU.A, false)).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    const seen = await (await fetch(`${kcAdminUrl}/users/${staffSub}`, { headers: { authorization: `Bearer ${await masterToken()}` } })).json();
    expect(seen.enabled).toBe(true);                                                                      // untouched
    await expect(kc.setEnabled(bidderRow.keycloak_sub, CU.B, false)).rejects.toMatchObject({ response: { code: 'USER_NOT_FOUND' } });
    await expect(kc.setCustomerRole(bidderRow.keycloak_sub, CU.A, 'super_admin')).rejects.toThrow(/refusing to grant non-customer role/);
    await expect(kc.createCustomerUser({ email: email('x'), firstName: 'X', lastName: 'Y', customerId: CU.A, role: 'finance' }))
      .rejects.toThrow(/refusing to grant non-customer role/);
  });

  describe('TEAM_INVITE_METHOD=email', () => {
    let smtp: SMTPServer, smtpDown = false, realmSmtp: unknown;
    const inbox: ParsedMail[] = [];
    const master = async (method: string, path: string, body?: unknown) => fetch(`${kcAdminUrl}${path}`, {
      method, headers: { authorization: `Bearer ${await masterToken()}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const inviting = () => new TeamService(db, new AuditService(), new KeycloakAdmin({ ...env, TEAM_INVITE_METHOD: 'email', TEAM_INVITE_LIFESPAN_SECONDS: 3600 }));

    beforeAll(async () => {
      smtp = new SMTPServer({
        authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
        onData(stream, _s, cb) {
          if (smtpDown) { stream.resume(); return cb(Object.assign(new Error('mailbox unavailable'), { responseCode: 550 })); }
          simpleParser(stream).then((m) => { inbox.push(m); cb(); }, cb);
        },
      });
      await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
      realmSmtp = (await (await master('GET', '')).json()).smtpServer ?? {};
      // Keycloak runs on the host network in tests/CI, so it reaches this in-process catcher on 127.0.0.1.
      const res = await master('PUT', '', { smtpServer: { host: '127.0.0.1', port: String((smtp.server.address() as AddressInfo).port), from: 'no-reply@auctions.telus.test' } });
      expect(res.status).toBe(204);
    });
    afterAll(async () => {
      await master('PUT', '', { smtpServer: realmSmtp });
      await new Promise<void>((r) => smtp.close(() => r()));
    });

    it('the new login gets an emailed set-up link and NO credential; nothing secret is returned to the inviter', async () => {
      const row = await inviting().create(firstAdmin, { email: email('invitee'), firstName: 'In', lastName: 'Vitee', role: 'customer_viewer' });
      created.push(row.keycloak_sub);
      expect(row.temporaryPassword).toBeNull();
      expect(await (await master('GET', `/users/${row.keycloak_sub}/credentials`)).json()).toEqual([]);
      expect((await kcGet(`/users/${row.keycloak_sub}`)).requiredActions.sort()).toEqual(['CONFIGURE_TOTP', 'UPDATE_PASSWORD']);
      const m = inbox.at(-1)!;
      expect((Array.isArray(m.to) ? m.to : [m.to!]).flatMap((a) => a.value.map((v) => v.address))).toEqual([email('invitee')]);
      expect(m.text).toMatch(/\/realms\/telus\/login-actions\/action-token\?key=/);
    });

    it('if the invitation cannot be sent, the login is not created anywhere and the address stays usable', async () => {
      smtpDown = true;
      try {
        await expect(inviting().create(firstAdmin, { email: email('unlucky'), firstName: 'Un', lastName: 'Lucky', role: 'customer_viewer' }))
          .rejects.toMatchObject({ response: { code: 'INVITE_EMAIL_FAILED' } });
      } finally { smtpDown = false; }
      expect(await (await master('GET', `/users?exact=true&username=${encodeURIComponent(email('unlucky'))}`)).json()).toEqual([]);
      expect((await team.list(firstAdmin)).map((u: any) => u.email)).not.toContain(email('unlucky'));
      const retry = await inviting().create(firstAdmin, { email: email('unlucky'), firstName: 'Un', lastName: 'Lucky', role: 'customer_viewer' });
      created.push(retry.keycloak_sub);
      expect(retry.email).toBe(email('unlucky'));
    });
  });
});
