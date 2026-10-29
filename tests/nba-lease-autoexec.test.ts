import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// ═══════════════════════════════════════════════════════════════
// nba-lease-autoexec.test.ts — v2.58.6 (user finding P2)
//
// THE AUDIT REPRO (confirmed on the v2.58.5 code):
//   createNextActionsFromAnalysis creates AiNextAction rows through
//   fencedTx (lease-guarded), but the AUTO-EXECUTION of those actions
//   called executeNextAction DIRECTLY — a plain db.$transaction with
//   NO leaseToken check. A worker whose lease was re-granted to a
//   newer owner could still materialize a CRM Activity, flip the
//   action to executed and write a success audit row.
//
// THE CONTRACT (real service, real SQLite; crash states simulated by
// the exact rows a crash leaves behind — no real AI call):
//   • auto-execution MUST run inside the SAME short fenced
//     transaction as ownership proof + action claim + Activity
//     creation + activityId link + audit (token check and write are
//     ONE operation, never check-then-await-then-write);
//   • a stale worker (token no longer matches) writes ZERO: no
//     Activity, no action change, no success audit — it aborts;
//   • the fresh owner (B) executes the action exactly once;
//   • two concurrent authorized executions → ONE Activity, one id;
//   • the manual user path (executeNextAction without a lease) keeps
//     its own contract and still works;
//   • WITHOUT a lease the AUTO path never executes (absence of a
//     lease must not become an auto-execution escape hatch) — the
//     action stays 'suggested' for a human or a later fenced worker.
// ═══════════════════════════════════════════════════════════════

import { createNextActionsFromAnalysis, executeNextAction } from '@/lib/ai/engine/nba';
import { invalidateAiSettingsCache } from '@/lib/ai/settings';
import { LeaseLostError } from '@/lib/ai/engine/lease';
import type { AnalysisExtractionRaw } from '@/lib/ai/extraction';

const db = new PrismaClient();
const TAG = `p2nba-${Date.now().toString(36)}`;

async function fixture(leaseToken: string | null = null) {
  const company = await db.company.findFirstOrThrow({ where: { slug: 'bazargani' } });
  const user = await db.user.findFirstOrThrow({ where: { role: 'admin' } });
  const recording = await db.aiCallRecording.create({
    data: {
      companyId: company.id, userId: user.id,
      direction: 'outbound', source: 'manual-upload', status: 'analyzing', language: 'fa',
      title: `${TAG}`, leaseToken: leaseToken ?? undefined,
      leaseUntil: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  const analysis = await db.aiCallAnalysis.create({
    data: { recordingId: recording.id, llmProvider: 'fake', model: 'test', status: 'completed', summary: 's', topic: 't', callReason: 'c', customerNeed: 'n', confidence: 0.8 },
  });
  return { company, user, recording, analysis };
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

async function auditCountFor(recordingId: string): Promise<number> {
  const actions = await db.aiNextAction.findMany({ where: { recordingId }, select: { title: true } });
  if (actions.length === 0) return 0;
  const titles = actions.map((a) => a.title);
  return db.auditEvent.count({
    where: { eventType: 'AI_ACTION_AUTO_EXECUTED', subject: { in: titles } },
  });
}

async function cleanup() {
  const recs = await db.aiCallRecording.findMany({ where: { title: TAG }, select: { id: true } });
  for (const r of recs) {
    const actions = await db.aiNextAction.findMany({ where: { recordingId: r.id }, select: { id: true, executedActivityId: true } });
    for (const a of actions) {
      if (a.executedActivityId) await db.activity.delete({ where: { id: a.executedActivityId } }).catch(() => undefined);
      await db.aiNextAction.delete({ where: { id: a.id } }).catch(() => undefined);
    }
    await db.auditEvent.deleteMany({ where: { subject: { startsWith: TAG } } });
    await db.aiCallAnalysis.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallTranscript.deleteMany({ where: { recordingId: r.id } });
    await db.aiCallRecording.delete({ where: { id: r.id } }).catch(() => undefined);
  }
  await db.meta.deleteMany({ where: { key: { startsWith: 'ai_sales.approval_mode.' } } });
  invalidateAiSettingsCache();
}

beforeAll(async () => { await cleanup(); });
afterAll(async () => { await cleanup(); await db.$disconnect(); });

describe('P2.1 — THE REPRO: a stale worker auto-executes an Activity with NO lease check', () => {
  it('existing suggested action, lease now owned by B, worker A continues with its OLD token → ZERO writes', async () => {
    const { company, user, recording, analysis } = await fixture('token-B');
    await setMode('auto', company.id);
    try {
      // the exact state a crash leaves: the action row EXISTS (created by A),
      // un-executed; the lease was re-granted to B
      await db.aiNextAction.create({
        data: {
          companyId: company.id, recordingId: recording.id, analysisId: analysis.id,
          dedupeKey: `${recording.id}#0`,
          type: 'call', title: `${TAG} تماس پیگیری`, detail: 'd', priority: 'high',
          reason: 'r', confidence: 0.9, status: 'suggested', assignedTo: user.id,
        },
      });

      // worker A's continuation, carrying its STALE token
      await expect(
        createNextActionsFromAnalysis(
          { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
          analysis.id, HIGH_CONF_RAW, null,
          { recordingId: recording.id, token: 'token-A' }, // ← the stale lease
        ),
      ).rejects.toBeInstanceOf(LeaseLostError);

      // ZERO stale writes: no Activity, no status flip, no success audit
      expect(await activityCountFor(recording.id)).toBe(0);
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('suggested');
      expect(action.executedActivityId).toBeNull();
      expect(await auditCountFor(recording.id)).toBe(0);
    } finally {
      await cleanup();
    }
  }, 20_000);

  it('the fresh owner (B) then executes the SAME action exactly once', async () => {
    const { company, user, recording, analysis } = await fixture('token-B');
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
      const created = await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null,
        { recordingId: recording.id, token: 'token-B' },
      );
      expect(created).toHaveLength(1);
      expect(await activityCountFor(recording.id)).toBe(1);
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('executed');
      expect(action.executedActivityId).not.toBeNull();
      expect(await auditCountFor(recording.id)).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe('P2.2 — crash between action creation and execution → resume under the CURRENT owner', () => {
  it('A created the action then died; the lease moved to B; A\'s continuation executes NOTHING, B executes once', async () => {
    const { company, user, recording, analysis } = await fixture('token-B');
    await setMode('auto', company.id);
    try {
      // worker A (with the CURRENT valid lease) creates the action — this is
      // the state right after a crash between suggested-create and execute
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null,
        { recordingId: recording.id, token: 'token-B' },
      );
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('executed'); // valid lease → executed immediately
      expect(await activityCountFor(recording.id)).toBe(1);
      const firstActivityId = action.executedActivityId;

      // the lease is re-granted to C; the old worker's continuation re-runs:
      // the action is already executed — its path is read-only (nothing to
      // claim), so it must NOT touch anything the newer owner produced
      await db.aiCallRecording.update({
        where: { id: recording.id },
        data: { leaseToken: 'token-C' },
      });
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null,
        { recordingId: recording.id, token: 'token-B' }, // stale now
      );
      // ZERO changes from the stale continuation
      expect(await activityCountFor(recording.id)).toBe(1);
      let afterAction = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(afterAction.status).toBe('executed');
      expect(afterAction.executedActivityId).toBe(firstActivityId);

      // worker C completes the resume — idempotent, SAME activity identity
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null,
        { recordingId: recording.id, token: 'token-C' },
      );
      expect(await activityCountFor(recording.id)).toBe(1);
      afterAction = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(afterAction.executedActivityId).toBe(firstActivityId);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe('P2.3 — concurrency: two authorized executions → ONE Activity, one identity', () => {
  it('parallel fenced executions of the same action → exactly one Activity', async () => {
    const { company, user, recording, analysis } = await fixture('token-D');
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
      const lease = { recordingId: recording.id, token: 'token-D' };
      const [a, b] = await Promise.all([
        executeNextAction(action.id, null, true, lease),
        executeNextAction(action.id, null, true, lease),
      ]);
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).toBe(b); // the SAME activity id — one Activity, ever
      expect(await activityCountFor(recording.id)).toBe(1);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe('P2.4 — the manual user path keeps its own contract', () => {
  it('executeNextAction WITHOUT a lease (the human route) still executes; the AUTO path without a lease never does', async () => {
    const { company, user, recording, analysis } = await fixture(null);
    await setMode('auto', company.id);
    try {
      // AUTO path with NO lease context → the action is created but NEVER
      // auto-executed (no lease = no autonomous write, ever)
      await createNextActionsFromAnalysis(
        { id: recording.id, companyId: company.id, centerId: null, contactId: null, userId: user.id },
        analysis.id, HIGH_CONF_RAW, null,
        // ← no lease argument at all
      );
      const action = await db.aiNextAction.findUniqueOrThrow({ where: { dedupeKey: `${recording.id}#0` } });
      expect(action.status).toBe('suggested');
      expect(await activityCountFor(recording.id)).toBe(0);

      // the MANUAL path (route-level authorization, no lease) executes
      const activityId = await executeNextAction(action.id, user.id, false);
      expect(activityId).not.toBeNull();
      expect(await activityCountFor(recording.id)).toBe(1);
    } finally {
      await cleanup();
    }
  }, 20_000);
});

describe('P2.5 — the REAL pipeline path auto-executes under its own lease', () => {
  it('processRecording (controlled providers, mode=auto) creates exactly one Activity per auto-executable action', async () => {
    // driven through the REAL pipeline in ai-pipeline-resume.test.ts; here we
    // assert the engine-level invariant the pipeline relies on: the lease the
    // pipeline passes ({ recordingId, token }) is honored end-to-end.
    const { company, user, recording, analysis } = await fixture('token-E');
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
      // the lease token on the RECORDING row is what the pipeline minted;
      // a mismatch (stale) must fence; a match must execute
      const activityId = await executeNextAction(action.id, null, true, { recordingId: recording.id, token: 'token-E' });
      expect(activityId).not.toBeNull();
      expect(await activityCountFor(recording.id)).toBe(1);
      // a stale worker is fenced out EVEN on the idempotent read path —
      // it must neither write nor learn the newer worker's result
      await expect(
        executeNextAction((await db.aiNextAction.findUniqueOrThrow({ where: { id: action.id } })).id, null, true, { recordingId: recording.id, token: 'stale' }),
      ).rejects.toBeInstanceOf(LeaseLostError);
      expect(await activityCountFor(recording.id)).toBe(1);
    } finally {
      await cleanup();
    }
  }, 20_000);
});
