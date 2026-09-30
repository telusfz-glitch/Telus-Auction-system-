import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { AuditService } from '../src/audit/audit.service';
import { BidsService } from '../src/bids/bids.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { asStaff, custP, resetDb, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2), C: id(3), D: id(4), E: id(5), F: id(6), G: id(7) };
const AU = { MAIN: id(101), FULL: id(102), CLOSED: id(103), SCHED: id(104), SNIPE: id(105), SNIPE2: id(106) };
const LOT = {
  MAIN: id(201), FULL: id(202), LIMIT: id(203), RANGE: id(204), EXP1: id(205), EXP2: id(206), RACE: id(207), SAME: id(208),
  IDEM: id(209), CLOSED: id(210), SCHED: id(211), SNIPE1: id(212), SNIPE2: id(213), SN2A: id(214), SN2B: id(215), MISC: id(216),
};
const aBid = custP(CU.A, 'customer_bidder', 'a-bid');
const aView = custP(CU.A, 'customer_viewer', 'a-view');
const bBid = custP(CU.B, 'customer_bidder', 'b-bid');
const cBid = custP(CU.C, 'customer_bidder', 'c-bid');   // invited nowhere
const dBid = custP(CU.D, 'customer_bidder', 'd-bid');
const eBid = custP(CU.E, 'customer_bidder', 'e-bid');   // suspended
const fBid = custP(CU.F, 'customer_bidder', 'f-bid');   // has not accepted terms
const gBid = custP(CU.G, 'customer_bidder', 'g-bid');   // limited capacity (AED 2,000)

(enabled ? describe : describe.skip)('Bid engine — real Postgres, non-superuser owner, restricted runtime role', () => {
  let admin: Pool, db: DbService, svc: BidsService, snipeClose: Date;
  const bid = (p: any, lotId: string, amount: number, key: string = randomUUID()) => svc.place(p, { lotId, amount, idempotencyKey: key });
  const codeOf = (pr: Promise<unknown>) => pr.then(() => 'OK', (e: any) => (e.getResponse ? e.getResponse().code : `ERR:${e.message}`));
  // Reads run as the OWNER inside a staff context: bids has FORCE'd RLS, so even the owner sees nothing without an identity.
  const rowsAdmin = async (sql: string, params: unknown[] = []) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','test-reader',true)");
      const r = await c.query(sql, params);
      await c.query('COMMIT');
      return r.rows;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  };

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    db = new DbService({ DATABASE_URL: APP_URL } as Env);
    svc = new BidsService(db, new AuditService());
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO margin_rule_sets (id, name) VALUES ('${id(901)}','std'), ('${id(902)}','deposit');
        INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin) VALUES
          ('${id(901)}',100,200,5), ('${id(901)}',200,800,10), ('${id(901)}',800,1400,15), ('${id(901)}',1400,999999999,20),
          ('${id(902)}',100,200,3), ('${id(902)}',200,800,7),  ('${id(902)}',800,1400,12), ('${id(902)}',1400,999999999,15);
        INSERT INTO customers (id, company_name, contact_email, status, margin_rule_set_id) VALUES
          ('${CU.A}','Alpha','a@x.ae','active','${id(901)}'), ('${CU.B}','Beta','b@x.ae','active','${id(902)}'),
          ('${CU.C}','Gamma','c@x.ae','active','${id(901)}'), ('${CU.D}','Delta','d@x.ae','active','${id(901)}'),
          ('${CU.E}','Eps','e@x.ae','suspended','${id(901)}'), ('${CU.F}','Zeta','f@x.ae','active','${id(901)}'),
          ('${CU.G}','Eta','g@x.ae','active','${id(901)}');
        INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES
          ('${CU.A}',100000000), ('${CU.B}',100000000), ('${CU.C}',100000000), ('${CU.D}',100000000),
          ('${CU.E}',100000000), ('${CU.F}',100000000), ('${CU.G}',2000);
        INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility) VALUES
          ('${AU.MAIN}','A-MAIN','Main','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only'),
          ('${AU.FULL}','A-FULL','Full','live', now() - interval '1 hour', now() + interval '1 hour','full_price'),
          ('${AU.CLOSED}','A-CLOSED','Closed','live', now() - interval '2 hour', now() - interval '1 minute','winning_losing_only'),
          ('${AU.SCHED}','A-SCHED','Sched','scheduled', now() + interval '1 hour', now() + interval '2 hour','winning_losing_only'),
          ('${AU.SNIPE}','A-SNIPE','Snipe','live', now() - interval '1 hour', now() + interval '60 seconds','winning_losing_only'),
          ('${AU.SNIPE2}','A-SNIPE2','Snipe2','live', now() - interval '1 hour', now() + interval '60 seconds','winning_losing_only');
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at)
          SELECT a.id, c.id, CASE WHEN c.id = '${CU.F}' THEN NULL ELSE now() END
          FROM auctions a CROSS JOIN customers c WHERE c.id <> '${CU.C}';
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${LOT.MAIN}','${AU.MAIN}','1','main',10,100), ('${LOT.FULL}','${AU.FULL}','1','full',1,100),
          ('${LOT.LIMIT}','${AU.MAIN}','2','limit',1,100), ('${LOT.RANGE}','${AU.MAIN}','3','range',1,100),
          ('${LOT.EXP1}','${AU.MAIN}','4','exp1',10,50), ('${LOT.EXP2}','${AU.MAIN}','5','exp2',10,50),
          ('${LOT.RACE}','${AU.MAIN}','6','race',1,100), ('${LOT.SAME}','${AU.MAIN}','7','same',1,100),
          ('${LOT.IDEM}','${AU.MAIN}','8','idem',1,100), ('${LOT.CLOSED}','${AU.CLOSED}','1','closed',1,100),
          ('${LOT.SCHED}','${AU.SCHED}','1','sched',1,100), ('${LOT.SNIPE1}','${AU.SNIPE}','1','s1',1,100),
          ('${LOT.SNIPE2}','${AU.SNIPE}','2','s2',1,100), ('${LOT.SN2A}','${AU.SNIPE2}','1','a',1,100),
          ('${LOT.SN2B}','${AU.SNIPE2}','2','b',1,100), ('${LOT.MISC}','${AU.MAIN}','9','misc',1,100);`);
    });
    snipeClose = (await rowsAdmin('SELECT close_at FROM auctions WHERE id = $1', [AU.SNIPE]))[0].close_at;
  });
  afterAll(async () => { await db?.onModuleDestroy(); await admin?.end(); });

  // ============ pricing rules ============
  it('accepts a first bid at/above the starting price; rejects below it', async () => {
    expect(await codeOf(bid(aBid, LOT.MAIN, 99))).toBe('BID_TOO_LOW');
    expect(await codeOf(bid(aBid, LOT.MAIN, 100))).toBe('OK');
    const st = (await rowsAdmin('SELECT * FROM lot_bid_state WHERE lot_id = $1', [LOT.MAIN]))[0];
    expect(st.leader_customer_id).toBe(CU.A);
    expect(st.highest_amount).toBe('100.00');
  });

  it("applies EACH customer's own margin bracket (deposit customer +3, standard +5)", async () => {
    expect(await codeOf(bid(bBid, LOT.MAIN, 102))).toBe('BID_TOO_LOW');   // 100 + 3 = 103 needed
    expect(await codeOf(bid(bBid, LOT.MAIN, 103))).toBe('OK');
    expect(await codeOf(bid(aBid, LOT.MAIN, 107))).toBe('BID_TOO_LOW');   // 103 + 5 = 108 needed
    expect(await codeOf(bid(aBid, LOT.MAIN, 108))).toBe('OK');
  });

  it('hidden-price auction: a rejection does NOT reveal the price or the minimum next bid', async () => {
    let body: any;
    try { await bid(bBid, LOT.MAIN, 109); } catch (e: any) { body = e.getResponse(); }
    expect(body.code).toBe('BID_TOO_LOW');
    expect(body.minNextBid).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/10[0-9]|113|108/);
  });

  it('full-price auction: rejection discloses the minimum next bid (the auction allows price visibility)', async () => {
    expect(await codeOf(bid(aBid, LOT.FULL, 100))).toBe('OK');
    let body: any;
    try { await bid(bBid, LOT.FULL, 101); } catch (e: any) { body = e.getResponse(); }
    expect(body.minNextBid).toBe('103.00');
    expect(await codeOf(bid(bBid, LOT.FULL, 103))).toBe('OK');
  });

  it('my-status and visible_highest_bid honour the visibility mode and never leak competitors', async () => {
    const hiddenLeader = await svc.myStatus(aBid, LOT.MAIN);
    const hiddenLoser = await svc.myStatus(bBid, LOT.MAIN);
    expect(hiddenLeader).toMatchObject({ status: 'leading', currentHighestBid: null });
    expect(hiddenLoser).toMatchObject({ status: 'outbid', currentHighestBid: null });     // price hidden
    const fullLoser = await svc.myStatus(aBid, LOT.FULL);
    expect(fullLoser).toMatchObject({ status: 'outbid', currentHighestBid: '103.00' });   // price visible in full_price
    // a customer who is not invited can neither see the lot nor its price
    await expect(svc.myStatus(cBid, LOT.FULL)).rejects.toMatchObject({ response: { code: 'LOT_NOT_FOUND' } });
    const leak = await db.withPrincipal(cBid, (c) => c.query('SELECT visible_highest_bid($1) AS v', [LOT.FULL]));
    expect(leak.rows[0].v).toBeNull();
  });

  // ============ eligibility ============
  it('rejects: not invited (404, no enumeration), viewer role, suspended, terms not accepted', async () => {
    expect(await codeOf(bid(cBid, LOT.MISC, 500))).toBe('LOT_NOT_FOUND');
    expect(await codeOf(bid(aView, LOT.MISC, 500))).toBe('FORBIDDEN');
    expect(await codeOf(bid(eBid, LOT.MISC, 500))).toBe('CUSTOMER_NOT_ACTIVE');
    expect(await codeOf(bid(fBid, LOT.MISC, 500))).toBe('TERMS_NOT_ACCEPTED');
    expect(await rowsAdmin('SELECT 1 FROM bids WHERE lot_id = $1', [LOT.MISC])).toHaveLength(0);
  });

  it('rejects bids on closed or not-yet-open auctions', async () => {
    expect(await codeOf(bid(aBid, LOT.CLOSED, 500))).toBe('AUCTION_NOT_OPEN');
    expect(await codeOf(bid(aBid, LOT.SCHED, 500))).toBe('AUCTION_NOT_OPEN');
  });

  // ============ hard security limits ============
  it('HARD max bid limit blocks the bid and writes a tamper-evident audit record', async () => {
    await asStaff(admin, (c) => c.query('UPDATE security_settings SET max_bid_limit = 500').then(() => undefined));
    try {
      expect(await codeOf(bid(aBid, LOT.LIMIT, 501))).toBe('MAX_BID_LIMIT');
      expect(await codeOf(bid(aBid, LOT.LIMIT, 500))).toBe('OK');
      const audits = await rowsAdmin("SELECT * FROM audit_logs WHERE action = 'bid.rejected' AND actor_sub = 'a-bid'");
      expect(audits.some((r) => r.after_value.code === 'MAX_BID_LIMIT')).toBe(true);
      expect((await rowsAdmin('SELECT verify_audit_chain() AS bad'))[0].bad).toBeNull();
    } finally {
      await asStaff(admin, (c) => c.query('UPDATE security_settings SET max_bid_limit = 1000000').then(() => undefined));
    }
  });

  it('bid range rule blocks bids below the minimum and above the maximum when enabled', async () => {
    await asStaff(admin, (c) => c.query('UPDATE security_settings SET range_enabled = true, range_min = 200, range_max = 300').then(() => undefined));
    try {
      expect(await codeOf(bid(aBid, LOT.RANGE, 350))).toBe('RANGE_LIMIT');
      expect(await codeOf(bid(aBid, LOT.RANGE, 150))).toBe('RANGE_LIMIT');
      expect(await codeOf(bid(aBid, LOT.RANGE, 250))).toBe('OK');
    } finally {
      await asStaff(admin, (c) => c.query('UPDATE security_settings SET range_enabled = false').then(() => undefined));
    }
  });

  it('exposure limit counts everything the customer currently leads, across lots', async () => {
    expect(await codeOf(bid(gBid, LOT.EXP1, 150))).toBe('OK');                 // 150 x 10 = 1500 of 2000
    expect(await codeOf(bid(gBid, LOT.EXP2, 60))).toBe('EXPOSURE_LIMIT');      // +600 -> 2100
    expect(await codeOf(bid(gBid, LOT.EXP2, 50))).toBe('OK');                  // +500 -> exactly 2000 (allowed)
    expect(await codeOf(bid(gBid, LOT.EXP1, 155))).toBe('EXPOSURE_LIMIT');     // replacing 1500 with 1550 -> 2050
    expect(await codeOf(bid(gBid, LOT.EXP2, 75))).toBe('EXPOSURE_LIMIT');      // 750 + 1500 = 2250
  });

  // ============ idempotency ============
  it('same idempotency key + same bid ⇒ same result, one row; different amount ⇒ 422', async () => {
    const key = randomUUID();
    const first = await bid(aBid, LOT.IDEM, 100, key);
    const again = await bid(aBid, LOT.IDEM, 100, key);
    expect(again.bidId).toBe(first.bidId);
    expect(again.replayed).toBe(true);
    expect(await rowsAdmin('SELECT 1 FROM bids WHERE lot_id = $1', [LOT.IDEM])).toHaveLength(1);
    expect(await codeOf(bid(aBid, LOT.IDEM, 120, key))).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('8 simultaneous requests with the SAME key create exactly one bid (double-click / retry storm)', async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => bid(dBid, LOT.MISC, 100, key)));
    expect(new Set(results.map((r) => r.bidId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await rowsAdmin('SELECT 1 FROM bids WHERE lot_id = $1 AND customer_id = $2', [LOT.MISC, CU.D])).toHaveLength(1);
  });

  // ============ concurrency ============
  it('RACE: 30 simultaneous bids from 3 customers ⇒ strictly increasing ledger, correct leader, every increment honoured', async () => {
    const bidders = [aBid, bBid, dBid];
    const amounts = Array.from({ length: 30 }, (_, i) => 300 + i * 10);   // 300..590, all inside the 200–800 bracket
    const results = await Promise.all(amounts.map((amt, i) => codeOf(bid(bidders[i % 3], LOT.RACE, amt))));
    const outcomes = new Set(results);
    for (const o of outcomes) expect(['OK', 'BID_TOO_LOW', 'BID_CONFLICT']).toContain(o);

    const ledger = await rowsAdmin('SELECT customer_id, amount::numeric AS amount FROM bids WHERE lot_id = $1 ORDER BY id', [LOT.RACE]);
    expect(ledger.length).toBe(results.filter((r) => r === 'OK').length);
    expect(ledger.length).toBeGreaterThan(0);
    let prev: number | null = null;
    for (const row of ledger) {
      const amt = Number(row.amount);
      if (prev !== null) {
        const inc = row.customer_id === CU.B ? 7 : 10;                     // per-customer margin bracket
        expect(amt).toBeGreaterThanOrEqual(prev + inc);                     // strictly higher AND by the required increment
      }
      prev = amt;
    }
    const st = (await rowsAdmin('SELECT highest_amount::numeric AS h, bid_count FROM lot_bid_state WHERE lot_id = $1', [LOT.RACE]))[0];
    expect(Number(st.h)).toBe(590);                                        // the highest attempted bid always ends up winning
    expect(Number(st.h)).toBe(prev);
    expect(st.bid_count).toBe(ledger.length);
  });

  it('RACE: 9 simultaneous bids of the identical amount ⇒ exactly one winner', async () => {
    const bidders = [aBid, bBid, dBid];
    const results = await Promise.all(Array.from({ length: 9 }, (_, i) => codeOf(bid(bidders[i % 3], LOT.SAME, 300))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(1);
    expect(await rowsAdmin('SELECT 1 FROM bids WHERE lot_id = $1', [LOT.SAME])).toHaveLength(1);
  });

  // ============ anti-sniping ============
  it('a bid inside the closing window extends the auction by exactly the configured time; a later one does not', async () => {
    const first = await bid(aBid, LOT.SNIPE1, 100);
    expect(first.extended).toBe(true);
    expect(new Date(first.closeAt).getTime()).toBe(snipeClose.getTime() + 120_000);
    const second = await bid(bBid, LOT.SNIPE2, 100);                       // ~178s left > 120s window
    expect(second.extended).toBe(false);
    expect(new Date(second.closeAt).getTime()).toBe(snipeClose.getTime() + 120_000);
  });

  it('two simultaneous late bids on DIFFERENT lots extend the auction exactly once (no double extension)', async () => {
    const before = (await rowsAdmin('SELECT close_at FROM auctions WHERE id = $1', [AU.SNIPE2]))[0].close_at as Date;
    const [r1, r2] = await Promise.all([bid(aBid, LOT.SN2A, 100), bid(bBid, LOT.SN2B, 100)]);
    expect([r1.extended, r2.extended].filter(Boolean)).toHaveLength(1);
    const after = (await rowsAdmin('SELECT close_at FROM auctions WHERE id = $1', [AU.SNIPE2]))[0].close_at as Date;
    expect(after.getTime()).toBe(before.getTime() + 120_000);
  });

  // ============ database safety net (engine bypassed entirely) ============
  it('even raw SQL that bypasses the engine cannot record a lower/equal bid or a bid on a closed auction', async () => {
    const raw = (p: any, lot: string, auction: string, amount: number) =>
      db.withPrincipal(p, (c) => c.query(
        'INSERT INTO bids (auction_id, lot_id, customer_id, acting_user_sub, amount, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)',
        [auction, lot, p.customerId, p.sub, amount, randomUUID()]));
    await expect(raw(aBid, LOT.MAIN, AU.MAIN, 50)).rejects.toMatchObject({ message: 'BID_NOT_HIGHER' });
    await expect(raw(aBid, LOT.MAIN, AU.MAIN, 108)).rejects.toMatchObject({ message: 'BID_NOT_HIGHER' });   // equal is not higher
    await expect(raw(aBid, LOT.CLOSED, AU.CLOSED, 9999)).rejects.toMatchObject({ message: 'AUCTION_NOT_OPEN' });
  });

  // ============ confidentiality of stored state ============
  it('customers can only read lot_bid_state rows they lead, cannot write it, and cannot read the outbox', async () => {
    const asA = (await db.withPrincipal(aBid, (c) => c.query('SELECT lot_id FROM lot_bid_state WHERE lot_id = $1', [LOT.MAIN]))).rows;
    const asB = (await db.withPrincipal(bBid, (c) => c.query('SELECT lot_id FROM lot_bid_state WHERE lot_id = $1', [LOT.MAIN]))).rows;
    expect(asA).toHaveLength(1);       // A leads MAIN
    expect(asB).toHaveLength(0);       // B was outbid: cannot see price/leader
    await expect(db.withPrincipal(aBid, (c) => c.query('UPDATE lot_bid_state SET highest_amount = 1'))).rejects.toMatchObject({ code: '42501' });
    await expect(db.withPrincipal(aBid, (c) => c.query('DELETE FROM lot_bid_state'))).rejects.toMatchObject({ code: '42501' });
    expect((await db.withPrincipal(aBid, (c) => c.query('SELECT * FROM outbox_events'))).rows).toHaveLength(0);
    expect((await db.withPrincipal(staffP, (c) => c.query("SELECT * FROM outbox_events WHERE type = 'bid.accepted'"))).rows.length).toBeGreaterThan(0);
  });

  it('the outbox records who was outbid (for notifications) inside the same transaction as the bid', async () => {
    const ev = await rowsAdmin("SELECT payload FROM outbox_events WHERE payload->>'lotId' = $1 ORDER BY id", [LOT.MAIN]);
    expect(ev.length).toBe(3);                                             // A, B, A
    expect(ev[1].payload.previousLeaderCustomerId).toBe(CU.A);
    expect(ev[2].payload.previousLeaderCustomerId).toBe(CU.B);
  });

  it('margin brackets cannot overlap (enforced by the database)', async () => {
    await expect(asStaff(admin, (c) => c.query(`INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin) VALUES ('${id(901)}',150,250,9)`).then(() => undefined))).rejects.toThrow(/brackets_no_overlap/);
  });

  it('lot table (myPositions): prices only in full-price auctions, own position always, nothing for the uninvited', async () => {
    const FP = id(151), HID = id(152);
    const lot = (a: string, n: number) => id((a === FP ? 310 : 320) + n);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility) VALUES
          ('${FP}','A-POS-FP','PosFP','live', now() - interval '1 hour', now() + interval '1 hour','full_price'),
          ('${HID}','A-POS-H','PosH','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only');
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES
          ('${FP}','${CU.A}',now()), ('${FP}','${CU.B}',now()), ('${HID}','${CU.A}',now()), ('${HID}','${CU.B}',now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${lot(FP, 1)}','${FP}','1','p1',1,100), ('${lot(FP, 2)}','${FP}','2','p2',1,100), ('${lot(FP, 3)}','${FP}','3','p3',1,100),
          ('${lot(HID, 1)}','${HID}','1','h1',1,100), ('${lot(HID, 2)}','${HID}','2','h2',1,100), ('${lot(HID, 3)}','${HID}','3','h3',1,100);`);
    });
    for (const a of [FP, HID]) {
      await bid(aBid, lot(a, 1), 100);
      await bid(bBid, lot(a, 1), 110);   // A is outbid on lot 1
      await bid(aBid, lot(a, 2), 150);   // A leads lot 2; lot 3 has no bids
    }
    const byLot = async (a: string) => Object.fromEntries((await svc.myPositions(aBid, a)).map((r) => [r.lotId, r]));

    const fp = await byLot(FP);   // A's rule set: 100–200 → +5
    expect(fp[lot(FP, 1)]).toMatchObject({ status: 'outbid', myHighestBid: '100.00', currentHighestBid: '110.00', minNextBid: '115.00' });
    expect(fp[lot(FP, 2)]).toMatchObject({ status: 'leading', myHighestBid: '150.00', currentHighestBid: '150.00', minNextBid: '155.00' });
    expect(fp[lot(FP, 3)]).toMatchObject({ status: 'no_bid', myHighestBid: null, currentHighestBid: null, minNextBid: '100.00' });

    const hid = await byLot(HID);   // the competitor's price never shows; A's own price does, where A leads
    expect(hid[lot(HID, 1)]).toMatchObject({ status: 'outbid', myHighestBid: '100.00', currentHighestBid: null, minNextBid: null });
    expect(hid[lot(HID, 2)]).toMatchObject({ status: 'leading', myHighestBid: '150.00', currentHighestBid: null, minNextBid: '155.00' });
    expect(hid[lot(HID, 3)]).toMatchObject({ status: 'no_bid', currentHighestBid: null, minNextBid: null });

    expect(await codeOf(svc.myPositions(cBid, FP))).toBe('AUCTION_NOT_FOUND');   // not invited
  });
});
