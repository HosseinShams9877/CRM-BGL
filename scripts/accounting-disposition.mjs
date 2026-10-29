#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/accounting-disposition.mjs — v2.58.10 (ported from the
// B-package's operator tool; adapted to the shared resolve-env
// contract so CLI/app/launcher agree on ONE database + ONE storage
// folder).
//
// READ-ONLY disposition report for the two legacy data conditions
// previous audits found in the operational database:
//   A) SalesDocumentFinance factors whose owning document has no
//      attributable center account (8 rows in the last verified
//      operational state — round 86/90 reports);
//   B) committed File records whose physical bytes are missing
//      (2 rows in the last verified operational state).
//
// POLICY (the user's explicit instruction): NEVER auto-delete,
// rebuild, or attach these rows to a GUESSED center. This tool only
// REPORTS them with the exact identifiers an administrator needs to
// decide; every disposition option is manual and documented in the
// output itself. It performs ZERO writes.
//
// Usage:
//   node scripts/accounting-disposition.mjs
//   node scripts/accounting-disposition.mjs --root=D:\BGL-CRM
//   BGL_DISPOSITION_DB=/path/to/dev.db node scripts/accounting-disposition.mjs
// ═══════════════════════════════════════════════════════════
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRootDefault = resolve(here, '..');
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const root = argRoot
  ? resolve(projectRootDefault, argRoot.slice('--root='.length))
  : process.env.BGL_DISPOSITION_ROOT
    ? resolve(process.env.BGL_DISPOSITION_ROOT)
    : projectRootDefault;

// resolve the DB through the ONE shared path contract (cwd-independent)
const { resolveAppEnv } = await import('./lib/resolve-env.mjs');
const eff = resolveAppEnv({ root });
const dbFile = process.env.BGL_DISPOSITION_DB
  ? resolve(process.env.BGL_DISPOSITION_DB)
  : eff.dbFile;
const storageDir = eff.storageDir;

if (!existsSync(dbFile)) {
  console.error(`[disposition] database not found: ${dbFile}`);
  console.error('                run from the project root, pass --root=<dir>, or set BGL_DISPOSITION_DB.');
  process.exit(1);
}

const require = createRequire(join(root, 'package.json'));
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

function money(n) {
  return Number(n ?? 0).toLocaleString('fa-IR');
}

console.log('══════════════════════════════════════════════════');
console.log('  BGL CRM — گزارش تعیین تکلیف اسناد/فاکتورهای بدون مرکز و فایل‌های مفقود');
console.log(`  دیتابیس: ${dbFile} (منبع: ${eff.databaseSource})`);
console.log('  (فقط گزارش — هیچ داده‌ای حذف، بازسازی یا به مرکز حدسی متصل نمی‌شود)');
console.log('══════════════════════════════════════════════════');

// ── A) finance factors with no attributable center (SalesDocument.centerId) ──
const orphanFactors = await db.$queryRawUnsafe(`
  SELECT f.id, f."salesDocumentId", f.amount, f."paymentDate", f.description,
         d."documentNumber", d.status AS "docStatus", d."createdAt", d."centerId"
  FROM "SalesDocumentFinance" f
  LEFT JOIN "SalesDocument" d ON d.id = f."salesDocumentId"
  WHERE d."centerId" IS NULL
  ORDER BY f."paymentDate" ASC
`);
console.log('');
console.log(`(الف) ردیف‌های مالی اسناد بدون مرکز (SalesDocument.centerId): ${orphanFactors.length} ردیف`);
if (orphanFactors.length === 0) {
  console.log('  ✓ هیچ ردیفی یافت نشد.');
} else {
  for (const r of orphanFactors) {
    console.log(`  - سند: ${r.documentNumber || '—'} · مبلغ: ${money(r.amount)} ریال`);
    console.log(`    تاریخ: ${r.paymentDate ? new Date(r.paymentDate).toISOString().slice(0, 10) : '—'} · شرح: ${(r.description || '—').slice(0, 60)}`);
    console.log(`    documentId: ${r.salesDocumentId} · status: ${r.docStatus || '—'}`);
  }
  console.log('');
  console.log('  گزینه‌های تعیین تکلیف (تصمیم با مدیر — هیچ‌کدام خودکار اجرا نمی‌شود):');
  console.log('   ۱. اگر سند متعلق به مرکزی است که بعداً حذف/بایگانی شده، با ابزار حسابداری');
  console.log('       مبلغ را به سند جدید همان مرکز منتقل و ردیف قدیمی را با یادداشت ابطال کنید.');
  console.log('   ۲. اگر سند آزمایشی/خطای ورود داده بوده، در حضور مدیر مالی ابطال مستند انجام شود');
  console.log('       (هرگز حذف خام SQL انجام نشود — رکورد حسابرسی باید بماند).');
  console.log('   ۳. در هر حالت، جمع کل این ردیف‌ها را در گزارش‌های وصولی با شراکت مدیر مالی تطبیق دهید.');
}

// ── B) committed File records without bytes ──
const missingFiles = await db.$queryRawUnsafe(`
  SELECT id, "storedName", "originalName", size, "centerId", "createdAt"
  FROM "File" WHERE status = 'committed'
`);
console.log('');
console.log(`(ب) رکوردهای فایل committed بدون محتوای فیزیکی (بررسی در پوشهٔ ذخیره‌سازی): ${missingFiles.length} رکورد بررسی شد`);
const ghosts = [];
for (const f of missingFiles) {
  const p = join(storageDir, f.storedName);
  let present = true;
  try { statSync(p); } catch { present = false; }
  if (!present) ghosts.push(f);
}
console.log(`  پوشهٔ ذخیره‌سازی: ${storageDir} (منبع: ${eff.storageSource})`);
if (ghosts.length === 0) {
  console.log('  ✓ همهٔ رکوردها محتوای فیزیکی خود را دارند.');
} else {
  for (const g of ghosts) {
    console.log(`  - ${g.storedName} «${g.originalName}» ${money(g.size)}B · center=${g.centerId || '—'} · ${new Date(g.createdAt).toISOString().slice(0, 10)}`);
  }
  console.log('');
  console.log('  گزینه‌های تعیین تکلیف (تصمیم با مدیر — هیچ‌کدام خودکار اجرا نمی‌شود):');
  console.log('   ۱. اگر نسخهٔ پشتیبان فایل موجود است، آن را با checksum یکسان به پوشهٔ ذخیره‌سازی برگردانید.');
  console.log('   ۲. اگر فایل واقعاً از دست رفته، رکورد را با ابزار رسمی حذف کنید');
  console.log('       (npx tsx scripts/files-health.ts --prune — با تأیید تعاملی؛ نه حذف خام SQL).');
  console.log('   ۳. اگر فایل هنوز در سیستم مشتری هست، دوباره بارگذاری و رکورد قدیمی را حذف کنید.');
}

console.log('');
console.log('پایان گزارش — هیچ تغییری روی داده‌ها انجام نشد.');
await db.$disconnect();
