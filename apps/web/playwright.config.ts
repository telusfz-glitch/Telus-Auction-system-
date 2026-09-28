import { defineConfig } from '@playwright/test';
import { STACK } from './e2e/stack';

/**
 * Full-stack end-to-end tests: real Keycloak, Postgres, Redis, the API and the production build of this app.
 * Keycloak, Postgres and Redis must already be running (see README "End-to-end tests"); the API and the web app
 * are started here.
 */
const apiPort = new URL(STACK.apiUrl).port || '4000';
const common = { NODE_ENV: 'production' };

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: STACK.webUrl,
    timezoneId: 'Asia/Dubai',
    locale: 'en-GB',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : undefined,
  },
  webServer: [
    {
      command: 'npm run start -w @telus/api',
      cwd: '../..',
      url: `${STACK.apiUrl}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        ...common, NODE_ENV: 'test', PORT: apiPort, DATABASE_URL: STACK.dbAppUrl,
        KEYCLOAK_ISSUER: `${STACK.keycloakUrl}/realms/telus`, API_AUDIENCE: 'telus-api', CORS_ORIGINS: STACK.webUrl,
        REALTIME_TICKET_SECRET: 'e2e-ticket-secret-0123456789abcdef-0123456789', SCHEDULER_INTERVAL_MS: '500',
      },
    },
    {
      command: 'npm run build && npm run start',
      url: STACK.webUrl,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      env: {
        ...common, WEB_URL: STACK.webUrl, OIDC_ISSUER: `${STACK.keycloakUrl}/realms/telus`, OIDC_CLIENT_ID: 'telus-web',
        OIDC_CLIENT_SECRET: STACK.clientSecret, API_URL: STACK.apiUrl, API_PUBLIC_URL: STACK.apiUrl, REDIS_URL: STACK.redisUrl,
        SESSION_SECRET: STACK.sessionSecret, NEXT_TELEMETRY_DISABLED: '1',
        ALLOW_HTTP_FOR_LOCAL_TESTING: 'true',
      },
    },
  ],
});
