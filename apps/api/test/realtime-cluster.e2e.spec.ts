import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { KeyLike } from 'jose';
import type { Pool } from 'pg';
import { createClient } from 'redis';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { WorkersService } from '../src/workers/workers.service';
import { asStaff, resetDb } from './db-helpers';
import { AUD, ISS, customerClaims, makeKeys, signToken, staffClaims } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const REDIS_URL = process.env.TEST_REDIS_URL;
const enabled = !!ADMIN_URL && !!APP_URL && !!REDIS_URL;
if (!enabled && process.env.REQUIRE_REDIS_TESTS) {
  it('cluster tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL / TEST_REDIS_URL are not set', () => { throw new Error('env missing'); });
}

const id = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2) };
const AU = id(101);
const LOT = id(201);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(enabled ? describe : describe.skip)('Realtime across two API instances sharing Redis', () => {
  let admin: Pool, priv: KeyLike, node1: INestApplication, node2: INestApplication;
  const sockets: Socket[] = [];

  const boot = async (publicKey: KeyLike) => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => publicKey }))
      .compile();
    const app = mod.createNestApplication();
    await configureApp(app, loadEnv());
    await app.listen(0, '127.0.0.1');
    return app;
  };
  const connect = async (app: INestApplication, token: string) => {
    const s = io(await app.getUrl(), { path: '/realtime', transports: ['websocket'], auth: { token }, reconnection: false, forceNew: true });
    sockets.push(s);
    await new Promise<void>((res, rej) => { s.on('connect', () => res()); s.on('connect_error', rej); });
    return s;
  };

  beforeAll(async () => {
    const r = createClient({ url: REDIS_URL });
    await r.connect();
    const stale = await r.keys('telus:rl:*');
    if (stale.length) await r.del(stale);
    await r.quit();
    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES ('${CU.A}','Alpha','a@x.ae','active'), ('${CU.B}','Beta','b@x.ae','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 1000000 FROM customers;
        INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility) VALUES
          ('${AU}','C-1','Cluster','live', now() - interval '1 hour', now() + interval '1 hour','full_price');
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES ('${AU}','${CU.A}', now()), ('${AU}','${CU.B}', now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES ('${LOT}','${AU}','1','lot',1,100);`);
    });
    const keys = await makeKeys();
    priv = keys.privateKey;
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD, CORS_ORIGINS: '', WORKERS_ENABLED: 'false', REDIS_URL,
    });
    node1 = await boot(keys.publicKey);
    node2 = await boot(keys.publicKey);
  });
  afterAll(async () => {
    sockets.forEach((s) => s.close());
    await node1?.close();
    await node2?.close();
    await admin?.end();
    delete process.env.REDIS_URL;
  });

  it('rate limits are shared: 140 requests split across two instances exceed the 120/min limit', async () => {
    const hit = (app: INestApplication) => request(app.getHttpServer()).get('/health').then((r) => r.status);
    const codes = await Promise.all(Array.from({ length: 140 }, (_, i) => hit(i % 2 ? node1 : node2)));
    const limited = codes.filter((c) => c === 429).length;
    expect(codes.filter((c) => c === 200).length).toBe(120);
    expect(limited).toBe(20);   // with per-instance memory each node would have allowed all 70
  });

  it('a bid placed and published on node 1 reaches sockets connected to node 2 (customer room AND auction room)', async () => {
    const tA = await signToken(priv, customerClaims('customer_bidder', CU.A), { sub: 'a-bid' });
    const tB = await signToken(priv, customerClaims('customer_bidder', CU.B), { sub: 'b-bid' });
    const a = await connect(node2, tA);
    const b = await connect(node2, tB);
    const got: Record<string, Array<[string, unknown]>> = { a: [], b: [] };
    a.onAny((e, d) => got.a!.push([e, d]));
    b.onAny((e, d) => got.b!.push([e, d]));
    expect(await b.timeout(2000).emitWithAck('auction.subscribe', { auctionId: AU })).toEqual({ ok: true });

    await request(node1.getHttpServer()).post('/bids').set('Authorization', `Bearer ${tA}`)
      .send({ lotId: LOT, amount: 150, idempotencyKey: 'cluster-key-0001' }).expect(201);
    await node1.get(WorkersService).drainOutbox();   // only node 1 publishes
    await sleep(300);

    expect(got.a).toEqual([['lot.leading', { auctionId: AU, lotId: LOT, myBid: '150.00' }]]);
    expect(got.b).toEqual([['lot.price', { auctionId: AU, lotId: LOT, highestBid: '150.00' }]]);   // full_price auction

    // Revoking B on node 1 pulls B's socket on node 2 out of the auction room, and B cannot re-join.
    const staff = await signToken(priv, staffClaims('auction_manager'), { sub: 'mgr-1' });
    await request(node1.getHttpServer()).delete(`/admin/auctions/${AU}/participants/${CU.B}`).set('Authorization', `Bearer ${staff}`).expect(200);
    await sleep(200);
    expect(await b.timeout(2000).emitWithAck('auction.subscribe', { auctionId: AU })).toEqual({ ok: false, code: 'NOT_FOUND' });
    await request(node1.getHttpServer()).post('/bids').set('Authorization', `Bearer ${tA}`)
      .send({ lotId: LOT, amount: 200, idempotencyKey: 'cluster-key-0002' }).expect(201);
    await node1.get(WorkersService).drainOutbox();
    await sleep(300);
    expect(got.b).toHaveLength(1);                                                   // nothing new for B
    expect(got.a.at(-1)).toEqual(['lot.leading', { auctionId: AU, lotId: LOT, myBid: '200.00' }]);
  });
});
