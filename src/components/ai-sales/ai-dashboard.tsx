'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — MANAGER DASHBOARD (v2.27.0)
// KPI cards + trends + objection distribution + temperature +
// representative ranking + at-risk customers + supervisor brief.
// All numbers come from real CRM aggregations (engine/stats.ts).
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell,
} from 'recharts';
import {
  Sparkles, PhoneCall, Gauge, Flame, Clock, AlertTriangle, CheckCircle2,
  RefreshCw, TrendingUp, ShieldAlert,
} from 'lucide-react';
import {
  toPersianNum, AiSkeleton, AiEmptyState, AiErrorState, aiApiJson,
  TemperatureBadge,
} from './shared';
import { AI_OBJECTION_TYPE_LABEL, AI_TEMPERATURE_LABEL, type AiObjectionType } from '@/lib/ai/types';
import { toJalaliString } from '@/lib/jalali';

interface DashboardDto {
  days: number;
  totals: {
    recordings: number; analyzed: number; failed: number;
    avgQualityScore: number | null; avgConversionScore: number | null;
    hotOpportunities: number; veryHotOpportunities: number;
    followupsDue: number; missedFollowups: number; atRiskActions: number;
    executedActions: number; dismissedActions: number; totalActions: number;
    conversionRate: number | null;
  };
  qualityTrend: { date: string; avgScore: number; calls: number }[];
  conversionTrend: { date: string; avgScore: number; calls: number }[];
  objectionDistribution: { type: string; count: number }[];
  temperatureDistribution: { temperature: string; count: number }[];
  repRanking: { userId: string; displayName: string; calls: number; avgQuality: number | null; avgConversion: number | null; executedActions: number; overdueActions: number }[];
  atRisk: {
    centerId: string; centerName: string; riskScore: number;
    signals: { code: string; points: number; reason: string }[];
    recommendedAction: string; daysSinceLastCall: number | null;
    conversionScore: number | null; temperature: string | null;
  }[];
  supervisorFacts: Record<string, number>[];
}

const TEMP_COLORS: Record<string, string> = { cold: '#0891b2', warm: '#d97706', hot: '#ea580c', very_hot: '#dc2626', unknown: '#94a3b8' };

export function AiDashboard({ companySlug, isAdmin }: { companySlug: string; isAdmin: boolean }) {
  const [data, setData] = useState<DashboardDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const res = await aiApiJson<DashboardDto>('/api/ai-sales/dashboard', {
      companySlug: companySlug === 'holding' ? 'all' : companySlug, days: 30,
    });
    setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
    setError('');
    setData(res.data);
  }, [companySlug]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  if (!isAdmin) {
    return (
      <AiEmptyState
        title="داشبورد هوش مدیریتی"
        description="این بخش برای مدیر سیستم فعال است. کارشناسان فروش می‌توانند از «تماس‌های تحلیل‌شده»، «اقدامات پیشنهادی» و «مربی هوشمند» استفاده کنند."
      />
    );
  }

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <Sparkles size={18} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
            داشبورد هوش فروش
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">نمای ۳۰ روز گذشته — همه اعداد از داده واقعی CRM.</p>
        </div>
        <ButtonishRefresh onClick={() => { setLoading(true); void load(); }} />
      </div>

      {loading && <AiSkeleton rows={6} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}

      {!loading && data && (
        <>
          {/* Supervisor brief — grounded one-liners */}
          <SupervisorBrief facts={data.supervisorFacts} />

          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Kpi icon={<PhoneCall size={15} />} label="تماس تحلیل‌شده" value={toPersianNum(data.totals.analyzed)} sub={`از ${toPersianNum(data.totals.recordings)} تماس`} tone="violet" />
            <Kpi icon={<Gauge size={15} />} label="میانگین کیفیت تماس" value={data.totals.avgQualityScore !== null ? toPersianNum(data.totals.avgQualityScore) : '—'} sub="از ۱۰۰" tone="teal" />
            <Kpi icon={<TrendingUp size={15} />} label="میانگین احتمال تبدیل" value={data.totals.avgConversionScore !== null ? `${toPersianNum(data.totals.avgConversionScore)}٪` : '—'} sub="از ۱۰۰" tone="emerald" />
            <Kpi icon={<Flame size={15} />} label="فرصت‌های داغ" value={toPersianNum(data.totals.hotOpportunities + data.totals.veryHotOpportunities)} sub={`${toPersianNum(data.totals.veryHotOpportunities)} خیلی داغ`} tone="orange" />
            <Kpi icon={<Clock size={15} />} label="پیگیری‌های فوری" value={toPersianNum(data.totals.followupsDue)} sub={`${toPersianNum(data.totals.missedFollowups)} عقب‌افتاده`} tone="amber" />
            <Kpi icon={<AlertTriangle size={15} />} label="اقدامات پرریسک" value={toPersianNum(data.totals.atRiskActions)} sub={`${toPersianNum(data.totals.executedActions)} اجراشده`} tone="rose" />
          </div>

          {/* Trends */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="روند کیفیت تماس">
              <TrendChart data={data.qualityTrend} color="#0d9488" />
            </ChartCard>
            <ChartCard title="روند احتمال تبدیل">
              <TrendChart data={data.conversionTrend} color="#059669" />
            </ChartCard>
          </div>

          {/* Distributions */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard title="توزیع اعتراض‌ها (همه دوره)">
              {data.objectionDistribution.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.objectionDistribution.slice(0, 8).map((o) => ({ name: AI_OBJECTION_TYPE_LABEL[o.type as AiObjectionType] || o.type, count: o.count }))} layout="vertical" margin={{ top: 5, right: 20, left: 40, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                    <XAxis type="number" reversed tick={{ fontSize: 11 }} className="text-slate-500" />
                    <YAxis type="category" dataKey="name" orientation="right" width={90} tick={{ fontSize: 11 }} className="text-slate-500" />
                    <Tooltip formatter={(v: number) => [toPersianNum(v), 'تعداد']} contentStyle={{ direction: 'rtl', fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="count" fill="#ea580c" radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <NoChartData />}
            </ChartCard>
            <ChartCard title="دمای فرصت‌ها">
              {data.temperatureDistribution.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={data.temperatureDistribution.map((t) => ({ name: AI_TEMPERATURE_LABEL[t.temperature as keyof typeof AI_TEMPERATURE_LABEL] || 'نامشخص', count: t.count }))} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} className="text-slate-500" />
                    <YAxis reversed orientation="right" tick={{ fontSize: 11 }} className="text-slate-500" allowDecimals={false} />
                    <Tooltip formatter={(v: number) => [toPersianNum(v), 'تعداد']} contentStyle={{ direction: 'rtl', fontSize: 12, borderRadius: 8 }} />
                    <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                      {data.temperatureDistribution.map((t, i) => <Cell key={i} fill={TEMP_COLORS[t.temperature] || TEMP_COLORS.unknown} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : <NoChartData />}
            </ChartCard>
          </div>

          {/* Rep ranking */}
          <ChartCard title="مقایسه کارشناسان">
            {data.repRanking.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-right text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                      <th className="p-2 font-semibold">کارشناس</th>
                      <th className="p-2 font-semibold">تماس</th>
                      <th className="p-2 font-semibold">کیفیت</th>
                      <th className="p-2 font-semibold">تبدیل</th>
                      <th className="p-2 font-semibold">اقدام اجراشده</th>
                      <th className="p-2 font-semibold">باز</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.repRanking.map((r) => (
                      <tr key={r.userId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                        <td className="p-2 font-semibold text-slate-700 dark:text-slate-200">{r.displayName}</td>
                        <td className="p-2">{toPersianNum(r.calls)}</td>
                        <td className="p-2">{r.avgQuality !== null ? toPersianNum(r.avgQuality) : '—'}</td>
                        <td className="p-2">{r.avgConversion !== null ? `${toPersianNum(r.avgConversion)}٪` : '—'}</td>
                        <td className="p-2 text-emerald-600 dark:text-emerald-400">{toPersianNum(r.executedActions)}</td>
                        <td className="p-2 text-amber-600 dark:text-amber-400">{toPersianNum(r.overdueActions)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <NoChartData />}
          </ChartCard>

          {/* At-risk customers */}
          <ChartCard title="فرصت‌های در معرض خطر (Risk Score قاعده‌محور)">
            {data.atRisk.length > 0 && data.atRisk.some((r) => r.riskScore > 0) ? (
              <ul className="space-y-2">
                {data.atRisk.filter((r) => r.riskScore > 0).slice(0, 8).map((r) => (
                  <li key={r.centerId} className="rounded-xl border border-rose-200 bg-rose-50/50 p-3 dark:border-rose-900 dark:bg-rose-950/20">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ShieldAlert size={14} className="text-rose-600 dark:text-rose-400" aria-hidden="true" />
                        <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{r.centerName}</span>
                        <TemperatureBadge temperature={r.temperature || undefined} />
                      </div>
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${r.riskScore >= 60 ? 'bg-rose-600 text-white' : r.riskScore >= 35 ? 'bg-amber-500 text-white' : 'bg-slate-400 text-white'}`}>
                        ریسک {toPersianNum(r.riskScore)}
                      </span>
                    </div>
                    <p className="mt-1.5 text-xs leading-6 text-slate-600 dark:text-slate-300">
                      <b>علائم: </b>{r.signals.map((s) => s.reason).join('؛ ') || '—'}
                    </p>
                    <p className="mt-1 text-xs leading-6 text-slate-500 dark:text-slate-400"><b>اقدام پیشنهادی: </b>{r.recommendedAction}</p>
                  </li>
                ))}
              </ul>
            ) : <NoChartData text="هیچ مرکزی در معرض خطر شناسایی نشد." />}
          </ChartCard>
        </>
      )}
    </div>
  );
}

// ── Sub components ──────────────────────────────────────────

function ButtonishRefresh({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800" aria-label="رفرش داشبورد">
      <RefreshCw size={13} aria-hidden="true" /> رفرش
    </button>
  );
}

function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone: 'violet' | 'teal' | 'emerald' | 'orange' | 'amber' | 'rose' }) {
  const tones: Record<string, string> = {
    violet: 'bg-violet-50 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300',
    teal: 'bg-teal-50 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300',
    emerald: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300',
    orange: 'bg-orange-50 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300',
    amber: 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
      <div className={`mb-2 inline-flex h-8 w-8 items-center justify-center rounded-xl ${tones[tone]}`} aria-hidden="true">{icon}</div>
      <div className="text-xl font-black text-slate-800 dark:text-slate-100">{value}</div>
      <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{label}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">{title}</h3>
      {children}
    </div>
  );
}

function NoChartData({ text = 'داده کافی برای نمایش نیست — پس از تحلیل چند تماس اینجا پر می‌شود.' }: { text?: string }) {
  return <p className="flex h-40 items-center justify-center text-center text-xs text-slate-400">{text}</p>;
}

function TrendChart({ data, color }: { data: { date: string; avgScore: number; calls: number }[]; color: string }) {
  if (data.length === 0) return <NoChartData />;
  const chartData = data.map((d) => ({ ...d, label: toJalaliString(d.date) }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-700" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} className="text-slate-500" reversed />
        <YAxis reversed orientation="right" domain={[0, 100]} tick={{ fontSize: 10 }} className="text-slate-500" />
        <Tooltip
          formatter={(v: number, name: string) => [name === 'avgScore' ? toPersianNum(v) : toPersianNum(v), name === 'avgScore' ? 'میانگین' : 'تماس']}
          contentStyle={{ direction: 'rtl', fontSize: 12, borderRadius: 8 }}
        />
        <Line type="monotone" dataKey="avgScore" stroke={color} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function SupervisorBrief({ facts }: { facts: Record<string, number>[] }) {
  const merged: Record<string, number> = {};
  for (const f of facts) for (const [k, v] of Object.entries(f)) merged[k] = (merged[k] || 0) + v;
  if (Object.keys(merged).length === 0) return null;
  const lines: string[] = [];
  if (merged.analyzedYesterday) lines.push(`دیروز ${toPersianNum(merged.analyzedYesterday)} مکالمه تحلیل شد.`);
  if (merged.hotOpportunities) lines.push(`${toPersianNum(merged.hotOpportunities)} فرصت داغ در جریان است.`);
  if (merged.urgentFollowups) lines.push(`${toPersianNum(merged.urgentFollowups)} پیگیری موعد‌رسیده دارد.`);
  if (merged.missedFollowups) lines.push(`${toPersianNum(merged.missedFollowups)} پیگیری عقب‌افتاده وجود دارد.`);
  if (merged.repsWithCoaching) lines.push(`${toPersianNum(merged.repsWithCoaching)} کارشناس دارای ارزیابی کوچینگ است.`);
  if (lines.length === 0) return null;
  return (
    <div className="rounded-2xl border border-violet-200 bg-gradient-to-l from-violet-50 to-white p-4 dark:border-violet-800 dark:from-violet-950/40 dark:to-slate-900">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-violet-800 dark:text-violet-200">
        <Sparkles size={15} aria-hidden="true" /> خلاصه روزانه مدیر (AI Supervisor)
      </h3>
      <ul className="grid grid-cols-1 gap-1 text-xs leading-6 text-slate-700 dark:text-slate-200 sm:grid-cols-2">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <CheckCircle2 size={13} className="mt-1.5 shrink-0 text-violet-500" aria-hidden="true" /> {l}
          </li>
        ))}
      </ul>
    </div>
  );
}
