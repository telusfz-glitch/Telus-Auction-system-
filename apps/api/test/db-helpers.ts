import { Pool, type PoolClient } from 'pg';
import type { Principal } from '../src/auth/principal';
import { migrate } from '../src/db/migrate';

/** Drops and rebuilds the schema. Refuses unless the database name contains "test". */
export async function resetDb(adminUrl: string): Promise<Pool> {
  const dbName = new URL(adminUrl).pathname.replace('/', '');
  if (!/test/i.test(dbName)) throw new Error(`Refusing to run destructive DB tests against "${dbName}"`);
  const admin = new Pool({ connectionString: adminUrl });
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(adminUrl);
  return admin;
}

/** Runs seed SQL as the OWNER role, inside a staff RLS context — the owner is NOT a superuser, so FORCE'd RLS applies. */
export async function asStaff(admin: Pool, fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const c = await admin.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.role','staff',true), set_config('app.user_sub','seed',true)");
    await fn(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

export const custP = (customerId: string, customerRole: string, sub: string): Principal =>
  ({ sub, username: sub, kind: 'customer', roles: [customerRole], customerId, customerRole });
export const staffP: Principal = { sub: 'staff-1', username: 'staff', kind: 'staff', roles: ['super_admin'], customerId: null, customerRole: null };

/** Test-only clock control: moves an auction's close time as the OWNER with no RLS context. Staff are not allowed
 *  to shorten a live auction (auctions_staff_guard), and `auctions` has no FORCE'd RLS, so this bypasses both. */
export async function setCloseIn(admin: Pool, auctionId: string, interval: string): Promise<void> {
  await admin.query('UPDATE auctions SET close_at = clock_timestamp() + $2::interval WHERE id = $1', [auctionId, interval]);
}
