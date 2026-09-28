import { Injectable } from '@nestjs/common';
import { isIP } from 'net';
import type { PoolClient } from 'pg';
import type { Principal } from '../auth/principal';

export interface AuditEntry {
  actor: Principal;
  action: string;
  referenceType?: string;
  referenceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/** Writes inside the caller's transaction, so a rolled-back action leaves no orphan audit row.
 *  The DB itself makes audit_logs append-only and hash-chained (see migration). */
@Injectable()
export class AuditService {
  async record(client: PoolClient, e: AuditEntry): Promise<void> {
    await client.query(
      `INSERT INTO audit_logs (actor_sub, actor_kind, action, reference_type, reference_id, before_value, after_value, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        e.actor.sub, e.actor.kind, e.action, e.referenceType ?? null, e.referenceId ?? null,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.ip && isIP(e.ip) ? e.ip : null,
      ],
    );
  }
}
