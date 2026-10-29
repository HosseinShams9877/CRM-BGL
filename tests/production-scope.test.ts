import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// production-scope.test.ts — v2.58.7 (G3)
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): the
// production route's READ paths (list / get) scoped rows by company,
// but `update-status` re-read the row with a bare findUnique and
// `list-inbox` queried {status:'pending'} with NO company fragment —
// the WRITE surface was wider than the READ surface (a company-stamped
// request outside the caller's companies was transitionable while
// being invisible in their UI).
//
// THE CONTRACT: write scope == read scope. The SHARED queue
// (companyId null) stays visible/transitionable to every production
// user — that is the documented design, preserved.
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as productionPost } from '@/app/api/production/route';

const db = new PrismaClient();
const TAG = `r97pr-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/production', {
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

async function mkUser(username: string, role: string, companyIds: string[]): Promise<TestUser> {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username, passwordHash: 'x', role,
      companyIds: JSON.stringify(companyIds), businessUnitId: 'trading',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds, jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
}

let prodBazargani: TestUser;
let requestAriaId: string; // company-stamped OUTSIDE the caller's companies
let requestSharedId: string; // companyId null — the shared queue
let requestOwnId: string; // company-stamped INSIDE the caller's companies

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const aria = (await db.company.findFirst({ where: { slug: 'aria' } }))!;
  prodBazargani = await mkUser('prod-bg', 'production', ['bazargani']);

  requestAriaId = (await db.productionPurchaseRequest.create({
    data: { title: `درخواست ${TAG} الف`, status: 'pending', companyId: aria.id, requestedBy: prodBazargani.id },
  })).id;
  requestSharedId = (await db.productionPurchaseRequest.create({
    data: { title: `درخواست ${TAG} مشترک`, status: 'pending', companyId: null, requestedBy: prodBazargani.id },
  })).id;
  requestOwnId = (await db.productionPurchaseRequest.create({
    data: { title: `درخواست ${TAG} ب`, status: 'pending', companyId: bazargani.id, requestedBy: prodBazargani.id },
  })).id;
});

afterAll(async () => {
  await db.productionPurchaseRequest.deleteMany({ where: { title: { startsWith: `درخواست ${TAG}` } } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('G3 — production update-status write scope == read scope', () => {
  it('REGRESSION GUARD: an out-of-company-stamped request is NOT transitionable (was: writable while invisible)', async () => {
    const res = await asUser(prodBazargani, () =>
      productionPost(req({ action: 'update-status', id: requestAriaId, status: 'approved' })));
    expect(res.status).toBe(404);
    const row = await db.productionPurchaseRequest.findUnique({ where: { id: requestAriaId } });
    expect(row?.status).toBe('pending');
  });

  it('CONTROL: the shared (companyId null) queue stays transitionable — documented design', async () => {
    const res = await asUser(prodBazargani, () =>
      productionPost(req({ action: 'update-status', id: requestSharedId, status: 'approved' })));
    expect(res.status).toBe(200);
    const row = await db.productionPurchaseRequest.findUnique({ where: { id: requestSharedId } });
    expect(row?.status).toBe('approved');
  });

  it('CONTROL: the own-company request is transitionable', async () => {
    const res = await asUser(prodBazargani, () =>
      productionPost(req({ action: 'update-status', id: requestOwnId, status: 'approved' })));
    expect(res.status).toBe(200);
  });
});

describe('G3 — list-inbox is company-scoped now', () => {
  it('the out-of-company pending request does NOT appear in the inbox', async () => {
    // reset ALL three rows to pending so the only discriminator is the company scope
    await db.productionPurchaseRequest.updateMany({
      where: { title: { startsWith: `درخواست ${TAG}` } },
      data: { status: 'pending' },
    });
    const res = await asUser(prodBazargani, () => productionPost(req({ action: 'list-inbox' })));
    expect(res.status).toBe(200);
    const body = (await (res as { json(): Promise<unknown> }).json()) as { items: Array<{ id: string }> };
    const ids = body.items.map((i) => i.id);
    expect(ids).not.toContain(requestAriaId);
    expect(ids).toContain(requestSharedId); // shared queue still visible
    expect(ids).toContain(requestOwnId); // own company visible
  });
});
