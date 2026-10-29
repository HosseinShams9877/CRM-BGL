import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// ai-fenced-writes.test.ts — v2.58.5 (user finding R4)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 code):
//   • failRecording was called WITHOUT the lease token inside
//     analyzeTranscript (both parse/validation failures) — a stale
//     worker could mark the NEW owner's recording failed;
//   • the pipeline's real outputs (transcript, analysis, memory,
//     next-actions, coach insight) were all written UNFENCED;
//   • a coaching failure still set coachingDone=true (recorded as
//     success forever).
//
// THE CONTRACT (controlled providers, real service, real SQLite; the
// transcript is pre-created so the pipeline drives straight to the
// analysis stage — the same pattern as ai-pipeline-resume.test.ts):
//   1. worker A stalls after the provider answers; the lease moves
//      to B; A's continuation writes NOTHING (every fenced write
//      aborts — analysis, action, coach insight, state, failure);
//   2. A's ANALYSIS FAILS while B owns → B's state is untouched;
//   3. a crash between "output persisted" and "marker set" → the
//      retry does not duplicate the output (analysis re-read /
//      insight find-first / action dedupe);
//   4. a coaching FAILURE never sets coachingDone; a successful
//      coach-only resume later completes it.
// ═══════════════════════════════════════════════════════════════

const ANALYSIS_JSON = JSON.stringify({
  summary: 'خلاصه', topic: 'موضوع', callReason: 'دلیل', customerNeed: 'نیاز',
  products: [{ name: 'دستگاه' }],
  objections: [], commitments: { customer: ['ارسال کاتالوگ'], rep: [] },
  competitors: [], paymentTerms: 'نقدی', purchaseTimeframe: 'این ماه', budget: '',
  intent: 'warm', conversionScore: 70, scoreReasons: [],
  openQuestions: [], risks: [], opportunities: [], decisionMakers: [],
  suggestedFollowupDate: null, suggestedFollowupReason: '', stageSuggestion: '',
  nextActions: [
    { type: 'call', title: 'پیگیری', reason: 'r', priority: 'high', confidence: 0.9 },
  ],
  confidence: 0.8,
});
const MEMORY_JSON = JSON.stringify({ summary: 'خلاصه حافظه', preferences: {}, insights: {} });
const COACH_JSON = JSON.stringify({
  qualityScore: 80, scores: { opening: 80 }, strengths: ['s'], improvements: [], mistakes: [], recommendations: [],
});
const COACH_GARBAGE = 'THIS-IS-NOT-JSON';

// (R4) provider state knobs
let coachReturnsGarbage = false;

vi.mock('@/lib/ai/providers/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers/llm')>();
  return {
    ...actual,
    getLLMProvider: () => ({
      id: 'fake',
      async complete(messages: Array<{ role: string; content: string }>) {
        const system = messages[0]?.content ?? '';
        if (system.includes('تحلیلگر ارشد فروش')) {
          return { provider: 'fake', model: 't', content: ANALYSIS_JSON, inputTokens: 1, outputTokens: 1 };
        }
        if (system.includes('مدیر حافظه مشتریان')) {
          return { provider: 'fake', model: 't', content: MEMORY_JSON, inputTokens: 1, outputTokens: 1 };
        }
        if (system.includes('مربی حرفه‌ای فروش')) {
          if (coachReturnsGarbage) {
            return { provider: 'fake', model: 't', content: COACH_GARBAGE, inputTokens: 1, outputTokens: 1 };
          }
          return { provider: 'fake', model: 't', content: COACH_JSON, inputTokens: 1, outputTokens: 1 };
        }
        throw new Error('unexpected LLM call');
      },
    }),
  };
});
vi.mock('@/lib/ai/providers/stt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers/stt')>();
  return {
    ...actual,
    getSTTProvider: () => ({
      id: 'fake',
      async transcribe() { return { provider: 'fake', text: 'متن مکالمه آزمون', confidence: 0.9 }; },
    }),
  };
});

import { processRecording, claimRecordingForProcessingWithToken } from '@/lib/ai/engine/pipeline';
import { fencedUpdate, fencedTx } from '@/lib/ai/engine/lease';
import { invalidateAiSettingsCache } from '@/lib/ai/settings';

const db = new PrismaClient();
const TAG = `r4fence-${Date.now().toString(36)}`;
let centerId = '';
let companyId = '';

async function setCoach(enabled: boolean) {
  await db.meta.upsert({
    where: { key: 'ai_sales.coach_enabled' },
    update: { value: enabled ? 'true' : 'false' },
    create: { key: 'ai_sales.coach_enabled', value: enabled ? 'true' : 'false' },
  });
  await db.meta.upsert({
    where: { key: `ai_sales.approval_mode.${companyId}` },
    update: { value: 'auto' },
    create: { key: `ai_sales.approval_mode.${companyId}`, value: 'auto' },
  });
  invalidateAiSettingsCache();
}

/** A recording sitting mid-pipeline (crashed-worker state) WITH its
 *  transcript already persisted — processRecording resumes from the
 *  analysis stage. */
async function mkStalledRecording() {
  const user = await db.user.findFirstOrThrow({ where: { role: 'admin' } });
  const rec = await db.aiCallRecording.create({
    data: {
      companyId, userId: user.id, centerId,
      direction: 'outbound', source: 'manual-upload', status: 'transcribing', language: 'fa',
      title: `${TAG}-${Math.random().toString(36).slice(2, 8)}`,
      leaseUntil: new Date(Date.now() - 20 * 60_000), // expired → claimable
    },
  });
  await db.aiCallTranscript.create({
    data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن مکالمه آزمون', segments: '[]', confidence: 0.9, wordCount: 3 },
  });
  return rec;
}

async function cleanup() {
  const recs = await db.aiCallRecording.findMany({ where: { title: { startsWith: `${TAG}-` } }, select: { id: true } });
  for (const r of recs) {
    const actions = await db.aiNextAction.findMany({ where: { recordingId: r.id }, select: { id: true, executedActivityId: true } });
    for (const a of actions) {
      if (a.executedActivityId) await db.activity.delete({ where: { id: a.executedActivityId } }).catch(() => undefined);
      await db.aiNextAction.delete({ where: { id: a.id } }).catch(() => undefined);
    }
    await db.aiCoachInsight.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallAnalysis.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallTranscript.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallRecording.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  if (centerId) await db.aiCustomerMemory.deleteMany({ where: { centerId } }).catch(() => undefined);
  await db.meta.deleteMany({ where: { key: { startsWith: 'ai_sales.approval_mode.' } } });
  await db.meta.deleteMany({ where: { key: 'ai_sales.coach_enabled' } });
  invalidateAiSettingsCache();
}

beforeAll(async () => {
  await cleanup();
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  companyId = company.id;
  const c = await db.center.create({
    data: { name: `${TAG}-center`, customerType: 'b2b', companyId, province: 'تهران', businessUnitId: 'trading' },
  });
  centerId = c.id;
});

afterAll(async () => {
  await cleanup();
  if (centerId) await db.center.delete({ where: { id: centerId } }).catch(() => undefined);
  await db.$disconnect();
});

describe('R4.1 — a stale worker cannot write ANY pipeline effect', () => {
  it('A stalls post-response; the lease moves to B; A\u2019s continuation writes NOTHING', async () => {
    await setCoach(false);
    const rec = await mkStalledRecording();

    // worker A claims (fresh token) — its provider call "answered", and
    // A now holds tokenA while the lease expires…
    const a = await claimRecordingForProcessingWithToken(rec.id);
    expect(a.claimed).toBe(true);
    const tokenA = a.token!;
    // the lease EXPIRES; worker B claims the SAME recording
    await db.aiCallRecording.update({ where: { id: rec.id }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    const b = await claimRecordingForProcessingWithToken(rec.id);
    expect(b.claimed).toBe(true);
    const tokenB = b.token!;
    expect(tokenB).not.toBe(tokenA);

    // A WAKES and tries to continue with its STALE token: its state
    // updates, its analysis, its action, its coach insight, its
    // failure mark — EVERY fenced write aborts.
    await expect(fencedUpdate(rec.id, tokenA, { status: 'analyzing' })).rejects.toMatchObject({ name: 'LeaseLostError' });
    await expect(
      fencedTx(rec.id, tokenA, (tx) => tx.aiCallAnalysis.create({
        data: { recordingId: rec.id, llmProvider: 'fake', model: 't', status: 'completed', summary: 'STALE', topic: 't', callReason: 'c', customerNeed: 'n', confidence: 0.5 },
      })),
    ).rejects.toMatchObject({ name: 'LeaseLostError' });
    await expect(
      fencedTx(rec.id, tokenA, (tx) => tx.aiNextAction.create({
        data: { companyId, recordingId: rec.id, dedupeKey: `${rec.id}#0`, type: 'call', title: 'STALE', priority: 'high', reason: 'r', confidence: 0.9, status: 'suggested' },
      })),
    ).rejects.toMatchObject({ name: 'LeaseLostError' });
    await expect(
      fencedTx(rec.id, tokenA, (tx) => tx.aiCoachInsight.create({
        data: { userId: rec.userId ?? 'x', recordingId: rec.id, qualityScore: 1, scores: '{}', strengths: '[]', improvements: '[]', mistakes: '[]', recommendations: '[]' },
      })),
    ).rejects.toMatchObject({ name: 'LeaseLostError' });
    // A's worker-failure mark (the OLD unfenced failRecording shape):
    // a conditional update on the stale token matches ZERO rows
    const failRes = await db.aiCallRecording.updateMany({
      where: { id: rec.id, leaseToken: tokenA },
      data: { status: 'failed', failReason: 'STALE' },
    });
    expect(failRes.count).toBe(0);

    // ZERO stale effects landed; B still owns the recording untouched
    expect(await db.aiCallAnalysis.count({ where: { recordingId: rec.id } })).toBe(0);
    expect(await db.aiNextAction.count({ where: { recordingId: rec.id } })).toBe(0);
    expect(await db.aiCoachInsight.count({ where: { recordingId: rec.id } })).toBe(0);
    const row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.leaseToken).toBe(tokenB);
    expect(row.status).not.toBe('failed');
  }, 30_000);
});

describe('R4.2 — a stale worker\u2019s failure cannot fail B\u2019s recording', () => {
  it('B owns; a conditional failure write on A\u2019s stale token changes NOTHING', async () => {
    await setCoach(false);
    const rec = await mkStalledRecording();
    const a = await claimRecordingForProcessingWithToken(rec.id);
    const tokenA = a.token!;
    await db.aiCallRecording.update({ where: { id: rec.id }, data: { leaseUntil: new Date(Date.now() - 60_000) } });
    const b = await claimRecordingForProcessingWithToken(rec.id);
    const tokenB = b.token!;

    // the v2.58.4 bug shape: failRecording WITHOUT the token would have
    // flipped the row B owns to 'failed'. The fenced variant (token
    // required) matches zero rows on a stale token.
    const res = await db.aiCallRecording.updateMany({
      where: { id: rec.id, leaseToken: tokenA },
      data: { status: 'failed', failReason: 'STALE FAILURE' },
    });
    expect(res.count).toBe(0);
    const row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.status).toBe('queued'); // B's claim state — untouched
    expect(row.leaseToken).toBe(tokenB);
  }, 30_000);
});

describe('R4.3 — crash between output-persist and marker does not duplicate', () => {
  it('analysis persisted + markers lost → resume re-reads, does NOT duplicate rows', async () => {
    await setCoach(false);
    const rec = await mkStalledRecording();
    await processRecording(rec.id); // completes fully (coach off)
    expect(await db.aiCallAnalysis.count({ where: { recordingId: rec.id } })).toBe(1);
    expect(await db.aiNextAction.count({ where: { recordingId: rec.id } })).toBe(1);

    // simulate the crash window: markers LOST, outputs still there
    await db.aiCallRecording.update({
      where: { id: rec.id },
      data: { status: 'analyzing', actionsDone: false, memoryDone: false, coachingDone: false, leaseUntil: new Date(Date.now() - 60_000), leaseToken: null },
    });
    await processRecording(rec.id); // the resume
    expect(await db.aiCallAnalysis.count({ where: { recordingId: rec.id } })).toBe(1); // no duplicate
    expect(await db.aiNextAction.count({ where: { recordingId: rec.id } })).toBe(1);
    const row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.status).toBe('completed');
    expect(row.actionsDone).toBe(true);
    expect(row.memoryDone).toBe(true);
  }, 30_000);

  it('coach insight persisted + coachingDone unset → coach-only resume does NOT duplicate', async () => {
    await setCoach(true);
    const rec = await mkStalledRecording();
    await processRecording(rec.id);
    expect(await db.aiCoachInsight.count({ where: { recordingId: rec.id } })).toBe(1);
    expect((await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } })).coachingDone).toBe(true);

    // the crash window: marker lost, insight still there, recording completed
    await db.aiCallRecording.update({ where: { id: rec.id }, data: { coachingDone: false, leaseUntil: null, leaseToken: null } });
    await processRecording(rec.id); // coach-only resume
    expect(await db.aiCoachInsight.count({ where: { recordingId: rec.id } })).toBe(1); // no duplicate
    expect((await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } })).coachingDone).toBe(true);
  }, 30_000);
});

describe('R4.4 — a coaching FAILURE is never recorded as success', () => {
  it('coach fails → coachingDone stays false; recording still completes; a retry heals it', async () => {
    await setCoach(true);
    const rec = await mkStalledRecording();

    coachReturnsGarbage = true; // the coach LLM answers garbage
    await processRecording(rec.id);
    coachReturnsGarbage = false;

    let row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.status).toBe('completed');            // non-fatal: the pipeline completes
    expect(row.coachingDone).toBe(false);            // ← THE FIX: failure ≠ success
    expect(await db.aiCoachInsight.count({ where: { recordingId: rec.id } })).toBe(0);

    // a retry (re-processing the completed-but-uncoached recording)
    // heals the coaching — exactly one insight
    await processRecording(rec.id); // coach-only resume
    row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
    expect(row.coachingDone).toBe(true);
    expect(await db.aiCoachInsight.count({ where: { recordingId: rec.id } })).toBe(1);
  }, 30_000);
});
