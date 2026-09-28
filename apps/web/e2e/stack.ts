/**
 * Where the end-to-end stack lives. Defaults match a local dev machine (see README "End-to-end tests");
 * every value can be overridden with an E2E_* variable. Nothing here is a production secret.
 */
const e = process.env;
export const STACK = {
  webUrl: e.E2E_WEB_URL ?? 'http://localhost:3000',
  apiUrl: e.E2E_API_URL ?? 'http://localhost:4000',
  keycloakUrl: e.E2E_KEYCLOAK_URL ?? 'http://localhost:8080',
  keycloakAdmin: e.E2E_KEYCLOAK_ADMIN ?? 'kcadmin',
  keycloakAdminPassword: e.E2E_KEYCLOAK_ADMIN_PASSWORD ?? 'kcadminpw',
  clientSecret: e.E2E_WEB_CLIENT_SECRET ?? 'e2e-web-client-secret-0123456789',
  dbAdminUrl: e.E2E_DB_ADMIN_URL ?? 'postgres://telus_owner:owner@localhost:5433/telus_e2e_test',
  dbAppUrl: e.E2E_DB_APP_URL ?? 'postgres://telus_app:app@localhost:5433/telus_e2e_test',
  redisUrl: e.E2E_REDIS_URL ?? 'redis://:testpw@127.0.0.1:6380/2',
  sessionSecret: 'e2e-session-secret-0123456789abcdef-0123456789',
};

export const PASSWORD = 'E2e-Passw0rd!2026-telus';
export const CUSTOMER = {
  alpha: { id: 'a1a1a1a1-0000-4000-8000-000000000001', name: 'Alpha Trading LLC' },
  beta: { id: 'b2b2b2b2-0000-4000-8000-000000000002', name: 'Beta Mobile FZE' },
};
export const USERS = {
  manager: { email: 'manager@telus.test', role: 'auction_manager', first: 'Mona', last: 'Manager' },
  viewOnly: { email: 'viewonly@telus.test', role: 'view_only', first: 'Vera', last: 'Viewer' },
  alphaAdmin: { email: 'admin@alpha.test', role: 'customer_admin', customerId: CUSTOMER.alpha.id, first: 'Ali', last: 'Alpha' },
  alphaViewer: { email: 'viewer@alpha.test', role: 'customer_viewer', customerId: CUSTOMER.alpha.id, first: 'Amal', last: 'Alpha' },
  betaBidder: { email: 'bidder@beta.test', role: 'customer_bidder', customerId: CUSTOMER.beta.id, first: 'Bilal', last: 'Beta' },
  noRole: { email: 'norole@telus.test', role: null, first: 'Nora', last: 'Norole' },
} as const;
