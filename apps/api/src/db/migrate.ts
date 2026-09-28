import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

/** Runs db/migrations/*.sql in order as the OWNER role, each in its own transaction. */
export async function migrate(ownerUrl: string, dir = join(__dirname, '../../db/migrations')): Promise<string[]> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module) {
  migrate(process.env.OWNER_DATABASE_URL ?? '')
    .then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'nothing to apply'))
    .catch((e) => { console.error(e); process.exit(1); });
}
