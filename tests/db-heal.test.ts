import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// db-heal.test.ts — v2.58.4 (external audit F01)
//
// THE AUDIT REPRO (reproduced on the pre-fix script):
//   an old install keeps its LIVE database at prisma/prisma/dev.db
//   (the round-≤2.46 .env path bug). That live database runs in WAL
//   mode, and a commit still sitting in the -wal file must survive
//   the heal. The old script did a bare file copy/rename: the
//   WAL-committed row was LEFT BEHIND (PROMOTED_ROWS 0) while the
//   script exited 0 — silent record loss on upgrade.
//
// THE CONTRACT (v2.58.4):
//   1. WAL-committed rows of the doubled db ARE present in the
//      promoted canonical db (VACUUM INTO consistent snapshot).
//   2. The retired doubled db + its -wal/-shm are PRESERVED in a
//      legacy backup dir (nothing deleted, upgrade reversible).
//   3. The pre-existing canonical (shipped demo db) is kept as
//      dev.db.shipped-<ts>.bak.
//   4. A CORRUPT doubled db → exit non-zero, canonical untouched,
//      source still in place (fail-closed, install must stop).
//   5. Integrity of the promoted db: quick_check ok.
//
// The heal script runs as a REAL child process (exactly what
// setup.bat / setup.sh invoke) against a per-test fixture root —
// BGL_HEAL_ROOT points the script at the fixture. The writer
// connection is held OPEN for the whole test so the marker row
// genuinely lives in the -wal file, never checkpointed into the
// main db file before the heal runs.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const script = join(projectRoot, 'scripts', 'setup-db-heal.mjs');
const FIX = join(projectRoot, 'prisma', `r89-heal-fixture-${process.pid}`);
const TAG = `r89heal-${Date.now().toString(36)}`;

// the worker's own isolated DB is the source for a schema-valid fixture copy
const workerDb = (process.env.DATABASE_URL || '').replace(/^file:/, '');

/** Run the heal script against the fixture root (real child process). */
function runHeal(): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, BGL_HEAL_ROOT: FIX },
  });
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function fixturePrisma(file: string) {
  return new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
}

/** Build a fixture where the doubled db REALLY runs in WAL mode with a
 *  commit sitting in the -wal file (the writer connection stays open for
 *  the whole test, so the row is never checkpointed into the main file). */
async function buildWalFixture(markerKey: string) {
  rmSync(join(FIX, 'prisma'), { recursive: true, force: true });
  mkdirSync(join(FIX, 'prisma', 'prisma'), { recursive: true });
  const canonical = join(FIX, 'prisma', 'dev.db');
  const doubled = join(FIX, 'prisma', 'prisma', 'dev.db');
  copyFileSync(workerDb, canonical); // the shipped demo db
  copyFileSync(workerDb, doubled); // the user's LIVE db
  const writer = fixturePrisma(doubled);
  await writer.$queryRawUnsafe('PRAGMA journal_mode=WAL'); // the real runtime mode (src/lib/db.ts)
  await writer.meta.create({ data: { key: markerKey, value: 'wal-committed' } });
  const walExists = existsSync(`${doubled}-wal`);
  if (!walExists) throw new Error('[db-heal] fixture setup failed: no -wal file after commit');
  return { canonical, doubled, writer };
}

beforeAll(async () => {
  if (!workerDb || !existsSync(workerDb)) throw new Error('[db-heal] worker DB missing');
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(join(FIX, 'prisma', 'prisma'), { recursive: true });
});

afterAll(async () => {
  rmSync(FIX, { recursive: true, force: true });
});

describe('F01 — legacy doubled db heal with a live WAL (mandatory repro)', () => {
  it('a WAL-committed row survives the promotion; nothing is deleted; exit 0', async () => {
    // ── fixture: shipped canonical + doubled live db in WAL mode ──
    const markerKey = `${TAG}-wal-row`;
    const { canonical, doubled, writer } = await buildWalFixture(markerKey);

    // a commit that lives ONLY in the -wal file (writer stays open)
    expect(existsSync(`${doubled}-wal`)).toBe(true);

    const res = runHeal();
    expect(res.stderr.trim()).toBe('');

    // exit 0 and the canonical path now hosts the LIVE data
    expect(res.status).toBe(0);

    const promoted = fixturePrisma(canonical);
    const marker = await promoted.meta.findUnique({ where: { key: markerKey } });
    expect(marker?.value).toBe('wal-committed'); // THE audit assertion: PROMOTED_ROWS 1
    const chk = await promoted.$queryRawUnsafe('PRAGMA quick_check') as Array<{ quick_check: string }>;
    expect(chk[0]?.quick_check).toBe('ok');
    await promoted.$disconnect();

    // the retired doubled source (db + wal + shm) is PRESERVED, not deleted
    const legacyDirs = readdirSync(join(FIX, 'prisma')).filter((n) => n.startsWith('legacy-doubled-'));
    expect(legacyDirs.length).toBe(1);
    const legacy = readdirSync(join(FIX, 'prisma', legacyDirs[0]));
    expect(legacy).toContain('dev.db');
    expect(legacy).toContain('dev.db-wal'); // the WAL left behind — preserved for recovery
    expect(existsSync(join(FIX, 'prisma', 'prisma', 'dev.db'))).toBe(false);

    // the shipped demo db was kept as a .bak
    const baks = readdirSync(join(FIX, 'prisma')).filter((n) => /^dev\.db\.shipped-.*\.bak$/.test(n));
    expect(baks.length).toBe(1);

    await writer.$disconnect();
    rmSync(join(FIX, 'prisma'), { recursive: true, force: true });
  }, 60_000);

  it('a CORRUPT doubled db → non-zero exit, canonical untouched, source kept', async () => {
    rmSync(join(FIX, 'prisma'), { recursive: true, force: true });
    mkdirSync(join(FIX, 'prisma', 'prisma'), { recursive: true });
    const canonical = join(FIX, 'prisma', 'dev.db');
    const doubled = join(FIX, 'prisma', 'prisma', 'dev.db');
    copyFileSync(workerDb, canonical);
    writeFileSync(doubled, Buffer.from('this is definitely not a sqlite database — corrupt bytes'));

    const res = runHeal();
    expect(res.status).not.toBe(0); // fail-closed: install must stop

    // canonical untouched + corrupt source still in place (usable state preserved)
    expect(existsSync(canonical)).toBe(true);
    expect(existsSync(doubled)).toBe(true);
    // no backups / legacy dirs / staged files were created
    const entries = readdirSync(join(FIX, 'prisma')).filter((n) => n !== 'prisma');
    expect(entries).toEqual(['dev.db']);
    rmSync(join(FIX, 'prisma'), { recursive: true, force: true });
  }, 60_000);

  it('no doubled db → healthy no-op, exit 0', async () => {
    const res = runHeal();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('healthy');
  }, 30_000);
});
