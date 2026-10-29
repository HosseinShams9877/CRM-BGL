import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// money-reconciliation-coverage.test.ts — v2.58.11 (independent
// audit 2.58.10, medium finding)
//
// The shipped script scanned a HAND-MAINTAINED list of 10 models and
// silently SKIPPED unreadable ones — while the schema carries 36
// Float columns, 16 of them money-bearing (Product.price,
// SalesReport.totalSales, SalesDocumentItem.discount/unitPrice/
// totalPrice, IssuedInvoiceItem.*, HesabfaItem.*, HesabfaInvoice.*,
// HesabfaContact.balance, AiUsageLog.estimatedCostRial …) that the
// list MISSED, and a read failure certified the whole DB as
// "all integer" anyway.
//
// THE CONTRACT:
//   • the column inventory is DERIVED from prisma/schema.prisma at
//     runtime (Float columns minus the documented non-money set) —
//     a new money column can never again be silently unscanned;
//   • every previously-missed money column is reported as scanned;
//   • a fractional money value → exit 1 with the row listed;
//   • an UNREADABLE model → exit 2 (operational error) — never a
//     clean "all integer" certificate.
// All spawned runs execute against a COPY of this worker's DB.
// ═══════════════════════════════════════════════════════════════

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PrismaClient();
const tempFiles: string[] = [];

async function snapshotTo(target: string): Promise<void> {
  await db.$queryRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  tempFiles.push(target);
}

function runRecon(dbFile: string): { status: number | null; out: string } {
  const res = spawnSync(
    process.execPath,
    [join('scripts', 'money-reconciliation.mjs')],
    { cwd: root, encoding: 'utf8', env: { ...process.env, BGL_RECON_DB: dbFile } },
  );
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

afterAll(async () => {
  for (const f of tempFiles) rmSync(f, { force: true });
  await db.$disconnect();
});

describe('money reconciliation — full coverage, honest failures', () => {
  it('a clean database → exit 0 AND every schema money column is reported as scanned', async () => {
    const copy = join(root, 'prisma', '.test-runs', `recon-clean-${Date.now()}.db`);
    await snapshotTo(copy);
    const r = runRecon(copy);
    expect(r.status).toBe(0);

    // the previously-MISSED money columns must appear in the scanned inventory
    for (const col of [
      'Product.price',
      'SalesReport.totalSales',
      'SalesDocumentItem.discount',
      'SalesDocumentItem.unitPrice',
      'SalesDocumentItem.totalPrice',
      'IssuedInvoiceItem.unitPrice',
      'IssuedInvoiceItem.totalPrice',
      'HesabfaInvoice.totalAmount',
      'HesabfaInvoice.paidAmount',
      'HesabfaItem.buyPrice',
      'HesabfaItem.sellPrice',
      'HesabfaContact.balance',
      'AiUsageLog.estimatedCostRial',
    ]) {
      expect(r.out).toContain(col);
    }
    // the documented non-money Float columns must be listed as excluded
    expect(r.out).toContain('excluded');
  }, 120_000);

  it('a fractional money value → exit 1 with the exact row reported', async () => {
    const copy = join(root, 'prisma', '.test-runs', `recon-bad-${Date.now()}.db`);
    await snapshotTo(copy);
    const probe = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    await probe.product.create({
      data: { code: 'recon-fraction-probe', name: 'recon-fraction-probe', price: 12.5 },
    });
    await probe.$disconnect();

    const r = runRecon(copy);
    expect(r.status).toBe(1);
    expect(r.out).toContain('Product.price');
  }, 120_000);

  it('an UNREADABLE model → exit 2 (never a clean certificate)', async () => {
    const copy = join(root, 'prisma', '.test-runs', `recon-err-${Date.now()}.db`);
    await snapshotTo(copy);
    const probe = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    await probe.$executeRawUnsafe('ALTER TABLE "Product" RENAME TO "Product_sabotaged"');
    await probe.$disconnect();

    const r = runRecon(copy);
    expect(r.status).toBe(2);
    expect(r.out).toContain('Product');

    const restore = new PrismaClient({ datasources: { db: { url: `file:${copy}` } } });
    await restore.$executeRawUnsafe('ALTER TABLE "Product_sabotaged" RENAME TO "Product"');
    await restore.$disconnect();
  }, 120_000);
});
