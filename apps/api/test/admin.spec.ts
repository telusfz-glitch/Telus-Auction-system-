import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { KeyLike } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { LifecycleService } from '../src/lifecycle/lifecycle.service';
import { asStaff, resetDb, setCloseIn } from './db-helpers';
import { AUD, ISS, customerClaims, makeKeys, signToken, staffClaims } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2) };
const soon = (s: number) => new Date(Date.now() + s * 1000).toISOString();

(enabled ? describe : describe.skip)('Staff admin API — real AppModule over HTTP, real Postgres', () => {
  let app: INestApplication, admin: Pool, priv: KeyLike, lifecycle: LifecycleService;
  const tokens: Record<string, string> = {};
  const http = () => request(app.getHttpServer());
  const as = (who: string) => ({
    get: (u: string) => http().get(u).set('Authorization', `Bearer ${tokens[who]}`),
    post: (u: string, b?: object) => http().post(u).set('Authorization', `Bearer ${tokens[who]}`).send(b ?? {}),
    patch: (u: string, b: object) => http().patch(u).set('Authorization', `Bearer ${tokens[who]}`).send(b),
    put: (u: string, b: object) => http().put(u).set('Authorization', `Bearer ${tokens[who]}`).send(b),
    del: (u: string) => http().delete(u).set('Authorization', `Bearer ${tokens[who]}`),
  });
  const mgr = () => as('manager');
  // audit_logs and outbox_events do not FORCE RLS, so the owner reads them directly.
  const auditCount = async (action: string) =>
    (await admin.query('SELECT count(*)::int AS n FROM audit_logs WHERE action = $1', [action])).rows[0].n as number;

  let auctionId = '';
  let lotIds: string[] = [];
  let ruleSetId = '';

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`INSERT INTO customers (id, company_name, contact_email, status) VALUES
        ('${CU.A}','Alpha','a@x.ae','pending'), ('${CU.B}','Beta','b@x.ae','active');`);
    });
    const keys = await makeKeys();
    priv = keys.privateKey;
    const sign = (claims: Record<string, unknown>, sub: string) => signToken(priv, claims, { sub });
    Object.assign(tokens, {
      manager: await sign(staffClaims('auction_manager'), 'mgr-1'),
      super: await sign(staffClaims('super_admin'), 'super-1'),
      finance: await sign(staffClaims('finance'), 'fin-1'),
      viewer: await sign(staffClaims('view_only'), 'view-1'),
      sales: await sign(staffClaims('sales_manager'), 'sales-1'),
      custA: await sign(customerClaims('customer_admin', CU.A), 'a-admin'),
      custB: await sign(customerClaims('customer_admin', CU.B), 'b-admin'),
    });
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD, CORS_ORIGINS: '', WORKERS_ENABLED: 'false' });
    delete process.env.REDIS_URL;
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => keys.publicKey }))
      .compile();
    app = mod.createNestApplication();
    await configureApp(app, loadEnv());
    await app.init();
    lifecycle = app.get(LifecycleService);
  });
  afterAll(async () => { await app?.close(); await admin?.end(); });

  // ============ authorization matrix ============
  it.each([
    ['viewer', 'POST', '/admin/auctions'], ['finance', 'POST', '/admin/auctions'], ['sales', 'POST', '/admin/auctions'],
    ['custA', 'GET', '/admin/auctions'], ['custA', 'POST', '/admin/margin-rule-sets'],
    ['manager', 'PATCH', '/admin/security-settings'], ['finance', 'PATCH', '/admin/security-settings'],
    ['manager', 'PUT', `/admin/customers/${CU.A}/limits`], ['viewer', 'PATCH', `/admin/customers/${CU.A}`],
  ])('%s cannot %s %s (403)', async (who, method, path) => {
    const res = await (http() as any)[method.toLowerCase()](path).set('Authorization', `Bearer ${tokens[who]}`).send({});
    expect(res.status).toBe(403);
  });

  it('a staff token without a second factor is refused with MFA_REQUIRED (the web app re-runs the login)', async () => {
    const { amr: _amr, ...pwdOnly } = staffClaims('super_admin');
    const t = await signToken(priv, { ...pwdOnly, amr: ['pwd'] }, { sub: 'staff-no-otp' });
    const res = await http().get('/admin/auctions').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('every staff role can read; validation rejects unknown fields (mass assignment) and bad values', async () => {
    for (const who of ['viewer', 'finance', 'sales', 'manager', 'super']) await as(who).get('/admin/auctions').expect(200);
    const smuggle = await mgr().post('/admin/auctions', { number: 'A-1', name: 'X', startAt: soon(60), closeAt: soon(120), status: 'live' });
    expect(smuggle.status).toBe(400);
    await mgr().post('/admin/auctions', { number: 'A-1', name: 'X', startAt: soon(120), closeAt: soon(60) }).expect(400);
    await mgr().post('/admin/auctions', { number: 'bad number!', name: 'X', startAt: soon(60), closeAt: soon(120) }).expect(400);
  });

  // ============ auction set-up flow ============
  it('create draft → add lots → invite → schedule; every step audited', async () => {
    const created = await mgr().post('/admin/auctions', { number: 'AUC-100', name: 'October phones', startAt: soon(2), closeAt: soon(3600), bidVisibility: 'full_price' }).expect(201);
    auctionId = created.body.id;
    expect(created.body).toMatchObject({ status: 'draft', bid_visibility: 'full_price', extension_enabled: true });
    await mgr().post('/admin/auctions', { number: 'AUC-100', name: 'dup', startAt: soon(60), closeAt: soon(120) }).expect(409);

    // customers never see drafts
    const listA = await as('custB').get('/auctions').expect(200);
    expect(listA.body).toEqual([]);

    await mgr().post(`/admin/auctions/${auctionId}/schedule`).expect(422);   // no lots yet
    const lots = await mgr().post(`/admin/auctions/${auctionId}/lots`, { lots: [
      { lotNumber: 'L1', description: 'iPhone 15 128GB', quantity: 10, startingPrice: 100 },
      { lotNumber: 'L2', description: 'Galaxy S24', quantity: 4, startingPrice: 250.5, fallbackIncrement: 10 },
      { lotNumber: 'L3', description: 'to delete', quantity: 1, startingPrice: 1 }] }).expect(201);
    lotIds = lots.body.map((l: any) => l.id);
    expect(lots.body.map((l: any) => [l.lot_number, l.starting_price, l.fallback_increment])).toEqual([['L1', '100.00', '25.00'], ['L2', '250.50', '10.00'], ['L3', '1.00', '25.00']]);
    await mgr().post(`/admin/auctions/${auctionId}/lots`, { lots: [{ lotNumber: 'L1', description: 'dup', quantity: 1, startingPrice: 1 }] }).expect(409);
    await mgr().patch(`/admin/lots/${lotIds[0]}`, { startingPrice: 120, quantity: 12 }).expect(200);
    await mgr().del(`/admin/lots/${lotIds[2]}`).expect(200);

    await mgr().post(`/admin/auctions/${auctionId}/schedule`).expect(422);   // nobody invited
    await mgr().post(`/admin/auctions/${auctionId}/participants`, { customerIds: [id(999)] }).expect(422);
    await mgr().post(`/admin/auctions/${auctionId}/participants`, { customerIds: [CU.A, CU.B] }).expect(200);
    const sched = await mgr().post(`/admin/auctions/${auctionId}/schedule`).expect(200);
    expect(sched.body.status).toBe('scheduled');

    const detail = await as('viewer').get(`/admin/auctions/${auctionId}`).expect(200);
    expect(detail.body.lots.map((l: any) => [l.lot_number, l.starting_price, l.quantity])).toEqual([['L1', '120.00', 12], ['L2', '250.50', 4]]);
    expect(detail.body.participants.map((x: any) => [x.code, x.is_allowed])).toEqual([['CUST-0001', true], ['CUST-0002', true]]);
    for (const action of ['auction.create', 'lot.create', 'lot.update', 'lot.delete', 'auction.invite', 'auction.scheduled']) {
      expect(await auditCount(action)).toBeGreaterThanOrEqual(1);
    }
  });

  it('customer commercial set-up: status, margin rule set (no overlaps), purchase limit', async () => {
    const overlap = await mgr().post('/admin/margin-rule-sets', { name: 'bad', brackets: [
      { priceFrom: 0, priceTo: 500, margin: 5 }, { priceFrom: 400, priceTo: 1000, margin: 10 }] });
    expect(overlap.status).toBe(422);
    expect(overlap.body.code).toBe('OVERLAP');
    const set = await mgr().post('/admin/margin-rule-sets', { name: 'standard', brackets: [
      { priceFrom: 0, priceTo: 500, margin: 5 }, { priceFrom: 500, priceTo: 100000, margin: 10 }] }).expect(201);
    ruleSetId = set.body.id;
    await mgr().put(`/admin/margin-rule-sets/${ruleSetId}/brackets`, { brackets: [{ priceFrom: 0, priceTo: 100000, margin: 7 }] }).expect(200);
    const sets = await as('viewer').get('/admin/margin-rule-sets').expect(200);
    expect(sets.body).toEqual([expect.objectContaining({ name: 'standard', brackets: [{ priceFrom: '0.00', priceTo: '100000.00', margin: '7.00' }] })]);

    await mgr().patch(`/admin/customers/${CU.A}`, { status: 'active', marginRuleSetId: ruleSetId }).expect(200);
    await mgr().patch(`/admin/customers/${CU.B}`, { marginRuleSetId: id(777) }).expect(422);   // no such rule set
    await mgr().patch(`/admin/customers/${CU.B}`, { marginRuleSetId: ruleSetId }).expect(200);
    await as('finance').put(`/admin/customers/${CU.A}/limits`, { maxPurchaseValue: 1000000 }).expect(200);
    await as('finance').put(`/admin/customers/${CU.B}/limits`, { maxPurchaseValue: 1000000 }).expect(200);
    await as('finance').put(`/admin/customers/${id(999)}/limits`, { maxPurchaseValue: 5 }).expect(404);
  });

  it('security settings: super_admin only, audited with before/after', async () => {
    const res = await as('super').patch('/admin/security-settings', { maxBidLimit: 50000 }).expect(200);
    expect(res.body.max_bid_limit).toBe('50000.00');
    await as('super').patch('/admin/security-settings', { rangeEnabled: true, rangeMin: 900, rangeMax: 100 }).expect(422);   // DB CHECK
    expect(await auditCount('security_settings.update')).toBe(1);
  });

  // ============ state rules once the auction is running ============
  it('once live: settings and lots are frozen (API and database), but a lot can be withdrawn and bids then fail', async () => {
    await new Promise((r) => setTimeout(r, 2100));
    expect((await lifecycle.tick()).opened).toEqual([auctionId]);
    await mgr().patch(`/admin/auctions/${auctionId}`, { name: 'renamed' }).expect(409);
    await mgr().patch(`/admin/lots/${lotIds[0]}`, { startingPrice: 1 }).expect(409);
    await mgr().del(`/admin/lots/${lotIds[0]}`).expect(409);
    await mgr().post(`/admin/auctions/${auctionId}/lots`, { lots: [{ lotNumber: 'L9', description: 'late', quantity: 1, startingPrice: 1 }] }).expect(409);
    await mgr().post(`/admin/auctions/${auctionId}/unschedule`).expect(409);

    // Database guards hold even if the application forgets its checks:
    const staffTx = async (sql: string) => asStaff(admin, async (c) => { await c.query(sql); });
    await expect(staffTx(`UPDATE auctions SET bid_visibility = 'own_bid_only' WHERE id = '${auctionId}'`)).rejects.toThrow(/AUCTION_FROZEN/);
    await expect(staffTx(`UPDATE auctions SET close_at = close_at - interval '1 minute' WHERE id = '${auctionId}'`)).rejects.toThrow(/AUCTION_FROZEN/);
    await expect(staffTx(`UPDATE auctions SET status = 'closed' WHERE id = '${auctionId}'`)).rejects.toThrow(/AUCTION_TRANSITION_FORBIDDEN/);
    await expect(staffTx(`UPDATE auction_lots SET starting_price = 1 WHERE id = '${lotIds[0]}'`)).rejects.toThrow(/LOT_FROZEN/);
    await staffTx(`UPDATE auctions SET close_at = close_at + interval '1 minute' WHERE id = '${auctionId}'`);   // extending is allowed

    await as('custA').post(`/auctions/${auctionId}/accept-terms`).expect(200);
    await http().post('/bids').set('Authorization', `Bearer ${tokens.custA}`).send({ lotId: lotIds[1], amount: 300, idempotencyKey: 'adm-k-00000000001' }).expect(201);
    const wd = await mgr().post(`/admin/lots/${lotIds[1]}/withdraw`).expect(200);
    expect(wd.body.status).toBe('withdrawn');
    const after = await http().post('/bids').set('Authorization', `Bearer ${tokens.custA}`).send({ lotId: lotIds[1], amount: 400, idempotencyKey: 'adm-k-00000000002' });
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('LOT_UNAVAILABLE');
    // Even raw SQL that bypasses the engine cannot bid on a withdrawn lot.
    const raw = asStaff(admin, async (c) => {
      await c.query("SELECT set_config('app.role','customer',true), set_config('app.customer_id',$1,true), set_config('app.customer_role','customer_admin',true), set_config('app.user_sub','a-admin',true)", [CU.A]);
      await c.query('INSERT INTO bids (auction_id, lot_id, customer_id, acting_user_sub, amount, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)', [auctionId, lotIds[1], CU.A, 'a-admin', 999, 'raw-wd']);
    });
    await expect(raw).rejects.toThrow(/LOT_UNAVAILABLE/);
  });

  it('revoking an invitation stops that customer bidding immediately; re-inviting keeps their terms acceptance', async () => {
    await mgr().del(`/admin/auctions/${auctionId}/participants/${CU.A}`).expect(200);
    const blocked = await http().post('/bids').set('Authorization', `Bearer ${tokens.custA}`).send({ lotId: lotIds[0], amount: 200, idempotencyKey: 'adm-k-00000000003' });
    expect(blocked.status).toBe(404);
    await as('custA').get(`/auctions/${auctionId}`).expect(404);
    await mgr().post(`/admin/auctions/${auctionId}/participants`, { customerIds: [CU.A] }).expect(200);
    await http().post('/bids').set('Authorization', `Bearer ${tokens.custA}`).send({ lotId: lotIds[0], amount: 200, idempotencyKey: 'adm-k-00000000004' }).expect(201);
  });

  it('cancelling a live auction stops bidding and notifies participants via the outbox; it cannot be revived', async () => {
    await mgr().post(`/admin/auctions/${auctionId}/cancel`).expect(200);
    const res = await http().post('/bids').set('Authorization', `Bearer ${tokens.custA}`).send({ lotId: lotIds[0], amount: 500, idempotencyKey: 'adm-k-00000000005' });
    expect(res.body.code).toBe('AUCTION_NOT_OPEN');
    await mgr().post(`/admin/auctions/${auctionId}/schedule`).expect(409);
    await mgr().post(`/admin/auctions/${auctionId}/cancel`).expect(409);
    await setCloseIn(admin, auctionId, '0 seconds');
    expect((await lifecycle.tick()).closed).toEqual([]);   // a cancelled auction is never allocated
    const ev = (await admin.query("SELECT payload FROM outbox_events WHERE type = 'auction.cancelled'")).rows;
    expect(ev).toEqual([{ payload: { auctionId, status: 'cancelled', previousStatus: 'live' } }]);
  });
});
