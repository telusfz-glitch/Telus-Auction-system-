/**
 * `npm run audit:verify -w @telus/api`: checks the database's audit log against its write-once copy (see audit-verify.ts).
 * Uses the API's own environment (DATABASE_URL, AUDIT_SHIP_*). Exit code 0 = intact, 2 = problems found, 1 = could not run.
 */
import { loadEnv } from '../config/env';
import { DbService } from '../db/db.service';
import { makeS3 } from './audit-shipper.service';
import { verifyAuditTrail } from './audit-verify';

async function main() {
  const env = loadEnv();
  if (!env.AUDIT_SHIP_BUCKET) throw new Error('AUDIT_SHIP_BUCKET is not set');
  const db = new DbService(env);
  try {
    const r = await verifyAuditTrail(makeS3(env), env.AUDIT_SHIP_BUCKET, env.AUDIT_SHIP_PREFIX, db);
    console.log(`${r.objects} locked object(s), ${r.shippedRows} shipped row(s), ${r.unshippedRows} not yet shipped`);
    for (const p of r.problems) console.log(`PROBLEM: ${p}`);
    console.log(r.problems.length ? `${r.problems.length} problem(s) — investigate before trusting the audit log` : 'OK — the database matches its locked copy');
    process.exitCode = r.problems.length ? 2 : 0;
  } finally {
    await db.onModuleDestroy();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
