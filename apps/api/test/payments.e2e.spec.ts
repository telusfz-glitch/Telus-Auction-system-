import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createServer, type Server } from 'http';
import type { KeyLike } from 'jose';
import type { AddressInfo } from 'net';
import type { Pool } from 'pg';
import Stripe from 'stripe';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { TokenVerifier } from '../src/auth/token-verifier';
import { configureApp } from '../src/bootstrap';
import { loadEnv } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { fromMinor, toMinor } from '../src/payments/payment-provider';
import { asStaff, custP, resetDb } from './db-helpers';
import { AUD, ISS, customerClaims, makeKeys, signToken } from './helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

describe('money conversion (pure)', () => {
  it('converts AED to fils exactly, and back', () => {
    expect(toMinor('1234.5')).toBe(123450);
    expect(toMinor('0.07')).toBe(7);
    expect(toMinor('19999999.99')).toBe(1999999999);
    expect(fromMinor(123450)).toBe('1234.50');
    expect(() => toMinor('1.234')).toThrow();
    expect(() => toMinor('-1')).toThrow();
  });
});

const id = (n: number) => `9a9a9a9a-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2) };
const INV = { MAIN: id(301), WRONG: id(302), EXPIRE: id(303), OTHER: id(304) };
const WHSEC = 'whsec_test_0123456789abcdefghijklmnopqrstuvwx';

(enabled ? describe : describe.skip)('Card payments via Stripe Checkout (real AppModule, real Postgres, Stripe API stand-in)', () => {
  let app: INestApplication, admin: Pool, priv: KeyLike, stub: Server;
  const created: Array<{ body: URLSearchParams; idem: string | undefined }> = [];
  const sessions = new Map<string, string>();   // idempotency key → session id, like Stripe
  const http = () => request(app.getHttpServer());
  let tok: Record<string, string>;
  const pay = (who: string, invoice: string) => http().post(`/invoices/${invoice}/pay`).set('Authorization', `Bearer ${tok[who]}`);
  const signed = (event: object) => {
    const payload = JSON.stringify(event);
    return { payload, sig: Stripe.webhooks.generateTestHeaderString({ payload, secret: WHSEC }) };
  };
  const hook = (event: object, sig?: string) => {
    const s = signed(event);
    return http().post('/payments/stripe/webhook').set('content-type', 'application/json').set('stripe-signature', sig ?? s.sig).send(s.payload);
  };
  const completed = (session: string, amountMinor: number, currency = 'aed') => ({
    id: `evt_${session}_${amountMinor}`, object: 'event', type: 'checkout.session.completed', api_version: '2025-01-01', created: Math.floor(Date.now() / 1000),
    data: { object: { id: session, object: 'checkout.session', payment_status: 'paid', amount_total: amountMinor, currency, payment_intent: `pi_${session}` } },
  });
  const asStaffRead = async <T>(sql: string, args: unknown[]): Promise<T[]> => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.role','staff',true)");
      return (await c.query(sql, args)).rows as T[];
    } finally { await c.query('ROLLBACK'); c.release(); }
  };
  // Owner reads see nothing: RLS is FORCE'd even for the owner. Read as staff.
  const invoice = async (i: string) => (await asStaffRead('SELECT status, settlement_note FROM invoices WHERE id = $1', [i]))[0];
  const payment = async (i: string) => (await asStaffRead('SELECT status, status_detail FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1', [i]))[0];
  const paymentCount = async (i: string) => (await asStaffRead<{ n: number }>('SELECT count(*)::int AS n FROM payments WHERE invoice_id = $1', [i]))[0]!.n;
  const sessionOf = async (i: string) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.role','staff',true)");
      return (await c.query('SELECT provider_session_id FROM payments WHERE invoice_id = $1 ORDER BY created_at DESC LIMIT 1', [i])).rows[0]?.provider_session_id as string;
    } finally { await c.query('ROLLBACK'); c.release(); }
  };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (req.method !== 'POST' || req.url !== '/v1/checkout/sessions') { res.writeHead(404).end('{}'); return; }
        const idem = req.headers['idempotency-key'] as string | undefined;
        created.push({ body: new URLSearchParams(body), idem });
        const sid = sessions.get(idem ?? '') ?? `cs_test_${sessions.size + 1}_${Date.now()}`;
        if (idem) sessions.set(idem, sid);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: sid, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${sid}` }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));

    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES ('${CU.A}','Alpha','a@x.ae','active'), ('${CU.B}','Beta','b@x.ae','active');
        INSERT INTO invoices (id, invoice_number, customer_id, total_amount) VALUES
          ('${INV.MAIN}','INV-P-1','${CU.A}', 1234.50), ('${INV.WRONG}','INV-P-2','${CU.A}', 500), ('${INV.EXPIRE}','INV-P-3','${CU.A}', 75),
          ('${INV.OTHER}','INV-P-4','${CU.B}', 100);`);
    });
    const keys = await makeKeys();
    priv = keys.privateKey;
    tok = {
      admin: await signToken(priv, customerClaims('customer_admin', CU.A), { sub: 'alpha-admin' }),
      bidder: await signToken(priv, customerClaims('customer_bidder', CU.A), { sub: 'alpha-bidder' }),
    };
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: APP_URL, KEYCLOAK_ISSUER: ISS, API_AUDIENCE: AUD, CORS_ORIGINS: 'https://auction.telus.ae',
      WORKERS_ENABLED: 'false', STRIPE_SECRET_KEY: 'sk_test_0123456789', STRIPE_WEBHOOK_SECRET: WHSEC,
      STRIPE_API_URL: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, PUBLIC_WEB_URL: 'https://auction.telus.test',
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TokenVerifier).useValue(new TokenVerifier({ issuer: ISS, audience: AUD, getKey: async () => keys.publicKey }))
      .compile();
    app = mod.createNestApplication({ rawBody: true });
    await configureApp(app, loadEnv());
    await app.init();
  });
  afterAll(async () => {
    await app?.close(); await admin?.end(); await new Promise<void>((r) => stub.close(() => r()));
    for (const k of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_URL', 'PUBLIC_WEB_URL']) delete process.env[k];
  });

  it('only the customer administrator can open a payment; the provider gets the exact amount in fils, AED, and the invoice id', async () => {
    await pay('bidder', INV.MAIN).expect(403);
    const res = await pay('admin', INV.MAIN).expect(200);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    const sent = created.at(-1)!;
    expect(sent.body.get('line_items[0][price_data][unit_amount]')).toBe('123450');
    expect(sent.body.get('line_items[0][price_data][currency]')).toBe('aed');
    expect(sent.body.get('metadata[invoiceId]')).toBe(INV.MAIN);
    expect(sent.body.get('success_url')).toBe('https://auction.telus.test/invoices?payment=success');
    expect(sent.idem).toMatch(/^invoice-/);
    // A double click reuses the same provider session: still one payment row.
    await pay('admin', INV.MAIN).expect(200);
    expect(await paymentCount(INV.MAIN)).toBe(1);
    expect(await payment(INV.MAIN)).toMatchObject({ status: 'created' });
  });

  it("another company's invoice is invisible (404)", () => pay('admin', INV.OTHER).expect(404));

  it('a forged or missing webhook signature is refused and changes nothing', async () => {
    const sid = await sessionOf(INV.MAIN);
    await hook(completed(sid, 123450), 't=1,v1=deadbeef').expect(400);
    await http().post('/payments/stripe/webhook').set('content-type', 'application/json').send(JSON.stringify(completed(sid, 123450))).expect(400);
    expect(await invoice(INV.MAIN)).toMatchObject({ status: 'unpaid' });
  });

  it('a payment for the wrong amount is not applied: recorded for finance, invoice stays unpaid', async () => {
    await pay('admin', INV.WRONG).expect(200);
    const sid = await sessionOf(INV.WRONG);
    const res = await hook(completed(sid, 40000)).expect(200);
    expect(res.body.result).toMatch(/^rejected:amount 400.00 <> 500.00/);
    expect(await invoice(INV.WRONG)).toMatchObject({ status: 'unpaid' });
    expect(await payment(INV.WRONG)).toMatchObject({ status: 'rejected' });
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'payment.rejected'`)).rows[0].n).toBe(1);
  });

  it('the signed success settles the invoice once, audited; redelivery is harmless; a paid invoice cannot be paid again', async () => {
    const sid = await sessionOf(INV.MAIN);
    expect((await hook(completed(sid, 123450)).expect(200)).body.result).toBe('settled');
    expect(await invoice(INV.MAIN)).toMatchObject({ status: 'paid', settlement_note: `Card payment pi_${sid}` });
    expect(await payment(INV.MAIN)).toMatchObject({ status: 'succeeded' });
    expect((await hook(completed(sid, 123450)).expect(200)).body.result).toBe('already');
    expect((await admin.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'invoice.paid_by_card'`)).rows[0].n).toBe(1);
    expect((await admin.query('SELECT verify_audit_chain() AS broken')).rows[0].broken).toBeNull();
    expect((await pay('admin', INV.MAIN).expect(409)).body.code).toBe('INVOICE_NOT_PAYABLE');
  });

  it('an expired checkout is recorded and never touches the invoice; unknown event types are acknowledged and ignored', async () => {
    await pay('admin', INV.EXPIRE).expect(200);
    const sid = await sessionOf(INV.EXPIRE);
    const ev = (type: string) => ({ id: `evt_${type}`, object: 'event', type, api_version: '2025-01-01', created: Math.floor(Date.now() / 1000),
      data: { object: { id: sid, object: 'checkout.session', payment_status: 'unpaid' } } });
    expect((await hook(ev('checkout.session.expired')).expect(200)).body.result).toBe('expired');
    expect((await hook(ev('customer.created')).expect(200)).body.result).toBe('ignored');
    expect(await invoice(INV.EXPIRE)).toMatchObject({ status: 'unpaid' });
    expect(await payment(INV.EXPIRE)).toMatchObject({ status: 'expired' });
  });

  it('the database itself refuses: payments for a paid invoice or a wrong amount, and any status change by a customer', async () => {
    const db = new DbService({ DATABASE_URL: APP_URL } as never);
    const p = custP(CU.A, 'customer_admin', 'alpha-admin');
    const ins = (inv: string, amount: number) => db.withPrincipal(p, (c) => c.query(
      `INSERT INTO payments (invoice_id, customer_id, provider, provider_session_id, amount, created_by) VALUES ($1, $2, 'stripe', $3, $4, 'alpha-admin')`,
      [inv, CU.A, `cs_forged_${inv}_${amount}`, amount]));
    try {
      await expect(ins(INV.MAIN, 1234.5)).rejects.toMatchObject({ code: '42501' });     // already paid
      await expect(ins(INV.EXPIRE, 1)).rejects.toMatchObject({ code: '42501' });        // not the invoice total
      await expect(db.withPrincipal(p, (c) => c.query(`UPDATE payments SET status = 'succeeded'`))).rejects.toMatchObject({ code: '42501' });
      await expect(db.withPrincipal(p, (c) => c.query(`SELECT payment_succeeded('x','y',1,'AED')`))).rejects.toMatchObject({ code: '42501' });
    } finally { await db.onModuleDestroy(); }
  });
});
