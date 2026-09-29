import { execFileSync } from 'child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
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

  it('a backup of a tampered database fails the drill (audit chain), even though the file itself is intact', async () => {
    await admin.query('ALTER TABLE audit_logs DISABLE TRIGGER USER');
    await admin.query(`UPDATE audit_logs SET action = 'forged' WHERE id = (SELECT min(id) FROM audit_logs)`);
    await admin.query('ALTER TABLE audit_logs ENABLE TRIGGER USER');
    const d = drill(backup().out.trim());
    expect(d.out).toMatch(/FAIL {2}audit hash chain intact/);
    expect(d.out).toContain('RESTORE DRILL FAILED');
    expect(d.code).toBe(1);
  });

  it('dumping as any role without BYPASSRLS is refused (FORCE row-level security would hide rows)', () => {
    const b = run('backup.sh', [dir], { BACKUP_DB_URL: ADMIN_URL! });
    expect(b.code).not.toBe(0);
    expect(b.out).toMatch(/row-level security/i);
  });
});
