// Demo only: applies migrations, loads demo data once and creates the demo logins in Keycloak. Safe to re-run.
const APP = process.env.APP_DIR ?? '/app';            // the API image's working directory
const { Pool } = require(require.resolve('pg', { paths: [APP] }));
const { migrate } = require(`${APP}/apps/api/dist/db/migrate`);

const OWNER = process.env.OWNER_DATABASE_URL;
const KC = process.env.KC_URL;                       // http://keycloak:8080
const PASSWORD = process.env.DEMO_PASSWORD;
const ALPHA = 'a1a1a1a1-0000-4000-8000-000000000001';
const BETA = 'b2b2b2b2-0000-4000-8000-000000000002';
const RULES = 'c0c0c0c0-0000-4000-8000-000000000001';

const USERS = [
  { email: 'admin@telus.test', role: 'super_admin', first: 'Sara', last: 'Admin' },
  { email: 'manager@telus.test', role: 'auction_manager', first: 'Mona', last: 'Manager' },
  { email: 'finance@telus.test', role: 'finance', first: 'Fay', last: 'Finance' },
  { email: 'viewonly@telus.test', role: 'view_only', first: 'Vera', last: 'Viewer' },
  { email: 'admin@alpha.test', role: 'customer_admin', customerId: ALPHA, first: 'Ali', last: 'Alpha' },
  { email: 'viewer@alpha.test', role: 'customer_viewer', customerId: ALPHA, first: 'Amal', last: 'Alpha' },
  { email: 'admin@beta.test', role: 'customer_admin', customerId: BETA, first: 'Basma', last: 'Beta' },
  { email: 'bidder@beta.test', role: 'customer_bidder', customerId: BETA, first: 'Bilal', last: 'Beta' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedDatabase() {
  console.log('migrations:', (await migrate(OWNER)).join(', ') || 'up to date');
  const db = new Pool({ connectionString: OWNER });
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    // Row-level security hides every customer unless the session acts as staff, so set that before looking.
    await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','demo-seed',true)");
    if ((await c.query('SELECT count(*)::int AS n FROM customers')).rows[0].n > 0) {
      await c.query('ROLLBACK');
      console.log('demo data already loaded');
      return;
    }
    await c.query(`
      INSERT INTO margin_rule_sets (id, name) VALUES ('${RULES}', 'Standard');
      INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin) VALUES
        ('${RULES}', 0, 1000, 10), ('${RULES}', 1000, 999999999, 25);
      INSERT INTO customers (id, company_name, contact_email, status, margin_rule_set_id) VALUES
        ('${ALPHA}', 'Alpha Trading LLC', 'ops@alpha.test', 'active', '${RULES}'),
        ('${BETA}', 'Beta Mobile FZE', 'ops@beta.test', 'active', '${RULES}');
      INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ('${ALPHA}', 500000), ('${BETA}', 500000);`);
    const lots = [
      ['L-001', 'iPhone 15 Pro 256GB — Grade A', 40, 2450],
      ['L-002', 'iPhone 14 128GB — Grade B', 60, 1350],
      ['L-003', 'Samsung Galaxy S24 Ultra 512GB — Grade A', 25, 2900],
      ['L-004', 'Samsung Galaxy A55 128GB — New', 120, 780],
      ['L-005', 'iPad Air M2 11" 128GB — Grade A', 30, 1900],
      ['L-006', 'Google Pixel 8 128GB — Grade B', 45, 950],
    ];
    const auctions = [
      // Live straight away (the scheduler opens it within a second); closes in 3 days.
      { number: 'AUC-DEMO-01', name: 'Live now — October handsets, Dubai stock', start: "clock_timestamp() - interval '1 minute'",
        close: "clock_timestamp() + interval '3 days'", visibility: 'full_price', lots },
      // Opens tomorrow: shows how customers see an upcoming auction.
      { number: 'AUC-DEMO-02', name: 'Upcoming — tablets and accessories', start: "clock_timestamp() + interval '1 day'",
        close: "clock_timestamp() + interval '4 days'", visibility: 'winning_losing_only', lots: lots.slice(4) },
    ];
    for (const a of auctions) {
      const { rows: [row] } = await c.query(
        `INSERT INTO auctions (number, name, status, start_at, close_at, bid_visibility)
         VALUES ($1, $2, 'scheduled', ${a.start}, ${a.close}, $3) RETURNING id`, [a.number, a.name, a.visibility]);
      for (const [no, desc, qty, price] of a.lots) {
        await c.query('INSERT INTO auction_lots (auction_id, lot_number, description, quantity, starting_price) VALUES ($1,$2,$3,$4,$5)',
          [row.id, no, desc, qty, price]);
      }
      await c.query('INSERT INTO auction_participants (auction_id, customer_id, is_allowed) VALUES ($1,$2,true), ($1,$3,true)', [row.id, ALPHA, BETA]);
    }
    await c.query('COMMIT');
    console.log('demo data loaded: 2 customers, 2 auctions');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
    await db.end();
  }
}

async function seedKeycloak() {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${KC}/realms/telus`)).ok) break; } catch { /* starting */ }
    if (i > 120) throw new Error('Keycloak did not start');
    if (i % 10 === 0) console.log('waiting for Keycloak…');
    await sleep(2000);
  }
  const tok = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_ADMIN, password: process.env.KC_ADMIN_PASSWORD }),
  });
  if (!tok.ok) throw new Error(`Keycloak admin login failed: ${tok.status}`);
  const { access_token } = await tok.json();
  const call = async (path, init = {}) => {
    const r = await fetch(`${KC}/admin/realms/telus${path}`, { ...init, headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' } });
    if (!r.ok) throw new Error(`Keycloak ${init.method ?? 'GET'} ${path} → ${r.status} ${await r.text()}`);
    return r;
  };
  for (const u of USERS) {
    const found = await (await call(`/users?exact=true&username=${encodeURIComponent(u.email)}`)).json();
    if (found.length) continue;
    await call('/users', { method: 'POST', body: JSON.stringify({
      username: u.email, email: u.email, firstName: u.first, lastName: u.last, enabled: true, emailVerified: true,
      attributes: u.customerId ? { customer_id: [u.customerId] } : {},
      credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    }) });
    const [created] = await (await call(`/users?exact=true&username=${encodeURIComponent(u.email)}`)).json();
    const role = await (await call(`/roles/${u.role}`)).json();
    await call(`/users/${created.id}/role-mappings/realm`, { method: 'POST', body: JSON.stringify([role]) });
    console.log(`login created: ${u.email} (${u.role})`);
  }
}

(async () => {
  await seedDatabase();
  await seedKeycloak();
  console.log('\nDemo ready → open http://localhost:3000');
})().catch((e) => { console.error(e); process.exit(1); });
