import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ═══════════════════════════════════════════════════════════════
// invoice-ownership.test.ts — v2.58.4 (external audit F05)
//
// THE AUDIT FINDING (confirmed on the pre-fix code): salesperson A
// creates a proforma; manager/finance B approves it; the DERIVED
// invoice sales document was written with createdById = B (the
// technical approver). Under the ownership-based visibility policy
// (createdById IS the commercial owner for standard roles), A then
// lost access to the final invoice of their own sale.
//
// THE CONTRACT (v2.58.4):
//   • the commercial owner of a derived document INHERITS from the
//     source document (createdById = source.createdById);
//   • the real approver stays recorded as approvedById + in the log —
//     the audit trail is NOT forged;
//   • A can 'get' their derived invoice; B (finance) still can (scope);
//   • legacy rows are repaired ONLY via the actual migration SQL
//     (executed here from the migration file itself — not a copy),
//     with a backup table for reversibility.
// ═══════════════════════════════════════════════════════════════

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as salesPost } from '@/app/api/sales-documents/route';

const db = new PrismaClient();
const TAG = `r89f5-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/sales-documents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

async function mkUser(username: string, role: string, companyIds: string[]) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(companyIds),
      businessUnitId: 'trading',
      territoryMode: 'country',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
}

let sellerA: Awaited<ReturnType<typeof mkUser>>;
let approverB: Awaited<ReturnType<typeof mkUser>>;
let centerId = '';
let proformaId = '';

const ITEM = { productName: `${TAG} کالا`, quantity: 2, unitPrice: 5_000_000, discount: 0 };

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  sellerA = await mkUser('seller-a', 'standard', ['bazargani']);
  approverB = await mkUser('approver-b', 'finance', ['bazargani']);
  const center = await db.center.create({
    data: { name: `${TAG}-مرکز`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;

  // A creates the proforma (draft) and submits it for approval
  const created = await asUser(sellerA, () => salesPost(req({
    action: 'create', documentType: 'proforma', centerId, description: `${TAG} پیش‌فاکتور`, items: [ITEM],
  })));
  expect(created.status).toBe(200);
  const createdBody = await jsonOf(created);
  proformaId = String((createdBody.data as { id: string } | undefined)?.id ?? '');
  expect(proformaId).toBeTruthy();

  const submitted = await asUser(sellerA, () => salesPost(req({ action: 'submit-approval', id: proformaId })));
  expect(submitted.status).toBe(200);
});

afterAll(async () => {
  await db.salesDocument.deleteMany({ where: { description: { startsWith: TAG } } });
  await db.salesDocument.deleteMany({ where: { documentNumber: { startsWith: `PF-` } } }).catch(() => undefined);
  await db.center.deleteMany({ where: { name: { startsWith: `${TAG}-` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('F05 — the derived invoice keeps the SELLER as commercial owner', () => {
  it('B approves A\u2019s proforma → the derived invoice is createdById = A (seller), approvedById = B (approver kept)', async () => {
    const approved = await asUser(approverB, () => salesPost(req({ action: 'approve', id: proformaId, comment: 'تأیید تست' })));
    expect(approved.status).toBe(200);

    const invoice = await db.salesDocument.findFirst({
      where: { sourceDocumentId: proformaId, documentType: 'invoice' },
    });
    expect(invoice).toBeTruthy();
    expect(invoice!.createdById).toBe(sellerA.id); // THE audit assertion
    expect(invoice!.approvedById).toBe(approverB.id); // the real approver stays recorded

    // the audit trail keeps the honest story: the APPROVAL record and the
    // proforma's log carry the real approver (B) — never forged onto the seller
    const approval = await db.salesDocumentApproval.findFirst({
      where: { salesDocumentId: proformaId, action: 'approved' },
    });
    expect(approval?.userId).toBe(approverB.id);
    const proformaLog = await db.salesDocumentLog.findFirst({
      where: { salesDocumentId: proformaId, action: 'approve' },
    });
    expect(proformaLog?.userId).toBe(approverB.id);
  });

  it('seller A can GET their derived invoice (ownership path works again)', async () => {
    const invoice = await db.salesDocument.findFirst({ where: { sourceDocumentId: proformaId } });
    expect(invoice).toBeTruthy();
    const res = await asUser(sellerA, () => salesPost(req({ action: 'get', id: invoice!.id })));
    expect(res.status).toBe(200); // pre-fix: 404 — the seller lost their own invoice
  });
});

describe('F05 — legacy backfill (the REAL migration SQL, executed from the migration file)', () => {
  it('repairs only valid sourceDocumentId chains and writes the backup table', async () => {
    // legacy state: an old derived invoice whose owner was flipped to the
    // approver (B), plus a chain whose SOURCE has no creator (must NOT be
    // repaired — no guessing a null owner)
    const legacy = await db.salesDocument.create({
      data: {
        businessUnitId: 'trading', centerId, companyId: null,
        sourceDocumentId: proformaId, documentNumber: `${TAG}-LEG-INV`,
        documentType: 'invoice', status: 'approved',
        totalAmount: 100, finalAmount: 100,
        createdById: approverB.id, // the bug: approver recorded as owner
        items: { create: [{ productName: 'x', quantity: 1, unitPrice: 100, totalPrice: 100 }] },
      },
    });
    const creatorlessSource = await db.salesDocument.create({
      data: {
        businessUnitId: 'trading', centerId, companyId: null,
        documentNumber: `${TAG}-NOOWNER`, documentType: 'proforma', status: 'approved',
        totalAmount: 100, finalAmount: 100, createdById: null,
        items: { create: [{ productName: 'x', quantity: 1, unitPrice: 100, totalPrice: 100 }] },
      },
    });
    const noGuess = await db.salesDocument.create({
      data: {
        businessUnitId: 'trading', centerId, companyId: null,
        sourceDocumentId: creatorlessSource.id, documentNumber: `${TAG}-NOGUESS`,
        documentType: 'invoice', status: 'approved',
        totalAmount: 100, finalAmount: 100,
        createdById: approverB.id,
        items: { create: [{ productName: 'x', quantity: 1, unitPrice: 100, totalPrice: 100 }] },
      },
    });

    // execute the ACTUAL migration SQL from the migration directory
    const migrationDir = join(projectRoot, 'prisma', 'migrations');
    const { readdirSync } = await import('node:fs');
    const dirs = readdirSync(migrationDir).filter((d) => d.includes('v2611'));
    expect(dirs.length).toBe(1);
    const sql = readFileSync(join(migrationDir, dirs[0], 'migration.sql'), 'utf8');
    // strip comment lines FIRST (they may contain semicolons), then split
    const codeOnly = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const statement of codeOnly.split(';')) {
      if (!statement.trim()) continue;
      await db.$executeRawUnsafe(statement.trim());
    }

    const fixed = await db.salesDocument.findUnique({ where: { id: legacy.id } });
    expect(fixed?.createdById).toBe(sellerA.id); // repaired from the source chain

    const untouched = await db.salesDocument.findUnique({ where: { id: noGuess.id } });
    expect(untouched?.createdById).toBe(approverB.id); // creator-less source → no guessing

    // the backup table captured the pre-repair value (reversible)
    const backup = await db.$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM _v2611_owner_backfill_backup WHERE invoiceId = '${legacy.id}'`,
    ) as Array<{ n: number }>;
    expect(Number(backup[0]?.n ?? 0)).toBe(1);

    await db.salesDocument.deleteMany({ where: { documentNumber: { startsWith: `${TAG}-` } } });
  });
});
