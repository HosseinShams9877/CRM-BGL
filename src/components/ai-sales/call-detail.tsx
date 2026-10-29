'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — CALL DETAIL DIALOG (v2.27.0)
// Six tabs: خلاصه | متن مکالمه | تحلیل AI | اعتراض‌ها |
//          اقدام بعدی | کوچینگ + audio player with sync.
// ════════════════════════════════════════════════════════════

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  FileText, AudioLines, BrainCircuit, MessageSquareWarning, ListTodo, GraduationCap,
  Play, Pause, Volume2, Search, RefreshCw, AlertTriangle, CheckCircle2, XCircle, User,
} from 'lucide-react';
import {
  toPersianNum, faDateTime, faDate, parseJsonArray, parseJsonObject,
  StatusPill, TemperatureBadge, IntentBadge, ScoreRing, ConfidenceBar, AiSkeleton, AiErrorState,
  aiApiJson, ActionStatusBadge, ActionTypeBadge, ObjectionTypeBadge,
} from './shared';
import {
  AI_SPEAKER_LABEL, AI_COACH_CRITERIA_LABEL,
  AI_BUYING_ROLE_LABEL, type AiTranscriptSegment, type AiSpeaker,
} from '@/lib/ai/types';

export interface CallDetailData {
  recording: {
    id: string; status: string; direction: string; source: string; title: string;
    durationSec: number; retryCount: number; failReason: string; createdAt: string;
    consent: string; hasAudio: boolean; audioFileId: string | null;
    center: { id: string; name: string; phone: string | null } | null;
    contact: { id: string; title: string; person: string | null; phone: string | null } | null;
    rep: { id: string; displayName: string } | null;
  };
  hasTranscript: boolean;
  analysis: AnalysisDto | null;
  coach: CoachDto | null;
  nextActions: ActionDto[];
}

export interface AnalysisDto {
  id: string; summary: string; topic: string; callReason: string; customerNeed: string;
  customerProblems: string; products: string; budget: string; purchaseTimeframe: string;
  intent: string; temperature: string; conversionScore: number; scoreReasons: string;
  objections: string; commitments: string; openQuestions: string; risks: string;
  opportunities: string; paymentTerms: string; competitors: string; decisionMakers: string;
  suggestedFollowupDate: string | null; suggestedFollowupReason: string; stageSuggestion: string;
  confidence: number; needsReview: boolean; createdAt: string;
}

export interface CoachDto {
  id: string; qualityScore: number; scores: string; strengths: string;
  improvements: string; mistakes: string; recommendations: string; createdAt: string;
}

export interface ActionDto {
  id: string; type: string; title: string; priority: string; dueAt: string | null;
  reason: string; confidence: number; status: string;
}

export function CallDetailDialog({ callId, open, onClose, onChanged }: {
  callId: string | null; open: boolean; onClose: () => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<CallDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [transcript, setTranscript] = useState<{ fullText: string; segments: string } | null>(null);
  const [search, setSearch] = useState('');
  const [retrying, setRetrying] = useState(false);

  // The parent mounts this dialog with key={callId}, so every call opens a
  // fresh instance — no reset effects (sync setState in effects is banned).
  const load = React.useCallback(async () => {
    const res = await aiApiJson<CallDetailData>('/api/ai-sales/calls', { action: 'get', id: callId });
    setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
    setData(res.data);
  }, [callId]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  // Transcript loads lazily (sensitive + potentially large). The loading
  // state is DERIVED from data+transcript — never set synchronously.
  const transcriptPending = !!data?.hasTranscript && transcript === null;
  useEffect(() => {
    if (!callId || !data?.hasTranscript || transcript) return;
    let cancelled = false;
    void (async () => {
      const res = await aiApiJson<{ transcript: { fullText: string; segments: string } | null }>('/api/ai-sales/calls', { action: 'transcript', id: callId });
      if (cancelled) return;
      if (res.ok && res.data?.transcript) setTranscript(res.data.transcript);
      else setTranscript({ fullText: '', segments: '[]' });
    })();
    return () => { cancelled = true; };
  }, [callId, data?.hasTranscript, transcript]);

  const handleRetry = async () => {
    if (!callId) return;
    setRetrying(true);
    const res = await aiApiJson('/api/ai-sales/calls', { action: 'retry', id: callId });
    setRetrying(false);
    if (res.ok) {
      toast.success('پردازش مجدد آغاز شد — وضعیت را چند لحظه بعد رفرش کنید.');
      await load();
      onChanged?.();
    } else toast.error(res.error || 'خطا');
  };

  const busy = data?.recording.status === 'transcribing' || data?.recording.status === 'analyzing' || data?.recording.status === 'queued';

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <BrainCircuit size={18} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
            <span>جزئیات مکالمه</span>
            {data && <StatusPill status={data.recording.status as never} />}
            {data?.recording.center && (
              <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
                {data.recording.center.name}
                {data.recording.contact?.person ? ` — ${data.recording.contact.person}` : ''}
              </span>
            )}
            {data && (
              <span className="text-xs font-normal text-slate-400">{faDateTime(data.recording.createdAt)}</span>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading && <AiSkeleton rows={4} />}
        {error && <AiErrorState message={error} onRetry={load} />}

        {data && !loading && (
          <div className="space-y-4">
            {data.recording.status === 'failed' && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300">
                <span className="flex items-center gap-2"><AlertTriangle size={14} aria-hidden="true" /> {data.recording.failReason || 'پردازش ناموفق بود'}</span>
                <Button size="sm" variant="outline" onClick={handleRetry} disabled={retrying} className="h-7 gap-1 text-[11px]">
                  <RefreshCw size={12} className={retrying ? 'animate-spin' : ''} aria-hidden="true" /> تلاش مجدد
                </Button>
              </div>
            )}
            {busy && (
              <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
                این مکالمه در حال پردازش است — این پنجره را ببندید و چند لحظه بعد لیست را رفرش کنید.
              </div>
            )}

            {data.analysis && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-violet-200 bg-violet-50/60 p-3 dark:border-violet-900 dark:bg-violet-950/30">
                <div className="flex items-center gap-4">
                  <ScoreRing score={data.analysis.conversionScore} label="احتمال تبدیل" />
                  {data.coach && <ScoreRing score={data.coach.qualityScore} label="کیفیت تماس" />}
                  <div className="flex flex-col gap-1.5">
                    <TemperatureBadge temperature={data.analysis.temperature} />
                    <IntentBadge intent={data.analysis.intent} />
                    {data.analysis.needsReview && (
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                        نیازمند بازبینی (اطمینان پایین)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                  <span>اطمینان استخراج AI</span>
                  <ConfidenceBar confidence={data.analysis.confidence} />
                  {data.analysis.suggestedFollowupDate && (
                    <span>پیگیری پیشنهادی: <b className="text-slate-700 dark:text-slate-200">{faDate(data.analysis.suggestedFollowupDate)}</b></span>
                  )}
                </div>
              </div>
            )}

            {data.recording.hasAudio && (
              <AudioPlayer recordingId={data.recording.id} durationSec={data.recording.durationSec} />
            )}

            <Tabs defaultValue="summary" dir="rtl">
              <TabsList className="flex w-full flex-wrap gap-1">
                <TabsTrigger value="summary" className="gap-1 text-xs"><FileText size={13} /> خلاصه</TabsTrigger>
                <TabsTrigger value="transcript" className="gap-1 text-xs"><AudioLines size={13} /> متن مکالمه</TabsTrigger>
                <TabsTrigger value="analysis" className="gap-1 text-xs"><BrainCircuit size={13} /> تحلیل AI</TabsTrigger>
                <TabsTrigger value="objections" className="gap-1 text-xs"><MessageSquareWarning size={13} /> اعتراض‌ها</TabsTrigger>
                <TabsTrigger value="actions" className="gap-1 text-xs"><ListTodo size={13} /> اقدام بعدی</TabsTrigger>
                <TabsTrigger value="coach" className="gap-1 text-xs"><GraduationCap size={13} /> کوچینگ</TabsTrigger>
              </TabsList>

              {/* ── Summary tab ── */}
              <TabsContent value="summary" className="mt-3 space-y-3">
                {data.analysis ? (
                  <div className="space-y-3 text-sm leading-7">
                    <Section title="خلاصه مکالمه">{data.analysis.summary || 'معلومات کافی موجود نیست.'}</Section>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Section title="موضوع">{data.analysis.topic || '—'}</Section>
                      <Section title="دلیل تماس">{data.analysis.callReason || '—'}</Section>
                      <Section title="نیاز مشتری">{data.analysis.customerNeed || '—'}</Section>
                      <Section title="بازه خرید">{data.analysis.purchaseTimeframe || '—'}</Section>
                      <Section title="بودجه">{data.analysis.budget || '—'}</Section>
                      <Section title="شرایط پرداخت">{data.analysis.paymentTerms || '—'}</Section>
                    </div>
                    {parseJsonArray<{ name?: string }>(data.analysis.products).length > 0 && (
                      <Section title="محصولات مطرح‌شده">
                        <ul className="list-inside list-disc space-y-1">
                          {parseJsonArray<{ name?: string; quantity?: string }>(data.analysis.products).map((p, i) => (
                            <li key={i}>{p.name}{p.quantity ? ` (${toPersianNum(p.quantity)})` : ''}</li>
                          ))}
                        </ul>
                      </Section>
                    )}
                  </div>
                ) : (
                  <p className="py-8 text-center text-xs text-slate-500">هنوز تحلیلی برای این مکالمه ثبت نشده است.</p>
                )}
              </TabsContent>

              {/* ── Transcript tab ── */}
              <TabsContent value="transcript" className="mt-3">
                <div className="mb-2 flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search size={13} className="absolute right-2.5 top-2.5 text-slate-400" aria-hidden="true" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="جست‌وجو در متن مکالمه…"
                      className="h-8 w-full rounded-lg border border-slate-300 bg-white pr-8 pl-3 text-xs outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-800"
                    />
                  </div>
                </div>
                {transcriptPending && <AiSkeleton rows={4} />}
                {!transcriptPending && !transcript && (
                  <p className="py-8 text-center text-xs text-slate-500">متن مکالمه‌ای برای این تماس ثبت نشده است.</p>
                )}
                {transcript && (
                  <TranscriptView segments={parseJsonArray<AiTranscriptSegment>(transcript.segments)} fullText={transcript.fullText} search={search} />
                )}
              </TabsContent>

              {/* ── Analysis tab ── */}
              <TabsContent value="analysis" className="mt-3 space-y-3">
                {data.analysis ? <AnalysisDetails analysis={data.analysis} /> : (
                  <p className="py-8 text-center text-xs text-slate-500">تحلیل AI هنوز آماده نیست.</p>
                )}
              </TabsContent>

              {/* ── Objections tab ── */}
              <TabsContent value="objections" className="mt-3">
                {data.analysis ? <ObjectionsView objections={parseJsonArray<{ type: string; description: string; severity: string; resolved: boolean; recommendedResponse?: string }>(data.analysis.objections)} /> : (
                  <p className="py-8 text-center text-xs text-slate-500">تحلیل AI هنوز آماده نیست.</p>
                )}
              </TabsContent>

              {/* ── Next actions tab ── */}
              <TabsContent value="actions" className="mt-3">
                {data.nextActions.length > 0 ? (
                  <ul className="space-y-2">
                    {data.nextActions.map((a) => (
                      <li key={a.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <ActionTypeBadge type={a.type} />
                            <span className="text-sm font-semibold">{a.title}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {a.dueAt && <span className="text-[11px] text-slate-500">موعد: {faDate(a.dueAt)}</span>}
                            <ActionStatusBadge status={a.status} />
                          </div>
                        </div>
                        <p className="mt-1.5 text-xs leading-6 text-slate-600 dark:text-slate-300">دلیل: {a.reason}</p>
                        <div className="mt-1"><ConfidenceBar confidence={a.confidence} /></div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="py-8 text-center text-xs text-slate-500">اقدام پیشنهادی از این مکالمه استخراج نشده است (یا همه رد شده‌اند).</p>
                )}
              </TabsContent>

              {/* ── Coach tab ── */}
              <TabsContent value="coach" className="mt-3">
                {data.coach ? <CoachView coach={data.coach} /> : (
                  <p className="py-8 text-center text-xs text-slate-500">
                    {data.recording.status === 'completed' ? 'کوچینگ برای این مکالمه تولید نشده (ممکن است غیرفعال باشد یا کارشناسی ثبت نشده باشد).' : 'پس از تکمیل پردازش، ارزیابی کوچینگ اینجا نمایش داده می‌شود.'}
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Section helper ──────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-slate-900/40">
      <h4 className="mb-1 text-xs font-bold text-slate-600 dark:text-slate-300">{title}</h4>
      <div className="text-xs leading-6 text-slate-700 dark:text-slate-200">{children}</div>
    </div>
  );
}

// ── Transcript with speaker separation + search highlight ──
function TranscriptView({ segments, fullText, search }: { segments: AiTranscriptSegment[]; fullText: string; search: string }) {
  const list = useMemo<AiTranscriptSegment[]>(() => {
    if (segments.length > 0) return segments;
    // No speaker segmentation — show raw lines.
    return fullText.split(/\n+/).filter(Boolean).map((text) => ({ speaker: 'other' as AiSpeaker, text }));
  }, [segments, fullText]);

  const filtered = search.trim()
    ? list.filter((s) => s.text.includes(search.trim()))
    : list;

  const speakerStyle: Record<AiSpeaker, string> = {
    rep: 'border-indigo-300 bg-indigo-50/70 dark:border-indigo-800 dark:bg-indigo-950/40',
    customer: 'border-emerald-300 bg-emerald-50/70 dark:border-emerald-800 dark:bg-emerald-950/40',
    other: 'border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800/60',
  };

  if (filtered.length === 0) {
    return <p className="py-6 text-center text-xs text-slate-500">موردی یافت نشد.</p>;
  }
  return (
    <div className="max-h-[45vh] space-y-2 overflow-y-auto pl-1" dir="rtl">
      {filtered.map((s, i) => (
        <div key={i} className={`rounded-xl border-r-4 p-2.5 ${speakerStyle[s.speaker] || speakerStyle.other}`}>
          <div className="mb-1 flex items-center gap-2">
            <User size={12} className="text-slate-400" aria-hidden="true" />
            <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {AI_SPEAKER_LABEL[s.speaker] || 'سایر'}
              {typeof s.startSec === 'number' ? ` — ${toPersianNum(Math.floor(s.startSec / 60))}:${toPersianNum(String(Math.floor(s.startSec % 60)).padStart(2, '0'))}` : ''}
            </span>
          </div>
          <Highlight text={s.text} term={search.trim()} />
        </div>
      ))}
    </div>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <p className="text-xs leading-6 text-slate-700 dark:text-slate-200">{text}</p>;
  const idx = text.indexOf(term);
  if (idx === -1) return <p className="text-xs leading-6 text-slate-700 dark:text-slate-200">{text}</p>;
  return (
    <p className="text-xs leading-6 text-slate-700 dark:text-slate-200">
      {text.slice(0, idx)}
      <mark className="rounded bg-amber-200 px-0.5 dark:bg-amber-800 dark:text-amber-50">{term}</mark>
      {text.slice(idx + term.length)}
    </p>
  );
}

// ── Analysis details ────────────────────────────────────────
function AnalysisDetails({ analysis }: { analysis: AnalysisDto }) {
  const reasons = parseJsonArray<{ factor: string; impact: number; detail: string }>(analysis.scoreReasons);
  const commitments = parseJsonObject<{ rep?: string[]; customer?: string[] }>(analysis.commitments) || {};
  const openQuestions = parseJsonArray<string>(analysis.openQuestions);
  const risks = parseJsonArray<string>(analysis.risks);
  const opportunities = parseJsonArray<string>(analysis.opportunities);
  const competitors = parseJsonArray<string>(analysis.competitors);
  const decisionMakers = parseJsonArray<{ name?: string; role?: string; type: string }>(analysis.decisionMakers);
  const problems = parseJsonArray<string>(analysis.customerProblems);

  return (
    <div className="space-y-3">
      {reasons.length > 0 && (
        <Section title="دلایل امتیاز تبدیل (Explainability)">
          <ul className="space-y-1.5">
            {reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2">
                {r.impact >= 0
                  ? <CheckCircle2 size={13} className="mt-1 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                  : <XCircle size={13} className="mt-1 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden="true" />}
                <span><b>{r.factor}:</b> {r.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(commitments.rep || []).length > 0 && (
          <Section title="تعهدات کارشناس">
            <ul className="list-inside list-disc space-y-1">{(commitments.rep || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {(commitments.customer || []).length > 0 && (
          <Section title="تعهدات مشتری">
            <ul className="list-inside list-disc space-y-1">{(commitments.customer || []).map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {problems.length > 0 && (
          <Section title="مشکلات مطرح‌شده مشتری">
            <ul className="list-inside list-disc space-y-1">{problems.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {openQuestions.length > 0 && (
          <Section title="سوالات باز">
            <ul className="list-inside list-disc space-y-1">{openQuestions.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {risks.length > 0 && (
          <Section title="ریسک‌ها">
            <ul className="list-inside list-disc space-y-1">{risks.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {opportunities.length > 0 && (
          <Section title="فرصت‌ها">
            <ul className="list-inside list-disc space-y-1">{opportunities.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {competitors.length > 0 && (
          <Section title="رقبا">
            <ul className="list-inside list-disc space-y-1">{competitors.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </Section>
        )}
        {decisionMakers.length > 0 && (
          <Section title="نقش‌های خرید سازمانی">
            <ul className="space-y-1">
              {decisionMakers.map((d, i) => (
                <li key={i}>
                  <span className="font-semibold">{d.name || 'نامشخص'}</span>
                  {d.role ? ` (${d.role})` : ''} — {AI_BUYING_ROLE_LABEL[d.type as keyof typeof AI_BUYING_ROLE_LABEL] || d.type}
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      {analysis.stageSuggestion && (
        <Section title="پیشنهاد مرحله کاریز">همچنین {analysis.stageSuggestion}</Section>
      )}
    </div>
  );
}

// ── Objections view ─────────────────────────────────────────
function ObjectionsView({ objections }: { objections: { type: string; description: string; severity: string; resolved: boolean; recommendedResponse?: string }[] }) {
  if (objections.length === 0) {
    return <p className="py-8 text-center text-xs text-slate-500">اعتراضی از این مکالمه استخراج نشده است.</p>;
  }
  return (
    <ul className="space-y-2">
      {objections.map((o, i) => (
        <li key={i} className={`rounded-xl border p-3 ${o.resolved ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30' : 'border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/30'}`}>
          <div className="flex flex-wrap items-center gap-2">
            <ObjectionTypeBadge type={o.type} />
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${o.severity === 'high' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : o.severity === 'medium' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
              شدت: {o.severity === 'high' ? 'زیاد' : o.severity === 'medium' ? 'متوسط' : 'کم'}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${o.resolved ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'}`}>
              {o.resolved ? 'حل‌شده' : 'باز'}
            </span>
          </div>
          <p className="mt-2 text-xs leading-6 text-slate-700 dark:text-slate-200">{o.description}</p>
          {o.recommendedResponse && (
            <p className="mt-1.5 rounded-lg bg-slate-100 p-2 text-[11px] leading-5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <b>پاسخ پیشنهادی AI:</b> {o.recommendedResponse}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── Coach view ──────────────────────────────────────────────
function CoachView({ coach }: { coach: CoachDto }) {
  const scores = parseJsonObject<Record<string, number>>(coach.scores) || {};
  const strengths = parseJsonArray<string>(coach.strengths);
  const improvements = parseJsonArray<string>(coach.improvements);
  const mistakes = parseJsonArray<string>(coach.mistakes);
  const recommendations = parseJsonArray<string>(coach.recommendations);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 rounded-2xl border border-teal-200 bg-teal-50/60 p-3 dark:border-teal-900 dark:bg-teal-950/30">
        <ScoreRing score={coach.qualityScore} label="کیفیت کل" />
        <div className="flex-1 space-y-1.5">
          {Object.entries(AI_COACH_CRITERIA_LABEL).map(([key, label]) => {
            const v = scores[key];
            if (typeof v !== 'number') return null;
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-32 shrink-0 text-[11px] text-slate-600 dark:text-slate-300">{label}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div className={`h-full rounded-full ${v >= 70 ? 'bg-emerald-500' : v >= 40 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${v}%` }} />
                </div>
                <span className="w-8 text-left text-[11px] font-semibold text-slate-700 dark:text-slate-200">{toPersianNum(v)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {strengths.length > 0 && <Section title="نقاط قوت"><ul className="list-inside list-disc space-y-1">{strengths.map((x, i) => <li key={i}>{x}</li>)}</ul></Section>}
        {improvements.length > 0 && <Section title="قابل بهبود"><ul className="list-inside list-disc space-y-1">{improvements.map((x, i) => <li key={i}>{x}</li>)}</ul></Section>}
        {mistakes.length > 0 && <Section title="اشتباهات"><ul className="list-inside list-disc space-y-1">{mistakes.map((x, i) => <li key={i}>{x}</li>)}</ul></Section>}
        {recommendations.length > 0 && <Section title="پیشنهاد کوچینگ"><ul className="list-inside list-disc space-y-1">{recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul></Section>}
      </div>
    </div>
  );
}

// ── Audio player with speed + seek ──────────────────────────
function AudioPlayer({ recordingId, durationSec }: { recordingId: string; durationSec: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(durationSec);
  const [error, setError] = useState('');

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => setPos(el.currentTime);
    const onMeta = () => { if (Number.isFinite(el.duration)) setDur(el.duration); };
    const onEnd = () => setPlaying(false);
    const onErr = () => setError('پخش فایل صوتی ممکن نشد. دوباره تلاش کنید.');
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('ended', onEnd);
    el.addEventListener('error', onErr);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('error', onErr);
    };
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) { el.pause(); setPlaying(false); }
    else { void el.play().then(() => setPlaying(true)).catch(() => setError('پخش ممکن نشد.')); }
  };
  const seek = (v: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = v;
    setPos(v);
  };
  const changeRate = () => {
    const next = rate === 1 ? 1.25 : rate === 1.25 ? 1.5 : rate === 1.5 ? 0.75 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  };
  const fmt = (s: number) => `${toPersianNum(Math.floor(s / 60))}:${toPersianNum(String(Math.floor(s % 60)).padStart(2, '0'))}`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <audio ref={audioRef} src={`/api/ai-sales/calls/audio?id=${recordingId}`} preload="metadata" />
      {error ? (
        <p className="text-center text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : (
        <div className="flex items-center gap-3">
          <button
            type="button" onClick={toggle}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-600 text-white transition hover:bg-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600"
            aria-label={playing ? 'توقف پخش' : 'پخش صوت'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <div className="flex-1">
            <input
              type="range" min={0} max={dur || 1} step={0.5} value={pos}
              onChange={(e) => seek(Number(e.target.value))}
              className="w-full accent-violet-600" aria-label="جابه‌جایی در فایل صوتی"
            />
            <div className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
              <span>{fmt(pos)}</span>
              <span>{fmt(dur)}</span>
            </div>
          </div>
          <button
            type="button" onClick={changeRate}
            className="rounded-lg border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="تغییر سرعت پخش"
          >
            {toPersianNum(rate)}×
          </button>
          <Volume2 size={14} className="text-slate-400" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
