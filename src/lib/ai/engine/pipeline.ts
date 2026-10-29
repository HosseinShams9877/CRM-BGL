import { db } from '@/lib/db';
import { logApiError } from '@/lib/logger';
import { randomBytes } from 'node:crypto';
import {
  LeaseLostError, fencedUpdate, fencedTx, renewLease, PROCESSING_LEASE_MS,
} from './lease';
export { LeaseLostError };
import { getLLMProvider, extractJsonObject, type LlmMessage } from '../providers/llm';
import { getSTTProvider } from '../providers/stt';
import {
  buildAnalysisSystemPrompt, buildAnalysisUserPrompt, buildCoachSystemPrompt,
  buildCoachUserPrompt,
} from '../prompts';
import { analysisExtractionSchema, coachExtractionSchema, normalizeIntent, normalizeTemperature, normalizeObjectionType, normalizeSeverity, normalizePriority, normalizeActionType, normalizeBuyingRole, normalizeIsoDate } from '../extraction';
import { getAiSettings } from '../settings';
import { recordAiUsage, isOverMonthlyLimit } from '../usage';
import { createNextActionsFromAnalysis } from './nba';
import { upsertMemoryFromAnalysis } from './memory';
import { toJalaliString } from '@/lib/jalali';
import type { AiTranscriptSegment, AiSpeaker } from '../types';
import { findFollowupDateInTexts } from '../followup-date';

// ════════════════════════════════════════════════════════════
// CALL PROCESSING PIPELINE (v2.27.0)
//
// uploaded → queued → transcribing → analyzing → completed | failed
//
// Runs in the background (`after()` in the route layer), never inside
// the UI request. Every failure is captured on the recording row with
// a human-readable reason; a retry re-queues without losing data.
// All AI provider calls go through the provider abstraction and are
// usage-logged. Transcript is UNTRUSTED INPUT throughout.
// ════════════════════════════════════════════════════════════

const MAX_RETRY = 3;

// ═══ v2.58.4 (external audit F07) — lease fencing + exact resume ══
// The v2.58.3 lease prevented CONCURRENT processing, but a stale worker
// whose lease had expired (and been re-granted) could still WRITE its
// results over the new owner's state, and "an action exists" was treated
// as "all actions were created" — a crash after the first of three
// actions permanently skipped the rest, and the resume path fed memory a
// STUB extraction (as-unknown-as cast) that crashed on objections.filter.
//
// v2.58.5 (R4): the fence primitives live in ./lease.ts and are shared by
// EVERY stage module (pipeline, nba, memory) — see that file for the
// contract.

export interface ClaimOutcome {
  claimed: boolean;
  /** The fencing token — every stage write must carry it. */
  token: string | null;
}

/** Atomically claim a recording for processing, minting a fencing token. */
export async function claimRecordingForProcessingWithToken(
  recordingId: string,
  now = new Date(),
): Promise<ClaimOutcome> {
  const leaseToken = randomBytes(12).toString('hex');
  const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);
  const res = await db.aiCallRecording.updateMany({
    where: {
      id: recordingId,
      OR: [
        // fresh work — no live lease (a row ALREADY carrying a future
        // lease is someone else's; claiming it again would double-process)
        { status: { in: ['uploaded', 'queued'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        // crashed worker: mid-pipeline state with an EXPIRED lease
        { status: { in: ['transcribing', 'analyzing'] }, leaseUntil: { lt: now } },
      ],
    },
    data: { status: 'queued', leaseUntil, leaseToken, failReason: '' },
  });
  return { claimed: res.count === 1, token: res.count === 1 ? leaseToken : null };
}

/** Backward-compatible boolean claim (see claimRecordingForProcessingWithToken). */
export async function claimRecordingForProcessing(recordingId: string, now = new Date()): Promise<boolean> {
  return (await claimRecordingForProcessingWithToken(recordingId, now)).claimed;
}

/** Kick off full processing for a recording.
 *  v2.58.3: claim-gated (exactly one concurrent worker), lease-protected
 *  (crash recovery).
 *  v2.58.4 (external audit F07): EXACT RESUME — every stage writes a
 *  completion marker on the recording (actionsDone / memoryDone /
 *  coachingDone), the resume path REBUILDS the validated extraction from
 *  the persisted analysis row (a real object, never an as-unknown-as
 *  stub), per-action dedupe keys let a half-created action set finish
 *  exactly the missing rows, and every stage write + the completion are
 *  FENCED by the lease token — a stale worker cannot clobber the state
 *  of the worker that replaced it.
 *  v2.58.5 (R4): the fence now covers EVERY pipeline write (transcript,
 *  analysis, memory, actions, coach insight) — each committed in a short
 *  transaction that atomically proves lease ownership; the lease is
 *  renewed before each long network stage; the worker-failure path is
 *  fenced too; a COACH FAILURE is never marked done (retryable — see
 *  the coach-only resume below). */
export async function processRecording(recordingId: string): Promise<void> {
  let recording = await db.aiCallRecording.findUnique({
    where: { id: recordingId },
    include: { center: { select: { id: true, name: true } }, contact: { select: { id: true, title: true, person: true } }, rep: { select: { id: true, displayName: true } } },
  });
  if (!recording) return;

  const settings = await getAiSettings();

  // v2.58.5 (R4) — COACH-ONLY RESUME: a completed recording whose coaching
  // FAILED (coachingDone deliberately left false) is re-entered here — the
  // analysis/transcript/actions/memory stages are all marked done; only the
  // missing coach stage runs, under a fresh fenced claim.
  if (recording.status === 'completed' && !recording.coachingDone) {
    if (!settings.coachEnabled || !recording.userId) return;
    const { claimed, token } = await claimCoachResume(recordingId);
    if (!claimed || !token) return;
    try {
      const done = await coachCall(recordingId, recording, recording.userId, token);
      if (done) {
        // set the marker AND release the coach-resume lease atomically
        await fencedUpdate(recordingId, token, { coachingDone: true, leaseUntil: null, leaseToken: null });
      }
    } catch (e) {
      if (e instanceof LeaseLostError) return; // fenced out — not ours anymore
      logApiError('ai-sales-pipeline', 'coach resume failed (non-fatal, retryable):', recordingId);
    }
    return;
  }

  if (recording.status === 'completed') return;

  // v2.58.3 — ATOMIC CLAIM; v2.58.4 — the claim also mints the FENCING
  // token this worker must carry on every write.
  const { claimed, token } = await claimRecordingForProcessingWithToken(recordingId);
  if (!claimed || !token) return;
  // re-read AFTER the claim so the stage markers are fresh
  recording = (await db.aiCallRecording.findUnique({
    where: { id: recordingId },
    include: { center: { select: { id: true, name: true } }, contact: { select: { id: true, title: true, person: true } }, rep: { select: { id: true, displayName: true } } },
  }))!;
  if (!recording) return;

  try {
    // ── Stage 0 (v2.47.0): consent gate — BEFORE any audio leaves the disk.
    if (recording.consent === 'denied') {
      await failRecording(
        recordingId,
        'رضایت ضبط این تماس ثبت نشده است (consent=denied) — پردازش صوت و تحلیل ممنوع است.',
        token,
      );
      return;
    }

    // Cost guard — do not burn provider budget when over the monthly cap.
    if (await isOverMonthlyLimit(recording.companyId, settings.monthlyCostLimitRial)) {
      await failRecording(recordingId, 'سقف ماهانه هزینه هوش مصنوعی پر شده است. با مدیر سیستم تماس بگیرید.', token);
      return;
    }

    // ── Stage 1: transcript ──
    let transcript = await db.aiCallTranscript.findUnique({ where: { recordingId } });
    if (!transcript) {
      if (recording.source === 'manual-transcript') {
        await failRecording(recordingId, 'متن مکالمه برای این تماس ثبت نشده است.', token);
        return;
      }
      await fencedUpdate(recordingId, token, { status: 'transcribing' });
      const stt = getSTTProvider(settings.sttProvider);
      let audioBuffer: Buffer | null = null;
      if (recording.audioFileId) {
        const file = await db.file.findUnique({ where: { id: recording.audioFileId } });
        if (file) {
          const { resolveStoredPath } = await import('@/lib/storage');
          const fs = await import('fs');
          const p = resolveStoredPath(file.storedName);
          if (p && fs.existsSync(p)) audioBuffer = fs.readFileSync(p);
        }
      }
      if (!audioBuffer) {
        await failRecording(recordingId, 'فایل صوتی این تماس روی دیسک یافت نشد.', token);
        return;
      }
      await renewLease(recordingId, token); // (R4) long network stage ahead
      const result = await stt.transcribe(audioBuffer, 'audio', recording.language);
      // (R4) fenced, short-tx commit — network stayed OUTSIDE
      transcript = await fencedTx(recordingId, token, (tx) => tx.aiCallTranscript.create({
        data: {
          recordingId,
          sttProvider: result.provider,
          language: recording.language,
          fullText: result.text,
          segments: '[]',
          confidence: result.confidence,
          wordCount: result.text.split(/\s+/).filter(Boolean).length,
        },
      }));
      await recordAiUsage({
        companyId: recording.companyId, userId: recording.createdById, feature: 'stt',
        provider: result.provider, model: 'asr', audioSeconds: recording.durationSec,
      });
    }

    // ── Stage 2: analysis ──
    // v2.58.4 (F07): a prior analysis row is RE-READ as a complete,
    // validated extraction (extractionFromAnalysisRow) — the old resume
    // path fabricated a stub with `as unknown as` and crashed memory on
    // objections.filter, feeding ungrounded empty facts to the merge.
    await fencedUpdate(recordingId, token, { status: 'analyzing' });
    let analysis: AnalysisOutcome | null = null;
    const priorAnalysis = await db.aiCallAnalysis.findFirst({
      where: { recordingId },
      orderBy: { createdAt: 'desc' },
    });
    if (priorAnalysis) {
      analysis = {
        analysisId: priorAnalysis.id,
        extraction: extractionFromAnalysisRow(priorAnalysis),
        segmentsJson: null,
        fallbackDue: priorAnalysis.suggestedFollowupDate,
      };
    }
    if (!analysis) {
      analysis = await analyzeTranscript(recordingId, recording, transcript.fullText, transcript.id, token);
    }
    if (!analysis) {
      await renewLease(recordingId, token); // (R4) the retry below is another network stage
      await recordAiUsage({ companyId: recording.companyId, feature: 'call_analysis', provider: 'retry', model: 'auto-retry' });
      analysis = await analyzeTranscript(recordingId, recording, transcript.fullText, transcript.id, token);
    }
    if (!analysis) return; // failure already recorded inside analyzeTranscript (fenced)

    // ── Stage 3: LLM-attributed speaker segments (persisted back onto the
    // transcript — fenced best-effort; a LeaseLostError still aborts).
    if (analysis.segmentsJson) {
      await fencedTx(recordingId, token, (tx) => tx.aiCallTranscript.update({
        where: { id: transcript.id },
        data: { segments: analysis!.segmentsJson! },
      })).catch((e: unknown) => {
        if (e instanceof LeaseLostError) throw e;
        logApiError('ai-sales-pipeline', 'segment persist failed (non-fatal):', recordingId);
      });
    }

    // ── Stage 4: Next Best Actions — completion-marker + per-action
    // dedupe keys (F07): a crash after the FIRST of N actions resumes
    // exactly the missing ones; zero actions is a valid completed result
    // (distinct from "stage never ran" via actionsDone).
    // v2.58.5 (R3/R4): resume also RE-EXECUTES a not-yet-executed action
    // the current policy auto-executes; every action write is fenced.
    if (!recording.actionsDone) {
      await createNextActionsFromAnalysis(recording, analysis.analysisId, analysis.extraction, analysis.fallbackDue, { recordingId, token });
      await fencedUpdate(recordingId, token, { actionsDone: true });
    }

    // ── Stage 5: structured customer memory (marker-guarded; on the
    // resume path this now receives the REBUILT grounded extraction) ──
    // v2.58.5 (R4): fenced commit; the LLM merge ran outside the fence.
    if (!recording.memoryDone) {
      await upsertMemoryFromAnalysis(recording.companyId, recording.centerId, recording.contactId, analysis.analysisId, analysis.extraction, recording.createdById, { recordingId, token });
      await fencedUpdate(recordingId, token, { memoryDone: true });
    }

    // ── Stage 6: coaching (marker-guarded; a crash mid-run does not
    // re-emit a completed insight). v2.58.5 (R4): a coaching FAILURE is
    // NEVER marked done — coachingDone=true ⇔ an insight was persisted;
    // failure leaves the marker false and the recording still completes
    // (the coach-only resume above retries the stage). ──
    if (settings.coachEnabled && recording.userId && !recording.coachingDone) {
      const coached = await coachCall(recordingId, recording, recording.userId, token)
        .catch((e: unknown) => {
          if (e instanceof LeaseLostError) throw e; // ownership lost — abort everything
          logApiError('ai-sales-pipeline', 'coach failed (non-fatal, retryable):', e instanceof Error ? e.message : String(e));
          return false;
        });
      if (coached) {
        await fencedUpdate(recordingId, token, { coachingDone: true });
      } else {
        logApiError('ai-sales-pipeline', 'coachingDone NOT set (failed/skipped) — retryable via re-processing:', recordingId);
      }
    }

    // FENCED completion — a stale worker cannot mark a recording the
    // newer owner is still processing (or has re-processed) as completed.
    await fencedUpdate(recordingId, token, { status: 'completed', failReason: '', leaseUntil: null, leaseToken: null });
  } catch (e) {
    if (e instanceof LeaseLostError) {
      // our lease was re-granted to a newer worker: OUR results are stale,
      // the new owner owns the recording's fate — exit without touching it
      logApiError('ai-sales-pipeline', 'stale worker fenced out (lease re-granted):', recordingId);
      return;
    }
    const msg = e instanceof Error ? e.message : 'خطای ناشناخته در پردازش تماس';
    logApiError('ai-sales-pipeline', 'recording failed:', recordingId, msg);
    await failRecording(recordingId, msg, token);
  }
}

/** v2.58.5 (R4) — claim for the COACH-ONLY resume (see processRecording):
 *  a completed recording with coachingDone=false and no live lease gets a
 *  fresh fencing token WITHOUT changing its completed status. */
async function claimCoachResume(recordingId: string, now = new Date()): Promise<ClaimOutcome> {
  const leaseToken = randomBytes(12).toString('hex');
  const leaseUntil = new Date(now.getTime() + PROCESSING_LEASE_MS);
  const res = await db.aiCallRecording.updateMany({
    where: {
      id: recordingId,
      status: 'completed',
      coachingDone: false,
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil, leaseToken },
  });
  return { claimed: res.count === 1, token: res.count === 1 ? leaseToken : null };
}

async function failRecording(recordingId: string, reason: string, token: string): Promise<void> {
  // v2.58.5 (R4): the token is MANDATORY on the worker-failure path — a
  // stale worker must not be able to mark a recording failed while the
  // new owner is processing it.
  await db.aiCallRecording.updateMany({
    where: { id: recordingId, leaseToken: token },
    data: { status: 'failed', failReason: reason.slice(0, 500), leaseUntil: null, leaseToken: null },
  }).catch(() => undefined);
}

// ── v2.58.4 (F07): rebuild the COMPLETE extraction from a persisted
// analysis row — a real, grounded, type-correct object (the exact
// inverse of the row's creation in analyzeTranscript). JSON columns are
// parsed defensively: a corrupt value degrades to an empty array, never
// to an undefined that crashes a downstream .filter/.map.
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  try {
    const v: unknown = JSON.parse(raw || '[]');
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function parseCommitments(raw: string | null | undefined): { rep: string[]; customer: string[] } {
  try {
    const v = JSON.parse(raw || '{}') as { rep?: unknown; customer?: unknown };
    const rep = Array.isArray(v.rep) ? v.rep.filter((x): x is string => typeof x === 'string') : [];
    const customer = Array.isArray(v.customer) ? v.customer.filter((x): x is string => typeof x === 'string') : [];
    return { rep, customer };
  } catch {
    return { rep: [], customer: [] };
  }
}

/** Exported for tests: the resume-path extraction rebuild. */
export function extractionFromAnalysisRow(a: {
  summary: string;
  topic: string;
  callReason: string;
  customerNeed: string;
  customerProblems: string;
  products: string;
  budget: string;
  purchaseTimeframe: string;
  intent: string;
  temperature: string;
  conversionScore: number;
  scoreReasons: string;
  objections: string;
  commitments: string;
  openQuestions: string;
  risks: string;
  opportunities: string;
  paymentTerms: string;
  competitors: string;
  decisionMakers: string;
  suggestedFollowupDate: Date | null;
  suggestedFollowupReason: string;
  stageSuggestion: string;
  nextActions: string;
  confidence: number;
}): import('../extraction').AnalysisExtractionRaw {
  return {
    summary: a.summary || '',
    topic: a.topic || '',
    callReason: a.callReason || '',
    customerNeed: a.customerNeed || '',
    customerProblems: parseJsonArray(a.customerProblems),
    products: parseJsonArray(a.products),
    budget: a.budget || '',
    purchaseTimeframe: a.purchaseTimeframe || '',
    intent: a.intent || '',
    temperature: a.temperature || '',
    conversionScore: a.conversionScore,
    scoreReasons: parseJsonArray(a.scoreReasons),
    objections: parseJsonArray(a.objections),
    commitments: parseCommitments(a.commitments),
    openQuestions: parseJsonArray(a.openQuestions),
    risks: parseJsonArray(a.risks),
    opportunities: parseJsonArray(a.opportunities),
    paymentTerms: a.paymentTerms || '',
    competitors: parseJsonArray(a.competitors),
    decisionMakers: parseJsonArray(a.decisionMakers),
    suggestedFollowupDate: a.suggestedFollowupDate ? a.suggestedFollowupDate.toISOString() : null,
    suggestedFollowupReason: a.suggestedFollowupReason || '',
    stageSuggestion: a.stageSuggestion || '',
    nextActions: parseJsonArray(a.nextActions),
    segments: [],
    confidence: a.confidence,
  };
}

// ── Analysis ────────────────────────────────────────────────
type RecordingWithRelations = {
  id: string; companyId: string; centerId: string | null; contactId: string | null;
  userId: string | null; language: string;
  center: { id: string; name: string } | null;
  contact: { id: string; title: string; person: string | null } | null;
  rep: { id: string; displayName: string } | null;
};

interface AnalysisOutcome {
  analysisId: string;
  extraction: import('../extraction').AnalysisExtractionRaw;
  segmentsJson: string | null;
  fallbackDue: Date | null;
}

async function analyzeTranscript(
  recordingId: string,
  recording: RecordingWithRelations,
  transcriptText: string,
  transcriptId: string,
  token: string,
): Promise<AnalysisOutcome | null> {
  const settings = await getAiSettings();
  const llm = getLLMProvider(settings.llmProvider);

  // Recent CRM context (grounding aid, not a source of facts)
  const recentContext = await buildRecentContext(recording);

  const todayJalali = toJalaliString(new Date());
  const system = buildAnalysisSystemPrompt({
    transcriptText: '',
    centerName: recording.center?.name,
    contactName: recording.contact?.person || recording.contact?.title,
    contactTitle: recording.contact?.title,
    repName: recording.rep?.displayName,
    domainVocabulary: settings.domainVocabulary,
    recentContext,
    todayJalali,
  });
  const user = buildAnalysisUserPrompt({
    transcriptText,
    centerName: recording.center?.name,
    contactName: recording.contact?.person || recording.contact?.title,
    contactTitle: recording.contact?.title,
    repName: recording.rep?.displayName,
    domainVocabulary: settings.domainVocabulary,
    recentContext,
    todayJalali,
  });

  const messages: LlmMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  await renewLease(recordingId, token); // (R4) long network stage ahead
  const completion = await llm.complete(messages, { maxTokens: 4000, temperature: 0.2 });
  await recordAiUsage({
    companyId: recording.companyId, userId: recording.userId, feature: 'call_analysis',
    provider: completion.provider, model: completion.model,
    inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
  });

  const parsed = extractJsonObject(completion.content);
  if (!parsed) {
    // (R4) fenced — a stale worker cannot fail the NEW owner's recording
    await failRecording(recordingId, 'پاسخ سرویس هوش مصنوعی قابل تفسیر نبود (JSON نامعتبر). دوباره تلاش کنید.', token);
    await recordAiUsage({ companyId: recording.companyId, feature: 'call_analysis', provider: completion.provider, model: completion.model, status: 'failed' });
    return null;
  }

  const check = analysisExtractionSchema.safeParse(parsed);
  if (!check.success) {
    await failRecording(recordingId, 'خروجی تحلیل فیلدهای موردانتظار را نداشت. دوباره تلاش کنید.', token);
    return null;
  }
  const raw = check.data;

  // Normalize enums + dates (defense against creative LLM values).
  const normalizedObjections = raw.objections.map((o) => ({
    type: normalizeObjectionType(o.type),
    description: o.description,
    severity: normalizeSeverity(o.severity),
    resolved: o.resolved,
    recommendedResponse: o.recommendedResponse || '',
  }));
  const normalizedActions = raw.nextActions
    .map((a) => ({ ...a, type: normalizeActionType(a.type), priority: normalizePriority(a.priority) }))
    .filter((a) => a.type);
  // LLM relative-date arithmetic is unreliable (wrong years are common) —
  // prefer the deterministic Persian parser, then a bounds-checked ISO date.
  const parsedRelative = findFollowupDateInTexts([
    raw.suggestedFollowupReason,
    ...raw.commitments.customer,
    ...raw.commitments.rep,
    raw.summary,
  ]);
  const explicitIso = normalizeIsoDate(raw.suggestedFollowupDate ?? null);
  let fallbackDue: Date | null = parsedRelative ? parsedRelative.date : null;
  if (!fallbackDue && explicitIso) {
    const d = new Date(explicitIso);
    const now = Date.now();
    const plausible = d.getTime() > now - 7 * 24 * 3600 * 1000 && d.getTime() < now + 2 * 365 * 24 * 3600 * 1000;
    fallbackDue = plausible ? d : null;
  }

  // (R4) fenced, short-tx commit — the LLM call stayed OUTSIDE; a stale
  // worker's analysis cannot land next to the new owner's processing.
  const analysis = await fencedTx(recordingId, token, (tx) => tx.aiCallAnalysis.create({
    data: {
      recordingId,
      llmProvider: completion.provider,
      model: completion.model,
      status: 'completed',
      summary: raw.summary,
      topic: raw.topic,
      callReason: raw.callReason,
      customerNeed: raw.customerNeed,
      customerProblems: JSON.stringify(raw.customerProblems),
      products: JSON.stringify(raw.products),
      budget: raw.budget,
      purchaseTimeframe: raw.purchaseTimeframe,
      intent: normalizeIntent(raw.intent),
      temperature: normalizeTemperature(raw.temperature),
      conversionScore: Math.round(raw.conversionScore),
      scoreReasons: JSON.stringify(raw.scoreReasons),
      objections: JSON.stringify(normalizedObjections),
      commitments: JSON.stringify(raw.commitments),
      openQuestions: JSON.stringify(raw.openQuestions),
      risks: JSON.stringify(raw.risks),
      opportunities: JSON.stringify(raw.opportunities),
      paymentTerms: raw.paymentTerms,
      competitors: JSON.stringify(raw.competitors),
      decisionMakers: JSON.stringify(raw.decisionMakers.map((d) => ({ ...d, type: normalizeBuyingRole(d.type) }))),
      suggestedFollowupDate: fallbackDue instanceof Date ? fallbackDue : null,
      suggestedFollowupReason: raw.suggestedFollowupReason || '',
      stageSuggestion: raw.stageSuggestion || '',
      nextActions: JSON.stringify(normalizedActions),
      confidence: raw.confidence,
      needsReview: raw.confidence < 0.55,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
    },
  }));

  // Persist the LLM-attributed speaker segments (rep/customer/other).
  let segmentsJson: string | null = null;
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    const segments: AiTranscriptSegment[] = raw.segments.slice(0, 400).map((s) => ({
      speaker: (['rep', 'customer', 'other'].includes(s.speaker) ? s.speaker : 'other') as AiSpeaker,
      text: s.text,
    }));
    segmentsJson = JSON.stringify(segments);
    // Also enrich the transcript full text if it was empty (fenced best-
    // effort; a LeaseLostError still aborts the caller).
    if (!transcriptText.trim()) {
      await fencedTx(recordingId, token, (tx) => tx.aiCallTranscript.update({
        where: { id: transcriptId },
        data: { fullText: segments.map((s) => s.text).join('\n') },
      })).catch((e: unknown) => {
        if (e instanceof LeaseLostError) throw e;
        // enrichment is optional — swallow non-ownership failures
      });
    }
  }

  return { analysisId: analysis.id, extraction: raw, segmentsJson, fallbackDue };
}

/** Grounding context from real CRM data — labeled, bounded, read-only. */
async function buildRecentContext(recording: RecordingWithRelations): Promise<string> {
  if (!recording.centerId) return '';
  const lines: string[] = [];
  const [memory, lastDocs, contactNotes] = await Promise.all([
    db.aiCustomerMemory.findFirst({ where: { centerId: recording.centerId, contactId: recording.contactId }, select: { summary: true } }),
    db.salesDocument.findMany({
      where: { centerId: recording.centerId },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { documentNumber: true, documentType: true, status: true },
    }),
    recording.contactId
      ? db.contactProfileNote.findMany({ where: { contactId: recording.contactId }, orderBy: { createdAt: 'desc' }, take: 3, select: { content: true } })
      : Promise.resolve([]),
  ]);
  if (memory?.summary) lines.push(`خلاصه رابطه: ${memory.summary}`);
  for (const d of lastDocs) lines.push(`سند اخیر: ${d.documentType === 'proforma' ? 'پیش‌فاکتور' : d.documentType === 'invoice' ? 'فاکتور' : 'سند'} شماره ${d.documentNumber || '-'} — وضعیت: ${d.status}`);
  for (const n of contactNotes) lines.push(`یادداشت رابط: ${n.content}`);
  return lines.slice(0, 8).join('\n');
}

// ── Coaching ────────────────────────────────────────────────
/**
 * Coach one call and persist the insight. Returns TRUE iff an insight
 * row was persisted (a pre-existing insight counts — idempotent).
 * v2.58.5 (R4): the insight create is FENCED (a stale worker cannot
 * land its coaching next to the new owner's); a repeated call after a
 * crash between "insight persisted" and "coachingDone marker" does NOT
 * duplicate the insight (find-first guard) — and a FAILURE returns
 * false so the caller NEVER marks coachingDone for a failed stage.
 */
async function coachCall(
  recordingId: string,
  recording: RecordingWithRelations,
  userId: string,
  token: string,
): Promise<boolean> {
  // idempotency: an interrupted run that already persisted the insight
  // (marker not yet set) must not emit a second one on retry
  const existingInsight = await db.aiCoachInsight.findFirst({ where: { recordingId }, select: { id: true } });
  if (existingInsight) return true;

  const transcript = await db.aiCallTranscript.findUnique({ where: { recordingId } });
  const transcriptText = transcript?.fullText ?? '';

  const settings = await getAiSettings();
  const llm = getLLMProvider(settings.llmProvider);
  await renewLease(recordingId, token); // (R4) long network stage ahead
  const completion = await llm.complete([
    { role: 'system', content: buildCoachSystemPrompt(settings.domainVocabulary) },
    { role: 'user', content: buildCoachUserPrompt(transcriptText, recording.rep?.displayName || '') },
  ], { maxTokens: 2000, temperature: 0.2 });
  await recordAiUsage({
    companyId: recording.companyId, userId: recording.userId, feature: 'coaching',
    provider: completion.provider, model: completion.model,
    inputTokens: completion.inputTokens, outputTokens: completion.outputTokens,
  });
  const parsed = extractJsonObject(completion.content);
  if (!parsed) return false; // (R4) FAILED — the caller must NOT mark done
  const check = coachExtractionSchema.safeParse(parsed);
  if (!check.success) return false; // (R4) FAILED
  const raw = check.data;
  // Keep only known criteria keys, clamp 0-100.
  const validKeys = new Set(['opening', 'rapport', 'needDiscovery', 'qualification', 'questionQuality', 'presentation', 'listening', 'objectionHandling', 'negotiation', 'closing', 'nextAction', 'professionalism', 'followupQuality']);
  const scores: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.scores)) {
    if (validKeys.has(k)) scores[k] = Math.max(0, Math.min(100, Math.round(v)));
  }
  const analysis = await db.aiCallAnalysis.findFirst({ where: { recordingId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  // (R4) fenced, short-tx commit — the LLM call stayed OUTSIDE
  await fencedTx(recordingId, token, (tx) => tx.aiCoachInsight.create({
    data: {
      userId,
      recordingId,
      analysisId: analysis?.id || null,
      qualityScore: Math.max(0, Math.min(100, Math.round(raw.qualityScore))),
      scores: JSON.stringify(scores),
      strengths: JSON.stringify(raw.strengths),
      improvements: JSON.stringify(raw.improvements),
      mistakes: JSON.stringify(raw.mistakes),
      recommendations: JSON.stringify(raw.recommendations),
    },
  }));
  return true;
}

// ── Retry ───────────────────────────────────────────────────
/**
 * Re-queue a failed recording — v2.58.4 (external audit F07): the flip is
 * now an ATOMIC CONDITIONAL update. The old unconditional update let a
 * LIVE worker's recording (status 'transcribing', a fresh lease, retryCount
 * 0) be flipped to 'queued' — the audit's repro: a transcribing call was
 * re-queued and the attempt consumed. Now ONLY:
 *   • a terminal 'failed' recording (below the retry cap), or
 *   • a CRASHED worker's mid-pipeline state with an EXPIRED lease
 *     (the real recovery entry — reachable from the running UI retry
 *     action, not just from tests)
 * can be re-queued; 'completed' and live-leased rows answer false.
 */
export async function retryRecording(recordingId: string): Promise<boolean> {
  const now = new Date();
  const res = await db.aiCallRecording.updateMany({
    where: {
      id: recordingId,
      retryCount: { lt: MAX_RETRY },
      OR: [
        { status: 'failed' },
        { status: { in: ['transcribing', 'analyzing'] }, leaseUntil: { lt: now } },
      ],
    },
    data: { status: 'queued', retryCount: { increment: 1 }, failReason: '', leaseUntil: null, leaseToken: null },
  });
  return res.count === 1;
}

/** Convert raw manual transcript text into segments when the user marked speakers. */
export function parseManualTranscript(text: string): { fullText: string; segments: AiTranscriptSegment[] } {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const segments: AiTranscriptSegment[] = [];
  const repRe = /^(?:کارشناس|متخصص|کارشناس فروش|من)\s*[:：-]\s*/;
  const customerRe = /^(?:مشتری|طرف مقابل|خریدار|بیمارستان)\s*[:：-]\s*/;
  for (const line of lines) {
    if (repRe.test(line)) segments.push({ speaker: 'rep', text: line.replace(repRe, '') });
    else if (customerRe.test(line)) segments.push({ speaker: 'customer', text: line.replace(customerRe, '') });
    else segments.push({ speaker: 'other', text: line });
  }
  return { fullText: text, segments };
}
