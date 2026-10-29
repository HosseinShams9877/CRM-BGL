import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// cartable-territory-parity.test.ts — v2.58.10 (final-review P1)
//
// THE FINAL-REVIEW FINDING (reproduced RED on v2.58.7):
//   addCartablePayment applies the caller's territory scope, but
//   updateCartablePayment / deleteCartablePayment only re-check
//   company + ownership. A province-scoped finance_write user who
//   OWNS a document whose center sits OUTSIDE their province
//   (territory narrowed after creation, or a center move) could
//   still EDIT and DELETE payment rows on that document.
//
// THE CONTRACT (this file pins it):
//   guard order on every cartable payment mutation:
//     company (403) → territory (404 no-leak) → ownership (403)
//   — identical to the add path (cartable-payments.ts add policy).
//   Full cartable holders (accounting_cartable) keep the
//   finance-wide reach — territory never walls them (add parity).
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as cartablePost } from '@/app/api/accounting-cartable/route';

const db = new PrismaClient();
const TAG = `r92terr-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/accounting-cartable', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

async function mkUser(
  username: string,
  role: string,
  companyIds: string[],
  territoryMode: 'country' | 'provinces' = 'country',
  territoryProvinces: string[] = [],
): Promise<TestUser> {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role,
      companyIds: JSON.stringify(companyIds), businessUnitId: 'trading',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode, territoryProvinces: JSON.stringify(territoryProvinces), territoryCenterIds: '[]',
  };
}

// the province-scoped finance_write user (a standard salesperson)
let scopedUser: TestUser;
// full cartable holder, country-wide (control)
let financeUser: TestUser;

let docOutId: string; // scoped user's OWN doc, center OUTSIDE their province
let payOutId: string; // their payment row on that doc
let docInId: string; // scoped user's OWN doc, center INSIDE their province
let payInId: string; // their payment row on that doc
let centerOutId: string;
let centerInId: string;

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  // scoped to Esfahan; the OUT doc's center sits in Tehran
  scopedUser = await mkUser('scoped', 'standard', ['bazargani'], 'provinces', ['اصفهان']);
  financeUser = await mkUser('finance', 'finance', ['bazargani']);

  const centerOut = await db.center.create({
    data: { name: `${TAG}-center-out`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerOutId = centerOut.id;
  const centerIn = await db.center.create({
    data: { name: `${TAG}-center-in`, customerType: 'b2b', companyId: bazargani.id, province: 'اصفهان', businessUnitId: 'trading' },
  });
  centerInId = centerIn.id;

  const docOut = await db.salesDocument.create({
    data: {
      documentNumber: `D-OUT-${TAG}`, documentType: 'proforma', status: 'approved',
      totalAmount: 1_000_000, discountAmount: 0, taxAmount: 0, finalAmount: 1_000_000,
      centerId: centerOut.id, companyId: bazargani.id, businessUnitId: 'trading', createdById: scopedUser.id,
      items: { create: [{ productName: 'x', quantity: 1, unitPrice: 1_000_000, totalPrice: 1_000_000 }] },
    },
  });
  docOutId = docOut.id;
  payOutId = (await db.salesDocumentFinance.create({
    data: { salesDocumentId: docOutId, paymentMethod: 'cash', paymentDate: new Date(), amount: 400_000, description: '', createdById: scopedUser.id },
  })).id;

  const docIn = await db.salesDocument.create({
    data: {
      documentNumber: `D-IN-${TAG}`, documentType: 'proforma', status: 'approved',
      totalAmount: 1_000_000, discountAmount: 0, taxAmount: 0, finalAmount: 1_000_000,
      centerId: centerIn.id, companyId: bazargani.id, businessUnitId: 'trading', createdById: scopedUser.id,
      items: { create: [{ productName: 'y', quantity: 1, unitPrice: 1_000_000, totalPrice: 1_000_000 }] },
    },
  });
  docInId = docIn.id;
  payInId = (await db.salesDocumentFinance.create({
    data: { salesDocumentId: docInId, paymentMethod: 'cash', paymentDate: new Date(), amount: 200_000, description: '', createdById: scopedUser.id },
  })).id;
});

afterAll(async () => {
  for (const docId of [docOutId, docInId]) {
    await db.salesDocumentFinance.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: docId } });
    await db.salesDocument.deleteMany({ where: { id: docId } });
  }
  await db.center.deleteMany({ where: { id: { in: [centerOutId, centerInId] } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

async function amountOf(paymentId: string): Promise<number | null> {
  const row = await db.salesDocumentFinance.findUnique({ where: { id: paymentId } });
  return row ? row.amount : null;
}

describe('PROVINCE-SCOPED finance_write user — their OWN doc OUTSIDE their province', () => {
  it('ADD → 404 (territory wall — the existing add-path contract)', async () => {
    const before = await db.salesDocumentFinance.count({ where: { salesDocumentId: docOutId } });
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'add-payment', salesDocumentId: docOutId, amount: 100_000, paymentMethod: 'cash' })));
    expect(res.status).toBe(404);
    expect(await db.salesDocumentFinance.count({ where: { salesDocumentId: docOutId } })).toBe(before);
  });

  it('UPDATE → 404 (PARITY — the final-review gap), row untouched', async () => {
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'update-payment', paymentId: payOutId, amount: 999_999 })));
    expect(res.status).toBe(404);
    expect(await amountOf(payOutId)).toBe(400_000);
  });

  it('DELETE → 404 (PARITY — the final-review gap), row survives', async () => {
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: payOutId })));
    expect(res.status).toBe(404);
    expect(await amountOf(payOutId)).toBe(400_000);
  });
});

describe('CONTROL — the same user INSIDE their province (ownership + territory pass)', () => {
  it('ADD → 200', async () => {
    const before = await db.salesDocumentFinance.count({ where: { salesDocumentId: docInId } });
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'add-payment', salesDocumentId: docInId, amount: 100_000, paymentMethod: 'cash' })));
    expect(res.status).toBe(200);
    expect(await db.salesDocumentFinance.count({ where: { salesDocumentId: docInId } })).toBe(before + 1);
  });

  it('UPDATE → 200 (their own row, in-province)', async () => {
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'update-payment', paymentId: payInId, amount: 250_000 })));
    expect(res.status).toBe(200);
    expect(await amountOf(payInId)).toBe(250_000);
  });

  it('DELETE → 200 (their own row, in-province)', async () => {
    const res = await asUser(scopedUser, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: payInId })));
    expect(res.status).toBe(200);
    expect(await amountOf(payInId)).toBeNull();
  });
});

describe('CONTROL — full cartable holder (finance) keeps the finance-wide reach (no territory wall)', () => {
  it('UPDATE on the out-of-province doc → 200', async () => {
    const res = await asUser(financeUser, () =>
      cartablePost(req({ action: 'update-payment', paymentId: payOutId, amount: 450_000 })));
    expect(res.status).toBe(200);
    expect(await amountOf(payOutId)).toBe(450_000);
  });

  it('DELETE on the out-of-province doc → 200', async () => {
    const res = await asUser(financeUser, () =>
      cartablePost(req({ action: 'delete-payment', paymentId: payOutId })));
    expect(res.status).toBe(200);
    expect(await amountOf(payOutId)).toBeNull();
  });
});
