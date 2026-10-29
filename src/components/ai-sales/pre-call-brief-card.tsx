'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — PRE-CALL BRIEF CARD (v2.27.0)
// «پیشنهاد AI برای تماس بعدی» — grounded on real CRM rows:
// last call, open objections, memory, pending actions, docs.
// Rendered inside the calls module (log tab) once a center is
// picked, so the rep walks into the call informed.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles, RefreshCw, ChevronDown, ChevronUp, Phone, Clock, HelpCircle, ListTodo } from 'lucide-react';
import {
  toPersianNum, faDate, AiSkeleton, aiApiJson, ObjectionTypeBadge,
} from './shared';
import type { AiPreCallBrief } from '@/lib/ai/types';
import { AI_TEMPERATURE_LABEL } from '@/lib/ai/types';

export function PreCallBriefCard({ centerId, centerName }: { centerId: string | null; centerName?: string }) {
  const [brief, setBrief] = useState<AiPreCallBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);

  const load = useCallback(async () => {
    if (!centerId) { setBrief(null); return; }
    setError('');
    const res = await aiApiJson<{ brief: AiPreCallBrief }>('/api/ai-sales/brief', { centerId });
    setLoading(false);
    if (!res.ok || !res.data?.brief) { setError(res.error || 'خطا'); setBrief(null); return; }
    setBrief(res.data.brief);
  }, [centerId]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  if (!centerId) return null;

  return (
    <div className="rounded-2xl border border-violet-200 bg-gradient-to-l from-violet-50/80 to-white p-4 dark:border-violet-800 dark:from-violet-950/30 dark:to-slate-900" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-bold text-violet-800 dark:text-violet-200">
          <Sparkles size={15} aria-hidden="true" />
          پیشنهاد AI برای تماس بعدی
          {centerName && <span className="font-normal text-slate-500 dark:text-slate-400">— {centerName}</span>}
        </h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => void load()} className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-100 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-900" aria-label="بازخوانی پیشنهاد">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
          </button>
          <button type="button" onClick={() => setExpanded(!expanded)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-100 dark:border-violet-800 dark:text-violet-300 dark:hover:bg-violet-900" aria-label={expanded ? 'جمع‌کردن' : 'باز‌کردن'} aria-expanded={expanded}>
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {loading && <div className="mt-3"><AiSkeleton rows={2} /></div>}
      {!loading && error && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error}</p>}

      {!loading && !error && brief && (
        brief.enoughData ? (
          <div className={`mt-3 space-y-3 ${expanded ? '' : 'hidden'}`}>
            {/* Recommendation line */}
            <p className="rounded-xl bg-violet-100/70 p-3 text-xs leading-6 text-violet-900 dark:bg-violet-900/50 dark:text-violet-100">
              <Sparkles size={12} className="ml-1 inline" aria-hidden="true" />
              <b>پیشنهاد: </b>{brief.aiRecommendation}
            </p>

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* Last call + status */}
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200"><Phone size={12} aria-hidden="true" /> آخرین تماس</h4>
                {brief.lastCallAt ? (
                  <div className="space-y-1.5 text-xs leading-6 text-slate-600 dark:text-slate-300">
                    <p>{brief.daysSinceLastCall === 0 ? 'امروز' : toPersianNum(brief.daysSinceLastCall || 0) + ' روز پیش'} — {faDate(brief.lastCallAt)}</p>
                    {brief.lastCallSummary && <p className="text-slate-500 dark:text-slate-400">{brief.lastCallSummary}</p>}
                    {typeof brief.lastConversionScore === 'number' && (
                      <p>احتمال تبدیل: <b className={brief.lastConversionScore >= 60 ? 'text-emerald-600' : 'text-amber-600'}>{toPersianNum(brief.lastConversionScore)}٪</b>
                        {brief.lastTemperature && <span className="mr-2 text-slate-500">({AI_TEMPERATURE_LABEL[brief.lastTemperature as keyof typeof AI_TEMPERATURE_LABEL] || brief.lastTemperature})</span>}
                      </p>
                    )}
                    {brief.suggestedFollowupDate && (
                      <p className="flex items-center gap-1"><Clock size={11} aria-hidden="true" /> تاریخ پیگیری پیشنهادی: <b>{faDate(brief.suggestedFollowupDate)}</b>{brief.suggestedFollowupReason ? ' — ' + brief.suggestedFollowupReason : ''}</p>
                    )}
                  </div>
                ) : <p className="text-xs text-slate-400">تماس تحلیل‌شده‌ای ثبت نشده است.</p>}
                {brief.totalCalls > 0 && <p className="mt-2 text-[10px] text-slate-400">{toPersianNum(brief.totalCalls)} تماس تحلیل‌شده اخیر برای این مشتری</p>}
              </div>

              {/* Open objections */}
              <div className="rounded-xl border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200"><ListTodo size={12} aria-hidden="true" /> اعتراض‌های باز</h4>
                {brief.openObjections.length > 0 ? (
                  <ul className="space-y-1.5">
                    {brief.openObjections.map((o, i) => (
                      <li key={i} className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                        <ObjectionTypeBadge type={o.type} />
                        <span>{o.description}</span>
                      </li>
                    ))}
                  </ul>
                ) : <p className="text-xs text-slate-400">اعتراض بازی ثبت نشده است.</p>}
                {brief.pendingActions.length > 0 && (
                  <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                    {toPersianNum(brief.pendingActions.length)} اقدام پیشنهادی باز — از بخش «اقدامات پیشنهادی» اجرا کنید.
                  </p>
                )}
              </div>

              {/* Topics */}
              {brief.topicsToDiscuss.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
                  <h4 className="mb-2 text-xs font-bold text-slate-700 dark:text-slate-200">مواردی که باید پیگیری شود</h4>
                  <ul className="list-inside list-disc space-y-1 text-xs leading-6 text-slate-600 dark:text-slate-300">
                    {brief.topicsToDiscuss.map((t, i) => <li key={i}>{t}</li>)}
                  </ul>
                </div>
              )}

              {/* Suggested questions */}
              {brief.suggestedQuestions.length > 0 && (
                <div className="rounded-xl border border-slate-200 bg-white/80 p-3 dark:border-slate-700 dark:bg-slate-900/60">
                  <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200"><HelpCircle size={12} aria-hidden="true" /> سوالات پیشنهادی</h4>
                  <ol className="list-inside list-decimal space-y-1 text-xs leading-6 text-slate-600 dark:text-slate-300">
                    {brief.suggestedQuestions.map((q, i) => <li key={i}>{q}</li>)}
                  </ol>
                </div>
              )}
            </div>

            {/* Memory */}
            {brief.memorySummary && (
              <p className="rounded-xl bg-slate-100 p-3 text-xs leading-6 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                <b className="text-slate-700 dark:text-slate-200">حافظه مشتری: </b>{brief.memorySummary}
                {typeof brief.memoryPreferences?.preferredContactTime === 'string' && (
                  <span className="mr-2 text-slate-500">(زمان مناسب تماس: {String(brief.memoryPreferences.preferredContactTime)})</span>
                )}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-xs leading-6 text-slate-500 dark:text-slate-400">
            اطلاعات کافی موجود نیست — برای این مشتری هنوز تماس تحلیل‌شده یا حافظه‌ای ثبت نشده است. پس از اولین تحلیل، پیشنهاد AI اینجا نمایش داده می‌شود.
          </p>
        )
      )}
    </div>
  );
}
