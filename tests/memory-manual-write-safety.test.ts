import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════════════
// memory-manual-write-safety.test.ts — v2.58.11 (independent audit
// 2.58.10, medium finding — reproduced RED on the shipped 2.58.10)
//
// The manual memory update route parsed the EXISTING preferences /
// insights cells with a raw JSON.parse — a corrupt blob (hand-edited
// DB, partial write from an ancient version) threw a SyntaxError →
// 500, even though the SAFE parser (safeParseJsonCell) already
// existed for the engine path and degrades corrupt cells to an
// empty merge base + a logged corruption event.
//
// THE CONTRACT: a manual update that does not carry new
// preferences/insights NEVER crashes on a corrupt stored cell — the
// corrupt base degrades to {} (the pipeline's documented semantics),
// the write succeeds, and the corrupt string is replaced by the
// merged result of the same transaction.
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
const TAG = `r9111ms-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/ai-sales/memory', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const me = {
  id: 'u-manual', username: 'manual', displayName: 'Manual', role: 'standard', roleLabel: '',
  businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true,
  impersonator: null, territoryMode: 'country', territoryProvinces: null, territoryCenterIds: null,
};

async function asMe<T>(fn: () => Promise<T>): Promise<T> {
  currentAuthUser = me;
  try { return await fn(); } finally { currentAuthUser = null; }
}

let centerId: string;

beforeAll(async () => {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-center`, companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;
});

afterAll(async () => {
  await db.aiCustomerMemory.deleteMany({ where: { centerId } });
  await db.center.deleteMany({ where: { id: centerId } });
  await db.$disconnect();
});

describe('manual memory update vs corrupt stored cells', () => {
  it('RED→GREEN: a corrupt preferences cell no longer 500s the manual update', async () => {
    await db.aiCustomerMemory.create({
      data: { companyId: (await db.center.findUniqueOrThrow({ where: { id: centerId } })).companyId, centerId, contactId: null, summary: 'قبلی', preferences: '{corrupt-json!!', source: 'ai' },
    });
    const res = await asMe(() => memoryPost(req({ action: 'update', centerId, summary: 'ویرایش دستی' })));
    expect(res.status).toBe(200);
    const row = await db.aiCustomerMemory.findFirstOrThrow({ where: { centerId, contactId: null } });
    expect(row.summary).toBe('ویرایش دستی');
    expect(() => JSON.parse(row.preferences)).not.toThrow(); // degraded to a valid object
  });

  it('a corrupt insights cell behaves identically', async () => {
    await db.aiCustomerMemory.update({
      where: { id: (await db.aiCustomerMemory.findFirstOrThrow({ where: { centerId, contactId: null } })).id },
      data: { insights: '["also corrupt' },
    });
    const res = await asMe(() => memoryPost(req({ action: 'update', centerId, summary: 'دوباره' })));
    expect(res.status).toBe(200);
    const row = await db.aiCustomerMemory.findFirstOrThrow({ where: { centerId, contactId: null } });
    expect(() => JSON.parse(row.insights)).not.toThrow();
  });

  it('valid stored cells keep flowing through (regression control)', async () => {
    const row = await db.aiCustomerMemory.findFirstOrThrow({ where: { centerId, contactId: null } });
    await db.aiCustomerMemory.update({
      where: { id: row.id },
      data: { preferences: JSON.stringify({ preferredContactTime: 'صبح' }), insights: JSON.stringify({ relationshipNotes: [] }) },
    });
    const res = await asMe(() => memoryPost(req({ action: 'update', centerId, summary: 'سالم' })));
    expect(res.status).toBe(200);
    const after = await db.aiCustomerMemory.findFirstOrThrow({ where: { centerId, contactId: null } });
    expect(JSON.parse(after.preferences)).toEqual({ preferredContactTime: 'صبح' }); // preserved when no new value supplied
  });
});
