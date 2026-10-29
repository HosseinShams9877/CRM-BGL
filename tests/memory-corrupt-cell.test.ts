import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// memory-corrupt-cell.test.ts — v2.58.10
//
// A CORRUPT JSON cell in an AiCustomerMemory row (hand-edited DB, a
// partial write from an ancient version) must never crash the whole
// memory stage — and must never be silently wiped either. The
// pre-v2.58.10 code threw JSON.parse exceptions straight out of the
// LLM-path update AND the fallback merge (the stage failed loudly but
// uselessly; the recording's memory step died).
//
// THE CONTRACT:
//   • a corrupt insights/preferences cell degrades to an empty merge
//     base, the corruption is logged (AI_MEMORY_CORRUPT_CELL), and the
//     write proceeds with the NEW validated facts;
//   • the corrupted source string is NOT silently destroyed in-place
//     before the write (it is replaced by the merged result of the
//     SAME transaction, exactly like any other memory update);
//   • valid JSON keeps flowing through unchanged (no behavior change
//     for healthy rows).
// ═══════════════════════════════════════════════════════════════

vi.mock('@/lib/ai/providers/llm', async () => ({
  getLLMProvider: () => ({
    complete: async () => {
      throw new Error('no LLM in test — force the deterministic fallback');
    },
  }),
  extractJsonObject: () => null,
}));
vi.mock('@/lib/ai/settings', async () => ({
  getAiSettings: async () => ({ llmProvider: 'zai' }),
}));
vi.mock('@/lib/ai/usage', async () => ({
  recordAiUsage: async () => undefined,
}));

import { upsertMemoryFromAnalysis } from '@/lib/ai/engine/memory';

const db = new PrismaClient();
const TAG = `r92mem-${Date.now().toString(36)}`;

let centerId: string;
const contactId = null;

beforeAll(async () => {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-center`, customerType: 'b2b', companyId: company.id, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = center.id;
});

afterAll(async () => {
  await db.aiCustomerMemory.deleteMany({ where: { centerId } });
  await db.center.deleteMany({ where: { id: centerId } });
  await db.$disconnect();
});

function facts(summary: string) {
  // the REAL AnalysisExtractionRaw shape (objections as typed objects,
  // products as named objects — exactly what the zod schema produces)
  return {
    summary,
    customerNeed: 'نیاز مشتری',
    objections: [
      { type: 'قیمت', description: `اعتراض ${TAG}`, resolved: false },
      { type: 'ارسال', description: 'اعتراض حل‌شده قدیمی', resolved: true },
    ],
    products: [{ name: 'محصول X', quantity: '1', note: '' }],
    competitors: [],
    decisionMakers: [],
    commitments: { rep: [], customer: ['تعهد ۱'] },
    paymentTerms: 'نقدی',
  } as unknown as Parameters<typeof upsertMemoryFromAnalysis>[4];
}

describe('corrupt JSON cells in an existing memory row', () => {
  it('a corrupt insights cell no longer kills the memory stage; the write lands', async () => {
    const row = await db.aiCustomerMemory.create({
      data: {
        companyId: (await db.center.findUniqueOrThrow({ where: { id: centerId } })).companyId as string,
        centerId, contactId,
        summary: 'خلاصهٔ قدیمی',
        preferences: '{"valid":true}',
        insights: 'NOT-JSON-{{{ broken', // the corrupt cell
        source: 'ai',
      },
    });
    try {
      // the LLM is mocked to FAIL → the deterministic fallback merge runs
      // (the exact production path when the LLM errors out)
      await expect(
        upsertMemoryFromAnalysis(row.companyId, centerId, contactId, 'analysis-id', facts('خلاصهٔ جدید'), null, undefined),
      ).resolves.toBeUndefined();

      const after = await db.aiCustomerMemory.findUniqueOrThrow({ where: { id: row.id } });
      // the deterministic fallback merges INSIGHTS (summary is the LLM
      // path's contract — the fallback never touches it)
      const insights = JSON.parse(after.insights) as Record<string, unknown>;
      expect(Array.isArray(insights.openObjections)).toBe(true);
      expect((insights.openObjections as string[]).some((o) => o.includes(TAG))).toBe(true);
    } finally {
      await db.aiCustomerMemory.deleteMany({ where: { centerId } });
    }
  });

  it('a healthy row keeps merging (no regression for valid cells)', async () => {
    const company = (await db.center.findUniqueOrThrow({ where: { id: centerId } })).companyId as string;
    const row = await db.aiCustomerMemory.create({
      data: {
        companyId: company, centerId, contactId,
        summary: 'خلاصهٔ قدیمی',
        preferences: '{"valid":true}',
        insights: '{"openObjections":["اعتراض قبلی"],"competitors":[]}',
        source: 'ai',
      },
    });
    try {
      await upsertMemoryFromAnalysis(company, centerId, contactId, 'analysis-id-2', facts('خلاصهٔ دوم'), null, undefined);
      const after = await db.aiCustomerMemory.findUniqueOrThrow({ where: { id: row.id } });
      const insights = JSON.parse(after.insights) as Record<string, unknown>;
      const objections = insights.openObjections as string[];
      expect(objections.some((o) => o === 'اعتراض قبلی')).toBe(true); // old fact survives
      expect(objections.some((o) => o.includes(TAG))).toBe(true); // new fact lands
    } finally {
      await db.aiCustomerMemory.deleteMany({ where: { centerId } });
    }
  });
});
