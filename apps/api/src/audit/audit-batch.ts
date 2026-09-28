import { createHash } from 'crypto';

/** One audit row in the exact text forms the database hashes (see audit_compute_hash in 001_init.sql). */
export interface AuditRow {
  id: string; actor_sub: string; actor_kind: string; action: string; reference_type: string | null; reference_id: string | null;
  before_value: string | null; after_value: string | null; ip: string | null; created_at: string; prev_hash: string | null; hash: string;
}

export interface BatchHeader {
  format: 'telus-audit-v1'; first_id: string; last_id: string; row_count: number; first_prev_hash: string | null; last_hash: string;
}

export const FORMAT = 'telus-audit-v1';
const ROW_KEYS: Array<keyof AuditRow> = ['id', 'actor_sub', 'actor_kind', 'action', 'reference_type', 'reference_id',
  'before_value', 'after_value', 'ip', 'created_at', 'prev_hash', 'hash'];

export const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** Recomputes a row's chain hash exactly as Postgres does. `ip` is not part of the hash (it is protected by the lock). */
export function rowHash(prev: string | null, r: AuditRow): string {
  return sha256hex([prev ?? '', r.actor_sub, r.actor_kind, r.action, r.reference_type ?? '', r.reference_id ?? '',
    r.before_value ?? '', r.after_value ?? '', r.created_at].join('|'));
}

/** Object key: zero-padded ids, so a lexical listing is chain order. */
export const objectKey = (prefix: string, first: string, last: string) =>
  `${prefix}${first.padStart(20, '0')}-${last.padStart(20, '0')}.ndjson`;

/** Deterministic NDJSON: the same rows always give the same bytes (so a retried upload can be recognised). */
export function encodeBatch(rows: AuditRow[]): { body: Buffer; header: BatchHeader } {
  if (rows.length === 0) throw new Error('empty batch');
  const header: BatchHeader = {
    format: FORMAT, first_id: rows[0]!.id, last_id: rows.at(-1)!.id, row_count: rows.length,
    first_prev_hash: rows[0]!.prev_hash, last_hash: rows.at(-1)!.hash,
  };
  const lines = [JSON.stringify(header), ...rows.map((r) => JSON.stringify(Object.fromEntries(ROW_KEYS.map((k) => [k, r[k]]))))];
  return { body: Buffer.from(lines.join('\n') + '\n', 'utf8'), header };
}

export function decodeBatch(body: Buffer): { header: BatchHeader; rows: AuditRow[] } {
  const lines = body.toString('utf8').split('\n').filter((l) => l.length > 0);
  const header = JSON.parse(lines[0] ?? '{}') as BatchHeader;
  if (header.format !== FORMAT) throw new Error(`unknown format ${String(header.format)}`);
  return { header, rows: lines.slice(1).map((l) => JSON.parse(l) as AuditRow) };
}

/**
 * Checks a run of rows: each links to the previous hash and its hash recomputes. `prev` is the hash the first row must
 * link to. Returns null when intact, else a description of the first problem.
 */
export function verifyChain(rows: AuditRow[], prev: string | null): string | null {
  for (const r of rows) {
    if (r.prev_hash !== prev) return `row ${r.id}: prev_hash does not link to the previous row`;
    if (rowHash(prev, r) !== r.hash) return `row ${r.id}: content does not match its hash`;
    prev = r.hash;
  }
  return null;
}

export function verifyBatch(body: Buffer, prev: string | null): { header: BatchHeader; rows: AuditRow[]; problem: string | null } {
  const { header, rows } = decodeBatch(body);
  const problem = rows.length !== header.row_count ? `header says ${header.row_count} rows, object has ${rows.length}`
    : rows[0]?.id !== header.first_id || rows.at(-1)?.id !== header.last_id ? 'header id range does not match the rows'
    : header.first_prev_hash !== prev ? 'does not continue the previous batch'
    : rows.at(-1)!.hash !== header.last_hash ? 'header last_hash does not match the rows'
    : verifyChain(rows, prev);
  return { header, rows, problem };
}
