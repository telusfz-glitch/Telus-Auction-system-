import { randomUUID } from 'crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AddressInfo } from 'net';
import type { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { AuctionsService } from '../src/auctions/auctions.service';
import { AuditService } from '../src/audit/audit.service';
import type { Principal } from '../src/auth/principal';
import { BidsService } from '../src/bids/bids.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { LifecycleService } from '../src/lifecycle/lifecycle.service';
import { renderEmail } from '../src/notifications/email-templates';
import { NotificationService } from '../src/notifications/notification.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { asStaff, custP, resetDb, setCloseIn, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const enabled = !!ADMIN_URL && !!APP_URL;
if (!enabled && process.env.REQUIRE_DB_TESTS) {
  it('database tests are REQUIRED but TEST_DB_ADMIN_URL / TEST_DB_APP_URL are not set', () => { throw new Error('DB env missing'); });
}

describe('Email templates (pure)', () => {
  const base = { id: '1', customerCode: 'CUST-0001', companyName: 'Alpha <b>LLC</b>', recipients: ['a@x.test'], auctionId: 'aid', auctionNumber: 'A-1' };
  it('escapes staff/customer-entered text in HTML and keeps subjects on one line', () => {
    const m = renderEmail({ ...base, kind: 'lot.outbid', auctionName: 'Oct <script>alert(1)</script>\r\nBcc: evil@x.test',
      details: { lotNumber: 'L1', description: '<img src=x onerror=alert(1)>', highestBid: null, closeAt: '2026-10-01T10:00:00Z' } }, { timeZone: 'Asia/Dubai', webUrl: 'https://auction.telus.ae' });
    expect(m.html).not.toMatch(/<script>|<img/);
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain('https://auction.telus.ae/auctions/aid');
    expect(m.text).not.toContain('highest bid');                                 // no price unless the job carries one
  });
  it('formats money as text with thousands separators', () => {
    const m = renderEmail({ ...base, kind: 'invoice.issued', auctionName: 'Oct', details: { invoiceNumber: 'INV-1', total: '1234567.5' } }, { timeZone: 'Asia/Dubai' });
    expect(m.subject).toBe('Invoice INV-1 — AED 1,234,567.50');
  });
});

const id = (n: number) => `e0e0e0e0-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CU = { A: id(1), B: id(2) };
const AU = { HID: id(101), FULL: id(102), CAN: id(103) };
const LOT = { H1: id(201), H2: id(202), F1: id(203), C1: id(204) };
const aBid = custP(CU.A, 'customer_bidder', 'a-bidder-sub');
const bBid = custP(CU.B, 'customer_bidder', 'b-bidder-sub');

(enabled ? describe : describe.skip)('Email notifications — outbox → queue → SMTP (real Postgres, real SMTP server)', () => {
  let admin: Pool, db: DbService, bids: BidsService, outbox: OutboxService, lifecycle: LifecycleService, auctions: AuctionsService;
  let smtp: SMTPServer, mail: NotificationService, smtpDown = false;
  const inbox: ParsedMail[] = [];
  const bid = (p: Principal, lotId: string, amount: number) => bids.place(p, { lotId, amount, idempotencyKey: randomUUID() });
  const publish = async () => { while ((await outbox.publishBatch(() => undefined)) > 0); };
  const deliver = async () => { while ((await mail.sendBatch()) > 0); };
  const to = (m: ParsedMail) => (Array.isArray(m.to) ? m.to : [m.to!]).flatMap((a) => a.value.map((v) => v.address)).sort();
  const queue = async () => (await admin.query('SELECT kind, customer_id, status, attempts, dedupe_key FROM email_queue ORDER BY id')).rows;

  beforeAll(async () => {
    smtp = new SMTPServer({
      authOptional: true, disabledCommands: ['STARTTLS'], logger: false,
      onData(stream, _s, cb) {
        if (smtpDown) { stream.resume(); return cb(Object.assign(new Error('mailbox unavailable'), { responseCode: 451 })); }
        simpleParser(stream).then((m) => { inbox.push(m); cb(); }, cb);
      },
    });
    await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
    const port = (smtp.server.address() as AddressInfo).port;

    admin = await resetDb(ADMIN_URL!);
    const env = { DATABASE_URL: APP_URL, SMTP_URL: `smtp://127.0.0.1:${port}`, MAIL_FROM: 'TELUS Auctions <no-reply@auctions.telus.test>',
      PUBLIC_WEB_URL: 'https://auction.telus.test', DISPLAY_TIMEZONE: 'Asia/Dubai' } as Env;
    db = new DbService(env);
    const audit = new AuditService();
    bids = new BidsService(db, audit);
    outbox = new OutboxService(db);
    lifecycle = new LifecycleService(db);
    auctions = new AuctionsService(db, audit);
    mail = new NotificationService(env, db);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES
          ('${CU.A}','Alpha Trading','ops@alpha.test','active'), ('${CU.B}','Beta Mobile','ops@beta.test','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) SELECT id, 100000000 FROM customers;
        INSERT INTO customer_users (customer_id, keycloak_sub, email, display_name, role, status) VALUES
          ('${CU.A}','a-admin-sub','admin@alpha.test','A Admin','customer_admin','active'),
          ('${CU.A}','a-bidder-sub','bidder@alpha.test','A Bidder','customer_bidder','active'),
          ('${CU.A}','a-viewer-sub','viewer@alpha.test','A Viewer','customer_viewer','active'),
          ('${CU.A}','a-gone-sub','gone@alpha.test','A Gone','customer_bidder','suspended'),
          ('${CU.B}','b-bidder-sub','bidder@beta.test','B Bidder','customer_bidder','active');
        INSERT INTO auctions (id, number, name, status, start_at, close_at, bid_visibility, extension_enabled) VALUES
          ('${AU.HID}','N-HID','Hidden sale','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only', false),
          ('${AU.FULL}','N-FULL','Open sale','live', now() - interval '1 hour', now() + interval '1 hour','full_price', false),
          ('${AU.CAN}','N-CAN','Doomed sale','live', now() - interval '1 hour', now() + interval '1 hour','winning_losing_only', false);
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at)
          SELECT a.id, c.id, now() FROM auctions a CROSS JOIN customers c;
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES
          ('${LOT.H1}','${AU.HID}','L1','iPhone 15',10,100), ('${LOT.H2}','${AU.HID}','L2','Galaxy S24',2,500),
          ('${LOT.F1}','${AU.FULL}','L1','Pixel 8',1,100), ('${LOT.C1}','${AU.CAN}','L1','iPad',1,100);`);
    });
  });
  afterAll(async () => {
    await db?.onModuleDestroy();
    await admin?.end();
    mail?.onApplicationShutdown();
    await new Promise<void>((r) => smtp.close(() => r()));
  });

  it('the email functions refuse every non-system context', async () => {
    for (const sql of ['SELECT email_enqueue_for_events(ARRAY[1]::bigint[])', 'SELECT * FROM email_claim(1)', "SELECT email_mark(1, 'sent', null)"]) {
      await expect(db.withPrincipal(staffP, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      await expect(db.withPrincipal(aBid, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('outbid (hidden prices): only the outbid company\'s admins and bidders are told, with no price and no competitor', async () => {
    await bid(aBid, LOT.H1, 100);
    await bid(bBid, LOT.H1, 125);
    await publish();
    await deliver();
    expect(inbox).toHaveLength(1);
    const m = inbox[0]!;
    expect(to(m)).toEqual(['admin@alpha.test', 'bidder@alpha.test']);   // not the viewer, not the suspended login, not Beta
    expect(m.subject).toBe('Outbid on lot L1 — Hidden sale');
    for (const body of [m.text ?? '', String(m.html)]) {
      expect(body).not.toMatch(/125|Beta|CUST-0002|bidder@beta/);
      expect(body).toContain('https://auction.telus.test/auctions/' + AU.HID);
    }
  });

  it('a bidding war produces ONE outbid email per company per lot per 10 minutes', async () => {
    for (const [p, amount] of [[aBid, 150], [bBid, 175], [aBid, 200], [bBid, 225], [aBid, 250]] as const) await bid(p, LOT.H1, amount);
    await publish();
    await deliver();
    // Alpha was outbid twice more inside the same window → deduplicated; Beta was outbid three times → one email.
    const subjects = inbox.slice(1).map((m) => `${to(m).join(',')}|${m.subject}`);
    expect(subjects).toEqual(['bidder@beta.test|Outbid on lot L1 — Hidden sale']);
  });

  it('outbid in a full-price auction includes the new highest bid', async () => {
    await bid(bBid, LOT.F1, 100);
    await bid(aBid, LOT.F1, 1234.5);
    await publish();
    await deliver();
    const m = inbox.at(-1)!;
    expect(to(m)).toEqual(['bidder@beta.test']);
    expect(m.text).toContain('The highest bid is now AED 1,234.50.');
  });

  it('SMTP failure: the email stays queued and is retried later; a redelivered event never duplicates it', async () => {
    smtpDown = true;
    await bid(aBid, LOT.H2, 500);
    await bid(bBid, LOT.H2, 600);
    await publish();
    await deliver();
    const failed = (await queue()).find((q) => q.dedupe_key.includes(LOT.H2))!;
    expect(failed).toMatchObject({ status: 'pending', attempts: 1 });
    // Redelivering the same outbox events (at-least-once) must not queue a second email.
    const ids = (await admin.query('SELECT array_agg(id) AS ids FROM outbox_events')).rows[0].ids;
    await db.withSystem('test', (c) => c.query('SELECT email_enqueue_for_events($1::bigint[])', [ids]));
    expect((await queue()).filter((q) => q.dedupe_key.includes(LOT.H2))).toHaveLength(1);

    smtpDown = false;
    await admin.query('UPDATE email_queue SET next_attempt_at = now() WHERE status = $1', ['pending']);   // skip the backoff wait
    await deliver();
    expect((await queue()).find((q) => q.dedupe_key.includes(LOT.H2))).toMatchObject({ status: 'sent', attempts: 2 });
    expect(inbox.at(-1)!.subject).toBe('Outbid on lot L2 — Hidden sale');
  });

  it('close → each winner gets their own results; finalise → each gets their invoice', async () => {
    const before = inbox.length;
    await setCloseIn(admin, AU.HID, '0 seconds');
    expect((await lifecycle.tick()).closed).toEqual([AU.HID]);
    await publish();
    await deliver();
    const won = inbox.slice(before);
    expect(won).toHaveLength(2);                                                     // one per winning company
    const beta = won.find((m) => to(m).includes('ops@beta.test'))!;
    expect(beta.subject).toBe('You won 1 lot(s) — Hidden sale');
    expect(beta.text).toContain('Lot L2 — Galaxy S24: 2 × AED 600.00 = AED 1,200.00');
    expect(beta.text).not.toContain('L1');                                          // only Beta's own lots
    const alpha = won.find((m) => to(m).includes('ops@alpha.test'))!;
    expect(to(alpha)).toEqual(['admin@alpha.test', 'bidder@alpha.test', 'ops@alpha.test', 'viewer@alpha.test']);
    expect(alpha.text).toContain('Lot L1 — iPhone 15: 10 × AED 250.00 = AED 2,500.00');

    const beforeInv = inbox.length;
    await auctions.finalize(staffP, AU.HID);
    await publish();
    await deliver();
    const inv = inbox.slice(beforeInv).map((m) => `${to(m).find((a) => a?.startsWith("ops@"))}|${m.subject}`).sort();
    expect(inv).toEqual(['ops@alpha.test|Invoice INV-N-HID-CUST-0001 — AED 2,500.00', 'ops@beta.test|Invoice INV-N-HID-CUST-0002 — AED 1,200.00']);
  });

  it('a cancelled live auction tells every invited company', async () => {
    const before = inbox.length;
    await asStaff(admin, async (c) => { await c.query(`UPDATE auctions SET status = 'cancelled' WHERE id = $1`, [AU.CAN]); });
    await publish();
    await deliver();
    const got = inbox.slice(before);
    expect(got.map((m) => m.subject)).toEqual(['Cancelled: Doomed sale', 'Cancelled: Doomed sale']);
    expect(got.flatMap(to).sort()).toEqual(['admin@alpha.test', 'bidder@alpha.test', 'bidder@beta.test', 'ops@alpha.test', 'ops@beta.test', 'viewer@alpha.test']);
  });
});
