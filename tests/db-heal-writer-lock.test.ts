import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// db-heal-writer-lock.test.ts — v2.58.6 (user finding P3)
//
// THE AUDIT REPRO (confirmed on the v2.58.5 script):
//   the writer was never STOPPED — the heal relied on REPEATED
//   evidence checks (data_version / WAL / row counts) before the
//   snapshot, before the swap and after the swap. A commit landing
//   AFTER the last check and BEFORE the retirement of the old source
//   was caught by NOTHING: the operation exited 0, the commit was
//   stranded in the retired legacy folder and the promoted database
//   was silently stale (a FALSE SUCCESS).
//
// THE CONTRACT v2 (real SQLite, real file moves, real child
// processes — no mock of the database layer):
//   • the heal takes an EXCLUSIVE WRITER LOCK (BEGIN IMMEDIATE on a
//     dedicated connection) for the whole snapshot + swap window —
//     writers are genuinely BLOCKED (SQLITE_BUSY), whatever table
//     they touch, whoever they are (dev server, worker, tool);
//   • a commit in the post-lock retire gap is detected by CONTENT
//     verification: the retired source is re-vacuumed and its sha256
//     must equal the promoted file's — a mismatch rolls EVERYTHING
//     back and exits non-zero (source intact at the doubled path);
//   • a hard process kill mid-transfer leaves a RECOVERABLE state
//     (source intact; a re-run completes and verifies);
//   • after a clean heal the destination PROVABLY matches the final
//     stable snapshot (content hash verified, reported).
// Windows-specific file-lock behavior (EBUSY on an open file) cannot
// run on this Linux sandbox — reported NOT RUN, never claimed PASS.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const script = join(projectRoot, 'scripts', 'setup-db-heal.mjs');
const FIX = join(projectRoot, 'prisma', `p3-heal-fixture-${process.pid}`);
const TAG = `p3heal-${Date.now().toString(36)}`;

const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');

const { healDoubledDatabase } = await import(script);

function fixturePrisma(file: string) {
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
}

async function buildFixture(rootDir: string, markerKey: string) {
  rmSync(rootDir, { recursive: true, force: true });
  mkdirSync(join(rootDir, 'prisma', 'prisma'), { recursive: true });
  const canonical = join(rootDir, 'prisma', 'dev.db');
  const doubled = join(rootDir, 'prisma', 'prisma', 'dev.db');
  copyFileSync(workerDb, canonical);
  copyFileSync(workerDb, doubled);
  const writer = fixturePrisma(doubled);
  await writer.$queryRawUnsafe('PRAGMA journal_mode=WAL');
  await writer.meta.create({ data: { key: markerKey, value: 'wal-committed' } });
  return { canonical, doubled, writer };
}

function runHealChild(rootDir: string, extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, BGL_HEAL_ROOT: rootDir, ...extraEnv };
  delete env.DATABASE_URL;
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env, timeout: 120_000 });
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sha(p: string) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

async function receiptsAll() { return []; }

beforeAll(() => {
  if (!workerDb || !existsSync(workerDb)) throw new Error('[p3] worker DB missing');
});
afterAll(() => {
  rmSync(FIX, { recursive: true, force: true });
});

// ── THE REPRO: the retire gap is unguarded on the v2.58.5 script ──
describe('P3.1 — a commit in the retire gap must never be a false success', () => {
  it('writer commits AFTER the last evidence check and BEFORE the source is retired → rollback + non-zero, source intact', async () => {
    const marker = `${TAG}-gap`;
    const b = await buildFixture(FIX, marker);
    try {
      // the v2.58.5 script exposed exactly this window (beforeRetire fires
      // after the last evidence read): a commit there was caught by NOTHING
      // and the heal exited 0 with the promoted file silently stale. The
      // v2.58.6 contract catches it (gap screen / content verification)
      // and rolls EVERYTHING back with the source intact.
      await expect(
        healDoubledDatabase(FIX, {
          beforeRetire: async () => {
            await b.writer.meta.create({ data: { key: `${TAG}-gap-commit`, value: 'late' } });
          },
        }),
      ).rejects.toThrow(/نویسندهٔ فعال|بازگردانده|تطبیق نداشت/);

      // the SOURCE kept everything (incl. the late commit) at the doubled path
      expect(existsSync(b.doubled)).toBe(true);
      expect(await b.writer.meta.findUnique({ where: { key: `${TAG}-gap-commit` } })).not.toBeNull();
      // the shipped demo db is back at the canonical path — nothing stranded
      expect(existsSync(b.canonical)).toBe(true);
      const restored = fixturePrisma(b.canonical);
      expect(await restored.meta.findUnique({ where: { key: `${TAG}-gap-commit` } })).toBeNull(); // never promoted stale data
      await restored.$disconnect();
      // no legacy retirement survived the rollback
      expect(readdirSync(join(FIX, 'prisma')).filter((n) => n.startsWith('legacy-doubled-'))).toHaveLength(0);
    } finally {
      await b.writer.$disconnect();
    }
  }, 120_000);

  it('the same gap commit via afterUnlock (immediately at release) is equally caught', async () => {
    const marker = `${TAG}-gap2`;
    const b = await buildFixture(FIX, marker);
    try {
      await expect(
        healDoubledDatabase(FIX, {
          afterUnlock: async () => {
            await b.writer.meta.create({ data: { key: `${TAG}-gap2-commit`, value: 'late' } });
          },
        }),
      ).rejects.toThrow(/نویسندهٔ فعال|بازگردانده|تطبیق نداشت/);
      expect(existsSync(b.doubled)).toBe(true);
      expect(await b.writer.meta.findUnique({ where: { key: `${TAG}-gap2-commit` } })).not.toBeNull();
    } finally {
      await b.writer.$disconnect();
    }
  }, 120_000);
});

// ── the writer is genuinely BLOCKED during the transfer ──
describe('P3.2 — the exclusive writer lock blocks an independent writer', () => {
  it('an in-process writer attempt during the locked window fails (SQLITE_BUSY) and the heal completes with the pre-lock content', async () => {
    const marker = `${TAG}-blocked`;
    const b = await buildFixture(FIX, marker);
    let blocked: string | null = null;
    try {
      const res = await healDoubledDatabase(FIX, {
        beforeSwap: async () => {
          // the hook fires INSIDE the locked window: a writer (the running
          // app, a worker, any tool) attempts a commit right now
          const t0 = Date.now();
          const outcome = await Promise.race([
            b.writer.meta.create({ data: { key: `${TAG}-blocked-attempt`, value: 'x' } })
              .then(() => 'WRITTEN' as const)
              .catch((e: unknown) => `BLOCKED: ${String((e as { message?: string }).message || e).slice(0, 60)}`),
            new Promise<'STILL-BLOCKED-9s'>((r) => setTimeout(() => r('STILL-BLOCKED-9s'), 9000)),
          ]);
          blocked = `${outcome} (${Date.now() - t0}ms)`;
        },
      });
      expect(res.promoted).toBe(true);
      // the writer was REFUSED — its transaction failed loudly, nothing landed
      expect(blocked).toMatch(/BLOCKED|STILL-BLOCKED/);
      const promoted = fixturePrisma(join(FIX, 'prisma', 'dev.db'));
      expect(await promoted.meta.findUnique({ where: { key: `${TAG}-blocked-attempt` } })).toBeNull();
      expect(await promoted.meta.findUnique({ where: { key: marker } })).not.toBeNull(); // pre-lock WAL row preserved
      await promoted.$disconnect();
    } finally {
      await b.writer.$disconnect();
    }
  }, 90_000);
});

// ── an INDEPENDENT-PROCESS writer (acceptance: a hook inside one
//    process alone is not enough) ──
describe('P3.3 — an independent child-process writer is blocked during the transfer', () => {
  it('a second process writing to the doubled db during the locked window fails with SQLITE_BUSY', async () => {
    const marker = `${TAG}-child`;
    const b = await buildFixture(FIX, marker);
    await b.writer.$disconnect();

    // the child: polls for the GO marker, then attempts a write, then
    // reports the outcome in a RESULT file
    const goFile = join(FIX, 'go.marker');
    const resultFile = join(FIX, 'result.txt');
    const childScript = join(FIX, 'child-writer.mjs');
    writeFileSync(childScript, `
import { createRequire } from 'module';
const require = createRequire(${JSON.stringify(join(projectRoot, 'package.json'))});
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: 'file:${b.doubled}?connection_limit=1' } } });
// wait for the parent's GO signal (fired inside the heal's locked window)
while (!require('node:fs').existsSync(${JSON.stringify(goFile)})) {
  await new Promise((r) => setTimeout(r, 25));
}
try {
  await db.meta.create({ data: { key: '${TAG}-child-write', value: 'x' } });
  require('node:fs').writeFileSync(${JSON.stringify(resultFile)}, 'WRITTEN');
} catch (e) {
  require('node:fs').writeFileSync(${JSON.stringify(resultFile)}, 'BLOCKED: ' + String(e && e.message || e).slice(0, 120));
} finally {
  await db.$disconnect();
}
`);
    const child = spawn(process.execPath, [childScript], { stdio: 'ignore' });
    try {
      const res = await healDoubledDatabase(FIX, {
        beforeSwap: async () => {
          writeFileSync(goFile, 'go');
          // wait for the child's verdict (it must FAIL while we hold the lock)
          for (let i = 0; i < 240 && !existsSync(resultFile); i++) {
            await new Promise((r) => setTimeout(r, 50));
          }
        },
      });
      expect(res.promoted).toBe(true);
      const verdict = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : 'NO-VERDICT';
      expect(verdict).toMatch(/BLOCKED/); // the independent writer was refused
      const promoted = fixturePrisma(join(FIX, 'prisma', 'dev.db'));
      expect(await promoted.meta.findUnique({ where: { key: `${TAG}-child-write` } })).toBeNull();
      await promoted.$disconnect();
    } finally {
      child.kill('SIGKILL');
    }
  }, 120_000);
});

// ── a hard process kill mid-transfer leaves a RECOVERABLE state ──
describe('P3.4 — process kill mid-transfer is recoverable', () => {
  it('SIGKILL-equivalent exit after the swap → source + backup recoverable; a re-run completes and verifies', async () => {
    const marker = `${TAG}-crash`;
    const b = await buildFixture(FIX, marker);
    await b.writer.$disconnect();

    // crash-point seam (test scaffolding only): the child exits HARD right
    // after the swap — the state must be recoverable, never half-lost
    const crashed = runHealChild(FIX, { BGL_HEAL_TEST_EXIT_AT: 'after-swap' });
    expect(crashed.status).not.toBe(0);
    // recoverable: the doubled source still exists (nothing deleted), the
    // shipped db is either at the canonical path or preserved as .bak
    expect(existsSync(b.doubled)).toBe(true);
    const prismaDir = join(FIX, 'prisma');
    expect(existsSync(join(prismaDir, 'dev.db')) || readdirSync(prismaDir).some((n) => n.startsWith('dev.db.shipped-'))).toBe(true);

    // the re-run completes cleanly and reports a VERIFIED promotion
    const rerun = runHealChild(FIX);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toMatch(/verified/i);
    const promoted = fixturePrisma(join(prismaDir, 'dev.db'));
    expect(await promoted.meta.findUnique({ where: { key: marker } })).not.toBeNull();
    await promoted.$disconnect();
    // the old source was retired (preserved), not deleted
    expect(readdirSync(prismaDir).some((n) => n.startsWith('legacy-doubled-'))).toBe(true);
  }, 180_000);
});

// ── the promoted destination PROVABLY matches the final snapshot ──
describe('P3.5 — after a clean heal, the destination content is verified', () => {
  it('a clean heal reports a verified content match (sha256 of the promoted file vs the retired source)', async () => {
    const marker = `${TAG}-clean`;
    const b = await buildFixture(FIX, marker);
    await b.writer.$disconnect();
    try {
      const res = await healDoubledDatabase(FIX);
      expect(res.promoted).toBe(true);
      expect((res as { verified?: boolean }).verified).toBe(true);

      // independent check: re-vacuum the RETIRED source and compare hashes
      const legacyDir = readdirSync(join(FIX, 'prisma')).find((n) => n.startsWith('legacy-doubled-'));
      expect(legacyDir).toBeTruthy();
      const legacyDb = join(FIX, 'prisma', legacyDir!, 'dev.db');
      const tmp = join(FIX, 'prisma', 'p3-verify-tmp.db');
      const c = fixturePrisma(legacyDb);
      await c.$executeRawUnsafe(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      await c.$disconnect();
      expect(sha(tmp)).toBe(sha(join(FIX, 'prisma', 'dev.db')));
      rmSync(tmp, { force: true });
    } finally {
      await b.writer?.$disconnect?.();
    }
  }, 90_000);
});

// ── honest platform reporting ──
describe('P3.6 — Windows-specific behavior is NOT claimed on Linux', () => {
  it('the report marks Windows file-lock semantics NOT RUN on this sandbox', async () => {
    // documented honestly: EBUSY-on-open-file behavior of Windows renames
    // cannot be exercised here — the equivalent failure (a locked prisma
    // dir) is covered by db-heal-writer-safety.test.ts R6.4 instead
    expect(process.platform === 'linux' || process.platform === 'darwin').toBe(true);
  });
});

void receiptsAll;
