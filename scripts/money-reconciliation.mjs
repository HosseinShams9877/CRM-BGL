#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// scripts/money-reconciliation.mjs — v2.58.10 → v2.58.11
// (independent audit 2.58.10, medium finding)
//
// WHAT CHANGED (v2.58.11): the shipped script scanned a HAND-MAINTAINED
// list of 10 models and SILENTLY SKIPPED unreadable ones — while the
// schema carries 36 Float columns, 16+ of them money-bearing that the
// list missed (Product.price, SalesReport.totalSales,
// SalesDocumentItem.discount/unitPrice/totalPrice, IssuedInvoiceItem.*,
// HesabfaItem.*, HesabfaInvoice.*, HesabfaContact.balance,
// AiUsageLog.estimatedCostRial …), and a read failure still certified
// the whole database as "all integer".
//
// THE NEW CONTRACT:
//   • the column inventory is DERIVED from prisma/schema.prisma at
//     runtime — every Float column of every model, minus a DOCUMENTED
//     non-money exclusion set (confidence / percents / quantities /
//     minQty). A NEW money column can never again be silently
//     unscanned; a new non-money Float name WILL be flagged for a
//     human decision (read-only report — the safe direction to err);
//   • every scanned column is LISTED in the output (auditable
//     coverage — no invisible gaps);
//   • an UNREADABLE model is an OPERATIONAL ERROR (exit 2) — never a
//     clean certificate over an unscanned table;
//   • NEVER writes, NEVER rounds: disposition belongs to a human with
//     the accounting tools (FINANCIAL-PRECISION.md §2/§4).
//
// Exit codes: 0 = all money values integer · 1 = non-integer values
// found (reported) · 2 = operational error.
// ═══════════════════════════════════════════════════════════
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const projectRootDefault = resolve(here, '..');
const argRoot = process.argv.find((a) => a.startsWith('--root='));
const root = argRoot ? resolve(projectRootDefault, argRoot.slice('--root='.length)) : projectRootDefault;

const { resolveAppEnv } = await import('./lib/resolve-env.mjs');
const eff = resolveAppEnv({ root });
const dbFile = process.env.BGL_RECON_DB ? resolve(process.env.BGL_RECON_DB) : eff.dbFile;

if (!existsSync(dbFile)) {
  console.error(`[reconciliation] database not found: ${dbFile}`);
  process.exit(2);
}

// ── schema-derived inventory (line-based parse; robust to the "{}"
// strings inside @default(...) that break naive block regexes) ──
const schemaPath = join(root, 'prisma', 'schema.prisma');
if (!existsSync(schemaPath)) {
  console.error(`[reconciliation] schema not found: ${schemaPath}`);
  process.exit(2);
}

/** Float columns that are DOCUMENTED non-money (rates, ratios, counts).
 *  Anything else that is Float is treated as money — the failure
 *  direction is a false POSITIVE report line for a human, never a
 *  silent gap. */
const NON_MONEY_FLOAT_COLUMNS = new Set([
  'confidence',        // AI analysis confidence (0..1)
  'commissionPercent', // rates, not rial
  'discountPercent',   // rates, not rial
  'quantity',          // counts (fractional units are legitimate)
  'minQty',            // counts
]);

function schemaFloatColumns() {
  const models = new Map(); // Model → [columns]
  let current = null;
  for (const rawLine of readFileSync(schemaPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, ''); // strip comments
    const start = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/);
    if (start) { current = start[1]; models.set(current, []); continue; }
    if (current && /^\}/.test(line)) { current = null; continue; }
    if (!current) continue;
    const field = line.trim().match(/^([A-Za-z0-9_]+)\s+Float\b/);
    if (field) models.get(current).push(field[1]);
  }
  return models;
}

const floatModels = schemaFloatColumns();
const inventory = []; // { model, column, money }
for (const [model, columns] of floatModels) {
  for (const column of columns) {
    inventory.push({ model, column, money: !NON_MONEY_FLOAT_COLUMNS.has(column) });
  }
}
const moneyColumns = inventory.filter((i) => i.money);
const excludedColumns = inventory.filter((i) => !i.money);

console.log('══════════════════════════════════════════════════');
console.log('  BGL CRM — سازگارسازی ستون‌های پولی (فقط-خواندنی)');
console.log(`  دیتابیس: ${dbFile}`);
console.log('  (هیچ داده‌ای تغییر نمی‌کند — گزارش موارد غیرصحیح برای تصمیم مدیر)');
console.log(`  منبع فهرست ستون‌ها: prisma/schema.prisma (${inventory.length} ستون Float؛ ${moneyColumns.length} پولی؛ ${excludedColumns.length} مستثنی)`);
console.log(`  excluded (غیرپولی، مستند): ${[...NON_MONEY_FLOAT_COLUMNS].join(' · ')}`);
console.log('══════════════════════════════════════════════════');

const require2 = createRequire(join(root, 'package.json'));
const { PrismaClient } = require2('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

let issues = 0;
let scanned = 0;
const operationalErrors = [];
try {
  for (const { model, column } of moneyColumns) {
    const accessor = model.charAt(0).toLowerCase() + model.slice(1);
    // v2.58.11: a missing model/column accessor is SCHEMA DRIFT, not a
    // skip — the generated client disagrees with the schema this tool
    // just parsed. Fail loudly (exit 2), never certify the blind spot.
    if (!db[accessor] || typeof db[accessor].findMany !== 'function') {
      operationalErrors.push(`${model}: مدل در کلاینت Prisma در دسترس نیست (drift بین اسکیما و کلاینت).`);
      continue;
    }
    let rows;
    try {
      rows = await db[accessor].findMany({ select: { id: true, [column]: true } });
    } catch (e) {
      // v2.58.11 (audit): an UNREADABLE table is an honest operational
      // error — the old code skipped it and still printed the clean
      // "همهٔ مقادیر پولی عدد صحیح" certificate.
      operationalErrors.push(`${model}.${column}: خواندن ناموفق — ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
      continue;
    }
    let nonInteger = 0;
    for (const row of rows) {
      const v = row[column];
      if (v === null || v === undefined) continue;
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        issues++;
        nonInteger++;
        console.log(`  ⚠ ${model}.${column} = ${v} (ردیف ${row.id})`);
      }
    }
    scanned += rows.length;
    console.log(`  ✓ ${model}.${column}: ${rows.length.toLocaleString('en-US')} ردیف${nonInteger ? ` (${nonInteger.toLocaleString('en-US')} غیرصحیح)` : ''}`);
  }

  console.log('');
  console.log(`  ردیف‌های اسکن‌شده: ${scanned.toLocaleString('fa-IR')} در ${moneyColumns.length} ستون پولی از ${new Set(moneyColumns.map((m) => m.model)).size} مدل`);

  if (operationalErrors.length > 0) {
    console.log(`  ✗ ${operationalErrors.length} خطای عملیاتی (اسکن کامل نبود — گواهی صادر نمی‌شود):`);
    for (const e of operationalErrors) console.log(`      - ${e}`);
    await db.$disconnect();
    process.exit(2);
  }

  if (issues === 0) {
    console.log('  ✓ همهٔ مقادیر پولی عدد صحیح ریال‌اند — هیچ اقدامی لازم نیست.');
  } else {
    console.log(`  ⚠ ${issues.toLocaleString('fa-IR')} مقدار غیرصحیح یافت شد (گزارش بالا).`);
    console.log('    تعیین تکلیف: گردکردن به نزدیک ریال با تأیید مدیر مالی (FINANCIAL-PRECISION.md §۴).');
  }
  await db.$disconnect();
  process.exit(issues === 0 ? 0 : 1);
} catch (e) {
  console.error(`[reconciliation] خطای عملیاتی: ${String(e)}`);
  await db.$disconnect().catch(() => undefined);
  process.exit(2);
}
