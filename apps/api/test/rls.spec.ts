import { Pool } from 'pg';
import { AuditService } from '../src/audit/audit.service';
import type { Principal } from '../src/auth/principal';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { asStaff, resetDb } from './db-helpers';
import { CUST_A, CUST_B } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;

if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const AUCTION_1 = '33333333-3333-4333-8333-333333333333'; // both A and B invited
const AUCTION_2 = '44444444-4444-4444-8444-444444444444'; // only B invited
const LOT_1 = '55555555-5555-4555-8555-555555555555';
const LOT_2 = '66666666-6666-4666-8666-666666666666';
const LOT_OF: Record<string, string> = { [AUCTION_1]: LOT_1, [AUCTION_2]: LOT_2 };

const staff: Principal = { sub: 'staff-1', username: 's', kind: 'staff', roles: ['super_admin'], customerId: null, customerRole: null };
const cust = (customerId: string, customerRole: string, sub: string): Principal => ({ sub, username: sub, kind: 'customer', roles: [customerRole], customerId, customerRole });
const aAdmin = cust(CUST_A, 'customer_admin', 'a-admin');
const aBidder = cust(CUST_A, 'customer_bidder', 'a-bidder');
const aViewer = cust(CUST_A, 'customer_viewer', 'a-viewer');
const bBidder = cust(CUST_B, 'customer_bidder', 'b-bidder');

(enabled ? describe : describe.skip)('Postgres row-level security + audit log (real database, restricted runtime role)', () => {
  let admin: Pool, rawApp: Pool, db: DbService;
  const audit = new AuditService();
  const insertBid = (p: Principal, auctionId: string, customerId: string, amount: number, key: string, actingSub = p.sub) =>
    db.withPrincipal(p, (c) => c.query('INSERT INTO bids (auction_id, lot_id, customer_id, acting_user_sub, amount, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)', [auctionId, LOT_OF[auctionId], customerId, actingSub, amount, key]));

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);   // owner is a NON-superuser, so FORCE'd RLS applies to seeding too
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES
          ('${CUST_A}','Alpha Trading','a@alpha.ae','active'), ('${CUST_B}','Beta Mobile','b@beta.ae','active');
        INSERT INTO auctions (id, number, name, status, start_at, close_at) VALUES
          ('${AUCTION_1}','AUC-1','One','live', now() - interval '1 hour', now() + interval '1 hour'),
          ('${AUCTION_2}','AUC-2','Two','live', now() - interval '1 hour', now() + interval '1 hour');
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES
          ('${AUCTION_1}','${CUST_A}', now()), ('${AUCTION_1}','${CUST_B}', now()), ('${AUCTION_2}','${CUST_B}', now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${LOT_1}','${AUCTION_1}','1','Lot 1',10,50), ('${LOT_2}','${AUCTION_2}','1','Lot 2',10,50);
        INSERT INTO invoices (invoice_number, customer_id, total_amount) VALUES ('INV-A','${CUST_A}',500), ('INV-B','${CUST_B}',900);
        INSERT INTO customer_users (customer_id, keycloak_sub, display_name, role) VALUES ('${CUST_B}','b-bidder','Bob','customer_bidder');`);
    });
    rawApp = new Pool({ connectionString: APP_URL });
    db = new DbService({ DATABASE_URL: APP_URL } as Env);
    await insertBid(aAdmin, AUCTION_1, CUST_A, 100, 'seed-a');
    await insertBid(bBidder, AUCTION_1, CUST_B, 200, 'seed-b');
  });
  afterAll(async () => { await db?.onModuleDestroy(); await rawApp?.end(); await admin?.end(); });

  // ---------- tenant isolation ----------
  it('customer A sees ONLY A\'s bids, even with a query that has no WHERE clause', async () => {
    const rows = (await db.withPrincipal(aAdmin, (c) => c.query('SELECT * FROM bids'))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].customer_id).toBe(CUST_A);
  });
  it('customer B cannot see A\'s bids or invoices', async () => {
    const bids = (await db.withPrincipal(bBidder, (c) => c.query('SELECT * FROM bids'))).rows;
    const inv = (await db.withPrincipal(bBidder, (c) => c.query('SELECT * FROM invoices'))).rows;
    expect(bids.every((r) => r.customer_id === CUST_B)).toBe(true);
    expect(inv.map((r) => r.invoice_number)).toEqual(['INV-B']);
  });
  it('a customer cannot read another customer\'s company record or team', async () => {
    const co = (await db.withPrincipal(aAdmin, (c) => c.query('SELECT * FROM customers'))).rows;
    const team = (await db.withPrincipal(aAdmin, (c) => c.query('SELECT * FROM customer_users'))).rows;
    expect(co.map((r) => r.id)).toEqual([CUST_A]);
    expect(team).toHaveLength(0); // only B has a team row
  });
  it('customer only sees auctions they were invited to', async () => {
    const rows = (await db.withPrincipal(aAdmin, (c) => c.query('SELECT id FROM auctions'))).rows;
    expect(rows.map((r) => r.id)).toEqual([AUCTION_1]);
  });
  it('staff see everything', async () => {
    expect((await db.withPrincipal(staff, (c) => c.query('SELECT * FROM bids'))).rows).toHaveLength(2);
    expect((await db.withPrincipal(staff, (c) => c.query('SELECT * FROM customers'))).rows).toHaveLength(2);
  });
  it('FAILS CLOSED: a query with no identity context returns zero rows from every table', async () => {
    for (const t of ['customers', 'customer_users', 'auctions', 'auction_participants', 'auction_lots', 'bids', 'invoices', 'audit_logs', 'lot_bid_state', 'outbox_events', 'customer_limits', 'margin_rule_sets', 'margin_rule_brackets', 'security_settings']) {
      const r = await rawApp.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(r.rows[0].n).toBe(0);
    }
  });

  // ---------- writes ----------
  it('customer A cannot insert a bid on behalf of customer B', async () => {
    await expect(insertBid(aBidder, AUCTION_1, CUST_B, 300, 'x1')).rejects.toMatchObject({ code: '42501' });
  });
  it('a bid cannot be attributed to a different acting user (no impersonation)', async () => {
    await expect(insertBid(aBidder, AUCTION_1, CUST_A, 300, 'x2', 'someone-else')).rejects.toMatchObject({ code: '42501' });
  });
  it('a read-only team member (viewer) cannot bid', async () => {
    await expect(insertBid(aViewer, AUCTION_1, CUST_A, 300, 'x3')).rejects.toMatchObject({ code: '42501' });
  });
  it('a customer cannot bid in an auction they were not invited to', async () => {
    await expect(insertBid(aBidder, AUCTION_2, CUST_A, 300, 'x4')).rejects.toMatchObject({ code: '42501' });
  });
  it('an invited bidder CAN bid as themselves', async () => {
    await expect(insertBid(aBidder, AUCTION_1, CUST_A, 250, 'ok1')).resolves.toBeDefined();
  });
  it('bids are immutable to the app role (no UPDATE / DELETE)', async () => {
    await expect(db.withPrincipal(aAdmin, (c) => c.query('UPDATE bids SET amount = 1'))).rejects.toMatchObject({ code: '42501' });
    await expect(db.withPrincipal(aAdmin, (c) => c.query('DELETE FROM bids'))).rejects.toMatchObject({ code: '42501' });
  });
  it('a customer cannot modify their own company status (e.g. re-activate themselves)', async () => {
    const r = await db.withPrincipal(aAdmin, (c) => c.query("UPDATE customers SET status = 'active'"));
    expect(r.rowCount).toBe(0);
  });
  it('customer_admin manages their OWN team but cannot add users to another customer', async () => {
    const ins = (p: Principal, custId: string, sub: string) =>
      db.withPrincipal(p, (c) => c.query("INSERT INTO customer_users (customer_id, keycloak_sub, display_name, role) VALUES ($1,$2,'X','customer_viewer')", [custId, sub]));
    await expect(ins(aAdmin, CUST_A, 'new-a')).resolves.toBeDefined();
    await expect(ins(aAdmin, CUST_B, 'new-b')).rejects.toMatchObject({ code: '42501' });
    await expect(ins(aBidder, CUST_A, 'new-a2')).rejects.toMatchObject({ code: '42501' });
  });
  it('identity settings do not leak across pooled connections', async () => {
    await db.withPrincipal(aAdmin, (c) => c.query('SELECT 1'));
    const r = await rawApp.query("SELECT current_setting('app.customer_id', true) AS v");
    expect(r.rows[0].v === null || r.rows[0].v === '').toBe(true);
  });

  // ---------- audit log ----------
  it('customers cannot read the audit log; staff can', async () => {
    await db.withPrincipal(staff, (c) => audit.record(c, { actor: staff, action: 'test.one', after: { a: 1 }, ip: '10.0.0.1' }));
    expect((await db.withPrincipal(aAdmin, (c) => c.query('SELECT * FROM audit_logs'))).rows).toHaveLength(0);
    expect((await db.withPrincipal(staff, (c) => c.query('SELECT * FROM audit_logs'))).rows.length).toBeGreaterThan(0);
  });
  it('audit entries cannot be forged in someone else\'s name', async () => {
    await expect(db.withPrincipal(aAdmin, (c) => c.query("INSERT INTO audit_logs (actor_sub, actor_kind, action) VALUES ('staff-1','staff','forged')"))).rejects.toMatchObject({ code: '42501' });
  });
  it('the app role cannot UPDATE or DELETE audit rows', async () => {
    await expect(db.withPrincipal(staff, (c) => c.query("UPDATE audit_logs SET action='x'"))).rejects.toMatchObject({ code: '42501' });
    await expect(db.withPrincipal(staff, (c) => c.query('DELETE FROM audit_logs'))).rejects.toMatchObject({ code: '42501' });
  });
  it('even the database OWNER/superuser cannot UPDATE, DELETE or TRUNCATE audit rows', async () => {
    await expect(admin.query("UPDATE audit_logs SET action='x'")).rejects.toThrow(/append-only/);
    await expect(admin.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    await expect(admin.query('TRUNCATE audit_logs')).rejects.toThrow(/append-only/);
  });
  it('hash chain verifies when intact, and DETECTS tampering (even with triggers disabled)', async () => {
    for (let i = 0; i < 3; i++) await db.withPrincipal(staff, (c) => audit.record(c, { actor: staff, action: `test.chain.${i}`, after: { i } }));
    expect((await admin.query('SELECT verify_audit_chain() AS bad')).rows[0].bad).toBeNull();

    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update');
      await c.query("UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT min(id) FROM audit_logs)");
      const bad = (await c.query('SELECT verify_audit_chain() AS bad')).rows[0].bad;
      expect(bad).not.toBeNull();
      await c.query('ROLLBACK');
    } finally { c.release(); }
    expect((await admin.query('SELECT verify_audit_chain() AS bad')).rows[0].bad).toBeNull();
  });
  it('concurrent audit writes still produce one valid chain', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.withPrincipal(staff, (c) => audit.record(c, { actor: staff, action: `test.concurrent.${i}` }))));
    expect((await admin.query('SELECT verify_audit_chain() AS bad')).rows[0].bad).toBeNull();
  });
});
