import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { reconcileCustomerMemoryDuplicates } from '@/lib/ai/memory-dedupe';

// ═══════════════════════════════════════════════════════════════
// memory-dedupe.test.ts — v2.58.7 (D2 — the AiCustomerMemory
// duplicate race).
//
// THE REGRESSION (confirmed on the schema + write paths): no unique
// constraint exists on (companyId, centerId, contactId) — contactId is
// NULLABLE and SQLite treats NULLs as distinct, so even a partial
// unique index cannot fully bind the key. Both write paths did
// findFirst → update-or-create; two concurrent writers for one center
// both saw "not found" and both created. Reads (findFirst) then
// flipped nondeterministically between the rows.
//
// THE CONTRACT:
//   • reconcileCustomerMemoryDuplicates removes every duplicate for the
//     key, keeping the LATEST updatedAt row
//   • the MANUAL route write (ai-sales/memory update) now runs in ONE
//     transaction with an in-tx re-check + reconcile — a pre-seeded
//     duplicate collapses to a single row, keeping the newest content
// (the ENGINE path's reconcile rides the same shared helper inside
//  its fenced transaction — exercised by ai-pipeline-resume tests.)
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
  };
});

import { POST as memoryPost } from '@/app/api/ai-sales/memory/route';

const db = new PrismaClient();
const TAG = `r97mem-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ai-sales/memory', {
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

let standardUser: TestUser;
let centerId: string;

beforeAll(async () => {
  const bazargani = (await db.company.findFirst({ where: { slug: 'bazargani' } }))!;
  const u = await db.user.create({
    data: {
      username: `${TAG}-user`, displayName: 'mem user', passwordHash: 'x', role: 'standard',
      companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
    },
  });
  standardUser = {
    id: u.id, username: u.username, displayName: u.displayName, role: 'standard', roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  };
  const center = await db.center.create({
    data: { name: `${TAG}-center`, customerType: 'b2b', companyId: bazargani.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;
});

afterAll(async () => {
  await db.aiCustomerMemory.deleteMany({ where: { centerId } });
  await db.center.deleteMany({ where: { name: `${TAG}-center` } });
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('unit — reconcileCustomerMemoryDuplicates', () => {
  it('keeps exactly the LATEST row for the key and removes the rest', async () => {
    // simulate the race result: three rows for one (center, null contact)
    const rows = await Promise.all([
      db.aiCustomerMemory.create({ data: { companyId: (await db.center.findUnique({ where: { id: centerId } }))!.companyId, centerId, contactId: null, summary: 'اولین', source: 'ai' } }),
      db.aiCustomerMemory.create({ data: { companyId: (await db.center.findUnique({ where: { id: centerId } }))!.companyId, centerId, contactId: null, summary: 'دومین', source: 'ai' } }),
    ]);
    // age the first row so the ordering is deterministic
    await db.aiCustomerMemory.update({
      where: { id: rows[0].id },
      data: { updatedAt: new Date(Date.now() - 60_000) },
    });
    const removed = await reconcileCustomerMemoryDuplicates(db, centerId, null);
    expect(removed).toBe(1);
    const survivors = await db.aiCustomerMemory.findMany({ where: { centerId, contactId: null } });
    expect(survivors).toHaveLength(1);
    expect(survivors[0].summary).toBe('دومین'); // keep-latest
  });

  it('a single (or missing) row is a clean no-op', async () => {
    expect(await reconcileCustomerMemoryDuplicates(db, centerId, null)).toBe(0);
    expect(await reconcileCustomerMemoryDuplicates(db, 'nonexistent-center', null)).toBe(0);
  });

  it('contact-scoped keys are reconciled independently', async () => {
    const contact = await db.centerContact.create({
      data: { centerId, title: `contact-${TAG}`, person: `contact-${TAG}`, phone: '02100000000' },
    });
    try {
      await db.aiCustomerMemory.create({ data: { companyId: (await db.center.findUnique({ where: { id: centerId } }))!.companyId, centerId, contactId: contact.id, summary: 'a' } });
      await db.aiCustomerMemory.create({ data: { companyId: (await db.center.findUnique({ where: { id: centerId } }))!.companyId, centerId, contactId: contact.id, summary: 'b' } });
      const removed = await reconcileCustomerMemoryDuplicates(db, centerId, contact.id);
      expect(removed).toBe(1);
      expect(await db.aiCustomerMemory.count({ where: { centerId, contactId: contact.id } })).toBe(1);
    } finally {
      await db.aiCustomerMemory.deleteMany({ where: { centerId, contactId: contact.id } });
      await db.centerContact.delete({ where: { id: contact.id } });
    }
  });
});

describe('route — the manual memory write collapses duplicates in-transaction', () => {
  it('a pre-seeded duplicate is collapsed to ONE row with the manual edit visible', async () => {
    // seed the race result: two rows, one "old", one "new"
    const companyId = (await db.center.findUnique({ where: { id: centerId } }))!.companyId;
    await db.aiCustomerMemory.create({ data: { companyId, centerId, contactId: null, summary: 'قدیمی', source: 'ai' } });
    const stale = await db.aiCustomerMemory.create({ data: { companyId, centerId, contactId: null, summary: 'جدیدتر', source: 'ai' } });
    // make the OLD row the newest (the manual update must still win by content)
    await db.aiCustomerMemory.update({ where: { id: stale.id }, data: { updatedAt: new Date(Date.now() - 120_000) } });

    const res = await asUser(standardUser, () =>
      memoryPost(req({ action: 'update', centerId, summary: 'ویرایش دستی تست' })));
    expect(res.status).toBe(200);

    const survivors = await db.aiCustomerMemory.findMany({ where: { centerId, contactId: null } });
    expect(survivors).toHaveLength(1); // duplicates collapsed
    expect(survivors[0].summary).toBe('ویرایش دستی تست'); // latest write wins
    expect(survivors[0].source).toBe('manual');
  });
});
