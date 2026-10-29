import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// nba-resume-autoexec.test.ts — v2.58.5 (user finding R3)
//
// THE AUDIT REPRO (confirmed on the v2.58.4 code):
//   createNextActionsFromAnalysis's resume fast-path hit an EXISTING
//   dedupeKey row and `continue`d past it — so a crash between
//   creating a 'suggested' action and its AUTO-EXECUTION left the
//   action permanently unexecuted: the retry re-ran the stage, saw
//   "the action exists", and skipped the execution entirely.
//
// THE CONTRACT (real service + real SQLite, crash states simulated
// by the exact rows a crash leaves behind):
//   • an existing suggested action that CURRENT policy says is
//     auto-executable (mode=auto, confidence ≥ 0.75) goes through
//     the idempotent execution path on retry → exactly ONE Activity;
//   • two concurrent retries → one Activity, one identity;
//   • an already-executed action → NO new Activity (same id back);
//   • a dismissed action, or a policy of confirm/suggest (a mode
//     change between crash and retry) → NO auto-execution;
//   • the dedupe key never produces a duplicate action row.
// ═══════════════════════════════════════════════════════════════

import { createNextActionsFromAnalysis, executeNextAction } from '@/lib/ai/engine/nba';
import { invalidateAiSettingsCache } from '@/lib/ai/settings';
import type { AnalysisExtractionRaw } from '@/lib/ai/extraction';

const db = new PrismaClient();
const TAG = `r3nba-${Date.now().toString(36)}`;

async function fixture() {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const user = await db.user.findFirstOrThrow({ where: { role: 'admin' } });
  const recording = await db.aiCallRecording.create({
    data: {
      companyId: company.id, userId: user.id,
      direction: 'outbound', source: 'manual-upload', status: 'analyzing', language: 'fa',
      title: `${TAG}`,
      // v2.58.6 (P2): the resume tests now carry the SAME lease context
      // the REAL pipeline passes (processRecording mints the token at claim
      // time and hands { recordingId, token } to every stage) — the row's
      // leaseToken mirrors it so the fenced writes match.
      leaseToken: 'resume-tok', leaseUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  const analysis = await db.aiCallAnalysis.create({
    data: { recordingId: recording.id, llmProvider: 'fake', model: 'test', status: 'completed', summary: 's', topic: 't', callReason: 'c', customerNeed: 'n', confidence: 0.8 },
  });
  return { company, user, recording, analysis };
}

/** The lease the real pipeline would hold for this recording. */
function leaseOf(recordingId: string) {
  return { recordingId, token: 'resume-tok' };
}

async function setMode(mode: 'suggest' | 'confirm' | 'auto', companyId: string) {
  await db.meta.upsert({
    where: { key: `ai_sales.approval_mode.${companyId}` },
    update: { value: mode },
    create: { key: `ai_sales.approval_mode.${companyId}`, value: mode },
  });
  invalidateAiSettingsCache();
}

const HIGH_CONF_RAW: AnalysisExtractionRaw = {
  summary: 's', topic: 't', callReason: 'c', customerNeed: 'n',
  customerProblems: [], products: [], budget: '', purchaseTimeframe: '',
  intent: 'warm', temperature: 'warm', conversionScore: 70, scoreReasons: [],
  objections: [], commitments: { rep: [], customer: [] }, openQuestions: [], risks: [],
  opportunities: [], paymentTerms: '', competitors: [], decisionMakers: [],
  suggestedFollowupDate: null, suggestedFollowupReason: '', stageSuggestion: '',
  nextActions: [
    { type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', reason: 'r', priority: 'high', confidence: 0.9, dueAt: null },
  ],
  segments: [], confidence: 0.8,
};

async function activityCountFor(recordingId: string): Promise<number> {
  const actions = await db.aiNextAction.findMany({ where: { recordingId }, select: { executedActivityId: true } });
  const ids = actions.map((a) => a.executedActivityId).filter((x): x is string => Boolean(x));
  if (ids.length === 0) return 0;
  return db.activity.count({ where: { id: { in: ids } } });
}

async function cleanup() {
  const recs = await db.aiCallRecording.findMany({ where: { title: TAG }, select: { id: true } });
  for (const r of recs) {
    const actions = await db.aiNextAction.findMany({ where: { recordingId: r.id }, select: { id: true, executedActivityId: true } });
    for (const a of actions) {
      if (a.executedActivityId) await db.activity.delete({ where: { id: a.executedActivityId } }).catch(() => undefined);
      await db.aiNextAction.delete({ where: { id: a.id } }).catch(() => undefined);
    }
    await db.aiCallAnalysis.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallTranscript.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallRecording.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  await db.meta.deleteMany({ where: { key: { startsWith: 'ai_sales.approval_mode.' } } });
  invalidateAiSettingsCache();
}

beforeAll(async () => { await cleanup(); });
afterAll(async () => { await cleanup(); await db.$disconnect(); });

describe('R3 — a crash between suggested-create and auto-execute resumes execution', () => {
  it('existing suggested (high confidence, mode=auto) → retry executes EXACTLY ONE Activity', async () => {
    const { company, user, recording, analysis } = await fixture();
    await setMode('auto', company.id);
    try {
      // the exact state a crash leaves: the action row EXISTS, un-executed
      await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'suggested', assignedTo: user.id,
        },
      });

      const created = await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id),
      );
      expect(created).toHaveLength(1);

      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('executed');
      expect(action.executedActivityId).not.toBeNull();
      expect(await activityCountFor(recording.id)).toBe(1);
      expect(await db.aiNextAction.count({ where: { recordingId: recording.id } })).toBe(1); // no duplicate rows
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('two CONCURRENT retries → one Activity, one identity', async () => {
    const { company, user, recording, analysis } = await fixture();
    await setMode('auto', company.id);
    try {
      await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'suggested', assignedTo: user.id,
        },
      });
      const ref = { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id };
      await Promise.all([
        createNextActionsFromAnalysis(ref, analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id)),
        createNextActionsFromAnalysis(ref, analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id)),
      ]);
      expect(await activityCountFor(recording.id)).toBe(1);
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('executed');
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('an already-executed action → retry creates NO new Activity', async () => {
    const { company, user, recording, analysis } = await fixture();
    await setMode('auto', company.id);
    try {
      const action = await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'suggested', assignedTo: user.id,
        },
      });
      const firstActivityId = await executeNextAction(action.id, null, true);
      expect(firstActivityId).not.toBeNull();
      const before = await activityCountFor(recording.id);

      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id),
      );
      expect(await activityCountFor(recording.id)).toBe(before); // 1 — nothing new
      const after = await db.aiNextAction.findUniqueOrThrow({ where: { id: action.id } });
      expect(after.executedActivityId).toBe(firstActivityId);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('a dismissed action is NEVER auto-executed by a retry', async () => {
    const { company, user, recording, analysis } = await fixture();
    await setMode('auto', company.id);
    try {
      await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'dismissed', assignedTo: user.id,
        },
      });
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id),
      );
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('dismissed');
      expect(action.executedActivityId).toBeNull();
      expect(await activityCountFor(recording.id)).toBe(0);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('mode changed auto→confirm between crash and retry → NO auto-execution', async () => {
    const { company, user, recording, analysis } = await fixture();
    await setMode('confirm', company.id); // the CURRENT policy governs the retry
    try {
      await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'suggested', assignedTo: user.id,
        },
      });
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null, leaseOf(recording.id),
      );
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('suggested');
      expect(await activityCountFor(recording.id)).toBe(0);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
