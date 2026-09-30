import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import ExcelJS from 'exceljs';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { createHmac } from 'crypto';
import { keyOf, seal, unseal } from '../src/lib/crypto';
import { CUSTOMER, PASSWORD, STACK, STRIPE, USERS } from './stack';
import { keycloakLogin } from './login';
import { freshCode, totp } from './totp';

test.describe.configure({ mode: 'serial' });

/** RS256 JWT header as Keycloak writes it. No response the browser receives may ever contain one. */
const KEYCLOAK_TOKEN_PREFIX = 'eyJhbGciOiJSUzI1NiIs';
const leaks: string[] = [];
let inspected = 0;

async function newUser(browser: Browser, who: keyof typeof USERS): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('response', async (res) => {
    const type = res.headers()['content-type'] ?? '';
    if (!/html|json|text|javascript|x-component/.test(type) || res.url().startsWith(STACK.keycloakUrl)) return;
    const body = await res.text().catch(() => '');
    inspected += 1;
    if (body.includes(KEYCLOAK_TOKEN_PREFIX)) leaks.push(`${who}: ${res.url()}`);
  });
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await keycloakLogin(page, who);
  return { ctx, page };
}

/** datetime-local value in Asia/Dubai (UTC+4, no DST), the browser time zone configured for these tests. */
const dubaiInput = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 16);
const lotRow = (page: Page, lot: string) => page.getByTestId(`lot-${lot}`);

let auctionPath = '';

test('anonymous visitors see only the sign-in page, with strict security headers', async ({ page }) => {
  const res = await page.goto('/');
  const csp = res!.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'nonce-");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-eval');
  expect(res!.headers()['x-powered-by']).toBeUndefined();
  await expect(page.getByTestId('sign-in')).toBeVisible();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/realms\/telus\/protocol\/openid-connect\/auth/);
});

test('an account without a TELUS role is refused after Keycloak login', async ({ browser }) => {
  const { ctx, page } = await newUser(browser, 'noRole');
  await expect(page).toHaveURL(/\?login=denied/);
  await expect(page.getByText('This account has no access')).toBeVisible();
  expect((await ctx.cookies()).some((c) => c.name.includes('telus_sid'))).toBe(false);
  await ctx.close();
});

test('staff must use an authenticator: one without is made to enrol before anything else; tokens prove it, refreshes keep it', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.locator('#username').fill(USERS.newStaff.email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  // Password accepted, but no way past this page without setting up an authenticator app.
  await expect(page.locator('#totp')).toBeVisible();
  expect(new URL(page.url()).origin).toBe(new URL(STACK.keycloakUrl).origin);   // still at Keycloak: no session yet
  if (!(await page.locator('#kc-totp-secret-key').isVisible())) await page.getByText(/Unable to scan/i).click();
  const secret = (await page.locator('#kc-totp-secret-key').textContent())!.trim();
  await page.locator('#totp').fill(await freshCode(USERS.newStaff.email, secret));
  await page.locator('#userLabel').fill('Nina phone');
  await page.locator('input[type=submit], button[type=submit]').first().click();
  // Enrolling is not the same as using the authenticator: the first token has no 'otp', the API answers MFA_REQUIRED and
  // the app asks Keycloak to sign her in again — password and a (fresh) code from the new authenticator.
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await page.locator('#otp').fill(await freshCode(USERS.newStaff.email, secret));
  await page.locator('#kc-login').click();
  await page.waitForURL((u) => u.origin === new URL(STACK.webUrl).origin);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Auctions', level: 1 })).toBeVisible();     // the staff API accepted the token

  // The token records the second factor (the API refuses staff tokens without it) — and a refreshed token keeps it.
  const sid = (await ctx.cookies()).find((c) => c.name === 'telus_sid')!.value;
  const r = createClient({ url: STACK.redisUrl });
  await r.connect();
  const key = keyOf('sess', sid);
  const read = async () => JSON.parse(unseal((await r.get(key))!, STACK.sessionSecret)!);
  const amrOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).amr as string[];
  const before = await read();
  expect(amrOf(before.accessToken)).toEqual(expect.arrayContaining(['pwd', 'otp']));
  await r.set(key, seal(JSON.stringify({ ...before, accessExp: Math.floor(Date.now() / 1000) - 1 }), STACK.sessionSecret), { KEEPTTL: true });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Auctions', level: 1 })).toBeVisible();
  const after = await read();
  expect(after.accessToken).not.toBe(before.accessToken);
  expect(amrOf(after.accessToken)).toEqual(expect.arrayContaining(['otp']));

  // Web session gone but Keycloak's SSO session alive (e.g. idle timeout): signing in again needs no password, and the
  // new token must still show the second factor — otherwise staff would be bounced to a step-up every time.
  await ctx.clearCookies({ name: 'telus_sid' });
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.waitForURL((u) => u.origin === new URL(STACK.webUrl).origin && u.pathname !== '/');
  await expect(page.getByRole('heading', { name: 'Auctions', level: 1 })).toBeVisible();
  const sid2 = (await ctx.cookies()).find((c) => c.name === 'telus_sid')!.value;
  const again = JSON.parse(unseal((await r.get(keyOf('sess', sid2)))!, STACK.sessionSecret)!);
  expect(amrOf(again.accessToken)).toEqual(expect.arrayContaining(['otp']));
  await r.quit();
  await ctx.close();
});

test('staff: create a draft, add lots, invite customers, schedule → the scheduler opens it', async ({ browser }) => {
  const { ctx, page } = await newUser(browser, 'manager');
  await expect(page).toHaveURL(/\/admin$/);

  // The session cookie is an opaque HttpOnly id; no token is stored in the browser.
  const cookies = await ctx.cookies();
  const sid = cookies.find((c) => c.name === 'telus_sid')!;
  expect(sid).toMatchObject({ httpOnly: true, sameSite: 'Lax' });
  expect(sid.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await page.evaluate(() => document.cookie)).not.toContain('telus_sid');
  expect(await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage))).not.toContain('eyJ');

  await page.getByRole('link', { name: 'New auction' }).click();
  await page.getByLabel('Auction number').fill('E2E-001');
  await page.getByLabel('Name').fill('October handsets');
  await page.getByRole('textbox', { name: 'Opens' }).fill(dubaiInput(new Date(Date.now() - 120_000)));
  await page.getByRole('textbox', { name: 'Closes' }).fill(dubaiInput(new Date(Date.now() + 30 * 60_000)));
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/admin\/auctions\/[0-9a-f-]{36}$/);
  auctionPath = new URL(page.url()).pathname.replace('/admin', '');
  await expect(page.getByTestId('auction-status')).toHaveText('Draft');

  await page.getByRole('button', { name: 'Schedule' }).click();
  await expect(page.getByText('Add at least one lot before scheduling.')).toBeVisible();

  for (const [no, desc, qty, price] of [['L1', 'iPhone 15 128GB grade A', '10', '100'], ['L2', 'Galaxy S24 sealed', '2', '1500']] as const) {
    await page.getByLabel('Lot no.').fill(no);
    await page.getByLabel('Description').fill(desc);
    await page.getByLabel('Qty').fill(qty);
    await page.getByLabel('Starting price (AED)').fill(price);
    await page.getByRole('button', { name: 'Add lot' }).click();
    await expect(lotRow(page, no)).toBeVisible();
  }
  // Excel import: a sheet with a bad row imports nothing; a good sheet imports every row.
  const xlsx = async (rows: unknown[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Lots');
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const upload = async (buffer: Buffer) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'lots.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.getByRole('button', { name: 'Import from Excel' }).click();
  };
  await upload(await xlsx([['Lot', 'Description', 'Quantity', 'Starting price'], ['L3', 'Pixel 8', 4, 900], ['L4', '', 0, 'abc']]));
  await expect(page.getByText(/Nothing imported\. Row 3:/)).toBeVisible();
  await expect(lotRow(page, 'L3')).toHaveCount(0);
  await upload(await xlsx([['Lot No.', 'Model', 'Qty', 'Starting price (AED)'], ['L3', 'Pixel 8 128GB', 4, 900], ['L4', 'iPad Air M2', 3, 1250.5]]));
  await expect(page.getByText('2 lot(s) imported.')).toBeVisible();
  await expect(lotRow(page, 'L4')).toContainText('AED 1,250.50');
  await page.getByLabel('Customers').selectOption([{ label: 'CUST-0001 · Alpha Trading LLC (active)' }, { label: 'CUST-0002 · Beta Mobile FZE (active)' }]);
  await page.getByRole('button', { name: 'Invite' }).click();
  await expect(page.getByTestId('participants')).toContainText('Alpha Trading LLC');
  await expect(page.getByTestId('participants')).toContainText('Beta Mobile FZE');

  await page.getByRole('button', { name: 'Schedule' }).click();
  await expect.poll(async () => { await page.reload(); return page.getByTestId('auction-status').textContent(); }, { timeout: 20_000 }).toBe('Live');
  await ctx.close();
});

test('view-only staff and customer viewers can look but not act', async ({ browser }) => {
  const staff = await newUser(browser, 'viewOnly');
  await staff.page.goto(`/admin${auctionPath}`);
  await expect(staff.page.getByTestId('auction-status')).toHaveText('Live');
  await expect(staff.page.getByTestId('transitions')).toHaveCount(0);
  await expect(staff.page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
  await staff.ctx.close();

  const viewer = await newUser(browser, 'alphaViewer');
  await expect(viewer.page).toHaveURL(/\/auctions$/);
  await viewer.page.goto(auctionPath);
  await expect(viewer.page.getByText('must accept the terms before bidding')).toBeVisible();
  await expect(viewer.page.getByRole('button', { name: 'Accept terms' })).toHaveCount(0);
  await expect(viewer.page.getByRole('button', { name: 'Bid' })).toHaveCount(0);
  await viewer.page.goto('/admin');                         // customers never see staff pages
  await expect(viewer.page).toHaveURL(/\/auctions$/);
  await viewer.ctx.close();
});

test('two customers bid; positions update live over the socket; hidden prices stay hidden', async ({ browser }) => {
  const alpha = await newUser(browser, 'alphaAdmin');
  const beta = await newUser(browser, 'betaBidder');
  for (const u of [alpha, beta]) {
    await u.page.goto(auctionPath);
    await u.page.getByRole('button', { name: 'Accept terms' }).click();
    await expect(u.page.getByRole('button', { name: 'Bid' }).first()).toBeVisible();
    await expect(u.page.getByTestId('live-state')).toHaveAttribute('data-state', 'live');
  }

  const bid = async (p: Page, lot: string, amount: string) => {
    await lotRow(p, lot).getByRole('textbox').fill(amount);
    await lotRow(p, lot).getByRole('button', { name: 'Bid' }).click();
  };
  await bid(alpha.page, 'L1', '100');
  await expect(lotRow(alpha.page, 'L1').getByTestId('position')).toHaveText('Leading');
  await expect(lotRow(alpha.page, 'L1').getByTestId('my-bid')).toHaveText('AED 100.00');

  await bid(beta.page, 'L1', '110');
  await expect(lotRow(beta.page, 'L1').getByTestId('position')).toHaveText('Leading');
  // Alpha's page changes WITHOUT a reload: the push arrives over the ticket-authenticated socket.
  await expect(lotRow(alpha.page, 'L1').getByTestId('position')).toHaveText('Outbid');
  await expect(alpha.page.getByTestId('live-notice')).toContainText('outbid on lot L1');
  await expect(alpha.page.locator('main')).not.toContainText('110');   // winning_losing_only: Beta's price is never shown

  await bid(alpha.page, 'L1', '115');                                  // below Beta's 110 + Alpha's own 10 increment
  await expect(lotRow(alpha.page, 'L1')).toContainText('Your bid is too low.');
  await expect(lotRow(alpha.page, 'L1')).not.toContainText('120');     // the minimum is not disclosed either
  await bid(alpha.page, 'L1', '120');
  await expect(lotRow(alpha.page, 'L1').getByTestId('position')).toHaveText('Leading');
  await expect(lotRow(beta.page, 'L1').getByTestId('position')).toHaveText('Outbid');

  const staff = await newUser(browser, 'manager');
  await staff.page.goto(`/admin${auctionPath}`);
  await expect(lotRow(staff.page, 'L1').getByTestId('highest')).toHaveText('AED 120.00');
  await expect(lotRow(staff.page, 'L1')).toContainText('CUST-0001');

  // ---- close (moved to "now" in the database) → scheduler allocates → pages update → staff finalise ----
  const db = new Pool({ connectionString: STACK.dbAdminUrl });
  await db.query('UPDATE auctions SET close_at = clock_timestamp() WHERE id = $1', [auctionPath.split('/').pop()]);
  await db.end();
  await expect(alpha.page.getByTestId('auction-status')).toHaveText('Closed', { timeout: 20_000 });
  await expect(alpha.page.getByTestId('results')).toContainText('AED 1,200.00');   // 10 × 120
  await expect(lotRow(alpha.page, 'L1').getByTestId('position')).toHaveText('Won');
  await beta.page.reload();
  await expect(beta.page.getByText('You did not win any lots in this auction.')).toBeVisible();

  await staff.page.reload();
  await staff.page.getByRole('button', { name: 'Finalise & create invoices' }).click();
  await expect(staff.page.getByTestId('auction-status')).toHaveText('Finalised');
  await expect(staff.page.getByTestId('finalized-note')).toBeVisible();
  await expect(staff.page.getByTestId('results')).toContainText('CUST-0001 · Alpha Trading LLC');

  // ---- sign-out ends the Keycloak SSO session too: coming back requires the password again ----
  await alpha.page.getByRole('button', { name: 'Sign out' }).click();
  await expect(alpha.page.getByTestId('sign-in')).toBeVisible();
  await alpha.page.goto('/auctions');
  await expect(alpha.page.locator('#username')).toBeVisible();

  for (const u of [alpha, beta, staff]) await u.ctx.close();
});

test('invoices: the winner sees theirs; only finance can settle it', async ({ browser }) => {
  const alpha = await newUser(browser, 'alphaAdmin');
  await alpha.page.getByRole('link', { name: 'Invoices' }).click();
  const inv = alpha.page.getByTestId('invoice-INV-E2E-001-CUST-0001');
  await expect(inv).toContainText('AED 1,200.00');
  await expect(inv).toContainText('unpaid');
  await expect(alpha.page.getByTestId(/invoice-.*CUST-0002/)).toHaveCount(0);

  const mgr = await newUser(browser, 'manager');
  await mgr.page.goto('/admin/invoices');
  await expect(mgr.page.getByTestId('invoice-INV-E2E-001-CUST-0001')).toBeVisible();
  await expect(mgr.page.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);   // auction managers do not settle money

  const fin = await newUser(browser, 'finance');
  await fin.page.goto('/admin/invoices');
  const row = fin.page.getByTestId('invoice-INV-E2E-001-CUST-0001');
  await row.getByPlaceholder('Payment reference').fill('TT-2026-0042');
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await expect(row).toContainText('TT-2026-0042');
  await expect(row.getByRole('button', { name: 'Mark paid' })).toHaveCount(0);   // settled once, for good
  await alpha.page.reload();
  await expect(inv).toContainText('paid');
  await expect(inv).toContainText('TT-2026-0042');
  for (const u of [alpha, mgr, fin]) await u.ctx.close();
});

test('card payment: the customer admin pays on the provider\'s page; the signed confirmation settles the invoice', async ({ browser }) => {
  // A second, unpaid invoice for Alpha (manual invoice, as finance could raise).
  const db = new Pool({ connectionString: STACK.dbAdminUrl });
  const staff = async (sql: string, args: unknown[] = []) => {
    const c = await db.connect();
    try {
      await c.query('BEGIN'); await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','e2e-seed',true)");
      const r = await c.query(sql, args); await c.query('COMMIT'); return r.rows;
    } finally { c.release(); }
  };
  await staff(`INSERT INTO invoices (invoice_number, customer_id, total_amount) VALUES ('INV-E2E-CARD', $1, 250.00)`, [CUSTOMER.alpha.id]);

  const alpha = await newUser(browser, 'alphaAdmin');
  // The provider's checkout page is outside this test environment: stand in for it.
  await alpha.page.route('https://checkout.stripe.com/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Stripe Checkout (test)</h1>' }));
  await alpha.page.getByRole('link', { name: 'Invoices' }).click();
  const inv = alpha.page.getByTestId('invoice-INV-E2E-CARD');
  await inv.getByRole('button', { name: 'Pay by card' }).click();
  await alpha.page.waitForURL(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_e2e_/);
  const sessionId = new URL(alpha.page.url()).pathname.split('/').pop()!;

  // The provider confirms: a webhook signed exactly as Stripe signs (HMAC-SHA256 over "timestamp.payload").
  const payload = JSON.stringify({ id: 'evt_e2e_card', object: 'event', type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
    data: { object: { id: sessionId, object: 'checkout.session', payment_status: 'paid', amount_total: 25000, currency: 'aed', payment_intent: 'pi_e2e_card' } } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', STRIPE.webhookSecret).update(`${t}.${payload}`).digest('hex');
  const res = await fetch(`${STACK.apiUrl}/payments/stripe/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` }, body: payload });
  expect(await res.json()).toMatchObject({ result: 'settled' });

  // Back from the provider: the success page, and the invoice is paid.
  await alpha.page.unroute('https://checkout.stripe.com/**');
  await alpha.page.goto('/invoices?payment=success');
  await expect(alpha.page.getByTestId('payment-banner')).toContainText('being confirmed');
  await expect(inv).toContainText('paid');
  await expect(inv).toContainText('Card payment pi_e2e_card');
  await expect(inv.getByRole('button', { name: 'Pay by card' })).toHaveCount(0);
  await db.end();
  await alpha.ctx.close();
});

test('team: a customer admin creates a login; the new person must set a password and enrol an authenticator; suspension blocks sign-in', async ({ browser }) => {
  const alpha = await newUser(browser, 'alphaAdmin');
  await alpha.page.getByRole('link', { name: 'Team' }).click();
  await alpha.page.getByLabel('Email').fill('newbidder@alpha.test');
  await alpha.page.getByLabel('First name').fill('Nadia');
  await alpha.page.getByLabel('Last name').fill('New');
  await alpha.page.getByLabel('Role').selectOption('customer_bidder');
  await alpha.page.getByRole('button', { name: 'Create login' }).click();
  const msg = alpha.page.getByText(/Temporary password \(shown once/);
  await expect(msg).toBeVisible();
  const temp = (await msg.textContent())!.split(': ').pop()!.trim();
  expect(temp).toHaveLength(20);
  await expect(alpha.page.getByTestId('member-newbidder@alpha.test')).toContainText('Bidder');

  // The new person signs in with the temporary password and is forced to choose their own.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.locator('#username').fill('newbidder@alpha.test');
  await page.locator('#password').fill(temp);
  await page.locator('#kc-login').click();
  // First sign-in: Keycloak requires a new password AND authenticator enrolment (in whichever order it chooses).
  let enrolledSecret = '';
  for (let step = 0; step < 4 && !page.url().startsWith(STACK.webUrl); step++) {
    await page.waitForLoadState();
    if (await page.locator('#password-new').isVisible()) {
      await page.locator('#password-new').fill('Nadia-Own-Passw0rd!2026');
      await page.locator('#password-confirm').fill('Nadia-Own-Passw0rd!2026');
      await page.locator('input[type=submit], button[type=submit]').first().click();
    } else if (await page.locator('#totp').isVisible()) {
      if (!(await page.locator('#kc-totp-secret-key').isVisible())) await page.getByText(/Unable to scan/i).click();
      enrolledSecret = (await page.locator('#kc-totp-secret-key').textContent())!.trim();
      await page.locator('#totp').fill(totp(enrolledSecret));
      await page.locator('#userLabel').fill('Nadia phone');
      await page.locator('input[type=submit], button[type=submit]').first().click();
    }
    await page.waitForURL((u) => u.href !== page.url() || u.origin === new URL(STACK.webUrl).origin, { timeout: 10_000 }).catch(() => undefined);
  }
  expect(enrolledSecret).toMatch(/^[A-Z2-7 ]{16,}$/);   // the authenticator really was enrolled
  await expect(page).toHaveURL(/\/auctions$/);
  await expect(page.getByTestId('whoami')).toHaveText('Nadia New');
  await expect(page.getByRole('link', { name: 'October handsets' })).toBeVisible();   // same company, same invitations

  // Each login controls its own outbid emails; the choice survives a reload.
  await page.getByRole('link', { name: 'Team' }).click();
  const prefs = page.getByTestId('my-notifications');
  const box = prefs.getByLabel('Email me when my company is outbid');
  await expect(box).toBeChecked();
  await box.uncheck();
  await prefs.getByRole('button', { name: 'Save' }).click();
  await expect(prefs.getByText('Outbid emails turned off.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('my-notifications').getByLabel('Email me when my company is outbid')).not.toBeChecked();

  // Suspended by the admin WHILE signed in → Keycloak's back-channel logout ends the web session at once
  // (not at the next token refresh): the very next page load goes to the sign-in page.
  const member = alpha.page.getByTestId('member-newbidder@alpha.test');
  await member.getByRole('button', { name: 'Suspend' }).click();
  await expect(member).toContainText('suspended');
  await expect.poll(async () => { await page.goto('/auctions'); return new URL(page.url()).origin; }, { timeout: 10_000 })
    .toBe(new URL(STACK.keycloakUrl).origin);
  // ...and Keycloak refuses the next sign-in.
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.locator('#username').fill('newbidder@alpha.test');
  await page.locator('#password').fill('Nadia-Own-Passw0rd!2026');
  await page.locator('#kc-login').click();
  await expect(page.getByText(/Account is disabled/i)).toBeVisible();

  await ctx.close();
  await alpha.ctx.close();
});

test('back-channel logout accepts only genuine, fresh, single-use Keycloak logout tokens', async ({ request }) => {
  const post = (logout_token: string) => request.post('/auth/backchannel-logout', { form: { logout_token } });
  expect((await post('not-a-token')).status()).toBe(400);
  // Correct shape, signed with a key Keycloak does not have → refused.
  const { SignJWT, generateKeyPair } = await import('jose');
  const { privateKey } = await generateKeyPair('RS256');
  const forged = await new SignJWT({ events: { 'http://schemas.openid.net/event/backchannel-logout': {} }, sid: 'x' })
    .setProtectedHeader({ alg: 'RS256', kid: 'forged' }).setIssuer(`${STACK.keycloakUrl}/realms/telus`).setAudience('telus-web')
    .setSubject('someone').setIssuedAt().setJti('j-1').sign(privateKey);
  expect((await post(forged)).status()).toBe(400);
  expect((await request.get('/auth/backchannel-logout')).status()).toBe(405);
});

test('a forged or stale session cookie gets no access', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'telus_sid', value: 'A'.repeat(43), url: STACK.webUrl }]);
  const page = await ctx.newPage();
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/realms\/telus\/protocol\/openid-connect\/auth/);
  await ctx.close();
});

test('an expired access token is refreshed exactly once, even when parallel requests all need it', async ({ browser }) => {
  const { ctx, page } = await newUser(browser, 'alphaViewer');
  const sid = (await ctx.cookies()).find((c) => c.name === 'telus_sid')!.value;
  const r = createClient({ url: STACK.redisUrl });
  await r.connect();
  const key = keyOf('sess', sid);
  const read = async () => JSON.parse(unseal((await r.get(key))!, STACK.sessionSecret)!);
  const before = await read();
  expect(before.accessToken).toMatch(/^eyJ/);                       // stored server-side, encrypted at rest
  expect(await r.get(key)).not.toContain('eyJ');
  await r.set(key, seal(JSON.stringify({ ...before, accessExp: Math.floor(Date.now() / 1000) - 1 }), STACK.sessionSecret), { KEEPTTL: true });

  // Keycloak rotates refresh tokens and revokes on reuse: without the lock, parallel refreshes would log the user out.
  const results = await Promise.all(Array.from({ length: 6 }, () => page.request.get('/auctions', { maxRedirects: 0 })));
  expect(results.map((x) => x.status())).toEqual([200, 200, 200, 200, 200, 200]);
  const after = await read();
  expect(after.accessToken).not.toBe(before.accessToken);
  expect(after.refreshToken).not.toBe(before.refreshToken);
  expect(after.accessExp).toBeGreaterThan(Math.floor(Date.now() / 1000) + 60);
  await page.goto('/auctions');
  await expect(page.getByRole('heading', { name: 'My auctions' })).toBeVisible();
  await r.quit();
  await ctx.close();
});

test('full-price auction: a competitor\'s bid shows in the current-bid column at once, for every participant', async ({ browser }) => {
  const db = new Pool({ connectionString: STACK.dbAdminUrl });
  const c = await db.connect();
  let auctionId = '';
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','e2e-seed',true)");
    auctionId = (await c.query(
      `INSERT INTO auctions (number, name, status, start_at, close_at, bid_visibility)
       VALUES ('E2E-FULL', 'Open-price test', 'live', now() - interval '1 minute', now() + interval '30 minutes', 'full_price') RETURNING id`)).rows[0].id;
    await c.query("INSERT INTO auction_lots (auction_id, lot_number, description, quantity, starting_price) VALUES ($1, 'F1', 'Open lot', 1, 100)", [auctionId]);
    await c.query('INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES ($1, $2, now()), ($1, $3, now())',
      [auctionId, CUSTOMER.alpha.id, CUSTOMER.beta.id]);
    await c.query('COMMIT');
  } finally { c.release(); await db.end(); }

  const alpha = await newUser(browser, 'alphaViewer');   // watches only (viewers cannot bid)
  const beta = await newUser(browser, 'betaBidder');
  for (const u of [alpha, beta]) {
    await u.page.goto(`/auctions/${auctionId}`);
    await expect(u.page.getByTestId('live-state')).toHaveAttribute('data-state', 'live');
  }
  await expect(lotRow(alpha.page, 'F1').getByTestId('current-bid')).toHaveText('—');
  await lotRow(beta.page, 'F1').getByRole('textbox').fill('150');
  await lotRow(beta.page, 'F1').getByRole('button', { name: 'Bid' }).click();
  await expect(lotRow(beta.page, 'F1').getByTestId('position')).toHaveText('Leading');
  // Pushed straight into the cell (the page's own rate-limited refresh would take up to ~3 s).
  await expect(lotRow(alpha.page, 'F1').getByTestId('current-bid')).toHaveText('AED 150.00', { timeout: 3000 });
  await alpha.ctx.close();
  await beta.ctx.close();
});

test('no Keycloak token ever reached the browser in any response', () => {
  expect(inspected).toBeGreaterThan(30);                              // the check really looked at the traffic
  expect(leaks).toEqual([]);
});
