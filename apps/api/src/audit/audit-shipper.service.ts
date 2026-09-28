import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DbService } from '../db/db.service';
import { encodeBatch, objectKey, sha256hex, verifyChain, type AuditRow } from './audit-batch';

export const makeS3 = (env: Env) => new S3Client({
  region: env.AUDIT_SHIP_REGION,
  ...(env.AUDIT_SHIP_ENDPOINT ? { endpoint: env.AUDIT_SHIP_ENDPOINT, forcePathStyle: true } : {}),
  // Credentials: the AWS default chain (instance/task role, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
});

/**
 * Copies the audit log, in hash-chained batches, to an S3 bucket with Object Lock. Each object is written with COMPLIANCE
 * retention (nobody can shorten it, delete the object or overwrite that version before AUDIT_SHIP_RETENTION_DAYS), then
 * recorded in audit_shipments. One shipper at a time across instances (advisory lock). A crash between upload and record
 * is harmless: the batch is rebuilt byte-for-byte, found already stored with the same checksum, and recorded.
 */
@Injectable()
export class AuditShipperService {
  private readonly logger = new Logger('AuditShipper');
  private readonly s3?: S3Client;

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: DbService) {
    if (env.AUDIT_SHIP_BUCKET) this.s3 = makeS3(env);
  }

  get enabled(): boolean { return !!this.s3; }

  /** Ships at most one batch. Returns the number of rows shipped (0 = nothing to do, or another instance is shipping). */
  async shipBatch(): Promise<number> {
    if (!this.s3) return 0;
    return this.db.withSystem('audit-ship', async (c) => {
      if (!(await c.query('SELECT pg_try_advisory_xact_lock(727003) AS ok')).rows[0].ok) return 0;
      const rows = (await c.query<AuditRow>('SELECT * FROM audit_export(NULL, $1)', [this.env.AUDIT_SHIP_BATCH])).rows
        .map((r) => ({ ...r, id: String(r.id) }));
      if (rows.length === 0) return 0;
      // Never copy a broken chain as if it were good: that would launder tampering into the locked copy.
      const problem = verifyChain(rows, rows[0]!.prev_hash);
      if (problem) {
        this.logger.error(`audit chain broken, shipping stopped: ${problem}`);
        throw new Error('AUDIT_CHAIN_BROKEN');
      }
      const { body, header } = encodeBatch(rows);
      const key = objectKey(this.env.AUDIT_SHIP_PREFIX, header.first_id, header.last_id);
      const sha = sha256hex(body);
      const retainUntil = new Date(Date.now() + this.env.AUDIT_SHIP_RETENTION_DAYS * 86_400_000);
      await this.put(key, body, sha, retainUntil);
      await c.query('SELECT audit_record_shipment($1, $2, $3, $4, $5, $6, $7, $8)',
        [header.first_id, header.last_id, header.row_count, header.first_prev_hash, header.last_hash, key, sha, retainUntil]);
      this.logger.log(`shipped audit rows ${header.first_id}–${header.last_id} (${rows.length}) to ${key}`);
      return rows.length;
    });
  }

  private async put(key: string, body: Buffer, sha: string, retainUntil: Date): Promise<void> {
    const Bucket = this.env.AUDIT_SHIP_BUCKET!;
    const existing = await this.s3!.send(new HeadObjectCommand({ Bucket, Key: key })).catch((e: unknown) => {
      if (e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404) return null;
      throw e;
    });
    if (existing) {
      // Stored by an earlier attempt that crashed before recording it: accept only if it is byte-identical.
      const got = Buffer.from(await (await this.s3!.send(new GetObjectCommand({ Bucket, Key: key }))).Body!.transformToByteArray());
      if (sha256hex(got) !== sha) throw new Error(`AUDIT_OBJECT_CONFLICT: ${key} exists with different content`);
      return;
    }
    await this.s3!.send(new PutObjectCommand({
      Bucket, Key: key, Body: body, ContentType: 'application/x-ndjson',
      ChecksumAlgorithm: 'SHA256', ChecksumSHA256: Buffer.from(sha, 'hex').toString('base64'),   // Object Lock requires a checksum
      ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retainUntil,
      IfNoneMatch: '*',
      Metadata: { sha256: sha },
    }));
  }
}
