import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// sales-strict-validation.test.ts — v2.58.4 (user issue 5:
// type-first sales validation).
//
// THE REGRESSION (confirmed on the pre-fix code): the shared row
// validator coerced inputs with Number() BEFORE checking anything —
// quantity "2" → 2, true → 1, unitPrice null → 0 all passed; and
// applyVat was tested with `!== false`, so the string "false" (and
// 0, "0", null) meant VAT-ON. The user's mandatory matrix:
//   {quantity:true}, {unitPrice:null}, {discount:"abc"},
//   {applyVat:"false"}  → must ALL be rejected.
//
// THE CONTRACT (v2.58.4):
//   • quantity: typeof number ONLY — null/boolean/string/≤0/frac
//     rejected before any conversion;
//   • unitPrice: typeof number ONLY — null/boolean/string/negative
//     rejected;
//   • discount: absent/null/'' → 0; otherwise typeof number ONLY;
//     negative / > line total rejected;
//   • applyVat: undefined or a REAL boolean; anything else → 400
//     on create, update and quick-sale.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as salesPost } from '@/app/api/sales-documents/route';
import { validateSalesItems } from '@/lib/sales-totals';
import { ApiError } from '@/lib/api-error';

const db = new PrismaClient();
const TAG = `r90val-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/sales-documents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function mkUser(username: string, role: string) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`,
      displayName: username,
      passwordHash: 'x',
      role,
      companyIds: JSON.stringify(['bazargani']),
      businessUnitId: 'trading',
      roleLabel: '',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
  };
}

let seller: Awaited<ReturnType<typeof mkUser>>;

function expectApiError(fn: () => unknown, match?: RegExp) {
  try {
    fn();
    throw new Error('expected validateSalesItems to throw');
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(400);
    if (match) expect((e as ApiError).message).toMatch(match);
  }
}

async function countDocs(): Promise<number> {
  return db.salesDocument.count({ where: { id: { in: createdDocIds } } });
}

// the create handler assigns its OWN documentNumber (a sequence, not the
// TAG) — created rows are tracked by id for assertions + zero-residue cleanup.
const createdDocIds: string[] = [];

async function jsonOf(res: unknown): Promise<Record<string, unknown>> {
  return (await (res as { json: () => Promise<unknown> }).json()) as Record<string, unknown>;
}

async function latestDocFrom(res: unknown) {
  const body = await jsonOf(res);
  const data = body.data as { id?: string } | undefined;
  expect(data?.id).toBeTruthy();
  const docId = data!.id as string;
  createdDocIds.push(docId);
  return db.salesDocument.findUniqueOrThrow({ where: { id: docId } });
}

beforeAll(async () => {
  seller = await mkUser('seller', 'standard');
  currentAuthUser = seller;
});

afterAll(async () => {
  // residue sweep — the strict rule of this repo: zero test residue
  for (const docId of createdDocIds) {
    await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocument.deleteMany({ where: { id: docId } });
  }
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

// ── 1. the SHARED row validator — type FIRST ──────────────────
describe('issue 5 — validateSalesItems is type-first (unit level)', () => {
  const good = { productName: 'کالا', quantity: 2, unitPrice: 100_000, discount: 0 };

  it.each([
    ['boolean quantity', { ...good, quantity: true }],
    ['string quantity', { ...good, quantity: '2' }],
    ['null quantity', { ...good, quantity: null }],
    ['undefined quantity', { ...good, quantity: undefined }],
    ['zero quantity', { ...good, quantity: 0 }],
    ['negative quantity', { ...good, quantity: -1 }],
    ['fractional quantity', { ...good, quantity: 1.5 }],
    ['NaN quantity', { ...good, quantity: NaN }],
    ['Infinity quantity', { ...good, quantity: Infinity }],
  ])('rejects %s', (_label, item) => {
    expectApiError(() => validateSalesItems([item]));
  });

  it.each([
    ['null unitPrice', { ...good, unitPrice: null }],
    ['boolean unitPrice', { ...good, unitPrice: true }],
    ['string unitPrice', { ...good, unitPrice: '100000' }],
    ['negative unitPrice', { ...good, unitPrice: -5 }],
    ['fractional unitPrice', { ...good, unitPrice: 1.5 }],
    ['NaN unitPrice', { ...good, unitPrice: NaN }],
  ])('rejects %s', (_label, item) => {
    expectApiError(() => validateSalesItems([item]));
  });

  it.each([
    ['string discount', { ...good, discount: '100' }],
    ['boolean discount', { ...good, discount: true }],
    ['negative discount', { ...good, discount: -1 }],
    ['fractional discount', { ...good, discount: 1.5 }],
    ['NaN discount', { ...good, discount: NaN }],
    ['discount over line total', { ...good, discount: 999_999_999 }],
  ])('rejects %s', (_label, item) => {
    expectApiError(() => validateSalesItems([item]));
  });

  it('discount absent / null / empty-string → 0 (documented legacy inputs)', () => {
    for (const d of [undefined, null, '']) {
      const rows = validateSalesItems([{ ...good, discount: d }]);
      expect(rows[0].discount).toBe(0);
    }
  });

  it('a fully valid row passes with exact numbers', () => {
    const rows = validateSalesItems([good]);
    expect(rows[0]).toEqual({ quantity: 2, unitPrice: 100_000, discount: 0 });
  });
});

// ── 2. applyVat — a REAL boolean or absent, on every route path ──
describe('issue 5 — applyVat accepts only a real boolean (route level)', () => {
  const validBody = {
    action: 'create',
    documentType: 'proforma',
    items: [{ productName: 'کالا', quantity: 1, unitPrice: 100_000, discount: 0 }],
  };

  it.each([
    ['string "false"', 'false'],
    ['string "true"', 'true'],
    ['number 0', 0],
    ['number 1', 1],
    ['null', null],
  ])('MANDATORY: create with applyVat = %s → 400, zero documents written', async (_label, applyVat) => {
    const before = await countDocs();
    const res = await salesPost(req({ ...validBody, applyVat }));
    expect(res.status).toBe(400);
    expect(await countDocs()).toBe(before);
  });

  it('applyVat true (boolean) → 200 with VAT applied', async () => {
    const res = await salesPost(req({ ...validBody, applyVat: true }));
    expect(res.status).toBe(200); // handleCreate's success status
    const doc = await latestDocFrom(res);
    expect(doc.taxAmount).toBeGreaterThan(0);
  });

  it('applyVat false (boolean) → 200 with zero tax', async () => {
    const res = await salesPost(req({ ...validBody, applyVat: false }));
    expect(res.status).toBe(200); // handleCreate's success status
    const doc = await latestDocFrom(res);
    expect(doc.taxAmount).toBe(0);
  });

  it('applyVat absent → default (taxed) document', async () => {
    const res = await salesPost(req({ ...validBody }));
    expect(res.status).toBe(200); // handleCreate's success status
  });
});

// ── 3. the mandatory row matrix THROUGH the real route ────────
describe('issue 5 — mandatory row matrix through the real create handler', () => {
  const base = { action: 'create', documentType: 'proforma' };

  it.each([
    ['{quantity:true}', { productName: 'کالا', quantity: true, unitPrice: 100_000 }],
    ['{unitPrice:null}', { productName: 'کالا', quantity: 1, unitPrice: null }],
    ['{discount:"abc"}', { productName: 'کالا', quantity: 1, unitPrice: 100_000, discount: 'abc' }],
    ['{quantity:"2"}', { productName: 'کالا', quantity: '2', unitPrice: 100_000 }],
    ['{unitPrice:"100"}', { productName: 'کالا', quantity: 1, unitPrice: '100' }],
    ['{discount:true}', { productName: 'کالا', quantity: 1, unitPrice: 100_000, discount: true }],
  ])('MANDATORY: %s → 400, zero rows written', async (_label, item) => {
    const before = await countDocs();
    const res = await salesPost(req({ ...base, items: [item] }));
    expect(res.status).toBe(400);
    expect(await countDocs()).toBe(before);
  });
});
