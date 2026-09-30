/**
 * Bid-engine load test against a real Postgres (the part that serialises: per-lot and per-customer locks).
 * Usage: LOAD_DB_ADMIN_URL=… LOAD_DB_APP_URL=… npm run load -w @telus/api [-- --seconds 15 --bidders 40]
 * The database is RESET (its name must contain "test"). Prints accepted bids/s and latency percentiles.
 */
import { randomUUID } from 'crypto';
import { AuditService } from '../../src/audit/audit.service';
import { BidsService } from '../../src/bids/bids.service';
import type { Env } from '../../src/config/env';
import { DbService } from '../../src/db/db.service';
import { asStaff, custP, resetDb } from '../db-helpers';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const SECONDS = arg('seconds', 15);
const BIDDERS = arg('bidders', 40);
const LOTS = arg('lots', 200);
const POOL = arg('pool', 20);
const ADMIN_URL = process.env.LOAD_DB_ADMIN_URL ?? '';
const APP_URL = process.env.LOAD_DB_APP_URL ?? '';

const cid = (n: number) => `10ad0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lid = (n: number) => `10ad1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUCTION = '10ad2000-0000-4000-8000-000000000001';

function pct(sorted: number[], p: number) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0; }

async function scenario(name: string, bids: BidsService, pickLot: () => string) {
  const latencies: number[] = [];
  const outcomes: Record<string, number> = {};
  const next: Record<string, number> = {};
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: BIDDERS }, async (_, i) => {
    const p = custP(cid(i + 1), 'customer_bidder', `load-${i + 1}`);
    while (Date.now() < until) {
      const lot = pickLot();
      // Clients bid "a bit above what they last saw": realistic contention, many racing bids lose.
      next[lot] = (next[lot] ?? 100) + 5 + Math.floor(Math.random() * 20);
      const t0 = performance.now();
      const code = await bids.place(p, { lotId: lot, amount: next[lot]!, idempotencyKey: randomUUID() })
        .then(() => 'ACCEPTED', (e: any) => e?.getResponse?.().code ?? `ERROR:${e?.message}`);
      latencies.push(performance.now() - t0);
      outcomes[code] = (outcomes[code] ?? 0) + 1;
    }
  }));
  latencies.sort((a, b) => a - b);
  const accepted = outcomes['ACCEPTED'] ?? 0;
  console.log(`\n${name}: ${BIDDERS} concurrent bidders for ${SECONDS}s (DB pool ${POOL})`);
  console.log(`  requests  ${latencies.length}  (${(latencies.length / SECONDS).toFixed(0)}/s)`);
  console.log(`  accepted  ${accepted}  (${(accepted / SECONDS).toFixed(0)} bids/s)`);
  console.log(`  outcomes  ${JSON.stringify(outcomes)}`);
  console.log(`  latency   p50 ${pct(latencies, 50).toFixed(1)} ms · p95 ${pct(latencies, 95).toFixed(1)} ms · p99 ${pct(latencies, 99).toFixed(1)} ms · max ${latencies.at(-1)?.toFixed(1)} ms`);
  return { accepted, outcomes };
}

async function main() {
  if (!ADMIN_URL || !APP_URL) throw new Error('set LOAD_DB_ADMIN_URL and LOAD_DB_APP_URL');
  const admin = await resetDb(ADMIN_URL);
  await asStaff(admin, async (c) => {
    await c.query(`INSERT INTO customers (id, company_name, contact_email, status)
                   SELECT ('10ad0000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Load ' || g, 'l' || g || '@x.test', 'active'
                     FROM generate_series(1, $1) g`, [BIDDERS]);
    await c.query('INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 999999999999 FROM customers');
    await c.query('UPDATE security_settings SET max_bid_limit = 1000000000');
    await c.query(`INSERT INTO auctions (id, number, name, status, start_at, close_at, extension_enabled)
                   VALUES ($1, 'LOAD', 'Load', 'live', now() - interval '1 hour', now() + interval '2 hours', false)`, [AUCTION]);
    await c.query('INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) SELECT $1, id, now() FROM customers', [AUCTION]);
    await c.query(`INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price)
                   SELECT ('10ad1000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, 'L' || g, 'lot ' || g, 1, 100
                     FROM generate_series(1, $2) g`, [AUCTION, LOTS]);
  });
  const db = new DbService({ DATABASE_URL: APP_URL } as Env);
  (db as any).pool.options.max = POOL;
  const bids = new BidsService(db, new AuditService());

  await scenario('HOT LOT (every bidder on the same lot)', bids, () => lid(1));
  await scenario(`SPREAD (random lot out of ${LOTS - 1})`, bids, () => lid(2 + Math.floor(Math.random() * (LOTS - 1))));

  // Integrity after the storm: every lot's recorded leader/price equals the top of its ledger.
  const bad = await admin.query(`
    SELECT count(*)::int AS n FROM lot_bid_state s
     WHERE s.highest_amount <> (SELECT max(amount) FROM bids b WHERE b.lot_id = s.lot_id)`);
  console.log(`\nintegrity: ${bad.rows[0].n === 0 ? 'OK — every lot state matches the top of its ledger' : `MISMATCH on ${bad.rows[0].n} lot(s)`}`);
  await db.onModuleDestroy();
  await admin.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
