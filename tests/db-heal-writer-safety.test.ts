import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// db-heal-writer-safety.test.ts — v2.58.5 (user finding R6)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 script):
//   • "writer is quiet" was proven by ROW COUNTS over six tables — an
//     UPDATE, a change in ANY other table, or a commit after the last
//     check was invisible; the swap could then promote a stale file
//     and exit 0 (false success);
//   • a failed .env fix also exited 0.
//
// THE CONTRACT (in-process healDoubledDatabase + deterministic test
// seams that place a commit EXACTLY inside the guarded windows):
//   • a commit DURING the snapshot → retry, never a stale promotion;
//   • an UPDATE without a row-count change (Meta value flip) while
//     transferring → controlled stop (no false success, source intact);
//   • a change in a table OUTSIDE the six-table fingerprint
//     (SalesDocumentFinance — a financial table) → same guarantee;
//   • a writer committing in the SWAP window → full rollback + throw
//     (shipped db restored, source untouched at the doubled path);
//   • a rename failure (locked prisma dir) → rollback usable;
//   • a failed .env fix → the CHILD PROCESS exits non-zero;
//   • spaces in the root path + a custom DATABASE_URL from a
//     higher-precedence source → never overwritten.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const script = join(projectRoot, 'scripts', 'setup-db-heal.mjs');
const FIX = join(projectRoot, 'prisma', `r6-heal-fixture-${process.pid}`);
const SPACES_FIX = join(projectRoot, 'prisma', `r6 heal fixture ${process.pid}`);
const TAG = `r6heal-${Date.now().toString(36)}`;

const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');

// in-process import of the REAL heal (test seams are its public hooks)
const { healDoubledDatabase } = await import(join(projectRoot, 'scripts', 'setup-db-heal.mjs'));

function fixturePrisma(file: string) {
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
}

interface Built {
  canonical: string;
  doubled: string;
  writer: PrismaClient;
}

async function buildFixture(rootDir: string, markerKey: string, extra?: (b: { doubled: string }) => Promise<void>): Promise<Built> {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(join(rootDir, 'prisma', 'prisma'), { recursive: true });
  const canonical = join(rootDir, 'prisma', 'dev.db');
  const doubled = join(rootDir, 'prisma', 'prisma', 'dev.db');
  copyFileSync(workerDb, canonical);
  copyFileSync(workerDb, doubled);
  const writer = fixturePrisma(doubled);
  await writer.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await writer.meta.create({ data: { key: markerKey, value: 'wal-committed' } });
  if (extra) await extra({ doubled });
  return { canonical, doubled, writer };
}

function runHealChild(rootDir: string): { status: number; stdout: string; stderr: string } {
  // a REAL installer (setup.bat / setup.sh) does not carry the test
  // worker's DATABASE_URL into the child — strip it so the child sees
  // the genuine .env / .env.local precedence, like production
  const env: NodeJS.ProcessEnv = { ...process.env, BGL_HEAL_ROOT: rootDir };
  delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env,
  });
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

beforeAll(() => {
  if (!workerDb || !existsSync(workerDb)) throw new Error('[r6] worker DB missing');
});

afterAll(() => {
  rmSync(FIX, { recursive: true, force: true });
  rmSync(SPACES_FIX, { recursive: true, force: true });
});

describe('R6.1 — a commit DURING the snapshot is retried, never promoted stale', () => {
  it('hook-committed UPDATE (row counts unchanged) during snapshot → heal stops (or retries), never false success', async () => {
    const marker = `${TAG}-during-snap`;
    let hookCount = 0;
    const b = await buildFixture(FIX, marker);
    try {
      // the writer commits an UPDATE (NO row-count change) DURING the
      // snapshot window — data_version must catch it every attempt
      await expect(healDoubledDatabase(FIX, {
        afterSnapshot: async () => {
          hookCount += 1;
          await b.writer.meta.update({ where: { key: marker }, data: { value: 'changed-during-snapshot' } });
        },
      })).rejects.toThrow(/در حال تغییر|نویسنده/);
      expect(hookCount).toBeGreaterThanOrEqual(3); // every attempt caught the drift

      // NO false success: nothing was promoted, source intact
      expect(existsSync(join(FIX, 'prisma', 'prisma', 'dev.db'))).toBe(true);
      expect(existsSync(join(FIX, 'prisma', 'dev.db.shipped'))).toBe(false);
      const baks = readdirSync(join(FIX, 'prisma')).filter((n) => n.startsWith('dev.db.shipped-'));
      expect(baks).toHaveLength(0);
    } finally {
      await b.writer.$disconnect();
    }
  }, 60_000);
});

describe('R6.2 — a financial-table change OUTSIDE the fingerprint is caught', () => {
  it('SalesDocumentFinance write during transfer → controlled stop, source intact', async () => {
    const marker = `${TAG}-fin-table`;
    // v2.58.6 (P2→P3 contract): a write attempt INSIDE the locked window is
    // now BLOCKED by SQLite itself (see db-heal-writer-lock.test.ts), so the
    // fingerprint-coverage scenario runs in the PRE-LOCK screen window —
    // the writer COMMITS (a financial table outside the six-table
    // fingerprint) and the screen's data_version must catch it.
    const b = await buildFixture(FIX, marker, async () => {
      // nothing extra — the hook below writes the financial table
    });
    let hookRun = 0;
    try {
      await expect(healDoubledDatabase(FIX, {
        afterSnapshot: async () => {
          // idempotent across the screen's retries (unique numbers per run)
          hookRun += 1;
          const company = await b.writer.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
          const center = await b.writer.center.create({
            data: { name: `${TAG}-fin-center-${hookRun}`, customerType: 'b2b', companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
          });
          const doc = await b.writer.salesDocument.create({
            data: {
              businessUnitId: 'trading', centerId: center.id, companyId: company.id,
              documentNumber: `${TAG}-fin-${hookRun}`, documentType: 'proforma', status: 'approved',
              totalAmount: 100, finalAmount: 100, createdById: null,
            },
          });
          await b.writer.salesDocumentFinance.create({
            data: { salesDocumentId: doc.id, paymentMethod: 'cash', paymentDate: new Date(), amount: 20, description: 'r6' },
          });
        },
      })).rejects.toThrow(/نویسنده|در حال تغییر|تغییر کرد/);

      // source intact; nothing promoted (every screen retry committed
      // another financial row — the screen must catch EACH attempt)
      expect(existsSync(b.doubled)).toBe(true);
      expect((await b.writer.salesDocumentFinance.count({ where: { description: 'r6' } }))).toBeGreaterThanOrEqual(1);
      const baks = readdirSync(join(FIX, 'prisma')).filter((n) => n.startsWith('dev.db.shipped-'));
      expect(baks).toHaveLength(0);
    } finally {
      await b.writer.$disconnect();
    }
  }, 60_000);
});

describe('R6.3 — a writer committing in the SWAP window → rollback, no false success', () => {
  it('commit lands after the swap → promoted file rolled back, shipped db restored, source untouched', async () => {
    const marker = `${TAG}-swap-window`;
    const b = await buildFixture(FIX, marker);
    try {
      await expect(healDoubledDatabase(FIX, {
        beforeRetire: async () => {
          // the writer commits in the window AFTER the files moved and
          // BEFORE the source is retired → the promoted file is stale
          await b.writer.meta.create({ data: { key: `${TAG}-swap-commit`, value: 'late' } });
        },
      })).rejects.toThrow(/نویسندهٔ فعال|بازگردانده/);

      // ROLLBACK happened: the shipped demo db is back at the canonical
      // path (it may be the ORIGINAL shipped file restored from .bak)
      expect(existsSync(b.canonical)).toBe(true);
      const late = fixturePrisma(b.canonical);
      expect(await late.meta.findUnique({ where: { key: `${TAG}-swap-commit` } })).toBeNull(); // stale data NOT promoted
      await late.$disconnect();
      // the source still holds EVERYTHING (incl. the late commit)
      expect(existsSync(b.doubled)).toBe(true);
      expect(await b.writer.meta.findUnique({ where: { key: `${TAG}-swap-commit` } })).not.toBeNull();
      // no legacy retirement happened
      expect(readdirSync(join(FIX, 'prisma')).filter((n) => n.startsWith('legacy-doubled-'))).toHaveLength(0);
    } finally {
      await b.writer.$disconnect();
    }
  }, 60_000);
});

describe('R6.4 — a locked prisma dir (rename fails) → usable rollback', () => {
  it('rename failure → HealError, source stays at the doubled path', async () => {
    const marker = `${TAG}-locked`;
    const b = await buildFixture(FIX, marker);
    chmodSync(join(FIX, 'prisma'), 0o555); // lock the dir: writes/renames now fail
    try {
      // fail-closed at ANY stage (the locked dir may break the staged
      // snapshot write before the renames even start) — the guarantee
      // under test: NO false success + source + canonical both intact
      await expect(healDoubledDatabase(FIX)).rejects.toThrow();
      // source untouched at the doubled path; the shipped db still there
      expect(existsSync(b.doubled)).toBe(true);
      expect(existsSync(b.canonical)).toBe(true);
    } finally {
      chmodSync(join(FIX, 'prisma'), 0o755);
      await b.writer.$disconnect();
    }
  }, 60_000);
});

describe('R6.5 — a failed .env fix is NOT a successful install', () => {
  it('unreadable .env (a directory) → the CHILD process exits non-zero', async () => {
    const marker = `${TAG}-envfail`;
    const b = await buildFixture(FIX, marker);
    await b.writer.$disconnect();
    // .env is a DIRECTORY: existsSync passes, readFileSync throws →
    // the heal reports envFixFailed → main() must exit non-zero
    mkdirSync(join(FIX, '.env'));
    try {
      const res = runHealChild(FIX);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('.env');
      // the database heal itself still completed safely
      expect(existsSync(join(FIX, 'prisma', 'dev.db'))).toBe(true);
    } finally {
      rmSync(join(FIX, '.env'), { recursive: true, force: true });
    }
  }, 60_000);
});

describe('R6.6 — spaces in the path + a custom DATABASE_URL from a higher-precedence source', () => {
  it('root path WITH SPACES heals correctly; a .env.local custom path is never overwritten', async () => {
    const marker = `${TAG}-spaces`;
    const b = await buildFixture(SPACES_FIX, marker);
    await b.writer.$disconnect();
    // .env still carries the OLD doubled pattern; .env.local points the
    // app at a valid custom database — the effective source wins
    writeFileSync(join(SPACES_FIX, '.env'), 'DATABASE_URL="file:./prisma/dev.db"\n');
    writeFileSync(join(SPACES_FIX, '.env.local'), 'DATABASE_URL="file:./custom-data.db"\n');
    try {
      // the REAL child process (like setup.bat), with a clean operator
      // shell env — the .env.local path is genuinely exercised
      const env: NodeJS.ProcessEnv = { ...process.env, BGL_HEAL_ROOT: SPACES_FIX };
      delete env.DATABASE_URL;
      const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('.env NOT rewritten: DATABASE_URL is overridden by .env.local');

      // the .env file is byte-identical (no overwrite of a valid custom setup)
      const envText = readFileSync(join(SPACES_FIX, '.env'), 'utf8');
      expect(envText).toContain('file:./prisma/dev.db');

      // the promoted db exists and holds the WAL-committed row
      const promoted = fixturePrisma(join(SPACES_FIX, 'prisma', 'dev.db'));
      expect(await promoted.meta.findUnique({ where: { key: marker } })).not.toBeNull();
      await promoted.$disconnect();
      // no custom-data.db was created by the heal
      expect(existsSync(join(SPACES_FIX, 'prisma', 'custom-data.db'))).toBe(false);
    } finally {
      rmSync(SPACES_FIX, { recursive: true, force: true });
    }
  }, 60_000);
});
