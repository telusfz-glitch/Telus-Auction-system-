import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { DbService } from '../db/db.service';
import { sha256hex, verifyBatch, verifyChain, type AuditRow } from './audit-batch';

export interface VerifyReport { objects: number; shippedRows: number; unshippedRows: number; problems: string[] }

const FIELDS: Array<keyof AuditRow> = ['actor_sub', 'actor_kind', 'action', 'reference_type', 'reference_id', 'before_value',
  'after_value', 'ip', 'created_at', 'prev_hash', 'hash'];

/**
 * Independent check of the audit trail:
 * 1. the locked copy on its own: every object intact (checksum), under COMPLIANCE retention, chained to the one before;
 * 2. the database against it: every shipped row still present and identical, nothing inserted into a shipped range;
 * 3. the not-yet-shipped tail of the database continues the shipped chain;
 * 4. every batch the database says it shipped is in the bucket, with the same checksum.
 */
export async function verifyAuditTrail(s3: S3Client, bucket: string, prefix: string, db: DbService): Promise<VerifyReport> {
  const problems: string[] = [];
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((o) => o.Key!).filter((k) => k.endsWith('.ndjson')));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  keys.sort();

  const recorded = new Map<string, string>(
    (await db.withSystem('audit-verify', (c) => c.query('SELECT object_key, sha256 FROM audit_shipments'))).rows.map((r) => [r.object_key, r.sha256]));

  let prev: string | null = null;
  let lastShippedId = '0';
  let shippedRows = 0;
  for (const key of keys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await obj.Body!.transformToByteArray());
    const sha = sha256hex(body);
    if (obj.Metadata?.['sha256'] !== sha) problems.push(`${key}: content does not match the checksum it was stored with`);
    if (recorded.has(key) && recorded.get(key) !== sha) problems.push(`${key}: differs from the checksum recorded in the database`);
    recorded.delete(key);
    // S3 reports the object's lock on every GET (needs s3:GetObjectRetention), so no extra call is needed.
    if (obj.ObjectLockMode !== 'COMPLIANCE' || !obj.ObjectLockRetainUntilDate) problems.push(`${key}: not under COMPLIANCE retention`);

    let batch: ReturnType<typeof verifyBatch>;
    try { batch = verifyBatch(body, prev); } catch (e) { problems.push(`${key}: unreadable (${(e as Error).message})`); continue; }
    if (batch.problem) problems.push(`${key}: ${batch.problem}`);
    prev = batch.header.last_hash;
    lastShippedId = batch.header.last_id;
    shippedRows += batch.rows.length;

    // The database's version of the same id range.
    const dbRows = (await db.withSystem('audit-verify', (c) => c.query<AuditRow>('SELECT * FROM audit_export($1, 10000)',
      [String(BigInt(batch.header.first_id) - 1n)]))).rows
      .map((r) => ({ ...r, id: String(r.id) })).filter((r) => BigInt(r.id) <= BigInt(batch.header.last_id));
    const byId = new Map(dbRows.map((r) => [r.id, r]));
    for (const r of batch.rows) {
      const d = byId.get(r.id);
      if (!d) { problems.push(`audit row ${r.id}: deleted from the database after it was shipped`); continue; }
      const changed = FIELDS.filter((f) => (d[f] ?? null) !== (r[f] ?? null));
      if (changed.length) problems.push(`audit row ${r.id}: changed in the database after it was shipped (${changed.join(', ')})`);
      byId.delete(r.id);
    }
    for (const id of byId.keys()) problems.push(`audit row ${id}: inserted into the database inside an already-shipped range`);
  }
  for (const key of recorded.keys()) problems.push(`${key}: recorded as shipped but missing from the bucket`);

  // The tail that has not been shipped yet must continue the shipped chain.
  let unshippedRows = 0;
  let after = lastShippedId;
  for (;;) {
    const rows = (await db.withSystem('audit-verify', (c) => c.query<AuditRow>('SELECT * FROM audit_export($1, 10000)', [after]))).rows
      .map((r) => ({ ...r, id: String(r.id) }));
    if (rows.length === 0) break;
    const problem = verifyChain(rows, prev);
    if (problem) { problems.push(`database (not yet shipped) ${problem}`); break; }
    prev = rows.at(-1)!.hash;
    after = rows.at(-1)!.id;
    unshippedRows += rows.length;
  }
  return { objects: keys.length, shippedRows, unshippedRows, problems };
}
