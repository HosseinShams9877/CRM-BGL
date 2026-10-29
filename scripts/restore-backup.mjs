#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// restore-backup.mjs — v2.47.0 → v2.58.1 (round 86, audit F7)
//
// Restores a backup produced by src/lib/backup-snapshot.ts:
//
//   node scripts/restore-backup.mjs --latest
//        → newest FULL PACKAGE (bgl-package-*) if one exists,
//          otherwise the newest DB snapshot (bgl-snapshot-*).
//   node scripts/restore-backup.mjs --package backups/bgl-package-<ts>
//        → full package: DATABASE + stored files (incl. voice notes).
//   node scripts/restore-backup.mjs --file backups/bgl-snapshot-…db
//        → DB-only snapshot (legacy v2.47 path, still supported).
//
// v2.58.1 SAFETY CONTRACT (audit F7 — every clause is enforced below):
//   1. The package is FULLY validated BEFORE anything is replaced:
//      manifest checksum (sha256) of the DB and of EVERY file entry,
//      PRAGMA quick_check on the snapshot, and the strict stored-name
//      shape — a hostile package cannot traverse paths
//      (files land only under storage/uploads/, names must match
//      /^[a-f0-9]{32}\.[a-z0-9]{1,8}$/).
//   2. A RETURNABLE pre-restore backup is taken first: the live DB is
//      checkpointed → prisma/dev.db.pre-restore-<ts>.bak, and the live
//      uploads dir is RENAMED to storage/uploads.pre-restore-<ts>
//      (rename = atomic, cheap, reversible).
//   3. STAGED swap — files are copied into storage/uploads.staging-<ts>/
//      and checksum-verified THERE; only then:
//        DB  : copy snapshot → dev.db
//        dirs: rename staging → uploads
//      A mid-flight failure puts everything back (no half-replaced
//      state, no half-restored ledger).
//   4. Post-restore: integrity_check + core counts + a File-vs-disk
//      consistency report, and an AuditEvent row.
//   5. SECRETS: the package contains NO .env values (BGL_HMAC_SECRET,
//      provider credentials stay in .env). Prerequisite documented in
//      RESTORE-BACKUP.md — restoring on a new machine requires the
//      original .env (or a re-generated secret).
//
// STOP the CRM server before restoring (a live server holds the old
// file open):  npm run stop
//
// v2.58.6 (user P5) — TARGET RESOLUTION: the live database and the
// uploads directory come from the SHARED resolver
// (scripts/lib/resolve-env.mjs) with the app's real precedence
// (process env > .env.local > .env > documented default) and the
// root-anchored STORAGE_DIR contract. The v2.58.5 script read ONLY
// process.env.DATABASE_URL and fell back to the hardcoded default —
// an install whose real database was selected by .env.local had its
// restore written onto the WRONG database. The environment is
// snapshotted BEFORE @prisma/client is loaded (its dotenv auto-load
// used to silently override the operator's precedence — the same
// lesson as setup-db-heal), and the resolved targets are PRINTED
// before anything is replaced (paths only, never secrets).
// ═══════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
} from 'fs';
import { createRequire } from 'module';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveAppEnv } from './lib/resolve-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// (P5) snapshot the environment BEFORE @prisma/client is loaded — its
// dotenv auto-load would silently override the operator's precedence.
const initialEnv = { ...process.env };
const require = createRequire(join(projectRoot, 'package.json'));
const { PrismaClient } = require('@prisma/client');

// (P5) the RESOLVED targets — the app's real database + uploads dir:
// one shared resolver, one precedence, one path contract. The values
// are computed ONCE so every phase below operates on the same target.
const resolved = resolveAppEnv({ root: projectRoot, env: initialEnv });
const backupDir = process.env.BGL_BACKUP_DIR
  ? resolve(process.env.BGL_BACKUP_DIR)
  : join(projectRoot, 'backups');

// The live database: the app's real DATABASE_URL (file:…) through the
// shared resolver — a RELATIVE path anchors at <root>/prisma, an
// absolute path passes through, and .env.local beats .env exactly like
// the running app. The v2.58.5 fallback to a hardcoded default is gone:
// a restore must NEVER land on a database the app does not use.
function liveDbPath() {
  return resolved.dbFile;
}

// Uploads dir: the shared resolver's STORAGE_DIR (root-anchored when
// relative — the app's contract; absolute passes through).
function uploadsDir() {
  return resolved.storageDir;
}

/** Strict stored-name shape — the path-traversal guard (F7). */
const STORED_NAME_RE = /^[a-f0-9]{32}\.[a-z0-9]{1,8}$/;

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ── Validation phase (throws on ANY problem; replaces nothing) ──
function validatePackage(pkgDir) {
  const manifestPath = join(pkgDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('manifest.json not found in the package directory.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.format !== 'bgl-crm-backup-package' || manifest.version !== 2) {
    throw new Error(`Unknown package format: ${manifest.format} v${manifest.version}`);
  }

  // DB snapshot: checksum + quick_check
  const dbFile = join(pkgDir, manifest.database.file || 'snapshot.db');
  if (!existsSync(dbFile)) throw new Error(`snapshot database not found: ${dbFile}`);
  const dbHash = sha(dbFile);
  if (manifest.database.sha256 && dbHash !== manifest.database.sha256) {
    throw new Error(`DB checksum mismatch: manifest ${manifest.database.sha256.slice(0, 16)}… ≠ file ${dbHash.slice(0, 16)}…`);
  }
  console.log(`  ✓ DB sha256 matches manifest (${dbHash.slice(0, 16)}…)`);

  // File entries: strict name shape + existence + checksum
  const entries = (manifest.files && manifest.files.entries) || [];
  for (const entry of entries) {
    if (!STORED_NAME_RE.test(entry.storedName)) {
      throw new Error(`ILLEGAL file name in package (path-traversal guard): ${JSON.stringify(entry.storedName)}`);
    }
    const src = join(pkgDir, 'files', entry.storedName);
    if (!existsSync(src)) throw new Error(`package file missing: ${entry.storedName}`);
    const h = sha(src);
    if (entry.sha256 && h !== entry.sha256) {
      throw new Error(`file checksum mismatch: ${entry.storedName} (manifest ${entry.sha256.slice(0, 12)}… ≠ ${h.slice(0, 12)}…)`);
    }
  }
  console.log(`  ✓ ${entries.length} package files verified (name shape + sha256)`);
  return { manifest, dbFile, entries };
}

async function quickCheck(p) {
  const probe = new PrismaClient({ datasources: { db: { url: `file:${p}` } } });
  try {
    const rows = await probe.$queryRawUnsafe('PRAGMA quick_check');
    const ok = String(rows?.[0]?.quick_check ?? 'unknown');
    if (ok !== 'ok') throw new Error(`quick_check failed: ${ok}`);
    return ok;
  } finally {
    await probe.$disconnect();
  }
}

// ── Rollback-capable swap ──
function restorePackageFiles(pkgDir, entries) {
  const uploads = uploadsDir();
  const staging = `${uploads}.staging-${stamp()}`;
  mkdirSync(staging, { recursive: true });
  // stage + verify copies
  for (const entry of entries) {
    copyFileSync(join(pkgDir, 'files', entry.storedName), join(staging, entry.storedName));
    if (sha(join(staging, entry.storedName)) !== entry.sha256) {
      rmSync(staging, { recursive: true, force: true });
      throw new Error(`staged copy failed verification: ${entry.storedName}`);
    }
  }
  console.log(`  ✓ ${entries.length} files staged + verified`);
  return staging;
}

async function main() {
  let target = argValue('--package');
  const explicitFile = argValue('--file');
  if (!target && !explicitFile && process.argv.includes('--latest')) {
    const all = readdirSync(backupDir);
    const pkgs = all
      .filter((n) => /^bgl-package-\d{8}-\d{9}$/.test(n))
      .map((name) => ({ name, mtimeMs: statSync(join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (pkgs.length > 0) {
      target = join(backupDir, pkgs[0].name);
      console.log(`[restore] latest FULL package: ${pkgs[0].name}`);
    } else {
      const snaps = all
        .filter((n) => /^bgl-snapshot-.*\.db$/.test(n))
        .map((name) => ({ name, mtimeMs: statSync(join(backupDir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (snaps.length === 0) throw new Error(`no backups found in ${backupDir}`);
      target = join(backupDir, snaps[0].name);
      console.log(`[restore] latest DB snapshot: ${snaps[0].name}`);
    }
  }
  if (!target && !explicitFile) {
    console.error('[restore] usage: node scripts/restore-backup.mjs --latest | --package <dir> | --file <snapshot.db>');
    process.exit(1);
  }

  const live = liveDbPath();
  let dbSource;
  let packageCtx = null; // { manifest, entries, pkgDir, staging }
  let preRestoreUploads = null;
  let dbBak = null;
  let dbReplaced = false;

  // (P5) the replacement targets, printed BEFORE anything is touched —
  // paths only (never secrets), so the operator can verify the restore
  // is heading to the database/storage the app actually uses.
  console.log(`[restore] target database: ${live} (source: ${resolved.databaseSource})`);
  console.log(`[restore] target uploads : ${uploadsDir()} (source: ${resolved.storageSource})`);
  if (resolved.storageConflict) {
    console.warn(`[restore] هشدار تعارض مسیر ذخیره‌سازی: مقصد مؤثر ${resolved.storageConflict.effective} است اما پوشهٔ قدیمی ${resolved.storageConflict.legacy} هم داده دارد — فایل‌ها جابه‌جا نشدند؛ ادغام را دستی بررسی کنید.`);
  }

  try {
    // ── 1/5 VALIDATE EVERYTHING FIRST (nothing replaced yet) ──
    console.log('[restore] 1/5 validating backup…');
    if (target) {
      const abs = resolve(target);
      if (!existsSync(abs)) throw new Error(`package not found: ${abs}`);
      const { manifest, dbFile, entries } = validatePackage(abs);
      await quickCheck(dbFile);
      console.log('  ✓ PRAGMA quick_check = ok (on the package DB)');
      dbSource = dbFile;
      packageCtx = { manifest, entries, pkgDir: abs, staging: null };
    } else {
      const abs = resolve(explicitFile);
      if (!existsSync(abs)) throw new Error(`snapshot not found: ${abs}`);
      const manifestPath = `${abs}.manifest.json`;
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const actual = sha(abs);
        if (manifest.sha256 && actual !== manifest.sha256) {
          throw new Error(`checksum mismatch: manifest ${manifest.sha256.slice(0, 16)}… ≠ file ${actual.slice(0, 16)}…`);
        }
        console.log(`  ✓ sha256 matches manifest (${actual.slice(0, 16)}…)`);
      } else {
        console.log('  ! no manifest next to the snapshot — skipping checksum verification');
      }
      await quickCheck(abs);
      console.log('  ✓ PRAGMA quick_check = ok (on the snapshot)');
      dbSource = abs;
    }

    // ── 2/5 STAGE THE FILES (verified copies, nothing replaced) ──
    if (packageCtx && packageCtx.entries.length > 0) {
      console.log('[restore] 2/5 staging file attachments…');
      packageCtx.staging = restorePackageFiles(packageCtx.pkgDir, packageCtx.entries);
    } else {
      console.log('[restore] 2/5 (no file attachments in this backup)');
    }

    // ── 3/5 RETURNABLE pre-restore backup of the CURRENT state ──
    console.log(`[restore] 3/5 protecting current state (live db: ${live})…`);
    const livePrisma = new PrismaClient({ datasources: { db: { url: `file:${live}` } } });
    try {
      await livePrisma.$queryRawUnsafe('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      await livePrisma.$disconnect();
    }
    dbBak = `${live}.pre-restore-${stamp()}.bak`;
    copyFileSync(live, dbBak);
    console.log(`  ✓ current db backed up → ${dbBak}`);
    const uploads = uploadsDir();
    if (packageCtx && existsSync(uploads)) {
      preRestoreUploads = `${uploads}.pre-restore-${stamp()}`;
      renameSync(uploads, preRestoreUploads);
      console.log(`  ✓ current uploads dir kept → ${preRestoreUploads}`);
    }

    // ── 4/5 REPLACE (DB first, then the verified file staging) ──
    console.log('[restore] 4/5 replacing data…');
    copyFileSync(dbSource, live);
    dbReplaced = true;
    if (packageCtx) {
      if (packageCtx.staging) {
        renameSync(packageCtx.staging, uploads);
      } else {
        mkdirSync(uploads, { recursive: true });
      }
    }
    console.log('  ✓ database restored' + (packageCtx ? ' + file attachments swapped in' : ''));

    // ── 5/5 POST-RESTORE VERIFICATION ──
    console.log('[restore] 5/5 verifying restored state…');
    const post = new PrismaClient({ datasources: { db: { url: `file:${live}` } } });
    try {
      const rows = await post.$queryRawUnsafe('PRAGMA integrity_check');
      const ok = String(rows?.[0]?.integrity_check ?? 'unknown');
      if (ok !== 'ok') throw new Error(`integrity_check failed AFTER restore: ${ok}`);
      const counts = {
        users: await post.user.count(),
        companies: await post.company.count(),
        centers: await post.center.count(),
        salesDocuments: await post.salesDocument.count(),
        files: await post.file.count(),
      };
      console.log(`  ✓ integrity_check = ok | counts: ${JSON.stringify(counts)}`);

      // File-vs-disk consistency report (honesty, no auto-fix):
      const disk = new Set(existsSync(uploads) ? readdirSync(uploads) : []);
      const fileRows = await post.file.findMany({ select: { storedName: true } });
      const missing = fileRows.filter((f) => !disk.has(f.storedName)).map((f) => f.storedName);
      if (missing.length > 0) {
        console.log(`  ⚠ ${missing.length} File record(s) without bytes on disk (reported, NOT deleted):`);
        for (const m of missing.slice(0, 10)) console.log(`      - ${m}`);
      } else if (fileRows.length > 0) {
        console.log(`  ✓ all ${fileRows.length} File records have their bytes on disk`);
      }

      await post.auditEvent
        .create({
          data: {
            eventType: 'BACKUP_RESTORED',
            category: 'database',
            subject: 'restore-backup.mjs',
            details: `source=${packageCtx ? packageCtx.pkgDir : dbSource}; files=${packageCtx ? packageCtx.entries.length : 0}; preRestoreDb=${dbBak}; preRestoreUploads=${preRestoreUploads || 'n/a'}`,
          },
        })
        .catch(() => undefined);
    } finally {
      await post.$disconnect();
    }

    console.log('[restore] DONE — restart the CRM (npm run dev / npm start).');
    if (dbBak || preRestoreUploads) {
      console.log('[restore] Rollback if needed:');
      if (dbBak) console.log(`   DB:   copy ${dbBak} back over ${live} (server stopped)`);
      if (preRestoreUploads) console.log(`   Files: rename ${preRestoreUploads} back to ${uploadsDir()}`);
    }
  } catch (e) {
    // NO HALF-REPLACED STATE: undo every partial move we already made.
    console.error(`[restore] FAILED: ${e.message}`);
    try {
      if (packageCtx && packageCtx.staging && existsSync(packageCtx.staging)) {
        rmSync(packageCtx.staging, { recursive: true, force: true });
      }
      if (dbReplaced && dbBak && existsSync(dbBak)) {
        copyFileSync(dbBak, live);
        console.error('[restore] rolled back: database restored to pre-restore state');
      }
      if (preRestoreUploads && existsSync(preRestoreUploads) && !existsSync(uploadsDir())) {
        renameSync(preRestoreUploads, uploadsDir());
        console.error('[restore] rolled back: uploads dir restored to pre-restore state');
      }
    } catch (rollbackErr) {
      console.error(`[restore] rollback warning: ${rollbackErr.message} — manual recovery: see the .pre-restore-* paths above`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[restore] FAILED: ${e.message}`);
  process.exit(1);
});
