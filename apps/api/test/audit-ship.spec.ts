import {
  CreateBucketCommand, DeleteObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import type { Pool } from 'pg';
import { verifyAuditTrail } from '../src/audit/audit-verify';
import { AuditShipperService } from '../src/audit/audit-shipper.service';
import { AuditService } from '../src/audit/audit.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { custP, resetDb, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;
const APP_URL = process.env.TEST_DB_APP_URL;
const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT;          // an S3-compatible server with Object Lock (CI: moto_server)
const enabled = !!ADMIN_URL && !!APP_URL && !!S3_ENDPOINT;
if (!enabled && process.env.REQUIRE_S3_TESTS) {
  it('S3 tests are REQUIRED but TEST_S3_ENDPOINT / DB env are not set', () => { throw new Error('env missing'); });
}

(enabled ? describe : describe.skip)('Audit shipping to write-once storage (real Postgres, S3 Object Lock)', () => {
  let admin: Pool, db: DbService, s3: S3Client, audit: AuditService;
  const bucket = `telus-audit-${Date.now()}`;
  const env = (over: Partial<Env> = {}) => ({
    DATABASE_URL: APP_URL, AUDIT_SHIP_BUCKET: bucket, AUDIT_SHIP_PREFIX: 'audit/', AUDIT_SHIP_REGION: 'us-east-1',
    AUDIT_SHIP_ENDPOINT: S3_ENDPOINT, AUDIT_SHIP_RETENTION_DAYS: 1, AUDIT_SHIP_BATCH: 3, ...over,
  }) as Env;
  let shipper: AuditShipperService;
  const write = (n: number, tag: string) => db.withPrincipal(staffP, async (c) => {
    for (let i = 0; i < n; i++) await audit.record(c, { actor: staffP, action: `test.${tag}`, referenceId: `${tag}-${i}`, after: { i, note: 'ünïcødé ✓' }, ip: '10.0.0.7' });
  });
  const verify = () => verifyAuditTrail(s3, bucket, 'audit/', db);
  const ids = async () => (await admin.query('SELECT id FROM audit_logs ORDER BY id')).rows.map((r) => String(r.id));
  /** audit_shipments is FORCE'd RLS: even its owner reads it only as staff (or the system). */
  const shipments = async (sql: string) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.role', 'staff', true)");
      return (await c.query(sql)).rows;
    } finally { await c.query('ROLLBACK'); c.release(); }
  };
  const keys = async () => (await shipments('SELECT object_key FROM audit_shipments ORDER BY id')).map((r) => r.object_key as string);
  const shipAll = async () => { let n = 0, k: number; while ((k = await shipper.shipBatch()) > 0) n += k; return n; };

  beforeAll(async () => {
    Object.assign(process.env, { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' });
    admin = await resetDb(ADMIN_URL!);
    db = new DbService(env());
    audit = new AuditService();
    shipper = new AuditShipperService(env(), db);
    s3 = new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true });
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
  });
  afterAll(async () => { await db?.onModuleDestroy(); await admin?.end(); });

  it('the export and record functions refuse every non-system context', async () => {
    for (const sql of ['SELECT * FROM audit_export(NULL, 10)', "SELECT audit_record_shipment(1, 1, 1, NULL, 'x', 'k', 's', now())"]) {
      await expect(db.withPrincipal(staffP, (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
      await expect(db.withPrincipal(custP('11111111-1111-4111-8111-111111111111', 'customer_admin', 'x'), (c) => c.query(sql))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(admin.query('DELETE FROM audit_shipments')).resolves.toBeDefined();   // (empty; the trigger fires per row)
  });

  it('ships in chained batches under COMPLIANCE retention; the verifier finds the database and the copy identical', async () => {
    await write(7, 'a');
    expect(await shipAll()).toBe(7);                                   // batches of 3 → 3 objects
    const r = await verify();
    expect(r).toMatchObject({ objects: 3, shippedRows: 7, unshippedRows: 0, problems: [] });
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: (await keys())[0] }));
    expect(head.ObjectLockMode).toBe('COMPLIANCE');
    expect(head.ObjectLockRetainUntilDate!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const all = await ids();                                          // ids may have gaps; batches follow row order
    const recorded = await shipments('SELECT first_id, last_id, row_count FROM audit_shipments ORDER BY id');
    expect(recorded.map((x) => `${x.first_id}-${x.last_id}:${x.row_count}`))
      .toEqual([`${all[0]}-${all[2]}:3`, `${all[3]}-${all[5]}:3`, `${all[6]}-${all[6]}:1`]);
    expect((await keys())[0]).toBe(`audit/${all[0]!.padStart(20, '0')}-${all[2]!.padStart(20, '0')}.ndjson`);
    await admin.query('ALTER TABLE audit_shipments NO FORCE ROW LEVEL SECURITY');       // even with RLS lifted by the owner…
    await expect(admin.query('UPDATE audit_shipments SET sha256 = $1', ['x'])).rejects.toThrow(/append-only/);
    await admin.query('ALTER TABLE audit_shipments FORCE ROW LEVEL SECURITY');
  });

  it('a locked batch cannot be deleted or overwritten, even by the bucket owner', async () => {
    const Key = (await keys())[0]!;
    const v = (await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: Key }))).Versions![0]!;
    await expect(s3.send(new DeleteObjectCommand({ Bucket: bucket, Key, VersionId: v.VersionId }))).rejects.toMatchObject({ name: 'AccessDenied' });
    await expect(s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'forged', IfNoneMatch: '*' }))).rejects.toMatchObject({ name: 'PreconditionFailed' });
  });

  it('new rows are picked up where shipping stopped; unshipped rows are checked against the shipped chain', async () => {
    await write(2, 'b');
    expect(await verify()).toMatchObject({ unshippedRows: 2, problems: [] });
    expect(await shipAll()).toBe(2);
    expect(await verify()).toMatchObject({ objects: 4, shippedRows: 9, unshippedRows: 0, problems: [] });
  });

  it('a crash between upload and record is recovered: the identical object is recognised, not duplicated', async () => {
    await write(1, 'c');
    expect(await shipper.shipBatch()).toBe(1);
    // Forget the record, as if the process died after the upload.
    await admin.query('ALTER TABLE audit_shipments DISABLE TRIGGER audit_shipments_no_update, NO FORCE ROW LEVEL SECURITY');
    expect((await admin.query('DELETE FROM audit_shipments WHERE id = (SELECT max(id) FROM audit_shipments)')).rowCount).toBe(1);
    await admin.query('ALTER TABLE audit_shipments ENABLE TRIGGER audit_shipments_no_update, FORCE ROW LEVEL SECURITY');
    expect(await shipper.shipBatch()).toBe(1);
    expect(await verify()).toMatchObject({ objects: 5, shippedRows: 10, problems: [] });
  });

  it('two shippers at once never ship the same rows twice', async () => {
    await write(6, 'd');
    const other = new AuditShipperService(env(), db);
    const [x, y] = await Promise.all([shipAll(), (async () => { let n = 0, k: number; while ((k = await other.shipBatch()) > 0) n += k; return n; })()]);
    await shipAll();                                                  // whatever the loser skipped while locked out
    expect(x + y).toBeLessThanOrEqual(6);
    expect(await verify()).toMatchObject({ shippedRows: 16, unshippedRows: 0, problems: [] });
    expect((await shipments('SELECT sum(row_count)::int AS n FROM audit_shipments'))[0].n).toBe(16);
  });

  it('a database owner who rewrites history — even re-computing the whole chain — is caught by the locked copy', async () => {
    // The attacker: drops the append-only guard, edits a shipped row, and re-chains everything after it so the
    // database's own check (verify_audit_chain) passes again.
    await admin.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    const [, second, third, , fifth, sixth] = await ids();
    await admin.query(`UPDATE audit_logs SET after_value = '{"i": 1, "note": "forged"}' WHERE id = $1`, [second]);
    await admin.query('DELETE FROM audit_logs WHERE id = $1', [fifth]);
    await admin.query(`DO $$ DECLARE r audit_logs; prev text := NULL; BEGIN
        FOR r IN SELECT * FROM audit_logs ORDER BY id LOOP
          UPDATE audit_logs SET prev_hash = prev, hash = audit_compute_hash(prev, r) WHERE id = r.id RETURNING hash INTO prev;
        END LOOP; END $$`);
    await admin.query('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    expect((await admin.query('SELECT verify_audit_chain() AS broken')).rows[0].broken).toBeNull();   // fooled

    const r = await verify();
    expect(r.problems).toEqual(expect.arrayContaining([
      `audit row ${second}: changed in the database after it was shipped (after_value, hash)`,
      `audit row ${third}: changed in the database after it was shipped (prev_hash, hash)`,   // re-chained
      `audit row ${fifth}: deleted from the database after it was shipped`,
      `audit row ${sixth}: changed in the database after it was shipped (prev_hash, hash)`,
    ]));
    expect(r.problems.filter((p) => /retention|checksum|bucket/.test(p))).toEqual([]);   // the copy itself is untouched
  });

  it('the shipper refuses to copy a broken chain into the locked store', async () => {
    await write(1, 'e');
    await admin.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await admin.query(`UPDATE audit_logs SET action = 'forged' WHERE id = (SELECT max(id) FROM audit_logs)`);
    await admin.query('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    const before = (await shipments('SELECT count(*)::int AS n FROM audit_shipments'))[0].n;
    await expect(shipper.shipBatch()).rejects.toThrow('AUDIT_CHAIN_BROKEN');
    expect((await shipments('SELECT count(*)::int AS n FROM audit_shipments'))[0].n).toBe(before);
  });
});
