import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { AuctionsService } from '../src/auctions/auctions.service';
import { AuditService } from '../src/audit/audit.service';
import type { Principal } from '../src/auth/principal';
import { BidsService } from '../src/bids/bids.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { LifecycleService } from '../src/lifecycle/lifecycle.service';
import { OutboxService, type OutboxEvent } from '../src/outbox/outbox.service';
import { asStaff, custP, resetDb, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2), C: id(3), D: id(4), F: id(6) };
const AU = { OPEN: id(101), FUTURE: id(102), ALLOC: id(103), EXT: id(104), HOLD: id(105), RACE: id(106), TERMS: id(107) };
const LOT = {
  W1: id(201), W2: id(202), UNSOLD: id(203), WD: id(204), EXT: id(205), HOLD: id(206),
  R1: id(207), R2: id(208), R3: id(209), TERMS: id(210),
};
const aBid = custP(CU.A, 'customer_bidder', 'a-bid');
const bBid = custP(CU.B, 'customer_bidder', 'b-bid');
const cBid = custP(CU.C, 'customer_bidder', 'c-bid');   // invited nowhere
const dBid = custP(CU.D, 'customer_bidder', 'd-bid');
const fBid = custP(CU.F, 'customer_bidder', 'f-bid');   // must accept terms first
const fView = custP(CU.F, 'customer_viewer', 'f-view');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(enabled ? describe : describe.skip)('Auction lifecycle, allocation, finalisation, outbox — real Postgres', () => {
  let admin: Pool, rawApp: Pool, db: DbService, bids: BidsService, lifecycle: LifecycleService, auctions: AuctionsService, outbox: OutboxService;
  const bid = (p: Principal, lotId: string, amount: number) => bids.place(p, { lotId, amount, idempotencyKey: randomUUID() });
  const codeOf = (pr: Promise<unknown>) => pr.then(() => 'OK', (e: any) => (e.getResponse ? e.getResponse().code : `ERR:${e.code ?? e.message}`));
  const asStaffRows = async (sql: string, params: unknown[] = []) => db.withPrincipal(staffP, async (c) => (await c.query(sql, params)).rows);
  const setClose = (auctionId: string, interval: string) =>
    asStaff(admin, async (c) => { await c.query(`UPDATE auctions SET close_at = clock_timestamp() + $2::interval WHERE id = $1`, [auctionId, interval]); });

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    db = new DbService({ DATABASE_URL: APP_URL } as Env);
    rawApp = new Pool({ connectionString: APP_URL });
    const audit = new AuditService();
    bids = new BidsService(db, audit);
    lifecycle = new LifecycleService(db);
    auctions = new AuctionsService(db, audit);
    outbox = new OutboxService(db);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO margin_rule_sets (id, name) VALUES ('${id(901)}','std');
        INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin) VALUES ('${id(901)}',0,999999999,5);
        INSERT INTO customers (id, company_name, contact_email, status, margin_rule_set_id) VALUES
          ('${CU.A}','Alpha','a@x.ae','active','${id(901)}'), ('${CU.B}','Beta','b@x.ae','active','${id(901)}'),
          ('${CU.C}','Gamma','c@x.ae','active','${id(901)}'), ('${CU.D}','Delta','d@x.ae','active','${id(901)}'),
          ('${CU.F}','Zeta','f@x.ae','active','${id(901)}');
        INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 1000000000 FROM customers;
        UPDATE security_settings SET max_bid_limit = 100000000;
        INSERT INTO auctions (id, number, name, status, start_at, close_at, extension_enabled) VALUES
          ('${AU.OPEN}','L-OPEN','Opens','scheduled', now() - interval '1 second', now() + interval '1 hour', true),
          ('${AU.FUTURE}','L-FUT','Future','scheduled', now() + interval '1 hour', now() + interval '2 hour', true),
          ('${AU.ALLOC}','L-ALLOC','Alloc','live', now() - interval '1 hour', now() + interval '1 hour', false),
          ('${AU.EXT}','L-EXT','Ext','live', now() - interval '1 hour', now() + interval '1 hour', true),
          ('${AU.HOLD}','L-HOLD','Hold','live', now() - interval '1 hour', now() + interval '1 hour', false),
          ('${AU.RACE}','L-RACE','Race','live', now() - interval '1 hour', now() + interval '1 hour', false),
          ('${AU.TERMS}','L-TERMS','Terms','live', now() - interval '1 hour', now() + interval '1 hour', false);
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at)
          SELECT a.id, c.id, CASE WHEN c.id = '${CU.F}' THEN NULL ELSE now() END
          FROM auctions a CROSS JOIN customers c WHERE c.id <> '${CU.C}';
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${LOT.W1}','${AU.ALLOC}','1','won by B',1,100), ('${LOT.W2}','${AU.ALLOC}','2','won by A',3,100),
          ('${LOT.UNSOLD}','${AU.ALLOC}','3','no bids',1,100), ('${LOT.WD}','${AU.ALLOC}','4','withdrawn',1,100),
          ('${LOT.EXT}','${AU.EXT}','1','ext',1,100), ('${LOT.HOLD}','${AU.HOLD}','1','hold',1,100),
          ('${LOT.R1}','${AU.RACE}','1','r1',1,100), ('${LOT.R2}','${AU.RACE}','2','r2',1,100), ('${LOT.R3}','${AU.RACE}','3','r3',1,100),
          ('${LOT.TERMS}','${AU.TERMS}','1','terms',1,100);`);
    });
  });
  afterAll(async () => { await db?.onModuleDestroy(); await rawApp?.end(); await admin?.end(); });

  // ============ access to the worker functions ============
  it('scheduler/outbox functions refuse every non-system context (customer, staff, none)', async () => {
    for (const sql of ['SELECT * FROM open_due_auctions()', `SELECT close_auction_if_due('${AU.ALLOC}')`, 'SELECT * FROM outbox_claim(10)', 'SELECT outbox_mark_published(ARRAY[1]::bigint[])']) {
      await expect(db.withPrincipal(aBid, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      await expect(db.withPrincipal(staffP, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      await expect(rawApp.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await db.withPrincipal(staffP, (c) => c.query('SELECT * FROM due_auction_closures()'))).rows).toEqual([]);
  });

  // ============ opening ============
  it('opens scheduled auctions whose start time has passed (DB clock), and only those; emits auction.opened', async () => {
    const r = await lifecycle.tick();
    expect(r.opened).toEqual([AU.OPEN]);
    const st = await asStaffRows('SELECT id, status FROM auctions WHERE id = ANY($1) ORDER BY number', [[AU.OPEN, AU.FUTURE]]);
    expect(Object.fromEntries(st.map((x) => [x.id, x.status]))).toEqual({ [AU.OPEN]: 'live', [AU.FUTURE]: 'scheduled' });
    const ev = await asStaffRows("SELECT payload FROM outbox_events WHERE type = 'auction.opened'");
    expect(ev.map((e) => e.payload.auctionId)).toEqual([AU.OPEN]);
    expect((await lifecycle.tick()).opened).toEqual([]);   // idempotent
  });

  // ============ closing + allocation ============
  it('closes a live auction once close_at passes and allocates every lot: won / unsold / withdrawn', async () => {
    expect(await codeOf(bid(aBid, LOT.W1, 100))).toBe('OK');
    expect(await codeOf(bid(bBid, LOT.W1, 150))).toBe('OK');
    expect(await codeOf(bid(bBid, LOT.W2, 200))).toBe('OK');
    expect(await codeOf(bid(aBid, LOT.W2, 250))).toBe('OK');
    expect(await codeOf(bid(aBid, LOT.WD, 300))).toBe('OK');
    await asStaff(admin, async (c) => { await c.query(`UPDATE auction_lots SET status = 'withdrawn' WHERE id = $1`, [LOT.WD]); });

    expect((await lifecycle.tick()).closed).not.toContain(AU.ALLOC);   // not due yet
    await setClose(AU.ALLOC, '-1 millisecond');
    expect((await lifecycle.tick()).closed).toEqual([AU.ALLOC]);
    expect((await lifecycle.tick()).closed).toEqual([]);                // idempotent

    const res = await asStaffRows('SELECT lot_id, outcome, winner_customer_id, unit_price, quantity, total, winning_bid_id FROM lot_results WHERE auction_id = $1', [AU.ALLOC]);
    const byLot = Object.fromEntries(res.map((r) => [r.lot_id, r]));
    const winBid = async (lot: string) => (await asStaffRows('SELECT id FROM bids WHERE lot_id = $1 ORDER BY amount DESC LIMIT 1', [lot]))[0].id;
    expect(byLot[LOT.W1]).toMatchObject({ outcome: 'won', winner_customer_id: CU.B, unit_price: '150.00', quantity: 1, total: '150.00', winning_bid_id: await winBid(LOT.W1) });
    expect(byLot[LOT.W2]).toMatchObject({ outcome: 'won', winner_customer_id: CU.A, unit_price: '250.00', quantity: 3, total: '750.00' });
    expect(byLot[LOT.UNSOLD]).toMatchObject({ outcome: 'unsold', winner_customer_id: null, total: null });
    expect(byLot[LOT.WD]).toMatchObject({ outcome: 'withdrawn', winner_customer_id: null, total: null });

    expect(await codeOf(bid(aBid, LOT.W1, 1000))).toBe('AUCTION_NOT_OPEN');
    const ev = await asStaffRows("SELECT payload FROM outbox_events WHERE type = 'auction.closed' AND payload->>'auctionId' = $1", [AU.ALLOC]);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ lotsWon: 2, lotsUnsold: 2 });
  });

  it('results are immutable (even for the owner) and each customer sees only the lots THEY won', async () => {
    await expect(admin.query(`UPDATE lot_results SET unit_price = 1`)).rejects.toThrow(/append-only/);
    await expect(db.withPrincipal(staffP, (c) => c.query(`DELETE FROM lot_results`))).rejects.toMatchObject({ code: '42501' });
    expect((await auctions.myResults(aBid, AU.ALLOC)).lotsWon.map((l: any) => l.lot_id)).toEqual([LOT.W2]);
    expect((await auctions.myResults(bBid, AU.ALLOC)).lotsWon.map((l: any) => l.lot_id)).toEqual([LOT.W1]);
    expect((await auctions.myResults(dBid, AU.ALLOC)).lotsWon).toEqual([]);
    await expect(auctions.myResults(cBid, AU.ALLOC)).rejects.toMatchObject({ response: { code: 'AUCTION_NOT_FOUND' } });
    const raw = await db.withPrincipal(dBid, (c) => c.query('SELECT * FROM lot_results'));
    expect(raw.rows).toHaveLength(0);
  });

  it('a late bid extends the auction, so the closer does NOT close it at the original time', async () => {
    await setClose(AU.EXT, '1 second');
    expect(await bids.place(aBid, { lotId: LOT.EXT, amount: 100, idempotencyKey: randomUUID() })).toMatchObject({ extended: true });
    await sleep(1100);                                                   // original close time has passed
    expect((await lifecycle.tick()).closed).not.toContain(AU.EXT);
    expect((await asStaffRows('SELECT status FROM auctions WHERE id = $1', [AU.EXT]))[0].status).toBe('live');
  });

  it('a bid that passed the open-check before close_at but commits later is INCLUDED: the closer waits for it', async () => {
    await setClose(AU.HOLD, '400 milliseconds');
    const conn = await rawApp.connect();
    try {
      await conn.query('BEGIN');
      await conn.query(`SELECT set_config('app.role','customer',true), set_config('app.customer_id',$1,true),
                               set_config('app.customer_role','customer_bidder',true), set_config('app.user_sub','d-bid',true)`, [CU.D]);
      await conn.query(`INSERT INTO bids (auction_id, lot_id, customer_id, acting_user_sub, amount, idempotency_key)
                        VALUES ($1,$2,$3,'d-bid',500,'held-open')`, [AU.HOLD, LOT.HOLD, CU.D]);   // passes the trigger, not committed
      await sleep(600);                                                  // close_at is now in the past
      let settled = false;
      const closing = lifecycle.tick().then((r) => { settled = true; return r; });
      await sleep(400);
      expect(settled).toBe(false);                                       // blocked behind the in-flight bid
      await conn.query('COMMIT');
      expect((await closing).closed).toContain(AU.HOLD);
    } finally { conn.release(); }
    const r = (await asStaffRows('SELECT outcome, winner_customer_id, unit_price FROM lot_results WHERE lot_id = $1', [LOT.HOLD]))[0];
    expect(r).toEqual({ outcome: 'won', winner_customer_id: CU.D, unit_price: '500.00' });
  });

  it('RACE: bid storm from 3 customers across the close ⇒ every lot is allocated to the highest bid in the ledger', async () => {
    await setClose(AU.RACE, '1500 milliseconds');
    const lots = [LOT.R1, LOT.R2, LOT.R3];
    const counter: Record<string, number> = { [LOT.R1]: 1, [LOT.R2]: 1, [LOT.R3]: 1 };
    let closed = false;
    const stopAt = Date.now() + 8000;
    const closer = (async () => {
      while (!closed && Date.now() < stopAt) {
        if ((await lifecycle.tick()).closed.includes(AU.RACE)) closed = true; else await sleep(3);
      }
    })();
    const storm = (p: Principal, seed: number) => (async () => {
      for (let i = seed; !closed && Date.now() < stopAt; i++) {
        const lot = lots[i % lots.length]!;
        await codeOf(bid(p, lot, 100 + (counter[lot]! += 1) * 10));
      }
    })();
    await Promise.all([closer, storm(aBid, 0), storm(aBid, 1), storm(bBid, 2), storm(bBid, 0), storm(dBid, 1), storm(dBid, 2)]);
    expect(closed).toBe(true);
    let total = 0;
    for (const lot of lots) {
      const top = (await asStaffRows('SELECT id, customer_id, amount::text AS amount, count(*) OVER () AS n FROM bids WHERE lot_id = $1 ORDER BY bids.amount DESC LIMIT 1', [lot]))[0];
      const res = (await asStaffRows('SELECT winning_bid_id, winner_customer_id, unit_price FROM lot_results WHERE lot_id = $1', [lot]))[0];
      expect(res).toEqual({ winning_bid_id: top.id, winner_customer_id: top.customer_id, unit_price: top.amount });
      total += Number(top.n);
    }
    expect(total).toBeGreaterThan(30);                                   // the storm really happened
  }, 20000);

  // ============ terms ============
  it('accepting terms: bidder can (idempotently), then bid; viewer / non-invited / closed auction cannot', async () => {
    expect(await codeOf(bid(fBid, LOT.TERMS, 100))).toBe('TERMS_NOT_ACCEPTED');
    await expect(auctions.acceptTerms(fView, AU.TERMS)).rejects.toMatchObject({ response: { code: 'FORBIDDEN' } });
    const first = await auctions.acceptTerms(fBid, AU.TERMS);
    expect(first.replayed).toBe(false);
    const again = await auctions.acceptTerms(fBid, AU.TERMS);
    expect(again).toEqual({ ...first, replayed: true });
    expect(await codeOf(bid(fBid, LOT.TERMS, 100))).toBe('OK');
    await expect(auctions.acceptTerms(cBid, AU.TERMS)).rejects.toMatchObject({ response: { code: 'AUCTION_NOT_FOUND' } });
    await expect(auctions.acceptTerms(fBid, AU.ALLOC)).rejects.toMatchObject({ response: { code: 'AUCTION_NOT_OPEN' } });   // closed
    const audit = await asStaffRows("SELECT actor_sub FROM audit_logs WHERE action = 'auction.terms_accepted'");
    expect(audit).toEqual([{ actor_sub: 'f-bid' }]);
  });

  it('raw SQL: a customer can neither un-accept terms, re-invite themselves, nor touch another customer\'s row', async () => {
    const fAdmin = custP(CU.F, 'customer_admin', 'f-admin');
    await expect(db.withPrincipal(fAdmin, (c) => c.query('UPDATE auction_participants SET terms_accepted_at = NULL WHERE auction_id = $1', [AU.TERMS])))
      .rejects.toMatchObject({ code: '42501' });
    await expect(db.withPrincipal(fAdmin, (c) => c.query('UPDATE auction_participants SET terms_accepted_at = now() - interval \'1 day\' WHERE auction_id = $1', [AU.TERMS])))
      .rejects.toMatchObject({ code: '42501' });
    await asStaff(admin, async (c) => { await c.query('UPDATE auction_participants SET is_allowed = false WHERE auction_id = $1 AND customer_id = $2', [AU.FUTURE, CU.F]); });
    const selfInvite = await db.withPrincipal(fAdmin, (c) => c.query('UPDATE auction_participants SET is_allowed = true, terms_accepted_at = now() WHERE auction_id = $1', [AU.FUTURE]));
    expect(selfInvite.rowCount).toBe(0);
    const other = await db.withPrincipal(fAdmin, (c) => c.query('UPDATE auction_participants SET terms_accepted_at = now() WHERE customer_id = $1', [CU.D]));
    expect(other.rowCount).toBe(0);
  });

  // ============ finalisation ============
  it('staff finalise: one invoice per winner with a line per lot; refuses twice; refuses a live auction', async () => {
    await expect(auctions.finalize(staffP, AU.TERMS)).rejects.toMatchObject({ response: { code: 'AUCTION_NOT_CLOSED' } });
    const out = await auctions.finalize(staffP, AU.ALLOC);
    expect(out.invoices.map((i) => [i.invoiceNumber, i.totalAmount, i.lots])).toEqual([
      ['INV-L-ALLOC-CUST-0001', '750.00', 1], ['INV-L-ALLOC-CUST-0002', '150.00', 1]]);
    await expect(auctions.finalize(staffP, AU.ALLOC)).rejects.toMatchObject({ response: { code: 'ALREADY_FINALIZED' } });
    const lines = await asStaffRows('SELECT l.lot_id, l.quantity, l.unit_price, l.amount FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id WHERE i.auction_id = $1 ORDER BY l.lot_id', [AU.ALLOC]);
    expect(lines).toEqual([
      { lot_id: LOT.W1, quantity: 1, unit_price: '150.00', amount: '150.00' },
      { lot_id: LOT.W2, quantity: 3, unit_price: '250.00', amount: '750.00' }]);
    expect((await asStaffRows("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auction.finalize'"))[0].n).toBe(1);
  });

  it('customers see only their own invoice and its lines', async () => {
    const mine = await db.withPrincipal(aBid, async (c) => ({
      inv: (await c.query('SELECT invoice_number FROM invoices')).rows, lines: (await c.query('SELECT lot_id FROM invoice_lines')).rows }));
    expect(mine).toEqual({ inv: [{ invoice_number: 'INV-L-ALLOC-CUST-0001' }], lines: [{ lot_id: LOT.W2 }] });
    const none = await db.withPrincipal(dBid, (c) => c.query('SELECT * FROM invoice_lines'));
    expect(none.rows).toHaveLength(0);
    await expect(db.withPrincipal(aBid, (c) => c.query(`INSERT INTO invoice_lines (invoice_id, lot_id, quantity, unit_price, amount)
      SELECT id, '${LOT.UNSOLD}', 1, 1, 1 FROM invoices LIMIT 1`))).rejects.toMatchObject({ code: '42501' });
  });

  // ============ outbox ============
  it('outbox: a failing handler publishes nothing (the batch is re-delivered later)', async () => {
    const before = (await asStaffRows('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL'))[0].n;
    expect(before).toBeGreaterThan(0);
    await expect(outbox.publishBatch(() => { throw new Error('socket layer down'); })).rejects.toThrow('socket layer down');
    expect((await asStaffRows('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL'))[0].n).toBe(before);
  });

  it('outbox: 4 concurrent publishers deliver every event exactly once, each batch in order', async () => {
    const expected = (await asStaffRows('SELECT id::text AS id FROM outbox_events WHERE published_at IS NULL ORDER BY outbox_events.id')).map((r) => r.id);
    const seen: string[] = [];
    const publisher = async () => {
      while ((await outbox.publishBatch(async (evs: OutboxEvent[]) => {
        const ids = evs.map((e) => e.id);
        expect(ids).toEqual([...ids].sort((x, y) => Number(x) - Number(y)));
        await sleep(5);
        seen.push(...ids);
      }, 7)) > 0);
    };
    await Promise.all([publisher(), publisher(), publisher(), publisher()]);
    expect([...seen].sort((x, y) => Number(x) - Number(y))).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await asStaffRows('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL'))[0].n).toBe(0);
  });
});
