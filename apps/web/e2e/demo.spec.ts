/**
 * Guided product walkthrough, not a test: `DEMO=1 npx playwright test e2e/demo.spec.ts` (same stack as the e2e suite).
 * Saves numbered screenshots and browser videos to DEMO_OUT (default ./demo-output). Skipped in normal test runs.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { Pool } from 'pg';
import { PASSWORD, STACK, USERS } from './stack';

test.skip(!process.env.DEMO, 'demo walkthrough: set DEMO=1');
test.setTimeout(300_000);

const OUT = resolve(process.env.DEMO_OUT ?? 'demo-output');
mkdirSync(OUT, { recursive: true });
const VIEWPORT = { width: 1280, height: 800 };
let n = 0;
const shot = async (page: Page, name: string) => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: true });
};
const dubaiInput = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 16);
const lotRow = (page: Page, lot: string) => page.getByTestId(`lot-${lot}`);

async function signIn(browser: Browser, who: keyof typeof USERS, video = false) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, ...(video ? { recordVideo: { dir: OUT, size: VIEWPORT } } : {}) });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto('/');
  await page.getByTestId('sign-in').click();
  await page.locator('#username').fill(USERS[who].email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  await page.waitForURL((u) => u.origin === new URL(STACK.webUrl).origin);
  return { ctx, page };
}

test('TELUS auction platform walkthrough', async ({ browser }) => {
  // ---- 1. Signing in: the app's page, then Keycloak (MFA-capable identity provider) ----
  const anon = await browser.newContext({ viewport: VIEWPORT });
  const a = await anon.newPage();
  await a.goto('/');
  await shot(a, 'home-sign-in');
  await a.getByTestId('sign-in').click();
  await a.locator('#username').fill(USERS.manager.email);
  await shot(a, 'keycloak-login');
  await anon.close();

  // ---- 2. Staff (auction manager) builds an auction ----
  const staff = await signIn(browser, 'manager');
  await shot(staff.page, 'staff-console');
  await staff.page.getByRole('link', { name: 'New auction' }).click();
  await staff.page.getByLabel('Auction number').fill('AUC-2026-10');
  await staff.page.getByLabel('Name').fill('October handsets — Dubai stock');
  await staff.page.getByRole('textbox', { name: 'Opens' }).fill(dubaiInput(new Date(Date.now() - 60_000)));
  await staff.page.getByRole('textbox', { name: 'Closes' }).fill(dubaiInput(new Date(Date.now() + 45 * 60_000)));
  await staff.page.getByLabel('Price visibility').selectOption('full_price');
  await shot(staff.page, 'staff-new-auction');
  await staff.page.getByRole('button', { name: 'Create draft' }).click();
  await expect(staff.page).toHaveURL(/\/admin\/auctions\/[0-9a-f-]{36}$/);
  const auctionPath = new URL(staff.page.url()).pathname.replace('/admin', '');
  for (const [no, desc, qty, price] of [
    ['L1', 'iPhone 15 128GB — grade A', '10', '1800'], ['L2', 'Galaxy S24 256GB — sealed', '6', '2100'],
    ['L3', 'Pixel 8 128GB — grade B', '12', '950'], ['L4', 'iPad Air M2 — open box', '4', '1650'],
  ] as const) {
    await staff.page.getByLabel('Lot no.').fill(no);
    await staff.page.getByLabel('Description').fill(desc);
    await staff.page.getByLabel('Qty').fill(qty);
    await staff.page.getByLabel('Starting price (AED)').fill(price);
    await staff.page.getByRole('button', { name: 'Add lot' }).click();
    await expect(lotRow(staff.page, no)).toBeVisible();
  }
  await staff.page.getByLabel('Customers').selectOption([{ label: 'CUST-0001 · Alpha Trading LLC (active)' }, { label: 'CUST-0002 · Beta Mobile FZE (active)' }]);
  await staff.page.getByRole('button', { name: 'Invite' }).click();
  await expect(staff.page.getByTestId('participants')).toContainText('Beta Mobile FZE');
  await staff.page.getByRole('button', { name: 'Schedule' }).click();
  await expect.poll(async () => { await staff.page.reload(); return staff.page.getByTestId('auction-status').textContent(); }, { timeout: 20_000 }).toBe('Live');
  await shot(staff.page, 'staff-auction-live');

  // ---- 3. Two competing customers bid; positions and prices update live over the socket ----
  const alpha = await signIn(browser, 'alphaAdmin', true);
  const beta = await signIn(browser, 'betaBidder', true);
  await shot(alpha.page, 'customer-auctions');
  for (const u of [alpha, beta]) {
    await u.page.goto(auctionPath);
    if (u === alpha) await shot(alpha.page, 'customer-terms');
    await u.page.getByRole('button', { name: 'Accept terms' }).click();
    await expect(u.page.getByTestId('live-state')).toHaveAttribute('data-state', 'live');
  }
  const bid = async (p: Page, lot: string, amount: string) => {
    await lotRow(p, lot).getByRole('textbox').fill(amount);
    await lotRow(p, lot).getByRole('button', { name: 'Bid' }).click();
    await expect(lotRow(p, lot).getByTestId('position')).toHaveText('Leading');
  };
  await bid(alpha.page, 'L1', '1800');
  await bid(alpha.page, 'L3', '950');
  await shot(alpha.page, 'alpha-leading');
  await bid(beta.page, 'L1', '1850');
  await expect(lotRow(alpha.page, 'L1').getByTestId('position')).toHaveText('Outbid');   // no reload: pushed live
  await shot(alpha.page, 'alpha-outbid-live');
  await shot(beta.page, 'beta-leading');
  await bid(alpha.page, 'L1', '1900');
  await bid(beta.page, 'L2', '2100');
  await expect(lotRow(beta.page, 'L1').getByTestId('position')).toHaveText('Outbid');
  await shot(beta.page, 'beta-outbid-live');

  await staff.page.reload();
  await shot(staff.page, 'staff-live-leaders');

  // ---- 4. Close → results → invoices → settlement ----
  const db = new Pool({ connectionString: STACK.dbAdminUrl });
  await db.query('UPDATE auctions SET close_at = clock_timestamp() WHERE id = $1', [auctionPath.split('/').pop()]);   // "time passes"
  await db.end();
  await expect(alpha.page.getByTestId('auction-status')).toHaveText('Closed', { timeout: 20_000 });
  await shot(alpha.page, 'alpha-results');
  await staff.page.reload();
  await staff.page.getByRole('button', { name: 'Finalise & create invoices' }).click();
  await expect(staff.page.getByTestId('auction-status')).toHaveText('Finalised');
  await shot(staff.page, 'staff-finalised');

  const fin = await signIn(browser, 'finance');
  await fin.page.goto('/admin/invoices');
  await shot(fin.page, 'finance-invoices');
  const row = fin.page.getByTestId('invoice-INV-AUC-2026-10-CUST-0001');
  await row.getByPlaceholder('Payment reference').fill('TT-2026-0042');
  await row.getByRole('button', { name: 'Mark paid' }).click();
  await expect(row).toContainText('TT-2026-0042');
  await alpha.page.getByRole('link', { name: 'Invoices' }).click();
  await expect(alpha.page.getByTestId('invoice-INV-AUC-2026-10-CUST-0001')).toContainText('TT-2026-0042');
  await shot(alpha.page, 'alpha-invoice-paid');
  await alpha.page.getByRole('link', { name: 'Team' }).click();
  await expect(alpha.page.getByTestId('team')).toBeVisible();
  await shot(alpha.page, 'alpha-team');

  for (const u of [alpha, beta, staff, fin]) await u.ctx.close();   // flushes the videos
  await alpha.page.video()?.saveAs(join(OUT, 'video-alpha-trading.webm'));
  await beta.page.video()?.saveAs(join(OUT, 'video-beta-mobile.webm'));
  await alpha.page.video()?.delete();
  await beta.page.video()?.delete();
});
