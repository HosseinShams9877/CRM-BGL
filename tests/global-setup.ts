// ═══════════════════════════════════════════════════════════
// tests/global-setup.ts — v2.58.1 → v2.58.4 (external audit F09)
//
// THE AUDIT FINDING (confirmed): the template and per-worker DBs had
// FIXED names, and this global setup DELETED every file matching those
// names — a second concurrent `vitest run` (or `vitest` watch in
// another terminal) destroyed the FIRST run's active template and its
// workers' open databases. Worker-isolation inside ONE run is not
// isolation between TWO runs.
//
// THE v2.58.4 CONTRACT:
//   • every run owns a UNIQUE run id (BGL_TEST_RUN_ID, set here and
//     inherited by the worker processes that spawn afterwards);
//   • ALL run files live under prisma/.test-runs/ and carry the run id
//     (template-<runId>.db, test-<runId>-pool-<N>.db) — two concurrent
//     runs can never see or delete each other's files;
//   • cleanup deletes ONLY this run's own files (global-teardown.ts);
//     crashed-run leftovers are swept by AGE (> 24h) — never a live
//     run's fresh files;
//   • the DEFAULT template source is a SYNTHETIC fixture built from the
//     migrations + prisma/seed.ts in a throwaway file — the operational
//     dev.db is NOT needed and NOT touched. BGL_TEST_DB_SOURCE=dev
//     opts into the real-data snapshot (VACUUM INTO — still read-only).
// ═══════════════════════════════════════════════════════════
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = join(root, 'prisma', '.test-runs');

/** Files older than this are leftovers of CRASHED runs (never of a live
 *  run — even the slowest suite does not keep one file untouched for a
 *  day). Sweeping them can never race a concurrent active run. */
const STALE_FILE_MS = 24 * 60 * 60 * 1000;

export function makeRunId(): string {
  return `${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
}

const runId = process.env.BGL_TEST_RUN_ID || makeRunId();
process.env.BGL_TEST_RUN_ID = runId;

const TEMPLATE = join(RUNS_DIR, `template-${runId}.db`);


/** Old flat-name patterns (pre-v2.58.4) + this scheme's files, swept
 *  strictly by age under prisma/ and prisma/.test-runs/. */
function sweepStaleFiles(): void {
  const candidates: Array<{ dir: string; pattern: RegExp }> = [
    { dir: RUNS_DIR, pattern: /^(template|test|fixture)-[A-Za-z0-9-]+\.db(-wal|-shm)?$/ },
    // pre-v2.58.4 flat naming (prisma/test-template.db, test-pool-N.db)
    { dir: join(root, 'prisma'), pattern: /^test-(template|pool-?[A-Za-z0-9]*)\.db(-wal|-shm)?$/ },
  ];
  for (const { dir, pattern } of candidates) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!pattern.test(name)) continue;
      const p = join(dir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > STALE_FILE_MS) {
          rmSync(p, { force: true });
        }
      } catch { /* raced a concurrent sweep — leave it for the next run */ }
    }
  }
}

/** Build the synthetic fixture: migrations + seed on a throwaway file.
 *  Real child processes (the exact production commands, no test doubles). */
function buildFixture(fixture: string): void {
  rmSync(fixture, { force: true });
  rmSync(`${fixture}-wal`, { force: true });
  rmSync(`${fixture}-shm`, { force: true });
  const env = {
    ...process.env,
    DATABASE_URL: `file:${fixture}`,
    // fixed throwaway credentials for the ISOLATED fixture only — never
    // used anywhere in the deliverable, never printed by tests.
    SEED_ADMIN_PASSWORD: 'test-fixture-admin',
    SEED_DEMO_USERS: 'true',
    SEED_DEMO_PASSWORD: 'test-fixture-demo',
  };
  const migrate = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (migrate.status !== 0) {
    throw new Error(`[test-global-setup] fixture migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }
  const seed = spawnSync(
    process.execPath,
    [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'prisma/seed.ts'],
    { cwd: root, env, encoding: 'utf8' },
  );
  if (seed.status !== 0) {
    throw new Error(`[test-global-setup] fixture seed failed:\n${seed.stdout}\n${seed.stderr}`);
  }
  if (!existsSync(fixture)) {
    throw new Error('[test-global-setup] fixture file was not created.');
  }
}

/** One consistent snapshot of the operational dev.db (opt-in source —
 *  VACUUM INTO only READS the source; works with the dev server up). */
async function snapshotDevDb(template: string): Promise<void> {
  const SRC = join(root, 'prisma', 'dev.db');
  if (!existsSync(SRC)) {
    throw new Error('[test-global-setup] BGL_TEST_DB_SOURCE=dev but prisma/dev.db not found.');
  }
  const { PrismaClient } = (await import('@prisma/client')) as typeof import('@prisma/client');
  const src = new PrismaClient({ datasources: { db: { url: `file:${SRC}` } } });
  try {
    await src.$queryRawUnsafe(`VACUUM INTO '${template.replace(/'/g, "''")}'`);
  } finally {
    await src.$disconnect();
  }
}

function mkdirRunsDir(): void {
  mkdirSync(RUNS_DIR, { recursive: true });
}

export async function setup(): Promise<void> {
  mkdirRunsDir();
  sweepStaleFiles();

  const source = process.env.BGL_TEST_DB_SOURCE === 'dev' ? 'dev' : 'fixture';
  if (source === 'dev') {
    await snapshotDevDb(TEMPLATE);
  } else {
    // the seeded fixture doubles as the template: after the seed's clean
    // disconnect its WAL is checkpointed away, so the single file is a
    // consistent, self-contained snapshot — workers copy it read-only.
    buildFixture(TEMPLATE);
  }
  if (!existsSync(TEMPLATE)) {
    throw new Error('[test-global-setup] template was not created.');
  }
}

/**
 * TEARDOWN (vitest calls this at the end of the run — same module, named
 * export). Deletes ONLY this run's own files (matched by the unique run
 * id): the template and every worker copy. A concurrent run's files carry
 * a different id and can never match. A crashed run leaves nothing but
 * stale files, which the next run's global-setup sweeps by AGE (> 24h) —
 * never by name against a live run.
 */
export async function teardown(): Promise<void> {
  if (!existsSync(RUNS_DIR)) return;
  const own = new RegExp(
    `^(?:template|fixture)-${runId}\\.db(?:-wal|-shm)?$|^test-${runId}-pool-[^.]+\\.db(?:-wal|-shm)?$`,
  );
  for (const name of readdirSync(RUNS_DIR)) {
    if (own.test(name)) {
      try { rmSync(join(RUNS_DIR, name), { force: true }); } catch { /* next run sweeps it */ }
    }
  }
}
// NOTE: no default export — vitest uses the NAMED `setup` + `teardown`
// pair from this module (a default export would take precedence and the
// teardown would never be registered).
