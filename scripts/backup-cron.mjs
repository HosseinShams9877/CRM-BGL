#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  backup-cron — BGL CRM automated database backup
//  v2.29.0 → v2.58.6 (user finding P5)
//
//  WHAT IT DOES (in order):
//    1. Resolves the SQLite database file through the SHARED resolver
//       (scripts/lib/resolve-env.mjs) — the app's real precedence:
//       process env > .env.local > .env > documented default. The
//       v2.58.5 script parsed .env itself (never .env.local) and had a
//       private candidate list — worse, @prisma/client AUTO-LOADS the
//       repository .env into process.env at import time, which silently
//       overrode the script's own precedence logic (the snapshot-before-
//       require pattern below closes that; same lesson as setup-db-heal).
//    2. Creates a TRANSACTIONALLY CONSISTENT live snapshot via
//       VACUUM INTO '<backup>.db' — safe while the CRM is running
//       (WAL included), no service stop needed.
//    3. VERIFIES the backup by opening it and running PRAGMA quick_check.
//       A backup that was never verified is not a backup (INSTALL.md §10-1).
//    4. Rotates: keeps the newest --keep snapshots, deletes the rest.
//    5. Optionally (--with-files) archives the uploads directory —
//       resolved through the same shared resolver (a RELATIVE
//       STORAGE_DIR is root-anchored, matching the running app).
//
//  USAGE (production cron — daily at 02:30):
//    30 2 * * * cd /opt/bgl-crm && node scripts/backup-cron.mjs >> backups/backup.log 2>&1
//
//  FLAGS:
//    --out DIR       backup directory (default: <project>/backups)
//    --keep N        snapshots to keep (default: 14)
//    --with-files    also tar.gz the uploads dir (requires `tar`)
//    --quiet         log only errors and the final summary
//
//  EXIT CODES: 0 = verified backup written; 1 = anything less.
//  Zero dependencies beyond @prisma/client (already installed).
// ═══════════════════════════════════════════════════════════════

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'module';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppEnv } from './lib/resolve-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// (P5) snapshot the environment BEFORE @prisma/client is loaded: the
// Prisma runtime AUTO-LOADS the repository .env into process.env at
// require time, which would silently override the operator's real
// precedence (env > .env.local > .env). Capturing it first keeps the
// resolution honest; @prisma/client comes in lazily via createRequire.
const initialEnv = { ...process.env };
const require = createRequire(join(projectRoot, 'package.json'));
const { PrismaClient } = require('@prisma/client');

// ── CLI flags ──
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const OUT_DIR = resolve(flag('out', join(projectRoot, 'backups')));
const KEEP = Number(flag('keep', '14')) || 14;
const WITH_FILES = argv.includes('--with-files');
const QUIET = argv.includes('--quiet');

const log = (...a) => { if (!QUIET) console.log(...a); };
const fail = (msg) => { console.error(`[backup] خطا: ${msg}`); process.exit(1); };

// ── 1. Resolve the database + storage through the SHARED resolver ──
const eff = resolveAppEnv({ root: projectRoot, env: initialEnv });
const dbPath = eff.dbFile;

if (!existsSync(dbPath)) {
  fail(`فایل دیتابیس پیدا نشد: ${dbPath} (منبع: ${eff.databaseSource}) — ابتدا 'npm run db:push && npm run db:seed' را اجرا کنید.`);
}
log(`[backup] دیتابیس: ${dbPath} (${(statSync(dbPath).size / 1048576).toFixed(1)} MB — منبع: ${eff.databaseSource})`);
if (eff.storageConflict) {
  console.warn(`[backup] هشدار تعارض مسیر ذخیره‌سازی: مقصد مؤثر ${eff.storageConflict.effective} است اما پوشهٔ قدیمی ${eff.storageConflict.legacy} هم داده دارد — فایل‌ها جابه‌جا نشدند؛ ادغام را دستی بررسی کنید.`);
}
log(`[backup] محل فایل‌ها: ${eff.storageDir} (منبع: ${eff.storageSource})`);

// ── 2. Live consistent snapshot via VACUUM INTO ──
mkdirSync(OUT_DIR, { recursive: true });
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19); // YYYY-MM-DD-HH-MM-SS
// VACUUM INTO refuses to overwrite an existing file. Two runs in the
// same second (manual re-runs, scripted retries) must not crash —
// find the first free filename instead.
let backupPath = join(OUT_DIR, `bgl-backup-${ts}.db`);
for (let i = 1; existsSync(backupPath); i++) {
  backupPath = join(OUT_DIR, `bgl-backup-${ts}-${i}.db`);
}

const main = new PrismaClient({
  datasources: { db: { url: `file:${dbPath}?connection_limit=1` } },
});
// VACUUM cannot run inside a transaction — $executeRawUnsafe is
// auto-commit, which is exactly what we need.
const sqlPath = backupPath.replace(/'/g, "''");
try {
  await main.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);
} catch (e) {
  await main.$disconnect();
  fail(`VACUUM INTO شکست خورد: ${e.message}`);
}
await main.$disconnect();
log(`[backup] snapshot ساخته شد: ${backupPath}`);

// ── 3. VERIFY the backup (quick_check on the copy itself) ──
const verify = new PrismaClient({
  datasources: { db: { url: `file:${backupPath}?connection_limit=1` } },
});
try {
  const rows = await verify.$queryRawUnsafe('PRAGMA quick_check');
  const verdict = rows && rows[0] && rows[0].quick_check;
  await verify.$disconnect();
  if (verdict !== 'ok') fail(`راستی‌آزمایی پشتیبان ناموفق بود (quick_check = ${verdict}).`);
} catch (e) {
  await verify.$disconnect();
  fail(`بازکردن فایل پشتیبان برای راستی‌آزمایی شکست خورد: ${e.message}`);
}
log('[backup] راستی‌آزمایی: quick_check = ok');

// ── 4. Rotate old snapshots ──
const backups = readdirSync(OUT_DIR)
  .filter((f) => /^bgl-backup-.*\.db$/.test(f))
  .map((f) => ({ f, m: statSync(join(OUT_DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
for (const old of backups.slice(KEEP)) {
  try {
    unlinkSync(join(OUT_DIR, old.f));
    log(`[backup] چرخش: ${old.f} حذف شد (نگهداری ${KEEP} نسخهٔ اخیر).`);
  } catch {
    /* non-fatal: worst case an old file lingers */
  }
}

// ── 5. Optional uploads archive (root-anchored STORAGE_DIR) ──
let filesNote = '';
if (WITH_FILES) {
  const uploadsDir = eff.storageDir;
  if (existsSync(uploadsDir)) {
    // Reuse the same unique suffix as the .db snapshot so a rerun in the
    // same second pairs its files unambiguously (tar refuses to overwrite).
    const suffix = backupPath.slice(backupPath.indexOf(ts) + ts.length, -3) || '';
    let archive = join(OUT_DIR, `bgl-uploads-${ts}${suffix}.tar.gz`);
    for (let i = 1; existsSync(archive); i++) {
      archive = join(OUT_DIR, `bgl-uploads-${ts}${suffix}-${i}.tar.gz`);
    }
    try {
      execFileSync('tar', ['-czf', archive, '-C', dirname(uploadsDir), basenameOf(uploadsDir)], {
        stdio: 'pipe',
      });
      const sz = (statSync(archive).size / 1048576).toFixed(1);
      log(`[backup] فایل‌های بارگذاری‌شده: ${archive} (${sz} MB)`);
      filesNote = ` + uploads ${sz}MB`;
      // rotate uploads archives too
      const archives = readdirSync(OUT_DIR)
        .filter((f) => /^bgl-uploads-.*\.tar\.gz$/.test(f))
        .map((f) => ({ f, m: statSync(join(OUT_DIR, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      for (const old of archives.slice(KEEP)) unlinkSync(join(OUT_DIR, old.f));
    } catch (e) {
      fail(`آرشیو uploads شکست خورد (tar لازم است): ${e.message}`);
    }
  } else {
    log('[backup] پوشهٔ uploads وجود ندارد — از آرشیو فایل‌ها صرف‌نظر شد.');
  }
}

const sizeMb = (statSync(backupPath).size / 1048576).toFixed(1);
console.log(`[backup] OK — ${backupPath} (${sizeMb} MB${filesNote}) — ${new Date().toISOString()}`);
process.exit(0);

function basenameOf(p) {
  return p.split('/').filter(Boolean).pop() || 'uploads';
}
