// ═══════════════════════════════════════════════════════════
// tests/setup.ts — v2.47.0 → v2.58.4 (external audit F09)
//
// Per-WORKER redirect: copies THIS RUN's template (prisma/.test-runs/
// template-<runId>.db, built once by tests/global-setup.ts) to this
// worker's OWN database file, then points DATABASE_URL at it.
//
// v2.58.4 — the worker file carries BOTH the run id (from
// BGL_TEST_RUN_ID, inherited from the vitest main process where
// global-setup set it) and the worker's pool id, so two concurrent
// vitest runs can never collide on any file. dev.db is never touched.
//
// If the run-id env var is unexpectedly missing (exotic pool setups),
// the worker falls back to its OWN fresh id — degraded sharing of the
// template is impossible (the template is looked up by the same id),
// so the worker rebuilds from the fixture path rather than crashing
// or silently touching dev.db.
// ═══════════════════════════════════════════════════════════
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// (node typings expose NODE_ENV as readonly — assign via the index form.)
(process.env as Record<string, string | undefined>).NODE_ENV = 'test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = join(root, 'prisma', '.test-runs');

const runId = process.env.BGL_TEST_RUN_ID || `fallback-${Date.now().toString(36)}-${randomBytes(5).toString('hex')}`;
const TEMPLATE = join(RUNS_DIR, `template-${runId}.db`);

if (!existsSync(TEMPLATE)) {
  if (!process.env.BGL_TEST_RUN_ID) {
    // degraded spawn: this worker arrived without the run id — it must
    // NOT invent access to another run's files; fail loud and rebuild
    // by re-running vitest is the honest path.
    throw new Error(
      '[test-setup] BGL_TEST_RUN_ID missing and no template for the fallback id — re-run vitest (the global setup must run first).',
    );
  }
  throw new Error(
    '[test-setup] this run\u2019s template is missing — global-setup should have created it. ' +
    'If a concurrent run deleted it, that is a bug: report it (v2.58.4 isolates runs by unique ids).',
  );
}

// VITEST_POOL_ID distinguishes workers (threads pool: thread id; forks
// pool: process id). Falls back to pid so even an unexpected missing
// value stays collision-free.
const poolId = process.env.VITEST_POOL_ID || String(process.pid);
const DST = join(RUNS_DIR, `test-${runId}-pool-${poolId}.db`);

// A previous run of THIS worker may have left its file behind.
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(`${DST}${suffix}`, { force: true }); } catch { /* already gone */ }
}
copyFileSync(TEMPLATE, DST);
process.env.DATABASE_URL = `file:${DST}`;

export {}; // side-effect module
