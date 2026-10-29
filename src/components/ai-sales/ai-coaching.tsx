'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — SALES COACH (v2.27.0)
// 'my'  → self coaching: recent insights + quality trend
// 'team'→ manager: cross-rep comparison (admin only)
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { GraduationCap, RefreshCw } from 'lucide-react';
import {
  toPersianNum, faDateTime, AiSkeleton, AiEmptyState, AiErrorState, aiApiJson,
  ScoreRing, parseJsonArray,
} from './shared';
import { AI_COACH_CRITERIA_LABEL } from '@/lib/ai/types';
import { toJalaliString } from '@/lib/jalali';

interface MyInsight {
  id: string; qualityScore: number; scores: string; strengths: string;
  improvements: string; mistakes: string; recommendations: string; createdAt: string;
  recording: { id: string; title: string; createdAt: string; center: { id: string; name: string } | null } | null;
}

export function AiCoaching({ companySlug, isAdmin }: { companySlug: string; isAdmin: boolean }) {
  const [tab, setTab] = useState<'my' | 'team'>(isAdmin ? 'team' : 'my');
  const [my, setMy] = useState<{ insights: MyInsight[]; summary: { totalCoached: number; avgQuality: number | null; trend: { date: string; score: number }[] } } | null>(null);
  const [team, setTeam] = useState<{ team: { userId: string; displayName: string; coachedCalls: number; avgQuality: number | null; bestQuality: number; worstQuality: number }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    if (tab === 'my') {
      const res = await aiApiJson<{ insights: MyInsight[]; summary: { totalCoached: number; avgQuality: number | null; trend: { date: string; score: number }[] } }>('/api/ai-sales/coaching', { action: 'my' });
      setLoading(false);
      if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
      setMy(res.data);
    } else {
      const res = await aiApiJson<{ team: { userId: string; displayName: string; coachedCalls: number; avgQuality: number | null; bestQuality: number; worstQuality: number }[] }>('/api/ai-sales/coaching', {
        action: 'team', companySlug: companySlug === 'holding' ? undefined : companySlug,
      });
      setLoading(false);
      if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
      setTeam(res.data);
    }
  }, [tab, companySlug]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <GraduationCap size={18} className="text-teal-600 dark:text-teal-400" aria-hidden="true" />
            مربی هوشمند فروش
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">ارزیابی ۱۳ معیاره مکالمات + پیشنهادهای کوچینگ عملی.</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <div className="flex rounded-lg border border-slate-300 p-0.5 dark:border-slate-600" role="tablist" aria-label="بخش کوچینگ">
              <button type="button" onClick={() => setTab('team')} role="tab" aria-selected={tab === 'team'} className={`rounded-md px-3 py-1 text-xs font-semibold ${tab === 'team' ? 'bg-teal-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                عملکرد تیم
              </button>
              <button type="button" onClick={() => setTab('my')} role="tab" aria-selected={tab === 'my'} className={`rounded-md px-3 py-1 text-xs font-semibold ${tab === 'my' ? 'bg-teal-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}>
                کوچینگ من
              </button>
            </div>
          )}
          <button type="button" onClick={() => { setLoading(true); void load(); }} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800" aria-label="رفرش">
            <RefreshCw size={13} aria-hidden="true" /> رفرش
          </button>
        </div>
      </div>

      {loading && <AiSkeleton rows={4} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}

      {!loading && !error && tab === 'my' && my && (
        my.insights.length === 0 ? (
          <AiEmptyState title="هنوز ارزیابی‌ای برای شما ثبت نشده" description="پس از آنکه مکالمه‌ای با کاربری شما ثبت و تحلیل شود، ارزیابی کوچینگ ۱۳معیاره آن اینجا نمایش داده می‌شود." />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-6 rounded-2xl border border-teal-200 bg-teal-50/50 p-4 dark:border-teal-900 dark:bg-teal-950/30">
              <ScoreRing score={my.summary.avgQuality} size={72} label="میانگین کیفیت" />
              <div className="flex-1 text-xs text-slate-600 dark:text-slate-300">
                <p className="mb-1 font-semibold">{toPersianNum(my.summary.totalCoached)} مکالمه ارزیابی‌شده</p>
                <p>روند کیفیت شما در ۳۰ ارزیابی اخیر:</p>
                <div className="mt-2 h-28">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={my.summary.trend.slice(-30).map((t) => ({ ...t, label: toJalaliString(t.date) }))}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                      <XAxis dataKey="label" tick={{ fontSize: 9 }} className="text-slate-500" reversed />
                      <YAxis reversed orientation="right" domain={[0, 100]} tick={{ fontSize: 9 }} className="text-slate-500" />
                      <Tooltip contentStyle={{ direction: 'rtl', fontSize: 11, borderRadius: 8 }} />
                      <Line type="monotone" dataKey="score" stroke="#0d9488" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
            {my.insights.map((ins) => <InsightCard key={ins.id} insight={ins} />)}
          </div>
        )
      )}

      {!loading && !error && tab === 'team' && team && (
        team.team.length === 0 ? (
          <AiEmptyState title="هنوز داده کوچینگ تیمی وجود ندارد" description="پس از تحلیل مکالمات کارشناسان، مقایسه عملکرد تیم اینجا نمایش داده می‌شود." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  <th className="p-3 font-semibold">کارشناس</th>
                  <th className="p-3 font-semibold">مکالمات ارزیابی‌شده</th>
                  <th className="p-3 font-semibold">میانگین کیفیت</th>
                  <th className="p-3 font-semibold">بهترین</th>
                  <th className="p-3 font-semibold">ضعیف‌ترین</th>
                </tr>
              </thead>
              <tbody>
                {team.team.map((r) => (
                  <tr key={r.userId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="p-3 font-semibold text-slate-700 dark:text-slate-200">{r.displayName}</td>
                    <td className="p-3">{toPersianNum(r.coachedCalls)}</td>
                    <td className="p-3">{r.avgQuality !== null ? <span className={`font-bold ${r.avgQuality >= 70 ? 'text-emerald-600' : r.avgQuality >= 40 ? 'text-amber-600' : 'text-rose-600'}`}>{toPersianNum(r.avgQuality)}</span> : '—'}</td>
                    <td className="p-3 text-emerald-600 dark:text-emerald-400">{toPersianNum(r.bestQuality)}</td>
                    <td className="p-3 text-rose-600 dark:text-rose-400">{toPersianNum(r.worstQuality)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function InsightCard({ insight }: { insight: MyInsight }) {
  const [open, setOpen] = useState(false);
  const scores = (() => { try { return JSON.parse(insight.scores || '{}') as Record<string, number>; } catch { return {}; } })();
  const strengths = parseJsonArray<string>(insight.strengths);
  const improvements = parseJsonArray<string>(insight.improvements);
  const mistakes = parseJsonArray<string>(insight.mistakes);
  const recommendations = parseJsonArray<string>(insight.recommendations);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center justify-between gap-2 text-right" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-3">
          <ScoreRing score={insight.qualityScore} size={48} />
          <div>
            <div className="text-sm font-bold text-slate-800 dark:text-slate-100">{insight.recording?.center?.name || insight.recording?.title || 'مکالمه'}</div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">{faDateTime(insight.createdAt)}</div>
          </div>
        </div>
        <span className="text-xs font-semibold text-teal-700 dark:text-teal-300">{open ? 'بستن جزئیات ▲' : 'نمایش جزئیات ▼'}</span>
      </button>
      {open && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
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
          {strengths.length > 0 && <Block title="نقاط قوت" items={strengths} tone="emerald" />}
          {improvements.length > 0 && <Block title="قابل بهبود" items={improvements} tone="amber" />}
          {mistakes.length > 0 && <Block title="اشتباهات" items={mistakes} tone="rose" />}
          {recommendations.length > 0 && <Block title="پیشنهاد کوچینگ" items={recommendations} tone="teal" />}
        </div>
      )}
    </div>
  );
}

function Block({ title, items, tone }: { title: string; items: string[]; tone: 'emerald' | 'amber' | 'rose' | 'teal' }) {
  const tones: Record<string, string> = {
    emerald: 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30',
    amber: 'border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/30',
    rose: 'border-rose-200 bg-rose-50/60 dark:border-rose-900 dark:bg-rose-950/30',
    teal: 'border-teal-200 bg-teal-50/60 dark:border-teal-900 dark:bg-teal-950/30',
  };
  return (
    <div className={`rounded-xl border p-3 ${tones[tone]}`}>
      <h4 className="mb-1.5 text-xs font-bold text-slate-700 dark:text-slate-200">{title}</h4>
      <ul className="list-inside list-disc space-y-1 text-xs leading-6 text-slate-600 dark:text-slate-300">
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ul>
    </div>
  );
}
