import type { Page } from '@playwright/test';
import { PASSWORD, STACK, STAFF_OTP_SECRET, USERS } from './stack';
import { base32, freshCode } from './totp';

/** Keycloak login as a seeded user, including the authenticator step staff always get. Ends back on the web app. */
export async function keycloakLogin(page: Page, who: keyof typeof USERS): Promise<void> {
  await page.locator('#username').fill(USERS[who].email);
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
  const web = new URL(STACK.webUrl).origin;
  const otp = page.locator('#otp');
  await Promise.race([page.waitForURL((u) => u.origin === web), otp.waitFor({ state: 'visible' })]);
  if (new URL(page.url()).origin !== web && await otp.isVisible()) {
    await otp.fill(await freshCode(USERS[who].email, base32(STAFF_OTP_SECRET)));
    await page.locator('#kc-login').click();
    await page.waitForURL((u) => u.origin === web);
  }
}
