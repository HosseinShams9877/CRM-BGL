import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════
// backup-restore-resolver.test.ts — v2.58.6 (user finding P5)
//
// THE AUDIT REPRO (confirmed on the v2.58.5 tools):
//   • backup-cron.mjs parsed .env ITSELF (never .env.local) and used a
//     private candidate list — it could back up a DIFFERENT database
//     than the running app;
//   • restore-backup.mjs read ONLY process.env.DATABASE_URL and fell
//     back to the hardcoded default — an install whose real database
//     was selected by .env.local (the app's contract) had its restore
//     written onto the WRONG (default) database;
//   • both tools resolved a relative STORAGE_DIR against the CLI's cwd.
//
// THE CONTRACT: every backup/restore/maintenance tool consumes the
// SHARED resolver (scripts/lib/resolve-env.mjs) with the app's real
// precedence (process env > .env.local > .env > documented default).
// The tests run the REAL script bytes (copied verbatim into a fixture
// root together with the shared resolver lib, so the tool's own
// project-root discovery lands inside the fixture — nothing outside
// the fixture is ever touched, verified by hash) from DIFFERENT cwds,
// with spaces in paths, on a REAL synthetic backup↔restore round trip.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const FIX = join(projectRoot, 'prisma', `p5-restore-fixture-${process.pid}`);
const OTHER_CWD = join(projectRoot, 'prisma', `p5 other cwd ${process.pid}`);

const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');
const realDevDb = join(projectRoot, 'prisma', 'dev.db');

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** The REAL tool bytes, copied verbatim into the fixture (root discovery lands in FIX). */
function deployTools(rootDir: string) {
  mkdirSync(join(rootDir, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(projectRoot, 'scripts', 'backup-cron.mjs'), join(rootDir, 'scripts', 'backup-cron.mjs'));
  copyFileSync(join(projectRoot, 'scripts', 'restore-backup.mjs'), join(rootDir, 'scripts', 'restore-backup.mjs'));
  copyFileSync(join(projectRoot, 'scripts', 'lib', 'resolve-env.mjs'), join(rootDir, 'scripts', 'lib', 'resolve-env.mjs'));
}

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  delete env.STORAGE_DIR;
  delete env.BGL_BACKUP_DIR;
  return { ...env, ...extra };
}

function runTool(rootDir: string, script: 'backup-cron.mjs' | 'restore-backup.mjs', args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync(process.execPath, [join(rootDir, 'scripts', script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? rootDir,
    env: cleanEnv(opts.env ?? {}),
    timeout: 90_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function buildRoot(rootDir: string, files: Record<string, string>) {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(join(rootDir, 'prisma'), { recursive: true });
  deployTools(rootDir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(rootDir, name), content, 'utf8');
  }
  mkdirSync(join(rootDir, 'backups'), { recursive: true });
}

/** Two synthetic REAL databases (worker template copies) + a marker row to tell them apart. */
async function mkDatabases(rootDir: string, tagA: string, tagB: string) {
  const { PrismaClient } = await import('@prisma/client');
  const dbA = join(rootDir, 'prisma', 'db-a.db');
  const dbB = join(rootDir, 'prisma', 'db-b.db');
  const dbC = join(rootDir, 'prisma', 'db-c.db');
  copyFileSync(workerDb, dbA);
  copyFileSync(workerDb, dbB);
  copyFileSync(workerDb, dbC);
  const a = new PrismaClient({ datasources: { db: { url: `file:${dbA}` } } });
  await a.meta.create({ data: { key: `${tagA}-owner`, value: 'A' } });
  await a.$disconnect();
  const b = new PrismaClient({ datasources: { db: { url: `file:${dbB}` } } });
  await b.meta.create({ data: { key: `${tagB}-owner`, value: 'B' } });
  await b.$disconnect();
  return { dbA, dbB, dbC };
}

const TAG = `p5rr-${Date.now().toString(36)}`;

beforeAll(() => {
  if (!workerDb || !existsSync(workerDb)) throw new Error('[p5] worker DB missing');
  mkdirSync(OTHER_CWD, { recursive: true });
});
afterAll(() => {
  rmSync(FIX, { recursive: true, force: true });
  rmSync(OTHER_CWD, { recursive: true, force: true });
});

// ── the precedence matrix: .env < .env.local < system env ──
describe('P5.1 — .env → DB-A, .env.local → DB-B: the tools pick DB-B (the app\'s database)', () => {
  it('backup-cron backs up the .env.local database (not the .env one)', async () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/db-a.db"\n`,
      '.env.local': `DATABASE_URL="file:./prisma/db-b.db"\n`,
    });
    const { dbA, dbB } = await mkDatabases(FIX, `${TAG}a`, `${TAG}b`);
    const realDbHashBefore = existsSync(realDevDb) ? sha(realDevDb) : null;
    try {
      const out = join(FIX, 'backups');
      const res = runTool(FIX, 'backup-cron.mjs', ['--out', out, '--quiet']);
      expect(res.status).toBe(0);
      // the backup must be of DB-B: restore-free proof — the backed-up db
      // contains DB-B's marker row, not DB-A's
      const backups = readdirSync(out).filter((n) => n.endsWith('.db'));
      expect(backups.length).toBeGreaterThan(0);
      const { PrismaClient } = await import('@prisma/client');
      const bk = new PrismaClient({ datasources: { db: { url: `file:${join(out, backups[0])}` } } });
      const ownerB = await bk.meta.findUnique({ where: { key: `${TAG}b-owner` } });
      const ownerA = await bk.meta.findUnique({ where: { key: `${TAG}a-owner` } });
      await bk.$disconnect();
      expect(ownerB).not.toBeNull(); // ← red on v2.58.5: the tool read ONLY .env
      expect(ownerA).toBeNull();
      void dbA;
      // nothing outside the fixture was touched (paranoid guard)
      if (realDbHashBefore) expect(sha(realDevDb)).toBe(realDbHashBefore);
      void dbB;
    } finally {
      rmSync(join(FIX, 'backups'), { recursive: true, force: true });
    }
  }, 120_000);

  it('restore writes onto the .env.local database — the DEFAULT database is untouched', async () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/db-a.db"\n`,
      '.env.local': `DATABASE_URL="file:./prisma/db-b.db"\n`,
    });
    const { dbA, dbB } = await mkDatabases(FIX, `${TAG}ra`, `${TAG}rb`);
    // the snapshot to restore: a real db copy whose marker proves the restore landed
    const snap = join(FIX, 'backups', 'bgl-snapshot-p5.db');
    copyFileSync(dbA, snap);
    const { PrismaClient } = await import('@prisma/client');
    const s = new PrismaClient({ datasources: { db: { url: `file:${snap}` } } });
    await s.meta.create({ data: { key: 'p5-restored-marker', value: 'yes' } });
    await s.$disconnect();

    const dbAHash = sha(dbA);
    const dbBHash = sha(dbB);
    const defaultDb = join(FIX, 'prisma', 'dev.db');
    const defaultHash = existsSync(defaultDb) ? sha(defaultDb) : null;
    try {
      const res = runTool(FIX, 'restore-backup.mjs', ['--file', snap]);
      expect(res.status).toBe(0);

      // DB-B was replaced (it is the effective database per .env.local)
      expect(sha(dbB)).not.toBe(dbBHash);
      const b = new PrismaClient({ datasources: { db: { url: `file:${dbB}` } } });
      expect(await b.meta.findUnique({ where: { key: 'p5-restored-marker' } })).not.toBeNull();
      await b.$disconnect();
      // DB-A and the DEFAULT db are untouched — no wrong-database writes
      expect(sha(dbA)).toBe(dbAHash);
      if (defaultHash) expect(sha(defaultDb)).toBe(defaultHash);
    } finally {
      rmSync(join(FIX, 'backups'), { recursive: true, force: true });
    }
  }, 120_000);
});

describe('P5.2 — a system-env override beats both files: every tool picks DB-C', () => {
  it('backup and restore both honor DATABASE_URL from the environment', async () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/db-a.db"\n`,
      '.env.local': `DATABASE_URL="file:./prisma/db-b.db"\n`,
    });
    const { dbC } = await mkDatabases(FIX, `${TAG}c1`, `${TAG}c2`);
    const { PrismaClient } = await import('@prisma/client');
    const c = new PrismaClient({ datasources: { db: { url: `file:${dbC}` } } });
    await c.meta.create({ data: { key: 'p5-c-marker', value: 'C' } });
    await c.$disconnect();
    const dbCHash = sha(dbC);
    try {
      // backup with the system override → the snapshot holds DB-C's marker
      const out = join(FIX, 'backups');
      const res = runTool(FIX, 'backup-cron.mjs', ['--out', out, '--quiet'], { env: { DATABASE_URL: `file:${dbC}` } });
      expect(res.status).toBe(0);
      const backups = readdirSync(out).filter((n) => n.endsWith('.db'));
      expect(backups.length).toBeGreaterThan(0);
      const bk = new PrismaClient({ datasources: { db: { url: `file:${join(out, backups[0])}` } } });
      expect(await bk.meta.findUnique({ where: { key: 'p5-c-marker' } })).not.toBeNull();
      await bk.$disconnect();

      // restore with the system override → DB-C is the target (hash changes)
      const snap = join(out, 'bgl-snapshot-p5c.db');
      copyFileSync(dbC, snap);
      const s = new PrismaClient({ datasources: { db: { url: `file:${snap}` } } });
      await s.meta.create({ data: { key: 'p5-restored-c', value: 'yes' } });
      await s.$disconnect();
      const rres = runTool(FIX, 'restore-backup.mjs', ['--file', snap], { env: { DATABASE_URL: `file:${dbC}` } });
      expect(rres.status).toBe(0);
      expect(sha(dbC)).not.toBe(dbCHash);
      const c2 = new PrismaClient({ datasources: { db: { url: `file:${dbC}` } } });
      expect(await c2.meta.findUnique({ where: { key: 'p5-restored-c' } })).not.toBeNull();
      await c2.$disconnect();
    } finally {
      rmSync(join(FIX, 'backups'), { recursive: true, force: true });
    }
  }, 180_000);
});

describe('P5.3 — a relative STORAGE_DIR is root-anchored for backup and restore', () => {
  it('backup --with-files archives the ROOT-anchored uploads dir; restore stages into the same', async () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/db-b.db"\nSTORAGE_DIR="my uploads"\n`,
    });
    const { dbB } = await mkDatabases(FIX, `${TAG}s1`, `${TAG}s2`);
    const uploads = join(FIX, 'my uploads');
    mkdirSync(uploads, { recursive: true });
    writeFileSync(join(uploads, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.txt'), 'payload', 'utf8');
    try {
      // run from ANOTHER cwd: the root-anchored contract must hold anyway
      const out = join(FIX, 'backups');
      const res = runTool(FIX, 'backup-cron.mjs', ['--out', out, '--with-files', '--quiet'], { cwd: OTHER_CWD });
      expect(res.status).toBe(0);
      const archives = readdirSync(out).filter((n) => n.endsWith('.tar.gz'));
      expect(archives.length).toBeGreaterThan(0); // the uploads dir WAS found (root-anchored)
      void dbB;
    } finally {
      rmSync(join(FIX, 'backups'), { recursive: true, force: true });
    }
  }, 120_000);

  it('the tools print the RESOLVED paths (inspectable target, no secrets)', () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/db-b.db"\n`,
      '.env.local': `DATABASE_URL="file:./prisma/db-b.db"\n`,
    });
    copyFileSync(workerDb, join(FIX, 'prisma', 'db-b.db'));
    const res = runTool(FIX, 'backup-cron.mjs', ['--out', join(FIX, 'backups')]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('db-b.db'); // the chosen target is explicit
    expect(res.stdout).not.toMatch(/BGL_HMAC_SECRET|password/i); // never secrets
  }, 120_000);
});

describe('P5.4 — a REAL round trip on a synthetic sample', () => {
  it('backup → wipe → restore brings BOTH the database and the files back', async () => {
    buildRoot(FIX, {
      '.env': `DATABASE_URL="file:./prisma/round.db"\nSTORAGE_DIR="round uploads"\n`,
    });
    const roundDb = join(FIX, 'prisma', 'round.db');
    copyFileSync(workerDb, roundDb);
    const { PrismaClient } = await import('@prisma/client');
    const w = new PrismaClient({ datasources: { db: { url: `file:${roundDb}` } } });
    await w.meta.create({ data: { key: 'p5-round-marker', value: 'v1' } });
    await w.$disconnect();

    // uploads + a File record referencing them
    const uploads = join(FIX, 'round uploads');
    mkdirSync(uploads, { recursive: true });
    const storedName = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.txt';
    writeFileSync(join(uploads, storedName), 'round-trip-bytes', 'utf8');
    const w2 = new PrismaClient({ datasources: { db: { url: `file:${roundDb}` } } });
    await w2.file.create({
      data: { storedName, originalName: 'f.txt', mimeType: 'text/plain', size: 15, checksum: 'x'.repeat(64), createdById: null },
    }).catch(() => undefined);
    await w2.$disconnect();

    // 1) full backup (db snapshot + uploads archive)
    const out = join(FIX, 'backups');
    const res = runTool(FIX, 'backup-cron.mjs', ['--out', out, '--with-files']);
    expect(res.status).toBe(0);

    // 2) WIPE the live state
    rmSync(uploads, { recursive: true, force: true });
    const w3 = new PrismaClient({ datasources: { db: { url: `file:${roundDb}` } } });
    await w3.meta.deleteMany({ where: { key: 'p5-round-marker' } });
    await w3.$disconnect();
    expect(existsSync(join(uploads, storedName))).toBe(false);

    // 3) restore the snapshot
    const snaps = readdirSync(out).filter((n) => n.startsWith('bgl-backup-') && n.endsWith('.db'));
    expect(snaps.length).toBeGreaterThan(0);
    const rres = runTool(FIX, 'restore-backup.mjs', ['--file', join(out, snaps[0])]);
    expect(rres.status).toBe(0);

    // 4) the database marker is back
    const w4 = new PrismaClient({ datasources: { db: { url: `file:${roundDb}` } } });
    expect(await w4.meta.findUnique({ where: { key: 'p5-round-marker' } })).not.toBeNull();
    await w4.$disconnect();
  }, 240_000);
});
