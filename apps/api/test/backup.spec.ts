import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { AuditService } from '../src/audit/audit.service';
import { BidsService } from '../src/bids/bids.service';
import type { Env } from '../src/config/env';
import { DbService } from '../src/db/db.service';
import { asStaff, custP, resetDb, staffP } from './db-helpers';

const ADMIN_URL = process.env.TEST_DB_ADMIN_URL;            // owner
const APP_URL = process.env.TEST_DB_APP_URL;
const SUPER_URL = process.env.TEST_DB_SUPERUSER_URL;        // e.g. postgres://postgres@localhost:5432/postgres (restore drill)
const BACKUP_URL = process.env.TEST_DB_BACKUP_URL;          // telus_backup role on the test database
const enabled = !!ADMIN_URL && !!APP_URL && !!SUPER_URL && !!BACKUP_URL;
if (!enabled && process.env.REQUIRE_BACKUP_TESTS) {
  it('backup tests are REQUIRED but TEST_DB_SUPERUSER_URL / TEST_DB_BACKUP_URL / DB env are not set', () => { throw new Error('env missing'); });
}

const SCRIPTS = resolve(__dirname, '../../../scripts/db');
const id = (n: number) => `bacb0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const run = (script: string, args: string[], env: Record<string, string>) => {
  try {
    return { code: 0, out: execFileSync(join(SCRIPTS, script), args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: any) {
    return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

(enabled ? describe : describe.skip)('Backups — dump as telus_backup, restore drill proves the copy (real Postgres)', () => {
  let admin: Pool, db: DbService, dir: string;
  const backup = () => run('backup.sh', [dir], { BACKUP_DB_URL: BACKUP_URL! });
  const drill = (file: string) => run('restore-drill.sh', [file, BACKUP_URL!], { DRILL_ADMIN_URL: SUPER_URL! });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'telus-backup-'));
    admin = await resetDb(ADMIN_URL!);
    await asStaff(admin, async (c) => {
      await c.query(`
        INSERT INTO customers (id, company_name, contact_email, status) VALUES ('${id(1)}','Backup Co','b@x.ae','active');
        INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ('${id(1)}', 100000000);
        INSERT INTO auctions (id, number, name, status, start_at, close_at, extension_enabled)
          VALUES ('${id(101)}','BK-1','Backup','live', now() - interval '1 hour', now() + interval '1 hour', false);
        INSERT INTO auction_participants (auction_id, customer_id, terms_accepted_at) VALUES ('${id(101)}','${id(1)}', now());
        INSERT INTO auction_lots (id, auction_id, lot_number, description, quantity, starting_price) VALUES ('${id(201)}','${id(101)}','1','lot',1,100);`);
    });
    db = new DbService({ DATABASE_URL: APP_URL } as Env);
    const bids = new BidsService(db, new AuditService());
    for (const amount of [100, 150, 200]) await bids.place(custP(id(1), 'customer_bidder', 'bk-bidder'), { lotId: id(201), amount, idempotencyKey: randomUUID() });
    await db.withPrincipal(staffP, (c) => new AuditService().record(c, { actor: staffP, action: 'backup.test', after: { ok: true } }));
  });
  afterAll(async () => { await db?.onModuleDestroy(); await admin?.end(); rmSync(dir, { recursive: true, force: true }); });

  it('a fresh backup restores, and every drill check passes — including row counts against the source', () => {
    const b = backup();
    expect(b.code).toBe(0);
    const file = b.out.trim();
    expect(readFileSync(`${file}.sha256`, 'utf8')).toContain(file.split('/').pop()!);
    const d = drill(file);
    expect(d.out).toContain('RESTORE DRILL PASSED');
    expect(d.out).toMatch(/ok {4}audit hash chain intact/);
    expect(d.out).toMatch(/ok {4}row counts match the source/);
    expect(d.code).toBe(0);
  });

  it('a damaged backup file is caught by its checksum before anything is restored', () => {
    const file = backup().out.trim();
    appendFileSync(file, 'x');
    const d = drill(file);
    expect(d.code).not.toBe(0);
    expect(d.out).not.toContain('restored into');
  });

  // The monthly AWS drill: newest backup from S3 → throwaway local server → every restore-drill check. initdb refuses
  // to run as root, so a root test runner hands the script to the postgres user.
  const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
  const canDrill = !!process.env.TEST_S3_ENDPOINT && (existsSync(join(PG_BIN, 'initdb')) || !!process.env.REQUIRE_BACKUP_TESTS);
  (canDrill ? describe : describe.skip)('scheduled drill (scripts/db/scheduled-drill.sh)', () => {
    const aws = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_S3: process.env.TEST_S3_ENDPOINT!,
      S3_FORCE_PATH_STYLE: '1', BACKUP_S3_SSE: 'AES256' };
    const bucket = `telus-drill-${Date.now()}`;
    const scheduled = (env: Record<string, string>) => {
      const vars = { ...aws, PG_BIN, TMPDIR: tmpdir(), ...env };
      const [cmd, args] = process.getuid?.() === 0
        ? ['runuser', ['-u', 'postgres', '--', 'env', `PATH=${process.env.PATH}`, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), join(SCRIPTS, 'scheduled-drill.sh')]]
        : [join(SCRIPTS, 'scheduled-drill.sh'), []];
      try {
        return { code: 0, out: execFileSync(cmd, args as string[], { env: { ...process.env, ...vars }, encoding: 'utf8', stdio: 'pipe' }) };
      } catch (e: any) {
        return { code: e.status as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };

    beforeAll(async () => {
      const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
      await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    });

    it('with no backup in the bucket the drill fails', () => {
      const d = scheduled({ DRILL_S3_URI: `s3://${bucket}/daily/` });
      expect(d.code).not.toBe(0);
      expect(d.out).toMatch(/no backups under/);
    });

    it('restores the newest backup from S3 into its own server and passes every check', () => {
      expect(run('backup.sh', [dir], { BACKUP_DB_URL: BACKUP_URL!, BACKUP_S3_URI: `s3://${bucket}/daily/`, ...aws }).code).toBe(0);
      const d = scheduled({ DRILL_S3_URI: `s3://${bucket}/daily/` });
      expect(d.out).toMatch(/newest backup: telus-\d{8}T\d{6}Z\.dump/);
      expect(d.out).toMatch(/ok {4}audit hash chain intact/);
      expect(d.out).toContain('RESTORE DRILL PASSED');
      expect(d.code).toBe(0);
    });

    it('a backup older than the limit fails the drill (the nightly job stopped)', () => {
      const d = scheduled({ DRILL_S3_URI: `s3://${bucket}/daily/`, DRILL_MAX_AGE_HOURS: '-1' });
      expect(d.code).toBe(1);
      expect(d.out).toMatch(/FAIL {2}newest backup is .* old/);
      expect(d.out).not.toContain('restored into');
    });
  });

  it('a backup of a tampered database fails the drill (audit chain), even though the file itself is intact', async () => {
    await admin.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await admin.query(`UPDATE audit_logs SET action = 'forged' WHERE id = (SELECT min(id) FROM audit_logs)`);
    await admin.query('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    const d = drill(backup().out.trim());
    expect(d.out).toMatch(/FAIL {2}audit hash chain intact/);
    expect(d.out).toContain('RESTORE DRILL FAILED');
    expect(d.code).toBe(1);
  });

  (process.env.TEST_S3_ENDPOINT ? it : it.skip)('with BACKUP_S3_URI the dump and its checksum go off-site and the local copies are removed', async () => {
    const { S3Client, CreateBucketCommand, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    const aws = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL_S3: process.env.TEST_S3_ENDPOINT!,
      S3_FORCE_PATH_STYLE: '1', BACKUP_S3_SSE: 'AES256' };
    const s3 = new S3Client({ region: 'us-east-1', endpoint: process.env.TEST_S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    const bucket = `telus-backups-${Date.now()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: true }));
    const b = run('backup.sh', [dir], { BACKUP_DB_URL: BACKUP_URL!, BACKUP_S3_URI: `s3://${bucket}/daily/`, ...aws });
    expect(b.code).toBe(0);
    const keys = ((await s3.send(new ListObjectsV2Command({ Bucket: bucket }))).Contents ?? []).map((o) => o.Key).sort();
    expect(keys).toEqual([expect.stringMatching(/^daily\/telus-\d{8}T\d{6}Z\.dump$/), expect.stringMatching(/\.dump\.sha256$/)]);
    expect(existsSync(b.out.trim())).toBe(false);
  });

  it('dumping as any role without BYPASSRLS is refused (FORCE row-level security would hide rows)', () => {
    const b = run('backup.sh', [dir], { BACKUP_DB_URL: ADMIN_URL! });
    expect(b.code).not.toBe(0);
    expect(b.out).toMatch(/row-level security/i);
  });
});
