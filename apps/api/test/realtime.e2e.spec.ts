import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { KeyLike } from 'jose';
import type { Pool } from 'pg';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { LifecycleService } from '../src/lifecycle/lifecycle.service';
import { WorkersService } from '../src/workers/workers.service';
import { asStaff, resetDb, setCloseIn } from './db-helpers';
import { AUD, ISS, customerClaims, makeKeys, signToken, staffClaims } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2), C: id(3) };
const AU = { HIDDEN: id(101), OTHER: id(102) };
const LOT = { H1: id(201), O1: id(202) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe { socket: Socket; events: Array<[string, any]> }

(enabled ? describe : describe.skip)('Realtime + auction HTTP flow — real AppModule, real sockets, real Postgres', () => {
  let app: INestApplication, admin: Pool, priv: KeyLike, url: string, workers: WorkersService, lifecycle: LifecycleService;
  const probes: Probe[] = [];
  const http = () => request(app.getHttpServer());
  const tok = (claims: Record<string, unknown>, sub: string, exp?: number) => signToken(priv, claims, { sub, ...(exp ? { exp } : {}) });
  const cust = (role: string, customerId: string, sub: string) => tok(customerClaims(role, customerId), sub);

  const connect = (auth: Record<string, unknown>) => new Promise<Probe>((resolve, reject) => {
    const socket = io(url, { path: '/realtime', transports: ['websocket'], auth, reconnection: false, forceNew: true });
    const probe: Probe = { socket, events: [] };
    socket.onAny((event, data) => probe.events.push([event, data]));
    socket.on('connect', () => { probes.push(probe); resolve(probe); });
    socket.on('connect_error', (e) => { socket.close(); reject(e); });
  });
  const ask = (p: Probe, event: string, body: unknown) => p.socket.timeout(2000).emitWithAck(event, body);
  const publish = async () => { await workers.drainOutbox(); await sleep(150); };

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES
          ('${CU.A}','Alpha','a@x.ae','active'), ('${CU.B}','Beta','b@x.ae','active'), ('${CU.C}','Gamma','c@x.ae','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 100000000 FROM customers;
        INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility, extension_enabled) VALUES
          ('${AU.HIDDEN}','R-HID','Hidden','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only', false),
          ('${AU.OTHER}','R-OTH','Other','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only', false);
        INSERT INTO auction_participants (auction_id, customer_id) VALUES
          ('${AU.HIDDEN}','${CU.A}'), ('${AU.HIDDEN}','${CU.B}'), ('${AU.OTHER}','${CU.C}');
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${LOT.H1}','${AU.HIDDEN}','1','iPhone 15, grade A',5,100), ('${LOT.O1}','${AU.OTHER}','1','other',1,100);`);
    });

    const keys = await makeKeys();
    priv = keys.privateKey;
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD, CORS_ORIGINS: 'https://auction.telus.ae', WORKERS_ENABLED: 'false',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => keys.publicKey }))
      .compile();
    app = mod.createNestApplication();
    await configureApp(app, loadEnv());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    workers = app.get(WorkersService);
    lifecycle = app.get(LifecycleService);
  });
  afterAll(async () => {
    probes.forEach((p) => p.socket.close());
    await app?.close();
    await admin?.end();
  });

  it('socket handshake: no token, a forged token, and a token signed by another key are all refused alike', async () => {
    const { privateKey: attacker } = await makeKeys();
    for (const auth of [{}, { token: 'eyJhbGciOiJub25lIn0.e30.' }, { token: await signToken(attacker, staffClaims('super_admin')) }]) {
      await expect(connect(auth)).rejects.toThrow('unauthorized');
    }
  });

  it('auction.subscribe: allowed for an invited customer, NOT_FOUND otherwise, BAD_REQUEST for junk', async () => {
    const a = await connect({ token: await cust('customer_bidder', CU.A, 'a-bid') });
    expect(await ask(a, 'auction.subscribe', { auctionId: AU.HIDDEN })).toEqual({ ok: true });
    expect(await ask(a, 'auction.subscribe', { auctionId: AU.OTHER })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await ask(a, 'auction.subscribe', { auctionId: 'x', extra: 1 })).toEqual({ ok: false, code: 'BAD_REQUEST' });
    a.socket.close();
  });

  it('full flow: accept terms → bid → realtime positions without leaking price or identity', async () => {
    const tA = await cust('customer_bidder', CU.A, 'a-bid');
    const tB = await cust('customer_admin', CU.B, 'b-admin');
    const [a, b, c, staff] = await Promise.all([
      connect({ token: tA }), connect({ token: tB }), connect({ token: await cust('customer_bidder', CU.C, 'c-bid') }),
      connect({ token: await tok(staffClaims('auction_manager'), 'staff-1') })]);
    expect(await ask(a, 'auction.subscribe', { auctionId: AU.HIDDEN })).toEqual({ ok: true });
    expect(await ask(b, 'auction.subscribe', { auctionId: AU.HIDDEN })).toEqual({ ok: true });

    const list = await http().get('/auctions').set('Authorization', `Bearer ${tA}`).expect(200);
    expect(list.body.map((x: any) => x.id)).toEqual([AU.HIDDEN]);
    const detail = await http().get(`/auctions/${AU.HIDDEN}`).set('Authorization', `Bearer ${tA}`).expect(200);
    expect(detail.body.lots.map((l: any) => l.id)).toEqual([LOT.H1]);
    await http().get(`/auctions/${AU.OTHER}`).set('Authorization', `Bearer ${tA}`).expect(404);

    const blocked = await http().post('/bids').set('Authorization', `Bearer ${tA}`).send({ lotId: LOT.H1, amount: 100, idempotencyKey: 'k-a-000000000001' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('TERMS_NOT_ACCEPTED');
    await http().post(`/auctions/${AU.HIDDEN}/accept-terms`).set('Authorization', `Bearer ${await cust('customer_viewer', CU.A, 'a-view')}`).expect(403);
    await http().post(`/auctions/${AU.HIDDEN}/accept-terms`).set('Authorization', `Bearer ${tA}`).expect(200);
    await http().post(`/auctions/${AU.HIDDEN}/accept-terms`).set('Authorization', `Bearer ${tB}`).expect(200);

    await http().post('/bids').set('Authorization', `Bearer ${tA}`).send({ lotId: LOT.H1, amount: 100, idempotencyKey: 'k-a-000000000002' }).expect(201);
    await publish();
    await http().post('/bids').set('Authorization', `Bearer ${tB}`).send({ lotId: LOT.H1, amount: 130, idempotencyKey: 'k-b-000000000001' }).expect(201);
    await publish();

    expect(a.events).toEqual([
      ['lot.leading', { auctionId: AU.HIDDEN, lotId: LOT.H1, myBid: '100.00' }],
      ['lot.outbid', { auctionId: AU.HIDDEN, lotId: LOT.H1 }]]);                     // no price: hidden auction
    expect(b.events).toEqual([['lot.leading', { auctionId: AU.HIDDEN, lotId: LOT.H1, myBid: '130.00' }]]);
    expect(c.events).toEqual([]);                                                   // not invited: hears nothing
    expect(JSON.stringify(a.events)).not.toContain(CU.B);
    expect(staff.events.filter(([e]) => e === 'bid.accepted').map(([, d]) => d.amount)).toEqual(['100.00', '130.00']);
  });

  it('scheduler closes the auction → participants are told; winner sees the result; staff finalise over HTTP', async () => {
    const tB = await cust('customer_admin', CU.B, 'b-admin');
    const a = probes.find((p) => p.events.some(([e]) => e === 'lot.outbid'))!;
    await setCloseIn(admin, AU.HIDDEN, '0 seconds');
    expect((await lifecycle.tick()).closed).toEqual([AU.HIDDEN]);
    await publish();
    expect(a.events.at(-1)).toEqual(['auction.closed', { auctionId: AU.HIDDEN }]);

    const mine = await http().get(`/auctions/${AU.HIDDEN}/my-results`).set('Authorization', `Bearer ${tB}`).expect(200);
    expect(mine.body.lotsWon).toEqual([expect.objectContaining({ lot_id: LOT.H1, quantity: 5, unit_price: '130.00', total: '650.00' })]);

    const staffTok = await tok(staffClaims('auction_manager'), 'staff-1');
    await http().post(`/admin/auctions/${AU.HIDDEN}/finalize`).set('Authorization', `Bearer ${await tok(staffClaims('view_only'), 'viewer-1')}`).expect(403);
    await http().post(`/admin/auctions/${AU.HIDDEN}/finalize`).set('Authorization', `Bearer ${tB}`).expect(403);
    const fin = await http().post(`/admin/auctions/${AU.HIDDEN}/finalize`).set('Authorization', `Bearer ${staffTok}`).expect(200);
    expect(fin.body.invoices).toEqual([expect.objectContaining({ invoiceNumber: 'INV-R-HID-CUST-0002', totalAmount: '650.00', lots: 1 })]);
    const res = await http().get(`/admin/auctions/${AU.HIDDEN}/results`).set('Authorization', `Bearer ${staffTok}`).expect(200);
    expect(res.body).toMatchObject({ status: 'finalized', lots: [{ lot_id: LOT.H1, outcome: 'won', winner_code: 'CUST-0002' }] });
  });

  it('a socket is disconnected when its access token expires', async () => {
    const exp = Math.floor(Date.now() / 1000) + 2;
    const p = await connect({ token: await tok(customerClaims('customer_bidder', CU.A), 'a-bid', exp) });
    const reason = await new Promise<string>((resolve) => p.socket.on('disconnect', resolve));
    expect(reason).toBe('io server disconnect');
  }, 10000);
});
