import { Pool } from 'pg';
import { migrate } from '../../api/src/db/migrate';
import { CREATED_IN_TEST, CUSTOMER, NOT_PREENROLLED, PASSWORD, STACK, STAFF_OTP_SECRET, STAFF_ROLES_E2E, USERS } from './stack';

/** Fresh database + seed data, and real Keycloak users (created through the admin REST API, like create-user.sh). */
export default async function globalSetup() {
  const dbName = new URL(STACK.dbAdminUrl).pathname.slice(1);
  if (!/test/i.test(dbName)) throw new Error(`Refusing to reset "${dbName}": e2e database name must contain "test"`);

  const admin = new Pool({ connectionString: STACK.dbAdminUrl });
  try {
    await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(STACK.dbAdminUrl);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','e2e-seed',true)");
      await c.query(`
        INSERT INTO margin_rule_sets (id, name) VALUES ('c0c0c0c0-0000-4000-8000-000000000001', 'Standard');
        INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin) VALUES
          ('c0c0c0c0-0000-4000-8000-000000000001', 0, 1000, 10), ('c0c0c0c0-0000-4000-8000-000000000001', 1000, 999999999, 25);
        INSERT INTO customers (id, company_name, contact_email, status, margin_rule_set_id) VALUES
          ('${CUSTOMER.alpha.id}', '${CUSTOMER.alpha.name}', 'ops@alpha.test', 'active', 'c0c0c0c0-0000-4000-8000-000000000001'),
          ('${CUSTOMER.beta.id}', '${CUSTOMER.beta.name}', 'ops@beta.test', 'active', 'c0c0c0c0-0000-4000-8000-000000000001');
        INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ('${CUSTOMER.alpha.id}', 500000), ('${CUSTOMER.beta.id}', 500000);`);
      await c.query('COMMIT');
    } finally { c.release(); }
  } finally {
    await admin.end();
  }

  // ---------- Keycloak ----------
  const kc = STACK.keycloakUrl;
  const tokenRes = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: STACK.keycloakAdmin, password: STACK.keycloakAdminPassword }),
  });
  if (!tokenRes.ok) throw new Error(`Keycloak admin login failed: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json() as { access_token: string };
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`${kc}/admin/realms/telus${path}`, {
      ...init, headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!r.ok && r.status !== 404) throw new Error(`Keycloak ${init.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`);
    return r;
  };

  for (const username of CREATED_IN_TEST) {
    const stale = await (await call(`/users?exact=true&username=${encodeURIComponent(username)}`)).json() as Array<{ id: string }>;
    for (const x of stale) await call(`/users/${x.id}`, { method: 'DELETE' });
  }
  for (const u of Object.values(USERS)) {
    const existing = await (await call(`/users?exact=true&username=${encodeURIComponent(u.email)}`)).json() as Array<{ id: string }>;
    for (const x of existing) await call(`/users/${x.id}`, { method: 'DELETE' });
    await call('/users', { method: 'POST', body: JSON.stringify({
      username: u.email, email: u.email, firstName: u.first, lastName: u.last, enabled: true, emailVerified: true,
      // No required actions here (production users must set a password + enrol TOTP; see create-user.sh).
      requiredActions: [],
      attributes: 'customerId' in u ? { customer_id: [u.customerId] } : {},
      credentials: [
        { type: 'password', value: PASSWORD, temporary: false },
        // Staff must present an authenticator code (telus browser flow + API amr check): seed one, like an enrolled phone.
        ...(u.role && STAFF_ROLES_E2E.includes(u.role) && !NOT_PREENROLLED.includes(u.email) ? [{
          type: 'otp', userLabel: 'e2e authenticator',
          secretData: JSON.stringify({ value: STAFF_OTP_SECRET }),
          credentialData: JSON.stringify({ subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' }),
        }] : []),
      ],
    }) });
    const [created] = await (await call(`/users?exact=true&username=${encodeURIComponent(u.email)}`)).json() as Array<{ id: string; attributes?: Record<string, string[]> }>;
    if ('customerId' in u && created?.attributes?.['customer_id']?.[0] !== u.customerId) {
      throw new Error(`Keycloak dropped customer_id for ${u.email} — is the user profile in telus-realm.json loaded?`);
    }
    if (u.role) {
      const role = await (await call(`/roles/${u.role}`)).json();
      await call(`/users/${created!.id}/role-mappings/realm`, { method: 'POST', body: JSON.stringify([role]) });
    }
  }
}
