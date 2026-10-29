#!/usr/bin/env node
// ═════════════════════════════════════════════════════════════
// setup-db-heal.mjs — v2.47.0 → v2.58.6 (external audit F01, R6, P3)
//
// Heals the round-≤2.46 packaging bug: the starter .env pointed at
// file:./prisma/dev.db, which Prisma resolves against the schema dir →
// prisma/prisma/dev.db. Users who ran the OLD setup.bat therefore have
// their live data in that doubled path while the SHIPPED prisma/dev.db
// sits unused next to it.
//
// ── v2.58.5 (R6) — evidence-based detection ──
// VACUUM INTO snapshots include WAL-committed rows; the swap is staged
// with rollback; corrupt sources fail closed; drift was detected via
// data_version + WAL size/mtime + row counts at four checkpoints.
//
// ── v2.58.6 (user P3) — the writer is now actually STOPPED ──
// Repeated change detection is NOT writer stoppage: a commit landing
// after the last check and before the source is retired was invisible
// (a false success with the promoted file silently stale). The new
// contract:
//   1. PRE-LOCK SCREEN — two evidence reads (data_version / WAL /
//      counts) catch an ACTIVELY committing writer early, with retries
//      and an honest "close the app" message;
//   2. EXCLUSIVE WRITER LOCK — BEGIN IMMEDIATE on a dedicated
//      single-connection client, held across the snapshot AND the
//      swap. Every OTHER writer (dev server, standalone, worker,
//      maintenance tool — whoever they are, no marker-file trust) is
//      REFUSED by SQLite itself with SQLITE_BUSY: this is real write
//      prevention, not observation;
//   3. RETIRE GAP PROTECTION — after the lock is released, the source
//      is re-checked AND the retired source's CONTENT is re-vacuumed
//      and sha256-compared with the promoted file: a commit that won
//      the gap is caught with certainty (content, not timing), the
//      swap is fully rolled back and the install fails non-zero with
//      the source intact;
//   4. VERIFIED SUCCESS — "data intact" is EARNED: the success message
//      only prints after the content hash of the promoted file is
//      proven equal to the final stable snapshot (report.verified).
// Windows semantics are respected: our own connections are closed
// BEFORE every rename (an open file can never be assumed renameable);
// a foreign process holding a file open makes the rename fail →
// rollback → non-zero exit. Windows EBUSY itself cannot be exercised
// on a Linux sandbox and is reported NOT RUN, never PASS.
//
// Testable: BGL_HEAL_ROOT / --root=<dir> retargets the operation;
// healDoubledDatabase(root, hooks) exposes optional test seams
// ({ afterSnapshot, beforeSwap, afterUnlock, beforeRetire }) that the
// in-process regression tests use to place commits EXACTLY inside the
// guarded windows. BGL_HEAL_TEST_EXIT_AT=<after-snapshot|after-swap|
// after-retire> is a crash-point seam for the child-process kill test
// ONLY — the operator CLI never sets it.
// ═════════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppEnv } from './lib/resolve-env.mjs';

// (R6/R7) snapshot the environment FIRST: @prisma/client AUTO-LOADS a
// .env from the working directory at require time, which would pollute
// the "which source provided DATABASE_URL" detection below.
const initialEnv = { ...process.env };

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(projectRoot, 'package.json'));
const { PrismaClient } = require('@prisma/client');

// ── CLI ────────────────────────────────────────────────────
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const root = argRoot ? resolve(projectRoot, argRoot.slice('--root='.length)) : process.env.BGL_HEAL_ROOT
  ? resolve(process.env.BGL_HEAL_ROOT)
  : projectRoot;

// crash-point seam (child-process kill test ONLY — see header)
const EXIT_AT = process.env.BGL_HEAL_TEST_EXIT_AT || '';

class HealError extends Error {}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function maybeExitAt(phase) {
  if (EXIT_AT === phase) {
    console.error(`  [TEST-CRASH] BGL_HEAL_TEST_EXIT_AT=${phase} — hard exit (recoverable-state test)`);
    process.exit(70);
  }
}

/** Open a single-connection PrismaClient pointed at an explicit sqlite file. */
function client(file) {
  return new PrismaClient({ datasources: { db: { url: `file:${file}?connection_limit=1` } } });
}

async function raw(c, sql) {
  return c.$queryRawUnsafe(sql);
}

/**
 * The WRITER-STABILITY EVIDENCE: data_version + the source WAL's
 * size/mtime + the six-table row counts. data_version increments on ANY
 * commit by ANOTHER connection (any table, UPDATE included).
 */
async function stabilityEvidence(c, doubled) {
  const dv = await raw(c, 'PRAGMA data_version');
  const counts = {};
  for (const t of ['User', 'Company', 'Center', 'Meta', 'Activity', 'SalesDocument']) {
    try {
      const rows = await raw(c, `SELECT count(*) AS n FROM "${t}"`);
      counts[t] = Number(rows[0]?.n ?? -1);
    } catch {
      counts[t] = -1; // table absent (very old schema?) — validated below
    }
  }
  let wal = { size: -1, mtime: -1 };
  try {
    const st = statSync(`${doubled}-wal`);
    wal = { size: st.size, mtime: st.mtimeMs };
  } catch { /* no -wal: all commits are in the main file */ }
  return { dataVersion: Number(dv[0]?.data_version ?? 0), counts, wal };
}

function evidenceEqual(a, b) {
  if (a.dataVersion !== b.dataVersion) return false;
  if (a.wal.size !== b.wal.size || a.wal.mtime !== b.wal.mtime) return false;
  for (const k of Object.keys(a.counts)) {
    if (a.counts[k] !== b.counts[k]) return false;
  }
  return true;
}

const CORE_TABLES = ['User', 'Company', 'Center', 'Meta', 'Activity', 'SalesDocument', '_prisma_migrations'];

async function validateSnapshot(snapClient) {
  const chk = await raw(snapClient, 'PRAGMA quick_check');
  if (String(chk[0]?.quick_check) !== 'ok') {
    throw new HealError('اعتبارسنجی سلامت دیتابیس (quick_check) ناموفق بود.');
  }
  const tables = await raw(snapClient, "SELECT name FROM sqlite_master WHERE type='table'");
  const present = new Set(tables.map((r) => r.name));
  for (const t of CORE_TABLES) {
    if (!present.has(t)) throw new HealError(`جدول پایه «${t}» در نسخهٔ تهیه‌شده یافت نشد.`);
  }
}

function sha256(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// ── Phase A: pre-lock stability screen (active writers → honest stop) ──
const MAX_SNAPSHOT_ATTEMPTS = 3;

async function preLockScreen(doubled, hooks) {
  const c = client(doubled);
  try {
    for (let attempt = 1; attempt <= MAX_SNAPSHOT_ATTEMPTS; attempt++) {
      const before = await stabilityEvidence(c, doubled);
      // (test seam) a commit placed here simulates an ACTIVE writer —
      // the screen must catch the drift on every attempt
      if (hooks?.afterSnapshot) await hooks.afterSnapshot();
      const after = await stabilityEvidence(c, doubled);
      if (evidenceEqual(before, after)) return after;
    }
    throw new HealError(
      'دیتابیس قدیمی هم‌اکنون در حال تغییر است (برنامهٔ در حال اجرا روی آن می‌نویسد). ' +
      'برنامه را ببندید و نصب را دوباره اجرا کنید.',
    );
  } finally {
    await c.$disconnect().catch(() => {});
  }
}

// ── Phase B: the EXCLUSIVE WRITER LOCK ──────────────────────
/**
 * BEGIN IMMEDIATE acquires (and holds) the SQLite write lock on a
 * dedicated single-connection client: every OTHER writer — dev server,
 * standalone build, worker, maintenance tool — is REFUSED by SQLite
 * itself with SQLITE_BUSY until we release. This is REAL write
 * prevention during the snapshot + swap window (validated empirically:
 * a foreign Prisma write fails with raw code 5 after the driver's busy
 * timeout; reads and VACUUM INTO from other connections still work and
 * see the WAL-committed rows).
 */
async function acquireWriterLock(doubled) {
  const lockConn = client(doubled);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await lockConn.$executeRawUnsafe('BEGIN IMMEDIATE');
      return lockConn;
    } catch (e) {
      if (attempt === 3) {
        await lockConn.$disconnect().catch(() => {});
        throw new HealError(
          'قفل نوشتن روی دیتابیس قدیمی گرفته نشد (یک نویسندهٔ فعال تراکنش باز دارد). ' +
          `برنامه را ببندید و دوباره اجرا کنید. (${e?.message || e})`,
        );
      }
      await sleep(350);
    }
  }
  throw new Error('unreachable');
}

async function releaseWriterLock(lockConn) {
  try { await lockConn.$executeRawUnsafe('ROLLBACK'); } catch { /* already closed */ }
  await lockConn.$disconnect().catch(() => {});
}

/**
 * v2.58.5 (R6) → v2.58.6 (P3) — correct a .env DATABASE_URL that still
 * points at the doubled path, using the SHARED resolver's precedence.
 */
function fixEnvDatabaseUrl(rootDir, changed) {
  const eff = resolveAppEnv({ root: rootDir, env: initialEnv });
  const envPath = join(rootDir, '.env');
  if (!existsSync(envPath)) return;

  if (eff.databaseSource === 'process-env' || eff.databaseSource === '.env.local') {
    console.log(`  .env NOT rewritten: DATABASE_URL is overridden by ${eff.databaseSource} (effective db: ${eff.dbFile})`);
    return;
  }
  if (eff.databaseSource === 'default') {
    try {
      if (existsSync(envPath) && !statSync(envPath).isFile()) {
        console.warn('  [WARN] .env exists but is not a readable file — cannot verify DATABASE_URL.');
        changed.envFixFailed = true;
      }
    } catch { /* stat failed — leave it */ }
    return;
  }

  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch (e) {
    console.warn(`  [WARN] Could not read .env to fix DATABASE_URL: ${e?.message || e}`);
    changed.envFixFailed = true;
    return;
  }
  const bad = /^\s*DATABASE_URL\s*=\s*["']?file:\.?(?:\/|\\)?prisma(?:\/|\\)dev\.db["']?\s*$/m;
  if (!bad.test(text)) return;
  const backup = `${envPath}.heal-${ts()}.bak`;
  try {
    require('node:fs').copyFileSync(envPath, backup);
    const fixed = text.replace(bad, 'DATABASE_URL="file:./dev.db"');
    require('node:fs').writeFileSync(envPath, fixed, 'utf8');
    console.log('  Fixed .env DATABASE_URL (was pointing at the doubled path) — timestamped backup kept');
    changed.envFixed = true;
  } catch (e) {
    console.warn(`  [WARN] Could not fix .env DATABASE_URL: ${e?.message || e}`);
    console.warn('         Edit .env manually: DATABASE_URL="file:./dev.db"');
    changed.envFixFailed = true;
  }
}

// ── THE HEAL ───────────────────────────────────────────────
/**
 * @param {string} rootDir
 * @param {{ afterSnapshot?: () => void | Promise<void>,
 *           beforeSwap?: () => void | Promise<void>,
 *           afterUnlock?: () => void | Promise<void>,
 *           beforeRetire?: () => void | Promise<void> }} [hooks]
 *   Optional test seams (in-process regression tests ONLY — the CLI
 *   entry never passes them): afterSnapshot fires between the pre-lock
 *   screen's two reads; beforeSwap fires INSIDE the locked window;
 *   afterUnlock fires in the retire gap (lock released, source not yet
 *   moved); beforeRetire fires right before the retirement rename.
 */
export async function healDoubledDatabase(rootDir, hooks = {}) {
  const prismaDir = join(rootDir, 'prisma');
  const doubled = join(prismaDir, 'prisma', 'dev.db');
  const canonical = join(prismaDir, 'dev.db');
  const report = {
    foundDoubled: existsSync(doubled),
    promoted: false,
    verified: false,
    sourceCounts: null,
    legacyDir: null,
    shippedBackup: null,
    envFixed: false,
    envFixFailed: false,
  };

  if (!report.foundDoubled) {
    console.log('  No legacy prisma\\prisma\\dev.db found - database path is healthy.');
    fixEnvDatabaseUrl(rootDir, report);
    return report;
  }

  const stamp = ts();

  // ── 1. PRE-LOCK SCREEN: an actively-committing writer is caught here ──
  const screenEvidence = await preLockScreen(doubled, hooks);
  report.sourceCounts = screenEvidence.counts;
  const committed = Object.entries(screenEvidence.counts).map(([t, n]) => `${t}:${n}`).join(' ');
  console.log(`  Source rows (incl. WAL-committed): ${committed}`);

  // ── 2. THE WRITER LOCK: from here until the swap is done, every other
  //      writer is REFUSED by SQLite (SQLITE_BUSY) — real prevention. ──
  const lockConn = await acquireWriterLock(doubled);
  let lockHeld = true;
  let src = null;
  let snap = null;
  let staged = null;
  let movedCanonical = false;
  let backup = null;
  let retiredLegacy = null;

  const rollbackSwap = async (reasonMsg) => {
    // restore the exact previous state — source first, then canonical
    try {
      if (retiredLegacy && existsSync(join(retiredLegacy, 'dev.db')) && !existsSync(doubled)) {
        renameSync(join(retiredLegacy, 'dev.db'), doubled);
        for (const suffix of ['-wal', '-shm']) {
          const s = join(retiredLegacy, `dev.db${suffix}`);
          if (existsSync(s)) renameSync(s, `${doubled}${suffix}`);
        }
        rmSync(retiredLegacy, { recursive: true, force: true });
        retiredLegacy = null;
      }
      if (report.promoted && existsSync(canonical)) {
        rmSync(canonical, { force: true });
      }
      if (movedCanonical && backup && !existsSync(canonical)) {
        renameSync(backup, canonical);
        for (const suffix of ['-wal', '-shm']) {
          const bs = `${backup}${suffix}`;
          if (existsSync(bs)) renameSync(bs, `${canonical}${suffix}`);
        }
      }
    } catch (e) {
      throw new HealError(`Rollback پس از «${reasonMsg}» هم ناموفق بود: ${e?.message || e}`);
    }
  };

  const cleanupAll = async () => {
    if (lockHeld) { await releaseWriterLock(lockConn); lockHeld = false; }
    await snap?.$disconnect?.().catch(() => {});
    await src?.$disconnect?.().catch(() => {});
    if (staged) { try { rmSync(staged, { force: true }); } catch { /* already moved */ } }
  };

  try {
    // ── 3. SNAPSHOT UNDER THE LOCK (VACUUM INTO reads through the WAL;
    //      reads from other connections are allowed while we hold the
    //      write lock — validated empirically) ──
    src = client(doubled);
    staged = join(prismaDir, `dev.db.heal.${stamp}.snapshot`);
    try {
      await src.$executeRawUnsafe(`VACUUM INTO '${staged.replace(/'/g, "''")}'`);
    } catch (e) {
      throw new HealError(`تهیهٔ snapshot سازگار از دیتابیس قدیمی ناموفق بود: ${e?.message || e}`);
    }
    snap = client(staged);
    await validateSnapshot(snap);
    const snapCounts = {};
    for (const t of ['User', 'Company', 'Center', 'Meta', 'Activity', 'SalesDocument']) {
      const rows = await raw(snap, `SELECT count(*) AS n FROM "${t}"`);
      snapCounts[t] = Number(rows[0]?.n ?? -1);
    }
    for (const k of Object.keys(screenEvidence.counts)) {
      if (snapCounts[k] !== screenEvidence.counts[k]) {
        throw new HealError('نسخهٔ تهیه‌شده با دیتابیس مبدأ هم‌خوانی ندارد.');
      }
    }
    await snap.$disconnect().catch(() => {});
    snap = null; // our own handle is closed BEFORE any rename (Windows rule)
    maybeExitAt('after-snapshot');

    const underLock = await stabilityEvidence(src, doubled); // frozen by the lock
    console.log('  Writer lock held (BEGIN IMMEDIATE): other writers are refused during the transfer.');

    // (test seam) fires INSIDE the locked window — a writer committing
    // here is BLOCKED by SQLite; the heal continues with the frozen content
    if (hooks?.beforeSwap) await hooks.beforeSwap();

    // ── 4. STAGED SWAP (both renames on files WE do not hold open) ──
    if (existsSync(canonical)) {
      backup = join(prismaDir, `dev.db.shipped-${stamp}.bak`);
      renameSync(canonical, backup);
      movedCanonical = true;
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(canonical + suffix)) renameSync(canonical + suffix, `${backup}${suffix}`);
      }
      console.log(`  Shipped database kept as backup: prisma/dev.db.shipped-${stamp}.bak`);
    }
    renameSync(staged, canonical);
    staged = null;
    report.promoted = true;
    report.shippedBackup = backup ? `prisma/dev.db.shipped-${stamp}.bak` : null;
    maybeExitAt('after-swap');

    // ── 5. POST-SWAP evidence (still under the lock — frozen by
    //      construction, checked anyway: belt and braces) ──
    const postSwap = await stabilityEvidence(src, doubled);
    if (!evidenceEqual(underLock, postSwap)) {
      await rollbackSwap('evidence-drift-under-lock');
      throw new HealError('شواهد در طول جایگزینی تغییر کرد — عملیات متوقف و بازگردانده شد.');
    }

    // ── 6. RELEASE the lock; the retire gap begins ──
    await releaseWriterLock(lockConn);
    lockHeld = false;
    await src.$disconnect().catch(() => {});
    src = null;
    if (hooks?.afterUnlock) await hooks.afterUnlock();

    // ── 7. PRE-RETIRE mini-screen (the retire gap): ONE fresh connection,
    //      two evidence reads ~150ms apart. Closing our own connections may
    //      have checkpointed the WAL (a benign file change), so the drift
    //      baseline is re-taken HERE — data_version works within one
    //      connection, so an actively-writing gap writer is caught before
    //      the source moves; anything quieter is caught with certainty by
    //      the content verification below (timing-independent). ──
    if (hooks?.beforeRetire) await hooks.beforeRetire();
    const gap = client(doubled);
    const gapA = await stabilityEvidence(gap, doubled);
    await sleep(150);
    const gapB = await stabilityEvidence(gap, doubled);
    await gap.$disconnect().catch(() => {});
    if (!evidenceEqual(gapA, gapB)) {
      await rollbackSwap('retire-gap-drift');
      throw new HealError(
        'نویسندهٔ فعالی پس از آخرین بررسی روی دیتابیس قدیمی نوشت. عملیات متوقف و به حالت قبل بازگردانده شد؛ ' +
        'برنامه را ببندید و نصب را دوباره اجرا کنید.',
      );
    }

    // ── 8. RETIRE the doubled source — moved, never deleted ──
    const legacyDir = join(prismaDir, `legacy-doubled-${stamp}`);
    mkdirSync(legacyDir, { recursive: true });
    renameSync(doubled, join(legacyDir, 'dev.db'));
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(doubled + suffix)) renameSync(doubled + suffix, join(legacyDir, `dev.db${suffix}`));
    }
    retiredLegacy = legacyDir;
    report.legacyDir = `prisma/legacy-doubled-${stamp}`;
    console.log(`  Retired the old doubled path (preserved, nothing deleted): prisma/legacy-doubled-${stamp}/`);
    maybeExitAt('after-retire');

    // ── 9. CONTENT VERIFICATION — the decisive, timing-independent proof:
    //      re-vacuum the retired source and compare sha256 with the
    //      promoted file. VACUUM INTO is byte-deterministic for identical
    //      logical content, so a mismatch means a commit won the gap →
    //      full rollback + non-zero (the source keeps ALL its data). ──
    const legacyDb = join(legacyDir, 'dev.db');
    const tmpVac = join(prismaDir, `dev.db.heal.${stamp}.verify`);
    const v = client(legacyDb);
    try {
      await v.$executeRawUnsafe(`VACUUM INTO '${tmpVac.replace(/'/g, "''")}'`);
    } finally {
      await v.$disconnect().catch(() => {});
    }
    const match = existsSync(tmpVac) && existsSync(canonical)
      && sha256(tmpVac) === sha256(canonical);
    rmSync(tmpVac, { force: true });
    if (!match) {
      console.error('  [ERROR] Content verification FAILED — a writer committed while the source was being retired.');
      console.error('          Rolling everything back (nothing lost; close the running app and re-run).');
      await rollbackSwap('content-verification');
      throw new HealError(
        'نویسندهٔ فعالی در حین تعیین تکلیف منبع قدیمی نوشت و محتوای مقصد با snapshot نهایی تطبیق نداشت. ' +
        'عملیات متوقف و به حالت قبل بازگردانده شد؛ داده‌ها در مسیر قدیمی سالم هستند.',
      );
    }
    report.verified = true;
    const doubledDir = join(prismaDir, 'prisma');
    try {
      if (readdirSync(doubledDir).length === 0) rmSync(doubledDir, { recursive: true });
    } catch { /* leave the dir if anything is off */ }
  } catch (e) {
    await cleanupAll();
    // a mid-flight failure must leave NO half-swapped state
    if (
      (report.promoted || retiredLegacy)
      && !(e instanceof HealError && /بازگردانده شد/.test(String(e?.message)))
    ) {
      await rollbackSwap('mid-flight-failure').catch(() => { /* best-effort; originals stay */ });
    }
    throw e;
  } finally {
    if (lockHeld) await releaseWriterLock(lockConn).catch(() => {});
  }

  // ── 10. .env path consistency (shared resolver precedence) ──
  fixEnvDatabaseUrl(rootDir, report);

  // the success message is EARNED: the writer was provably blocked
  // during the transfer, and the promoted file's CONTENT was proven
  // equal to the final stable snapshot (sha256).
  const size = statSync(canonical).size;
  console.log(
    `  Live database now at prisma/dev.db (${(size / 1_048_576).toFixed(1)} MB) — transfer under an exclusive writer lock; ` +
    'content verified against the final stable snapshot (sha256 match).',
  );
  return report;
}

// ── main ───────────────────────────────────────────────────
async function main() {
  const report = await healDoubledDatabase(root);
  if (report.envFixFailed) {
    console.error('  [ERROR] The .env database path could not be fixed automatically.');
    console.error('          Edit .env manually: DATABASE_URL="file:./dev.db" — then re-run setup.');
    process.exit(1);
  }
}

// module was IMPORTED (in-process tests) — do not auto-run
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`  [ERROR] DB heal failed: ${e?.message || e}`);
    console.error('          The install stops here. Nothing was deleted; your data is intact.');
    process.exit(1);
  });
}
