/**
 * End-to-end load test through the real HTTP and Socket.IO layers: separate API processes (two, sharing Redis, when
 * LOAD_REDIS_URL is set), bidders placing bids over HTTP at human pace and learning prices from their sockets, and
 * spectators watching the live price. Measures bid latency, push latency (bid sent → the bidder's own "you lead"
 * confirmation, and → every spectator's price update), missed pushes, and ledger integrity afterwards.
 *
 * Usage: LOAD_DB_ADMIN_URL=… LOAD_DB_APP_URL=… [LOAD_REDIS_URL=…] npm run load:http -w @telus/api --
 *        [--seconds 30] [--bidders 200] [--viewers 1000] [--lots 50] [--instances 2] [--think-ms 1000]
 * The database is RESET (its name must contain "test"). Tokens are signed by a throw-away key served from a local JWKS
 * endpoint, so the API verifies them exactly as it verifies Keycloak's.
 */
import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AddressInfo } from 'net';
import { cpus } from 'os';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { io, type Socket } from 'socket.io-client';
import { asStaff, resetDb } from '../db-helpers';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const ADMIN_URL = process.env.LOAD_DB_ADMIN_URL ?? '';
const APP_URL = process.env.LOAD_DB_APP_URL ?? '';
const REDIS_URL = process.env.LOAD_REDIS_URL;
const SECONDS = arg('seconds', 30);
const BIDDERS = arg('bidders', 200);
const VIEWERS = arg('viewers', 1000);
const LOTS = arg('lots', 50);
const INSTANCES = arg('instances', REDIS_URL ? 2 : 1);
const THINK_MS = arg('think-ms', 1000);          // mean pause between one bidder's bids (uniform 0.5×–1.5×)
const BASE_PORT = arg('port', 4100);
const AUD = 'telus-api';
const INCREMENT = 25;                              // auction_lots.fallback_increment default (no margin brackets seeded)

const cid = (n: number) => `10ad0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lid = (n: number) => `10ad1000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const AUCTION = '10ad2000-0000-4000-8000-000000000001';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN; };
const stats = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(0)} ms · p95 ${pct(xs, 95).toFixed(0)} ms · p99 ${pct(xs, 99).toFixed(0)} ms · max ${pct(xs, 100).toFixed(0)} ms  (n=${xs.length})`;

async function seed() {
  const admin = await resetDb(ADMIN_URL);
  const companies = BIDDERS + Math.max(1, Math.ceil(VIEWERS / 10));   // spectators: up to 10 viewer logins per company
  await asStaff(admin, async (c) => {
    await c.query(`INSERT INTO customers (id, company_name, contact_email, status)
                   SELECT ('10ad0000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Load ' || g, 'l' || g || '@x.test', 'active'
                     FROM generate_series(1, $1) g`, [companies]);
    await c.query('INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 999999999999 FROM customers');
    await c.query('UPDATE security_settings SET max_bid_limit = 1000000000');
    await c.query(`INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility, extension_enabled)
                   VALUES ($1, 'LOAD', 'Load', 'live', now() - interval '1 hour', now() + interval '2 hours', 'full_price', false)`, [AUCTION]);
    await c.query('INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) SELECT $1, id, now() FROM customers', [AUCTION]);
    await c.query(`INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price)
                   SELECT ('10ad1000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, $1, 'L' || g, 'lot ' || g, 1, 100
                     FROM generate_series(1, $2) g`, [AUCTION, LOTS]);
  });
  return admin;
}

async function startJwks() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'load', alg: 'RS256', use: 'sig' };
  const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/load`;
  const sign = (sub: string, customerId: string, role: string) => new SignJWT({ customer_id: customerId, realm_access: { roles: [role] }, preferred_username: sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'load' }).setIssuer(issuer).setAudience(AUD).setSubject(sub).setIssuedAt().setExpirationTime('2h').sign(privateKey);
  return { server, issuer, sign };
}

async function startApi(i: number, issuer: string): Promise<{ proc: ChildProcess; url: string }> {
  const port = BASE_PORT + i;
  const proc = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', 'src/main.ts'], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: issuer, API_AUDIENCE: AUD,
      CORS_ORIGINS: 'http://localhost', WORKERS_ENABLED: 'true', DB_POOL_MAX: process.env.LOAD_DB_POOL_MAX ?? '20',
      ...(REDIS_URL ? { REDIS_URL } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr!.on('data', (d) => process.stderr.write(`[api${i}] ${d}`));
  const url = `http://127.0.0.1:${port}`;
  for (let t = 0; t < 120; t++) {
    if (await fetch(`${url}/health`).then((r) => r.ok, () => false)) return { proc, url };
    await sleep(500);
  }
  throw new Error(`API ${i} did not start`);
}

/** CPU seconds used so far by a process (Linux /proc; NaN elsewhere). */
function cpuSeconds(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
    return (Number(f[11]) + Number(f[12])) / 100;       // utime + stime, in clock ticks (USER_HZ = 100)
  } catch { return NaN; }
}

function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(url, { path: '/realtime', transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true, extraHeaders: { origin: 'http://localhost' } });
    s.once('connect', async () => {
      const ack = await s.timeout(10_000).emitWithAck('auction.subscribe', { auctionId: AUCTION }).catch((e) => ({ ok: false, code: String(e) }));
      if (!(ack as { ok: boolean }).ok) return reject(new Error(`subscribe failed: ${JSON.stringify(ack)}`));
      resolve(s);
    });
    s.once('connect_error', reject);
  });
}

async function main() {
  if (!ADMIN_URL || !APP_URL) throw new Error('set LOAD_DB_ADMIN_URL and LOAD_DB_APP_URL');
  if (INSTANCES > 1 && !REDIS_URL) throw new Error('more than one instance needs LOAD_REDIS_URL (shared rooms and rate limits)');
  const admin = await seed();
  const jwks = await startJwks();
  const apis = await Promise.all(Array.from({ length: INSTANCES }, (_, i) => startApi(i, jwks.issuer)));
  const urlFor = (n: number) => apis[n % apis.length]!.url;
  const procs = apis.map((a) => a.proc);
  process.on('exit', () => procs.forEach((p) => p.kill()));

  // ---- connect everyone (bidders spread round-robin across instances, like a load balancer would) ----
  const t0Connect = performance.now();
  const sentAt = new Map<string, number>();            // `${lotId}:${amount}` → when the accepted bid was sent
  const pushLead: number[] = [];
  const pushSpectator: number[] = [];
  let spectatorEvents = 0;
  const minNext: Record<string, number> = {};          // what bidders have learnt: live prices (sockets) and 'too low' answers
  const key = (lot: string, amount: unknown) => `${lot}:${Number(amount).toFixed(2)}`;

  const bidderTokens = await Promise.all(Array.from({ length: BIDDERS }, (_, i) => jwks.sign(`bidder-${i + 1}`, cid(i + 1), 'customer_bidder')));
  const viewerTokens = await Promise.all(Array.from({ length: VIEWERS }, (_, i) =>
    jwks.sign(`viewer-${i + 1}`, cid(BIDDERS + 1 + Math.floor(i / 10)), 'customer_viewer')));
  const sockets: Socket[] = [];
  for (let i = 0; i < BIDDERS; i += 50) {
    sockets.push(...await Promise.all(bidderTokens.slice(i, i + 50).map((t, j) => connect(urlFor(i + j), t).then((s) => {
      s.on('lot.price', (d: { lotId: string; highestBid: string }) => { minNext[d.lotId] = Math.max(minNext[d.lotId] ?? 0, Number(d.highestBid) + INCREMENT); });
      s.on('lot.leading', (d: { lotId: string; myBid: string }) => {
        const t = sentAt.get(key(d.lotId, d.myBid));
        if (t !== undefined) pushLead.push(performance.now() - t);
      });
      return s;
    }))));
  }
  for (let i = 0; i < VIEWERS; i += 100) {
    sockets.push(...await Promise.all(viewerTokens.slice(i, i + 100).map((t, j) => connect(urlFor(i + j), t).then((s) => {
      s.on('lot.price', (d: { lotId: string; highestBid: string }) => {
        spectatorEvents += 1;
        const t = sentAt.get(key(d.lotId, d.highestBid));
        if (t !== undefined) pushSpectator.push(performance.now() - t);
      });
      return s;
    }))));
  }
  console.log(`\n${sockets.length} sockets connected and subscribed across ${INSTANCES} instance(s) in ${((performance.now() - t0Connect) / 1000).toFixed(1)} s`);

  // ---- bid at human pace for SECONDS ----
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  const cpu0 = { apis: procs.map((p) => cpuSeconds(p.pid!)), gen: process.cpuUsage() };
  const httpLatency: number[] = [];
  const outcomes: Record<string, number> = {};
  let accepted = 0;
  const until = Date.now() + SECONDS * 1000;
  await Promise.all(bidderTokens.map(async (token, i) => {
    await sleep(Math.random() * THINK_MS);             // stagger the start
    const url = urlFor(i);
    while (Date.now() < until) {
      // 30% of bids go to 3 "hot" lots, the rest spread over all lots.
      const lot = lid(Math.random() < 0.3 ? 1 + Math.floor(Math.random() * Math.min(3, LOTS)) : 1 + Math.floor(Math.random() * LOTS));
      const amount = (minNext[lot] ?? 100) + Math.floor(Math.random() * 20);   // the minimum, or a little more
      const t = performance.now();
      sentAt.set(key(lot, amount), t);
      let code: string;
      try {
        const res = await fetch(`${url}/bids`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ lotId: lot, amount, idempotencyKey: randomUUID() }),
        });
        const body = (await res.json().catch(() => ({}))) as { code?: string; minNextBid?: string };
        if (body.minNextBid) minNext[lot] = Math.max(minNext[lot] ?? 0, Number(body.minNextBid));
        code = res.ok ? 'ACCEPTED' : `${res.status} ${body.code ?? ''}`.trim();
      } catch (e) {
        code = `NETWORK ${(e as Error).message}`;
      }
      httpLatency.push(performance.now() - t);
      outcomes[code] = (outcomes[code] ?? 0) + 1;
      if (code === 'ACCEPTED') accepted += 1;
      await sleep(THINK_MS * (0.5 + Math.random()));
    }
  }));
  await sleep(2000);                                   // let the last pushes arrive
  const apiCpu = procs.map((p, i) => cpuSeconds(p.pid!) - cpu0.apis[i]!);
  const g = process.cpuUsage(cpu0.gen);
  const genCpu = (g.user + g.system) / 1e6;
  lag.disable();

  // ---- report ----
  const expectedSpectator = accepted * VIEWERS;
  console.log(`\nHTTP + Socket.IO: ${BIDDERS} bidders (think ~${THINK_MS} ms), ${VIEWERS} spectators, ${LOTS} lots, ${SECONDS} s, ${INSTANCES} API instance(s), ${cpus().length} CPUs shared with the load generator and Postgres`);
  console.log(`  bids sent       ${httpLatency.length}  (${(httpLatency.length / SECONDS).toFixed(0)}/s), accepted ${accepted} (${(accepted / SECONDS).toFixed(0)}/s)`);
  console.log(`  outcomes        ${JSON.stringify(outcomes)}`);
  console.log(`  bid HTTP        ${stats(httpLatency)}`);
  console.log(`  "you lead" push ${stats(pushLead)}   (bid sent → own socket; includes the outbox poll interval)`);
  console.log(`  spectator push  ${stats(pushSpectator)}`);
  console.log(`  spectator msgs  ${spectatorEvents} received for ${accepted} accepted bids × ${VIEWERS} spectators = ${expectedSpectator} expected`);
  const bad = await admin.query(`SELECT count(*)::int AS n FROM lot_bid_state s WHERE s.highest_amount <> (SELECT max(amount) FROM bids b WHERE b.lot_id = s.lot_id)`);
  const unpublished = await admin.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
  const window = SECONDS + 2;
  console.log(`  CPU (cores)     API ${apiCpu.map((c) => (c / window).toFixed(2)).join(' + ')} · load generator ${(genCpu / window).toFixed(2)}  (averaged over the run)`);
  // Every latency above is measured by this one Node process: when its event loop lags, they all read high.
  console.log(`  generator lag   event-loop delay p50 ${(lag.percentile(50) / 1e6).toFixed(0)} ms · p99 ${(lag.percentile(99) / 1e6).toFixed(0)} ms · max ${(lag.max / 1e6).toFixed(0)} ms  (a few ms = latencies above are the system's; more = they include the generator's own queueing)`);
  console.log(`  integrity       ${bad.rows[0].n === 0 ? 'OK — every lot state matches the top of its ledger' : `MISMATCH on ${bad.rows[0].n} lot(s)`}; unpublished outbox events: ${unpublished.rows[0].n}`);

  sockets.forEach((s) => s.close());
  procs.forEach((p) => p.kill('SIGTERM'));
  jwks.server.close();
  await admin.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
