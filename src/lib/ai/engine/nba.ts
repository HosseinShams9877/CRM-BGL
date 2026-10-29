import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { getApprovalModeForCompany } from '../settings';
import { findFollowupDateInTexts } from '../followup-date';
import type { AnalysisExtractionRaw } from '../extraction';
import { normalizeIsoDate, normalizePriority } from '../extraction';
import type { AiApprovalMode } from '../types';
import { fencedTx, type LeaseContext } from './lease';
// v2.58.6 (P2): a stale worker's abort must propagate to the pipeline
// (which exits without touching the newer owner's state).
export { LeaseLostError } from './lease';

// ════════════════════════════════════════════════════════════
// NEXT BEST ACTION ENGINE (v2.27.0)
//
// Turns validated analysis extractions into concrete AiNextAction
// rows. Every action carries a Reason (Explainability) and a
// Confidence. Execution policy respects the admin approval mode:
//   suggest  → only create 'suggested' rows (user approves + executes)
//   confirm  → same as suggest (default; execution needs a click)
//   auto     → high-confidence (≥0.75) actions also EXECUTE now,
//              creating a real CRM Activity automatically.
// Executing an action NEVER bypasses the Activity model — it writes
// through the same data path a human uses.
// ════════════════════════════════════════════════════════════

const AUTO_EXECUTE_CONFIDENCE = 0.75;
const MAX_ACTIONS_PER_CALL = 5;

interface RecordingRef {
  id: string;
  companyId: string;
  centerId: string | null;
  contactId: string | null;
  userId: string | null;
}

/** Reject LLM-produced dates that are nonsense (wrong year arithmetic). */
function isPlausibleDueDate(d: Date): boolean {
  const now = Date.now();
  const t = d.getTime();
  // not more than 7 days in the past, not more than 2 years ahead
  return t > now - 7 * 24 * 3600 * 1000 && t < now + 2 * 365 * 24 * 3600 * 1000;
}

/**
 * Resolve the concrete due date for an action.
 * Priority:
 *  1. The deterministic Persian relative-date parser over the analysis texts
 *     («شنبه»، «پس‌فردا»، …) — arithmetic we control, not the LLM.
 *  2. An explicit LLM ISO date — accepted only inside sane bounds
 *     (LLMs frequently botch year arithmetic on relative dates).
 */
function resolveDueDate(raw: AnalysisExtractionRaw, explicitIso?: string | null): Date | null {
  const fromReasons = findFollowupDateInTexts([
    raw.suggestedFollowupReason,
    ...raw.commitments.customer,
    ...raw.commitments.rep,
    raw.summary,
  ]);
  if (fromReasons) return fromReasons.date;
  const explicit = normalizeIsoDate(explicitIso ?? null);
  if (explicit) {
    const d = new Date(explicit);
    if (isPlausibleDueDate(d)) return d;
  }
  return null;
}

export async function createNextActionsFromAnalysis(
  recording: RecordingRef,
  analysisId: string,
  raw: AnalysisExtractionRaw,
  fallbackDue: Date | null,
  lease?: LeaseContext,
): Promise<string[]> {
  const created: string[] = [];
  if (raw.nextActions.length === 0) return created;

  const mode = await getApprovalModeForCompany(recording.companyId);
  const followupDue = fallbackDue || resolveDueDate(raw, raw.suggestedFollowupDate ?? null);

  // Replace null/absent dueAt with the resolved follow-up date where it
  // plausibly applies (call/whatsapp/meeting-style actions).
  const drafts = raw.nextActions.slice(0, MAX_ACTIONS_PER_CALL).map((a) => ({
    ...a,
    priority: normalizePriority(a.priority),
    dueAt: normalizeIsoDate(a.dueAt ?? null) ? new Date(normalizeIsoDate(a.dueAt ?? null) as string) : followupDue,
  }));

  // v2.58.4 (external audit F07) — RESUMABLE creation: every action carries
  // a stable dedupeKey ("<recordingId>#<index>") guarded by a UNIQUE index.
  // The old loop was all-or-nothing in effect: a crash after the FIRST
  // action made the pipeline's "an action exists" check skip the WHOLE
  // stage on retry, permanently losing the remaining actions. Now a
  // re-run creates EXACTLY the missing rows (existing keys are skipped,
  // duplicates are structurally impossible).
  for (const [index, draft] of drafts.entries()) {
    const dedupeKey = `${recording.id}#${index}`;

    // resume fast-path: an earlier interrupted run already created this
    // row — reuse its identity, create nothing (the UNIQUE index plus the
    // P2002 backstop below close the concurrent window).
    // v2.58.5 (R3): "the action EXISTS" is no longer conflated with "the
    // action was EXECUTED". A crash between creating a 'suggested' row and
    // its auto-execution left the row un-executed forever; now an EXISTING
    // row that the CURRENT policy still marks auto-executable (mode=auto,
    // confidence ≥ threshold, status suggested/approved) is routed through
    // the SAME idempotent execution path (exactly one Activity — the loser
    // of a concurrent race gets the winner's activity id; an already-
    // executed row returns its stored activity id; a dismissed row or a
    // confirm/suggest policy never auto-executes).
    const existing = await db.aiNextAction.findUnique({ where: { dedupeKey } });
    if (existing) {
      created.push(existing.id);
      // v2.58.6 (P2): the AUTO-EXECUTION of an existing action runs INSIDE
      // the fenced transaction (ownership proof + claim + Activity + link +
      // audit in ONE short tx). WITHOUT a lease the auto path NEVER
      // executes — the absence of a lease must not become an autonomous-
      // write escape hatch; the action stays 'suggested' for a human or a
      // later fenced worker (the pipeline always passes its lease).
      if (
        lease
        && mode === 'auto'
        && draft.confidence >= AUTO_EXECUTE_CONFIDENCE
        && (existing.status === 'suggested' || existing.status === 'approved')
      ) {
        await executeNextAction(existing.id, null, true, lease);
      }
      continue;
    }

    // dedup: don't stack the same action type for the same center from the same call.
    // v2.58.5 (R4): the CREATE is FENCED — only the current lease owner's
    // actions land; a lease-less caller keeps the unfenced write.
    const createData = {
      companyId: recording.companyId,
      centerId: recording.centerId,
      contactId: recording.contactId,
      recordingId: recording.id,
      analysisId,
      dedupeKey,
      type: draft.type,
      title: draft.title || 'اقدام پیشنهادی هوش مصنوعی',
      detail: draft.detail || '',
      priority: draft.priority,
      dueAt: draft.dueAt,
      reason: draft.reason || 'استخراج‌شده از تحلیل مکالمه',
      confidence: draft.confidence,
      status: 'suggested' as const,
      assignedTo: recording.userId,
      createdById: null,
    };
    const createAction = (tx: Pick<typeof db, 'aiNextAction'>) => tx.aiNextAction.create({ data: createData });
    const action = await (lease
      ? fencedTx(lease.recordingId, lease.token, (tx) => createAction(tx))
      : createAction(db)
    ).catch(async (e: unknown) => {
      // a concurrent duplicate on the UNIQUE(dedupeKey) — resume the
      // existing row's identity instead of failing the stage
      if ((e as { code?: string }).code === 'P2002') {
        const existing = await db.aiNextAction.findUnique({ where: { dedupeKey } });
        if (existing) return existing;
      }
      throw e;
    });
    created.push(action.id);

    // v2.58.6 (P2): the fresh action's auto-execution goes through the SAME
    // fenced path (see above); no lease ⇒ no autonomous execution.
    if (lease && mode === 'auto' && draft.confidence >= AUTO_EXECUTE_CONFIDENCE) {
      await executeNextAction(action.id, null, true, lease);
    }
  }
  return created;
}

// ── Execution: materialize as a REAL Activity ───────────────
const ACTIVITY_TITLE_PREFIX = '[اقدام AI] ';

/** Which Activity shape does an action type map to? */
function activityShape(type: string): { isPhoneCall: boolean; isMeeting: boolean } {
  return {
    isPhoneCall: type === 'call' || type === 'decision_maker',
    isMeeting: type === 'meeting' || type === 'demo',
  };
}

/**
 * Execute (or auto-execute) a suggested/approved next action by creating a
 * real CRM Activity assigned to the right user. Returns the activity id.
 * `actorId` is the human approver; null ⇒ autonomous execution by policy.
 *
 * v2.58.3 (round 88, finding 10) — ATOMIC + IDEMPOTENT:
 *   • the status flip (suggested/approved → executed) is a CONDITIONAL
 *     updateMany INSIDE the transaction that also creates the Activity
 *     and links it — concurrent executions cannot both pass a
 *     read-then-check guard anymore (exactly one Activity is created);
 *   • a crash mid-transaction leaves NOTHING (no activity, status
 *     unchanged) — a retry re-claims cleanly;
 *   • a repeat call on an ALREADY-executed action returns the SAME
 *     activity id (idempotent) instead of duplicating the output.
 *
 * v2.58.6 (user P2) — LEASE-FENCED AUTO EXECUTION: when the WORKER path
 * supplies a LeaseContext, the ownership proof (guard UPDATE on the
 * recording row conditioned on the lease token), the action claim, the
 * Activity creation, the activityId link and the audit row all land in
 * ONE SHORT fenced transaction — a token check before an await followed
 * by a separate write is exactly what this replaces. A worker whose
 * lease was re-granted to a newer owner matches ZERO rows and aborts via
 * LeaseLostError BEFORE any write. The MANUAL user path (no lease) keeps
 * its own authorization contract — the route checks permissions before
 * calling; it is never a path the autonomous engine can take.
 */
export async function executeNextAction(
  actionId: string,
  actorId: string | null,
  byPolicy: boolean,
  lease?: LeaseContext,
): Promise<string | null> {
  const run = async (tx: Prisma.TransactionClient): Promise<string | null> => {
    // ATOMIC CLAIM — only a suggested/approved row flips to executed here;
    // the loser of a concurrent race falls through to the idempotent read.
    const claim = await tx.aiNextAction.updateMany({
      where: { id: actionId, status: { in: ['suggested', 'approved'] } },
      data: {
        status: 'executed',
        executedAt: new Date(),
      },
    });

    const action = await tx.aiNextAction.findUnique({ where: { id: actionId } });
    if (!action) return null;

    if (claim.count === 0) {
      // IDEMPOTENT path: already executed → the SAME activity id back;
      // any other terminal state → not executable (null).
      if (action.status === 'executed' && action.executedActivityId) {
        return action.executedActivityId;
      }
      return null;
    }

    const shape = activityShape(action.type);
    const due = action.dueAt || new Date();
    // in-tx read (the global pool inside an interactive transaction
    // deadlocks Prisma's SQLite engine)
    const businessUnitId = action.centerId
      ? (await tx.center.findUnique({ where: { id: action.centerId }, select: { businessUnitId: true } }))?.businessUnitId || 'production'
      : 'production';

    const activity = await tx.activity.create({
      data: {
        title: `${ACTIVITY_TITLE_PREFIX}${action.title}`.slice(0, 200),
        description: [
          action.detail || '',
          action.reason ? `دلیل: ${action.reason}` : '',
          byPolicy ? 'ایجادشده خودکار توسط موتور اقدامات AI (سیاست اجرای خودکار)' : `ایجادشده از اقدام AI توسط ${actorId || ''}`,
        ].filter(Boolean).join(' — ').slice(0, 1000),
        activityDate: due,
        activityTime: '09:00',
        isPhoneCall: shape.isPhoneCall,
        centerId: action.centerId,
        assignedTo: action.assignedTo || actorId,
        createdById: actorId,
        businessUnitId,
        status: 'pending',
      },
    });

    await tx.aiNextAction.update({
      where: { id: actionId },
      data: {
        approvedById: action.approvedById || actorId,
        approvedAt: action.approvedAt || new Date(),
        executedActivityId: activity.id,
      },
    });

    await tx.auditEvent.create({
      data: {
        eventType: byPolicy ? 'AI_ACTION_AUTO_EXECUTED' : 'AI_ACTION_EXECUTED',
        category: 'ai_sales',
        subject: action.title,
        details: `type=${action.type}; activityId=${activity.id}; center=${action.centerId || '-'}; confidence=${action.confidence}`,
        userId: actorId || action.assignedTo || undefined,
      },
    }).catch(() => undefined);

    return activity.id;
  };

  if (lease) {
    // the WORKER path: guard + claim + create + link + audit in ONE short
    // fenced transaction (the token check is the FIRST statement, and the
    // commit IS the proof — never check-then-await-then-write)
    return fencedTx(lease.recordingId, lease.token, run);
  }
  // the MANUAL user path: route-level authorization, plain transaction
  return db.$transaction(run, { timeout: 20_000, maxWait: 5_000 });
}

/** Human approves a suggested action (Confirm-Before-Action mode).
 *  v2.58.3 — the transition is a CONDITIONAL update: a double-click or a
 *  concurrent approve/execute race resolves to exactly one flip. */
export async function approveNextAction(actionId: string, approverId: string): Promise<boolean> {
  const res = await db.aiNextAction.updateMany({
    where: { id: actionId, status: 'suggested' },
    data: { status: 'approved', approvedById: approverId, approvedAt: new Date() },
  });
  if (res.count === 0) return false;
  await db.auditEvent.create({
    data: {
      eventType: 'AI_ACTION_APPROVED', category: 'ai_sales', subject: actionId,
      details: `approver=${approverId}`, userId: approverId,
    },
  }).catch(() => undefined);
  return true;
}

/** Dismiss a suggested action with a reason.
 *  v2.58.3 — conditional update (same race-proof discipline as approve). */
export async function dismissNextAction(actionId: string, userId: string, reason: string): Promise<boolean> {
  const res = await db.aiNextAction.updateMany({
    where: { id: actionId, status: 'suggested' },
    data: { status: 'dismissed', dismissedReason: reason.slice(0, 500) },
  });
  if (res.count === 0) return false;
  await db.auditEvent.create({
    data: {
      eventType: 'AI_ACTION_DISMISSED', category: 'ai_sales', subject: actionId,
      details: `reason=${reason.slice(0, 200)}`, userId,
    },
  }).catch(() => undefined);
  return true;
}

/** Approval-mode helper for the UI. */
export function describePolicy(mode: AiApprovalMode): string {
  if (mode === 'auto') return `اقدامات با اطمینان ≥ ${Math.round(AUTO_EXECUTE_CONFIDENCE * 100)}٪ به‌صورت خودکار اجرا می‌شوند.`;
  if (mode === 'confirm') return 'هر اقدام پیش از اجرا به تأیید کاربر نیاز دارد.';
  return 'اقدامات فقط پیشنهاد می‌شوند و اجرای آنها با کاربر است.';
}
