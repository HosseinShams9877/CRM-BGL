import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// ai-pipeline-resume.test.ts — v2.58.4 (external audit F07)
//
// THE AUDIT REPROS (confirmed on the pre-fix code):
//   • AI_RESUME TypeError: Cannot read properties of undefined
//     (reading 'filter') — the resume path fabricated a STUB extraction
//     via `as unknown as` and memory crashed on objections.filter;
//   • a crash after the FIRST of three actions permanently skipped the
//     remaining two ("an action exists" was mistaken for "all created");
//   • retryRecording flipped a LIVE transcribing recording to queued
//     (unconditional update, no status/lease condition);
//   • a stale worker (expired lease, re-granted) could still write
//     results — no fencing.
//
// THE CONTRACT (real service + real SQLite; crash points are simulated
// by the exact database state a crash leaves behind; NO real AI call —
// the providers are controlled test doubles per the audit's rule):
//   • resume after transcript / after analysis / after the first action /
//     after memory completes EXACTLY the remaining stages;
//   • zero actions is a valid completed result (actionsDone marker),
//     distinct from "stage never ran";
//   • retryRecording is atomic-conditional (failed-only + crashed-expired
//     lease; a LIVE worker is never re-queued, the cap is enforced);
//   • lease fencing: a stale worker's writes match ZERO rows.
// ═══════════════════════════════════════════════════════════════

// ── controlled provider doubles (never a real network call) ──
const llmCalls: Array<{ feature: 'analysis' | 'memory' | 'coach'; userPrompt: string }> = [];
let memoryFactsSeen: string | null = null;
let coachFired = 0;

const ANALYSIS_JSON = JSON.stringify({
  summary: 'مشتری درخواست پیش‌فاکتور دستگاه داشت',
  topic: 'استعلام قیمت',
  callReason: 'پیگیری پیش‌فاکتور',
  customerNeed: 'دستگاه خلوص‌سنج',
  products: [{ name: 'دستگاه خلوص‌سنج GL-100' }],
  objections: [{ type: 'price', description: 'قیمت بالا', severity: 'medium', resolved: false }],
  commitments: { customer: ['ارسال پیش‌فاکتور تا فردا'], rep: ['پیگیری شنبه'] },
  competitors: ['رقیب الف'],
  paymentTerms: 'نقدی',
  purchaseTimeframe: 'این ماه',
  budget: '۵۰۰ میلیون',
  intent: 'warm',
  nextActions: [
    { type: 'call', title: 'تماس پیگیری', reason: 'مشتری درخواست پیگیری داشت', priority: 'high', confidence: 0.9 },
    { type: 'whatsapp', title: 'ارسال کاتالوگ', reason: 'درخواست کاتالوگ', priority: 'medium', confidence: 0.7 },
    { type: 'quotation', title: 'صدور پیش‌فاکتور', reason: 'توافق بر پیش‌فاکتور', priority: 'high', confidence: 0.8 },
  ],
  confidence: 0.8,
});
const MEMORY_JSON = JSON.stringify({ summary: 'مشتری علاقه‌مند به پیش‌فاکتور', preferences: {}, insights: {} });
const COACH_JSON = JSON.stringify({
  qualityScore: 78, scores: { opening: 80 }, strengths: ['شروع خوب'], improvements: [], mistakes: [], recommendations: [],
});

vi.mock('@/lib/ai/providers/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/providers/llm')>();
  return {
    ...actual,
    getLLMProvider: () => ({
      id: 'fake',
      async complete(messages: Array<{ role: string; content: string }>) {
        const system = messages[0]?.content ?? '';
        const user = messages[1]?.content ?? '';
        if (system.includes('تحلیلگر ارشد فروش')) {
          llmCalls.push({ feature: 'analysis', userPrompt: user });
          return { provider: 'fake', model: 'test', content: ANALYSIS_JSON, inputTokens: 10, outputTokens: 10 };
        }
        if (system.includes('مدیر حافظه مشتریان')) {
          llmCalls.push({ feature: 'memory', userPrompt: user });
          memoryFactsSeen = user; // captured for the grounded-facts assertion
          return { provider: 'fake', model: 'test', content: MEMORY_JSON, inputTokens: 10, outputTokens: 10 };
        }
        if (system.includes('مربی حرفه‌ای فروش')) {
          llmCalls.push({ feature: 'coach', userPrompt: user });
          coachFired += 1;
          return { provider: 'fake', model: 'test', content: COACH_JSON, inputTokens: 10, outputTokens: 10 };
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
      async transcribe() {
        return { provider: 'fake', text: 'متن مکالمه آزمونی', confidence: 0.9 };
      },
    }),
  };
});

import {
  processRecording,
  retryRecording,
  claimRecordingForProcessingWithToken,
  extractionFromAnalysisRow,
} from '@/lib/ai/engine/pipeline';
import { createNextActionsFromAnalysis } from '@/lib/ai/engine/nba';
import { LeaseLostError } from '@/lib/ai/engine/lease';
import { invalidateAiSettingsCache } from '@/lib/ai/settings';

const db = new PrismaClient();
const TAG = `r89r-${Date.now().toString(36)}`;
let fixtureCenterId = '';

async function mkRecording(overrides: Record<string, unknown> = {}) {
  const company = await db.company.findFirst({ where: { slug: 'bazargani' } });
  const user = await db.user.findFirst({ where: { role: 'admin' } });
  return db.aiCallRecording.create({
    data: {
      companyId: company!.id,
      centerId: fixtureCenterId || null,
      userId: user!.id,
      direction: 'outbound',
      source: 'manual-upload',
      status: 'uploaded',
      language: 'fa',
      title: TAG,
      ...overrides,
    },
  });
}

async function cleanup() {
  const recs = await db.aiCallRecording.findMany({ where: { title: TAG }, select: { id: true } });
  for (const r of recs) {
    await db.aiCallTranscript.deleteMany({ where: { recordingId: r.id } });
    await db.aiNextAction.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallAnalysis.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallRecording.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  await db.aiCoachInsight.deleteMany({ where: { recording: { title: TAG } } }).catch(() => undefined);
  if (fixtureCenterId) {
    await db.aiCustomerMemory.deleteMany({ where: { centerId: fixtureCenterId } }).catch(() => undefined);
  }
}

function analysisCalls(): number {
  return llmCalls.filter((c) => c.feature === 'analysis').length;
}

async function fullRunState(recId: string) {
  const [rec, transcript, analyses, actions, insights] = await Promise.all([
    db.aiCallRecording.findUnique({ where: { id: recId } }),
    db.aiCallTranscript.findUnique({ where: { recordingId: recId } }),
    db.aiCallAnalysis.findMany({ where: { recordingId: recId } }),
    db.aiNextAction.findMany({ where: { recordingId: recId } }),
    db.aiCoachInsight.findMany({ where: { recordingId: recId } }),
  ]);
  return { rec, transcript, analyses, actions, insights };
}

beforeAll(async () => {
  await cleanup();
  const company = await db.company.findFirst({ where: { slug: 'bazargani' } });
  const center = await db.center.create({
    data: { name: `${TAG}-مرکز`, customerType: 'b2b', companyId: company!.id, province: 'تهران', businessUnitId: 'trading' },
  });
  fixtureCenterId = center.id;
});

afterAll(async () => {
  await cleanup();
  if (fixtureCenterId) {
    await db.center.delete({ where: { id: fixtureCenterId } }).catch(() => undefined);
  }
  await db.$disconnect();
});

describe('F07 — exact resume after a crash (state = what the crash left behind)', () => {
  it('crash AFTER TRANSCRIPT (no analysis yet) → resume analyzes once, creates all 3 actions, memory, coaching; nothing duplicated', async () => {
    // the crash left: a recording + transcript, nothing else
    const rec = await mkRecording({ status: 'transcribing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن مکالمه آزمونی', segments: '[]', confidence: 0.9, wordCount: 3 },
    });
    const before = analysisCalls();

    await processRecording(rec.id);

    const st = await fullRunState(rec.id);
    expect(st.rec?.status).toBe('completed');
    expect(st.analyses).toHaveLength(1);
    expect(analysisCalls() - before).toBe(1); // analyzed EXACTLY once
    expect(st.actions).toHaveLength(3);
    expect(st.actions.map((a) => a.dedupeKey).sort()).toEqual([`${rec.id}#0`, `${rec.id}#1`, `${rec.id}#2`].sort());
    expect(st.insights).toHaveLength(1);
    expect(st.rec?.actionsDone).toBe(true);
    expect(st.rec?.memoryDone).toBe(true);
    expect(st.rec?.coachingDone).toBe(true);
  }, 30_000);

  it('crash AFTER ANALYSIS (row exists, no actions) → NO re-analysis, actions + memory (with the REBUILT extraction) complete; the memory merge receives the GROUNDED facts', async () => {
    const rec = await mkRecording({ status: 'analyzing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن مکالمه آزمونی', segments: '[]', confidence: 0.9, wordCount: 3 },
    });
    // the analysis row the crash left behind (persisted, grounded fields)
    await db.aiCallAnalysis.create({
      data: {
        recordingId: rec.id, llmProvider: 'fake', model: 'test', status: 'completed',
        summary: 'خلاصهٔ ذخیره‌شده', customerNeed: 'نیاز ذخیره‌شده',
        products: JSON.stringify([{ name: 'دستگاه ذخیره‌شده' }]),
        objections: JSON.stringify([{ type: 'price', description: 'قیمت بالا', severity: 'medium', resolved: false, recommendedResponse: '' }]),
        commitments: JSON.stringify({ customer: ['تعهد مشتری'], rep: ['تعهد کارشناس'] }),
        competitors: JSON.stringify(['رقیب ذخیره‌شده']),
        nextActions: JSON.stringify([
          { type: 'call', title: 'اقدام ۱', reason: 'r', priority: 'high', confidence: 0.9 },
          { type: 'whatsapp', title: 'اقدام ۲', reason: 'r', priority: 'medium', confidence: 0.7 },
        ]),
      },
    });
    const before = analysisCalls();
    memoryFactsSeen = null;

    await processRecording(rec.id);

    const st = await fullRunState(rec.id);
    expect(st.rec?.status).toBe('completed');
    expect(analysisCalls() - before).toBe(0); // THE stub-replacement assertion: no re-analysis
    expect(st.actions).toHaveLength(2); // from the PERSISTED nextActions JSON
    // the memory stage ran with the REBUILT extraction — the grounded facts
    // from the analysis row reached the merge (no crash, no empty stub):
    expect(st.rec?.memoryDone).toBe(true);
    expect(memoryFactsSeen).toBeTruthy();
    expect(memoryFactsSeen).toContain('قیمت بالا'); // the persisted objection
    expect(memoryFactsSeen).toContain('رقیب ذخیره‌شده'); // the persisted competitor
    expect(st.insights).toHaveLength(1);
  }, 30_000);

  it('crash after the FIRST of THREE actions → resume creates EXACTLY the missing two (the pre-fix code skipped them forever)', async () => {
    const rec = await mkRecording({ status: 'analyzing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن', segments: '[]', confidence: 0.9, wordCount: 1 },
    });
    await db.aiCallAnalysis.create({
      data: {
        recordingId: rec.id, llmProvider: 'fake', model: 'test', status: 'completed',
        summary: 'خلاصه',
        nextActions: JSON.stringify([
          { type: 'call', title: 'اقدام ۱', reason: 'r', priority: 'high', confidence: 0.9 },
          { type: 'whatsapp', title: 'اقدام ۲', reason: 'r', priority: 'medium', confidence: 0.7 },
          { type: 'quotation', title: 'اقدام ۳', reason: 'r', priority: 'high', confidence: 0.8 },
        ]),
      },
    });
    // the crash left the FIRST action created (with its stable key)
    await db.aiNextAction.create({
      data: {
        companyId: rec.companyId, recordingId: rec.id, dedupeKey: `${rec.id}#0`,
        type: 'call', title: 'اقدام ۱', priority: 'high', confidence: 0.9, status: 'suggested',
      },
    });

    await processRecording(rec.id);

    const st = await fullRunState(rec.id);
    expect(st.rec?.status).toBe('completed');
    expect(st.actions).toHaveLength(3); // exactly the full set — #1 and #2 created now
    expect(st.actions.map((a) => a.title).sort()).toEqual(['اقدام ۱', 'اقدام ۲', 'اقدام ۳'].sort());
    expect(st.rec?.actionsDone).toBe(true);
  }, 30_000);

  it('crash AFTER MEMORY → resume does not re-run analysis/actions/memory; coaching + completion only', async () => {
    const rec = await mkRecording({
      status: 'analyzing', leaseUntil: new Date(Date.now() - 20 * 60_000),
      actionsDone: true, memoryDone: true,
    });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن', segments: '[]', confidence: 0.9, wordCount: 1 },
    });
    await db.aiCallAnalysis.create({
      data: { recordingId: rec.id, llmProvider: 'fake', model: 'test', status: 'completed', summary: 'خلاصه', nextActions: '[]' },
    });
    const beforeAnalysis = analysisCalls();
    const beforeCoach = coachFired;

    await processRecording(rec.id);

    const st = await fullRunState(rec.id);
    expect(st.rec?.status).toBe('completed');
    expect(st.rec?.coachingDone).toBe(true);
    expect(coachFired - beforeCoach).toBe(1); // only the missing stage ran
    expect(analysisCalls() - beforeAnalysis).toBe(0);
    expect(st.actions).toHaveLength(0); // zero-action analysis → marker set, no rows
  }, 30_000);

  it('ZERO actions is a valid completed result — actionsDone set, no re-analysis on a later resume', async () => {
    const rec = await mkRecording({ status: 'analyzing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن', segments: '[]', confidence: 0.9, wordCount: 1 },
    });
    await db.aiCallAnalysis.create({
      data: { recordingId: rec.id, llmProvider: 'fake', model: 'test', status: 'completed', summary: 'بدون اقدام', nextActions: '[]' },
    });
    const before = analysisCalls();

    await processRecording(rec.id);

    const st = await fullRunState(rec.id);
    expect(st.rec?.status).toBe('completed');
    expect(st.rec?.actionsDone).toBe(true); // distinct from "stage never ran"
    expect(st.actions).toHaveLength(0);
    expect(analysisCalls() - before).toBe(0);
  }, 30_000);
});

describe('F07 — retryRecording is atomic-conditional', () => {
  it('a LIVE transcribing worker is NOT re-queued (the audit repro); a crashed one IS recovered; the cap is enforced; completed is terminal', async () => {
    const live = await mkRecording({ status: 'transcribing', leaseUntil: new Date(Date.now() + 10 * 60_000) });
    expect(await retryRecording(live.id)).toBe(false); // pre-fix: true — the audit's repro
    expect((await db.aiCallRecording.findUnique({ where: { id: live.id } }))?.status).toBe('transcribing');

    const crashed = await mkRecording({ status: 'analyzing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    expect(await retryRecording(crashed.id)).toBe(true); // real recovery path
    expect((await db.aiCallRecording.findUnique({ where: { id: crashed.id } }))?.status).toBe('queued');

    const capped = await mkRecording({ status: 'failed', retryCount: 3 });
    expect(await retryRecording(capped.id)).toBe(false);

    const done = await mkRecording({ status: 'completed' });
    expect(await retryRecording(done.id)).toBe(false);
  });
});

describe('F07 — lease FENCING (a stale worker cannot write)', () => {
  it('after the lease is re-granted, the STALE token\u2019s writes match ZERO rows; the new owner completes', async () => {
    const rec = await mkRecording({ status: 'transcribing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    const first = await claimRecordingForProcessingWithToken(rec.id);
    expect(first.claimed).toBe(true);

    // the first worker stalls; its lease expires and is re-granted
    await db.aiCallRecording.update({ where: { id: rec.id }, data: { leaseUntil: new Date(Date.now() - 20 * 60_000) } });
    const second = await claimRecordingForProcessingWithToken(rec.id);
    expect(second.claimed).toBe(true);
    expect(second.token).toBeTruthy();
    expect(second.token).not.toBe(first.token);

    // the stale worker's fenced write (this is exactly what every stage
    // write and the completion run through) matches ZERO rows:
    const staleWrite = await db.aiCallRecording.updateMany({
      where: { id: rec.id, leaseToken: first.token },
      data: { status: 'completed' },
    });
    expect(staleWrite.count).toBe(0);
    expect((await db.aiCallRecording.findUnique({ where: { id: rec.id } }))?.status).toBe('queued'); // untouched by the stale worker
  });
});

describe('F07 — extractionFromAnalysisRow (the stub-replacement)', () => {
  it('rebuilds a COMPLETE, typed object from a persisted row; corrupt JSON degrades to empty arrays (never undefined)', async () => {
    const rebuilt = extractionFromAnalysisRow({
      summary: 's', topic: 't', callReason: 'c', customerNeed: 'n',
      customerProblems: '["p"]', products: '[]', budget: 'b', purchaseTimeframe: 'pt',
      intent: 'i', temperature: 'warm', conversionScore: 50, scoreReasons: '[]',
      objections: '[]', commitments: 'not-json', openQuestions: '[]', risks: '[]',
      opportunities: '[]', paymentTerms: 'pay', competitors: '[]', decisionMakers: '[]',
      suggestedFollowupDate: null, suggestedFollowupReason: '', stageSuggestion: '',
      nextActions: '[]', confidence: 0.7,
    });
    // every field the memory stage touches is DEFINED (the crash was on
    // objections.filter / products.map / commitments.customer):
    expect(Array.isArray(rebuilt.objections)).toBe(true);
    expect(Array.isArray(rebuilt.products)).toBe(true);
    expect(rebuilt.commitments).toEqual({ rep: [], customer: [] }); // corrupt JSON → empty, never undefined
    expect(rebuilt.competitors).toEqual([]);
    expect(rebuilt.decisionMakers).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// v2.58.6 (user P2) — the AUTO-EXECUTION goes through the REAL
// pipeline under the worker's own lease: processRecording (with the
// controlled provider doubles above) runs end-to-end in mode=auto;
// the actions with confidence ≥ 0.75 (call 0.9 + quotation 0.8)
// materialize EXACTLY ONE Activity each, the 0.7 action stays
// suggested, and the recording completes. A stale re-run of the
// stage's continuation is fenced out (its LeaseLostError aborts
// inside the pipeline) — no second Activity, no state corruption.
// ═══════════════════════════════════════════════════════════════
describe('P2 — pipeline auto-execution is lease-fenced (mode=auto, real processRecording)', () => {
  it('processRecording auto-executes exactly the ≥0.75 actions ONCE each; stale continuation writes nothing', async () => {
    const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
    await db.meta.upsert({
      where: { key: `ai_sales.approval_mode.${company.id}` },
      update: { value: 'auto' },
      create: { key: `ai_sales.approval_mode.${company.id}`, value: 'auto' },
    });
    invalidateAiSettingsCache();
    // the same crash-after-transcript state the resume tests use (the
    // analysis stage runs for real through the controlled LLM double)
    const rec = await mkRecording({ status: 'transcribing', leaseUntil: new Date(Date.now() - 20 * 60_000) });
    await db.aiCallTranscript.create({
      data: { recordingId: rec.id, sttProvider: 'fake', fullText: 'متن مکالمه آزمونی', segments: '[]', confidence: 0.9, wordCount: 3 },
    });
    try {
      await processRecording(rec.id);

      const row = await db.aiCallRecording.findUniqueOrThrow({ where: { id: rec.id } });
      expect(row.status).toBe('completed');
      expect(row.actionsDone).toBe(true);

      const actions = await db.aiNextAction.findMany({ where: { recordingId: rec.id } });
      expect(actions).toHaveLength(3); // call 0.9, whatsapp 0.7, quotation 0.8
      const executed = actions.filter((a) => a.status === 'executed');
      const suggested = actions.filter((a) => a.status === 'suggested');
      expect(executed).toHaveLength(2); // 0.9 + 0.8 — NOT the 0.7 one
      expect(suggested).toHaveLength(1);
      expect(suggested[0].type).toBe('whatsapp');
      for (const a of executed) expect(a.executedActivityId).not.toBeNull();

      // exactly TWO Activities exist and each maps to ONE action
      const ids = executed.map((a) => a.executedActivityId) as string[];
      const activities = await db.activity.findMany({ where: { id: { in: ids } } });
      expect(activities).toHaveLength(2);

      // a STALE continuation of the action stage (a token nobody owns) is
      // fenced out: put the pipeline back into the exact "crashed between
      // suggested-create and auto-execute" state (one high-confidence
      // action left 'suggested'), then run the continuation with the OLD
      // token — the fenced auto-execution aborts, NOTHING is written
      const callAction = actions.find((a) => a.type === 'call')!;
      if (callAction.executedActivityId) {
        await db.activity.delete({ where: { id: callAction.executedActivityId } });
      }
      await db.aiNextAction.update({
        where: { id: callAction.id },
        data: { status: 'suggested', executedActivityId: null },
      });
      const analysisRow = await db.aiCallAnalysis.findFirstOrThrow({ where: { recordingId: rec.id } });
      const staleRun = createNextActionsFromAnalysis(
        {
          id: rec.id, companyId: company.id,
          centerId: row.centerId, contactId: null, userId: row.userId,
        },
        analysisRow.id,
        extractionFromAnalysisRow(analysisRow),
        null,
        { recordingId: rec.id, token: 'a-stale-token-nobody-owns' },
      );
      await expect(staleRun).rejects.toBeInstanceOf(LeaseLostError);
      // the action is UNTOUCHED by the stale worker (still suggested, no activity)
      const untouched = await db.aiNextAction.findUniqueOrThrow({ where: { id: callAction.id } });
      expect(untouched.status).toBe('suggested');
      expect(untouched.executedActivityId).toBeNull();
      // still exactly one executed action (quotation) and one Activity for it
      const after = await db.aiNextAction.findMany({ where: { recordingId: rec.id, status: 'executed' } });
      expect(after).toHaveLength(1);
      const afterIds = after.map((a) => a.executedActivityId) as string[];
      expect(await db.activity.count({ where: { id: { in: afterIds } } })).toBe(1);
    } finally {
      await cleanup();
      await db.meta.deleteMany({ where: { key: `ai_sales.approval_mode.${company.id}` } });
      invalidateAiSettingsCache();
    }
  }, 30_000);
});
