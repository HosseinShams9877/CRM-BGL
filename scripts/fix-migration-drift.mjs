#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/fix-migration-drift.mjs — v2.58.10 (final-review P1)
//
// THE FINDING (reproduced on the 2.58.7 operational DB): the stored
// checksums of two APPLIED migrations (v2520_company_print_template,
// v2580_audit_indexes_uniques) no longer match the shipped migration
// files, because later hardening rounds legitimately edited those
// files (round 86 moved the HesabfaContact statements into v2581).
// `migrate deploy` does not verify applied checksums (Prisma 6.19,
// verified empirically), but `migrate dev` refuses with a checksum
// mismatch and offers a RESET — a data-loss trap for a local
// Windows install.
//
// VERIFIED PRECONDITION (the reason this reconciliation is safe):
// a fresh `migrate deploy` of the shipped files lands at the SAME
// logical schema as the operational DB (verified object-by-object;
// the only differences were cosmetic column-order/line-wrap in
// CREATE TABLE text). The files are the canonical set.
//
// WHAT THIS SCRIPT DOES (fail-closed, backup-first, opt-in):
//   1. Backs up the DB (VACUUM INTO <db>.pre-drift-fix-<ts>.db) —
//      the same mechanism the backup route uses; the live file is
//      never written before the backup succeeds.
//   2. For every APPLIED migration whose stored checksum differs
//      from its file's sha-256: rewrites the checksum row to the
//      FILE hash (bringing the provenance table in line with the
//      canonical files) — ONLY with an explicit --confirm.
//   3. Verifies every migration folder is marked applied (a folder
//      on disk that the DB does not know about is REPORTED and
//      left alone — that case needs `prisma migrate resolve`,
//      never a checksum edit).
//   4. Prints a full before/after report and re-reads the table to
//      prove the write landed.
//
// Usage:
//   node scripts/fix-migration-drift.mjs                 (report only)
//   node scripts/fix-migration-drift.mjs --confirm       (apply)
//   node scripts/fix-migration-drift.mjs --root=D:\BGL   (another install)
//
// Exit codes (the protocol setup.sh / setup.bat gate on — v2.58.11):
//   0 — clean (or no DB yet: a fresh install has nothing applied)
//   2 — drift DETECTED, nothing written (report mode)
//   1 — operational error
// ═════════════════════════════════════════════════════════════
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRootDefault = resolve(here, '..');
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const root = argRoot
  ? resolve(projectRootDefault, argRoot.slice('--root='.length))
  : projectRootDefault;
const confirm = process.argv.includes('--confirm');

const { resolveAppEnv } = await import('./lib/resolve-env.mjs');
const eff = resolveAppEnv({ root });
const dbFile = process.env.BGL_DRIFT_DB ? resolve(process.env.BGL_DRIFT_DB) : eff.dbFile;
const migrationsDir = join(root, 'prisma', 'migrations');

if (!existsSync(dbFile)) {
  // v2.58.11 (audit P1-4): a fresh install has NO database yet — zero
  // applied migrations means zero drift, and the setup gate must PASS so
  // `prisma migrate deploy` can create the schema from the shipped files
  // (the release package ships no DB since the v2.58.10 P0 fix).
  console.log('[drift-fix] no database yet (fresh install) — nothing applied, no drift.');
  process.exit(0);
}
if (!existsSync(migrationsDir)) {
  console.error(`[drift-fix] migrations folder not found: ${migrationsDir}`);
  process.exit(1);
}

const require2 = createRequire(join(root, 'package.json'));
const { PrismaClient } = require2('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

// file hashes of every migration folder on disk
const fileHashes = new Map();
for (const d of readdirSync(migrationsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  try {
    const sql = readFileSync(join(migrationsDir, d.name, 'migration.sql'));
    fileHashes.set(d.name, createHash('sha256').update(sql).digest('hex'));
  } catch {
    console.error(`[drift-fix] unreadable migration folder: ${d.name}`);
    process.exit(1);
  }
}

const rows = await db.$queryRawUnsafe(
  'SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" ORDER BY migration_name',
);
console.log('══════════════════════════════════════════════════');
console.log('  BGL CRM — آشتی‌سازی checksum مهاجرت‌های اعمال‌شده با فایل‌های مرجع');
console.log(`  دیتابیس: ${dbFile}`);
console.log(`  مهاجرت‌های اعمال‌شده: ${rows.length} · پوشه‌های روی دیسک: ${fileHashes.size}`);
console.log(`  حالت اجرا: ${confirm ? 'APPLY (--confirm)' : 'فقط گزارش'}`);
console.log('══════════════════════════════════════════════════');

const drifted = [];
const unappliedFolders = [];
for (const row of rows) {
  const fileHash = fileHashes.get(row.migration_name);
  if (fileHash === undefined) {
    console.log(`  ✗ اعمال‌شده بدون پوشه: ${row.migration_name} — این ابزار دست نمی‌زند؛ با تیم پشتیبانی بررسی شود.`);
    continue;
  }
  if (fileHash !== row.checksum) {
    drifted.push({ name: row.migration_name, oldChecksum: row.checksum, newChecksum: fileHash });
  }
}
for (const name of fileHashes.keys()) {
  if (!rows.find((r) => r.migration_name === name)) {
    unappliedFolders.push(name);
  }
}

if (unappliedFolders.length > 0) {
  console.log('');
  console.log('  ⚠ پوشه‌های موجود که در DB اعمال نشده‌اند (فقط گزارش — نیاز به prisma migrate resolve --applied):');
  for (const n of unappliedFolders) console.log(`    - ${n}`);
}

if (drifted.length === 0) {
  console.log('');
  console.log('  ✓ هیچ drift ای وجود ندارد — checksum همهٔ مهاجرت‌های اعمال‌شده با فایل‌ها یکی است.');
  await db.$disconnect();
  process.exit(0);
}

console.log('');
console.log(`  drift های یافت‌شده: ${drifted.length}`);
for (const d of drifted) {
  console.log(`    - ${d.name}`);
  console.log(`        db  : ${d.oldChecksum}`);
  console.log(`        file: ${d.newChecksum}`);
}

if (!confirm) {
  console.log('');
  console.log('  اجرای مجدد با --confirm اعمال می‌کند (پشتیبان‌گیری خودکار قبل از نوشتن).');
  await db.$disconnect();
  process.exit(2); // drift exists, not applied
}

// ── backup FIRST (VACUUM INTO — the same mechanism as the backup route)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupPath = `${dbFile}.pre-drift-fix-${stamp}.db`;
await db.$queryRawUnsafe(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
if (!existsSync(backupPath)) {
  console.error('  ✗ پشتیبان‌گیری شکست خورد — هیچ تغییری نوشته نمی‌شود (fail-closed).');
  await db.$disconnect();
  process.exit(1);
}
console.log('');
console.log(`  پشتیبان ساخته شد: ${backupPath}`);

// ── apply the checksum reconciliation (one UPDATE per drifted row)
for (const d of drifted) {
  await db.$executeRawUnsafe(
    'UPDATE "_prisma_migrations" SET checksum = $1 WHERE migration_name = $2',
    d.newChecksum,
    d.name,
  );
}

// ── verify the write landed (re-read)
const after = await db.$queryRawUnsafe('SELECT migration_name, checksum FROM "_prisma_migrations"');
let bad = 0;
for (const d of drifted) {
  const row = after.find((r) => r.migration_name === d.name);
  if (!row || row.checksum !== d.newChecksum) {
    console.error(`  ✗ راستی‌آزمایی پس از نوشتن شکست خورد: ${d.name}`);
    bad++;
  } else {
    console.log(`  ✓ ${d.name} → ${row.checksum}`);
  }
}
await db.$disconnect();
if (bad > 0) {
  console.error('  برخی ردیف‌ها نوشته نشدند — پشتیبان را نگاه دارید و با پشتیبانی بررسی کنید.');
  process.exit(1);
}
console.log('');
console.log(`  انجام شد — ${drifted.length} checksum با فایل‌های مرجع همسان شد.`);
console.log('  حالا prisma migrate status باید «up to date» بدهد.');
console.log(`  برای بازگردانی: فایل DB را با ${backupPath} جایگزین کنید.`);
