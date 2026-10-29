import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// migration-drift-gate.test.ts — v2.58.11 (independent audit
// 2.58.10, P1-4)
//
// The auditor found `prisma migrate status` FALSELY reporting
// "up to date" while two applied migrations' checksums had drifted
// from the shipped files — and NOTHING in the install/upgrade path
// forced the backup-first reconciliation before `migrate deploy`.
//
// THE CONTRACT pinned here (the exit-code protocol setup.sh and
// setup.bat now gate on):
//   • exit 0 — no drift (fresh install included: zero applied rows)
//   • exit 2 — DRIFT DETECTED, nothing written (report-only mode)
//   • exit 1 — operational error
//   • --confirm — ALWAYS writes a VACUUM INTO backup FIRST, then
//     rewrites ONLY the drifted checksums and re-reads to prove it
// All runs execute against a COPY of this worker's database — the
// real test DB is never touched by the spawned script.
// ═══════════════════════════════════════════════════════════════

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PrismaClient();
const tempFiles: string[] = [];

async function snapshotTo(target: string): Promise<void> {
  await db.$queryRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  tempFiles.push(target);
}

function runDriftTool(dbFile: string, args: string[] = []): { status: number | null; out: string } {
  const res = spawnSync(
    process.execPath,
    [join('scripts', 'fix-migration-drift.mjs'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, BGL_DRIFT_DB: dbFile } },
  );
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

afterAll(async () => {
  for (const f of tempFiles) rmSync(f, { force: true });
  await db.$disconnect();
});

describe('the drift tool’s exit-code protocol (what setup gates on)', () => {
  it('a FRESH install (no DB file yet) passes the gate — zero applied, zero drift', async () => {
    // the release package ships no database (v2.58.10 P0); setup.bat's
    // gate runs BEFORE migrate deploy creates it
    const missing = join(root, 'prisma', '.test-runs', `drift-missing-${Date.now()}.db`);
    const r = runDriftTool(missing);
    expect(r.status).toBe(0);
  }, 60_000);

  it('a freshly migrated database → exit 0, no drift', async () => {
    const copy = join(root, 'prisma', '.test-runs', `drift-clean-${Date.now()}.db`);
    await snapshotTo(copy);
    const r = runDriftTool(copy);
    expect(r.status).toBe(0);
    expect(r.out).toContain('drift');
  }, 120_000);

  it('a drifted checksum → report mode exits 2 WITHOUT writing', async () => {
    const copy = join(root, 'prisma', '.test-runs', `drift-bad-${Date.now()}.db`);
    await snapshotTo(copy);
    const probe = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    const victim = (await probe.$queryRawUnsafe(
      'SELECT migration_name, checksum FROM "_prisma_migrations" ORDER BY migration_name LIMIT 1',
    )) as Array<{ migration_name: string; checksum: string }>;
    expect(victim.length).toBeGreaterThan(0);
    await probe.$executeRawUnsafe(
      'UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      victim[0].migration_name,
    );
    await probe.$disconnect();

    const r = runDriftTool(copy); // report-only
    expect(r.status).toBe(2);
    expect(r.out).toContain(victim[0].migration_name);

    const check = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    const after = (await check.$queryRawUnsafe(
      'SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1',
      victim[0].migration_name,
    )) as Array<{ checksum: string }>;
    await check.$disconnect();
    expect(after[0].checksum).toBe('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'); // untouched in report mode
  }, 120_000);

  it('--confirm writes the backup FIRST, fixes exactly the drift, and proves it by re-reading', async () => {
    const copy = join(root, 'prisma', '.test-runs', `drift-fix-${Date.now()}.db`);
    await snapshotTo(copy);
    const probe = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    const victim = (await probe.$queryRawUnsafe(
      'SELECT migration_name, checksum FROM "_prisma_migrations" ORDER BY migration_name LIMIT 1',
    )) as Array<{ migration_name: string; checksum: string }>;
    await probe.$executeRawUnsafe(
      'UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2',
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      victim[0].migration_name,
    );
    await probe.$disconnect();

    const r = runDriftTool(copy, ['--confirm']);
    expect(r.status).toBe(0);

    // a backup file was created NEXT to the DB (pre-drift-fix-*.db)
    const dir = dirname(copy);
    const backups = readdirSync(dir).filter((n) => n.startsWith(`${basename(copy)}.pre-drift-fix-`));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(dir, backups[0]))).toBe(true);
    for (const b of backups) tempFiles.push(join(dir, b));

    // the checksum now matches the SHIPPED file hash
    const expected = createHash('sha256')
      .update(readFileSync(join(root, 'prisma', 'migrations', victim[0].migration_name, 'migration.sql')))
      .digest('hex');
    const check = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    const after = (await check.$queryRawUnsafe(
      'SELECT checksum FROM "_prisma_migrations" WHERE migration_name = $1',
      victim[0].migration_name,
    )) as Array<{ checksum: string }>;
    await check.$disconnect();
    expect(after[0].checksum).toBe(expected);
  }, 120_000);
});
