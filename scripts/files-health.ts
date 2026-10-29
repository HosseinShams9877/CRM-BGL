#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/files-health.ts — v2.58.1 → v2.58.4 (external audit F12)
//
// THE AUDIT FINDING (confirmed on the pre-fix CLI):
//   • the CLI hardcoded <root>/prisma/dev.db — a custom DATABASE_URL
//     (or the .env file the app actually reads) was ignored, so the
//     health report could run against a DIFFERENT database than the app;
//   • .env was never loaded — a custom STORAGE_DIR lived there invisibly;
//   • it reimplemented the recovery logic with a DIFFERENT contract than
//     src/lib/file-lifecycle.ts (any pending row with a final file was
//     promotable — even a 1-second-old ACTIVE upload; no checksum/size
//     validation; .part orphans never collected; failures swallowed).
//
// THE v2.58.4 CLI is a THIN adapter over the shared service:
//   • env resolution mirrors the app (below) — same DB, same storage dir;
//   • report (the DEFAULT) is 100% dry-run;
//   • --sweep delegates to sweepStalePendingFiles() (age-guarded, size+
//     checksum-validated promotes, 'deleting' settlement, orphan .part
//     cleanup, HONEST counters — failures reported, never counted);
//   • --prune deletes the RECORDS whose bytes are gone (explicit opt-in,
//     interactive confirmation; --prune --yes for scripted maintenance).
//
// Usage:
//   npm run files:health            → dry-run report (exit 1 when content
//                                      is missing, so cron/CI can notice)
//   npm run files:health -- --sweep → ALSO recover stale uploads
//   npm run files:sweep             → v2.58.4 (issue 8): the dedicated
//                                      Worker/Job target — run it from
//                                      Task Scheduler / cron to settle
//                                      stale pending uploads regularly
//   npm run files:health -- --prune → ALSO delete orphaned RECORDS
//                                      (needs confirmation, or -- --prune --yes)
//   npm run files:health -- --prune-orphans
//                                    → v2.58.7: safely delete orphaned
//                                      physical FILES (no DB row; 1h grace;
//                                      strict name shape; --yes for scripts)
// ═══════════════════════════════════════════════════════════
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
// v2.58.5 (R7) — the SHARED environment resolver (the same one the
// launcher and the heal use): process env > .env.local > .env > default.
import { resolveAppEnv } from './lib/resolve-env.mjs';

const projectRootDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// v2.58.5 (R7) — an explicit --root=<dir> (or BGL_FILES_HEALTH_ROOT)
// retargets the CLI to inspect ANOTHER install (maintenance/operator
// use); with no override the CLI inspects THIS project — cwd-independent
// either way (the root is anchored at the script's own location).
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const projectRoot = argRoot
  ? resolve(projectRootDefault, argRoot.slice('--root='.length))
  : process.env.BGL_FILES_HEALTH_ROOT
    ? resolve(process.env.BGL_FILES_HEALTH_ROOT)
    : projectRootDefault;

// ── ONE environment resolver, shared with start.mjs / setup-db-heal ─
// v2.58.5 (R7): the old CLI read ONLY .env while the launcher also reads
// .env.local — the two could inspect DIFFERENT databases/storage. Now
// both use scripts/lib/resolve-env.mjs: identical precedence, identical
// Prisma path semantics, root-anchored storage default (cwd-independent).
// The resolved TARGET is printed BEFORE any repair so the operator can
// verify what is about to be inspected — paths only, never secrets.
const eff = resolveAppEnv({ root: projectRoot });
const dbFile = eff.dbFile;
console.log(`[files-health] env resolution: DATABASE_URL ← ${eff.databaseSource}, STORAGE_DIR ← ${eff.storageSource}`);
if (!existsSync(dbFile)) {
  console.error(`[files-health] database not found at ${dbFile} (DATABASE_URL=${eff.databaseUrl ?? 'unset'} from ${eff.databaseSource})`);
  process.exit(1);
}
process.env.DATABASE_URL = `file:${dbFile}`;
// STORAGE_DIR: the resolver's effective value wins (env / .env.local / .env
// or the root-anchored default — same dir the app uses)
process.env.STORAGE_DIR = eff.storageDir;

async function main(): Promise<void> {
  // dynamic import AFTER env resolution — src/lib/db.ts reads
  // DATABASE_URL at module init, and the service must see the resolved one
  const { filesHealthSnapshot, sweepStalePendingFiles, sweepOrphanFinalFiles } = await import('../src/lib/file-lifecycle');
  const { db } = await import('../src/lib/db');

  const snap = await filesHealthSnapshot();
  console.log(`[files-health] database: ${dbFile} (source: ${eff.databaseSource})`);
  console.log(`[files-health] storage: ${eff.storageDir} (source: ${eff.storageSource})`);
  console.log(`[files-health] ${snap.totalRows} File record(s) (${snap.committedRows} committed, ${snap.pendingRows} pending, ${snap.deletingRows} deleting), ${snap.diskObjects} physical object(s)`);

  // v2.58.11 (independent audit P1-3b): a physical-side inspection failure
  // makes the report UNRELIABLE — it is reported loudly and FAILS the run
  // (exit 1) instead of the 2.58.10 "healthy zero orphans" swallow.
  if (snap.errors.length > 0) {
    console.log(`  ⚠ ${snap.errors.length} physical-inspection failure(s) — the physical counters of THIS report are UNRELIABLE:`);
    for (const e of snap.errors) console.log(`      - ${e.slice(0, 200)}`);
    process.exitCode = 1;
  }

  if (snap.pendingRows > 0 || snap.deletingRows > 0) {
    console.log(`  ℹ ${snap.pendingRows} pending upload(s) (${snap.stalePendingRows} stale — a --sweep settles those); ${snap.deletingRows} delete-in-flight row(s)`);
  }

  if (snap.missingContentRows.length === 0) {
    console.log('  ✓ every committed File record has its bytes on disk');
  } else {
    console.log(`  ⚠ ${snap.missingContentRows.length} committed record(s) WITHOUT physical content (reported only — never fabricated):`);
    for (const m of snap.missingContentRows) {
      console.log(`      - ${m.storedName}  «${m.originalName}» ${m.size}B  center=${m.centerId || '—'}  created=${m.createdAt.toISOString().slice(0, 10)}`);
    }
  }
  if (snap.orphanPartFiles > 0) {
    console.log(`  ℹ ${snap.orphanPartFiles} orphan .part temp file(s) (a --sweep removes the stale ones)`);
  }
  if (snap.orphanFinalFiles > 0) {
    console.log(`  ℹ ${snap.orphanFinalFiles} physical object(s) with no DB row (orphaned bytes — a --prune-orphans removes the aged ones safely)`);
  }

  const sweep = process.argv.includes('--sweep');
  if (sweep) {
    console.log('  ↺ sweeping (shared service: age-guarded, checksum-validated, honest counters)…');
    const report = await sweepStalePendingFiles();
    console.log(`    promoted (size+checksum agreed): ${report.promotedRows}`);
    if (report.invalidPendingRows.length > 0) {
      console.log(`    ⚠ promote REFUSED for ${report.invalidPendingRows.length} row(s) (bytes disagree — reported, untouched):`);
      for (const r of report.invalidPendingRows) console.log(`        - ${r.storedName}: ${r.reason}`);
    }
    console.log(`    swept stale uploads: ${report.sweptPendingRows} row(s), ${report.sweptTempFiles} temp file(s)`);
    console.log(`    deleting rows settled: ${report.deletingRowsSettled}`);
    if (report.deletingFailures.length > 0) {
      console.log(`    ⚠ ${report.deletingFailures.length} delete(s) still in flight (rows kept, retried next sweep):`);
      for (const f of report.deletingFailures) console.log(`        - ${f.storedName}`);
    }
    console.log(`    orphan .part removed: ${report.orphanPartFiles}`);
    if (report.errors.length > 0) {
      console.log(`    ⚠ ${report.errors.length} step failure(s) (honestly reported, never counted as success):`);
      for (const e of report.errors) console.log(`        - ${e.slice(0, 160)}`);
    }
    if (report.promotedRows + report.sweptPendingRows + report.deletingRowsSettled + report.orphanPartFiles === 0
      && report.errors.length + report.deletingFailures.length + report.invalidPendingRows.length === 0) {
      console.log('    ✓ nothing to recover');
    }
  }

  const prune = process.argv.includes('--prune');
  if (prune && snap.missingContentRows.length > 0) {
    const yes = process.argv.includes('--yes');
    let confirmed = yes;
    if (!yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      confirmed = await new Promise((res) => {
        rl.question(`Delete the ${snap.missingContentRows.length} orphaned File RECORD(S) listed above? This cannot be undone. Type YES to confirm: `, (a) => { res(a.trim() === 'YES'); });
      });
      rl.close();
    }
    if (!confirmed) {
      console.log('[files-health] declined — nothing deleted (exit 1)');
      await db.$disconnect();
      process.exit(1);
    }
    for (const m of snap.missingContentRows) {
      await db.file.delete({ where: { id: m.id } });
      console.log(`  ✗ deleted record ${m.id} (${m.storedName})`);
    }
    console.log('[files-health] prune complete');
  } else if (snap.missingContentRows.length > 0) {
    // report mode with problems → non-zero exit so CI/cron can notice
    process.exitCode = 1;
  }

  // v2.58.7 (stage 7) — the OTHER orphan direction: physical FINAL files
  // no DB row owns. Report-only by default; --prune-orphans (with the same
  // --yes / interactive-YES convention as --prune) deletes the aged ones
  // through the shared service: strict stored-name shape gate, 1-hour
  // grace window, .part files untouched, DB rows untouched, honest
  // counters. This is the user's stage-7 «File بدون DB Record حذف امن شود».
  const pruneOrphans = process.argv.includes('--prune-orphans');
  if (pruneOrphans) {
    const yesOrphans = process.argv.includes('--yes');
    let confirmedOrphans = yesOrphans;
    if (!yesOrphans && snap.orphanFinalFiles > 0) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      confirmedOrphans = await new Promise((res) => {
        rl.question(`Safely delete the ${snap.orphanFinalFiles} orphaned physical FILE(S) (no DB row, older than 1 hour)? Type YES to confirm: `, (a) => { res(a.trim() === 'YES'); });
      });
      rl.close();
    }
    if (!confirmedOrphans) {
      console.log('[files-health] declined — nothing deleted (exit 1)');
      await db.$disconnect();
      process.exit(1);
    }
    const orphanReport = await sweepOrphanFinalFiles();
    console.log(`  ↺ orphan-bytes prune: removed ${orphanReport.removedFiles} object(s)`);
    if (orphanReport.skippedYoungFiles > 0) {
      console.log(`    ℹ ${orphanReport.skippedYoungFiles} orphan(s) younger than the 1-hour grace window — left alone, retried next run`);
    }
    if (orphanReport.skippedInvalidNames.length > 0) {
      console.log(`    ⚠ ${orphanReport.skippedInvalidNames.length} object(s) with invalid names — reported only, NOT touched:`);
      for (const n of orphanReport.skippedInvalidNames) console.log(`        - ${n}`);
    }
    if (orphanReport.errors.length > 0) {
      console.log(`    ⚠ ${orphanReport.errors.length} failure(s) (honestly reported):`);
      for (const e of orphanReport.errors) console.log(`        - ${e.slice(0, 160)}`);
    }
  }
  await db.$disconnect();
}

main().catch(async (e: unknown) => {
  console.error(`[files-health] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  const { db } = await import('../src/lib/db').catch(() => ({ db: null }) as { db: null });
  await db?.$disconnect();
  process.exit(1);
});
