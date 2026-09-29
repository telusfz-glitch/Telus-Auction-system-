import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { KeyLike } from 'jose';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { asStaff, resetDb, staffP } from './db-helpers';
import { AUD, ISS, customerClaims, makeKeys, signToken } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

const id = (n: number) => `0b0b0b0b-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = id(1), AU = id(101), LOT = id(201);
const TOKEN = 'metrics-test-token-0123456789abcdef-0123';

(enabled ? describe : describe.skip)('Operations endpoints — readiness and Prometheus metrics (real AppModule, real Postgres)', () => {
  let app: INestApplication, admin: Pool, priv: KeyLike;
  const http = () => request(app.getHttpServer());
  const scrape = () => http().get('/metrics').set('Authorization', `Bearer ${TOKEN}`);
  const line = (body: string, prefix: string) => body.split('\n').find((l) => l.startsWith(prefix));

  beforeAll(async () => {
    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES ('${CU}','Ops Co','o@x.ae','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ('${CU}', 100000000);
        INSERT INTO auctions (id, number, name, status, start_at, close_at, extension_enabled)
          VALUES ('${AU}','OPS-1','Ops','live', now() - interval '1 hour', now() + interval '1 hour', false);
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES ('${AU}','${CU}', now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES ('${LOT}','${AU}','1','lot',1,100);`);
    });
    const keys = await makeKeys();
    priv = keys.privateKey;
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD, CORS_ORIGINS: 'https://auction.telus.ae',
      WORKERS_ENABLED: 'false', METRICS_TOKEN: TOKEN,
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => keys.publicKey }))
      .compile();
    app = mod.createNestApplication();
    await configureApp(app, loadEnv());
    await app.init();
  });
  afterAll(async () => { await app?.close(); await admin?.end(); delete process.env.METRICS_TOKEN; });

  it('readiness is 200 when the database answers', () => http().get('/health/ready').expect(200, { ok: true }));

  it('/metrics answers only to the scrape token; a wrong token looks exactly like "metrics off"', async () => {
    await http().get('/metrics').expect(404);
    await http().get('/metrics').set('Authorization', `Bearer ${TOKEN}x`).expect(404);
    await http().get('/metrics').set('Authorization', `Bearer ${TOKEN.slice(0, -1)}`).expect(404);
    const res = await scrape().expect(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('telus_database_up 1');
    expect(line(res.text, 'telus_backlog{what="auctions_live"}')).toBe('telus_backlog{what="auctions_live"} 1');
  });

  it('bids are counted by outcome and timed; backlogs reflect the outbox and the unshipped audit log', async () => {
    const tok = await signToken(priv, customerClaims('customer_bidder', CU), { sub: 'ops-bidder' });
    const bid = (amount: number, key: string) => http().post('/bids').set('Authorization', `Bearer ${tok}`).send({ lotId: LOT, amount, idempotencyKey: key });
    await bid(100, '11111111-1111-4111-8111-111111111111').expect(201);
    await bid(50, '22222222-2222-4222-8222-222222222222').expect(422);
    await asStaff(admin, async (c) => {   // one audited staff action, not yet shipped (no bucket configured here)
      await c.query(`INSERT INTO audit_logs (actor_sub, actor_kind, action) VALUES ('seed', 'staff', 'ops.test')`);
    });
    const text = (await scrape()).text;
    expect(line(text, 'telus_bids_total{outcome="accepted"}')).toBe('telus_bids_total{outcome="accepted"} 1');
    expect(line(text, 'telus_bids_total{outcome="BID_TOO_LOW"}')).toBe('telus_bids_total{outcome="BID_TOO_LOW"} 1');
    expect(line(text, 'telus_bid_duration_seconds_count')).toBe('telus_bid_duration_seconds_count 2');
    expect(Number(line(text, 'telus_backlog{what="outbox_unpublished"}')!.split(' ')[1])).toBeGreaterThanOrEqual(1);   // workers off
    const audited = (await admin.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n;
    expect(audited).toBeGreaterThanOrEqual(1);
    expect(line(text, 'telus_backlog{what="audit_unshipped_rows"}')).toBe(`telus_backlog{what="audit_unshipped_rows"} ${audited}`);
  });

  it('ops_metrics() is for the system context only', async () => {
    const db = new DbService({ DATABASE_URL: APP_URL } as never);
    try {
      await expect(db.withPrincipal(staffP, (c) => c.query('SELECT ops_metrics()'))).rejects.toMatchObject({ code: '42501' });
    } finally { await db.onModuleDestroy(); }
  });
});
