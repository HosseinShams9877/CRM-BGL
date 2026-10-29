'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useTabAccess } from '@/components/access-context';
import {
  BarChart3, TrendingUp, Target, Building2,
  Download, ArrowUpRight, ArrowDownRight,
  Users, CreditCard, FileText,
  CircleDollarSign, Award, MapPin,
  Layers, Briefcase, Heart, Star, Factory, Truck,
} from 'lucide-react';
import { toJalaliString } from '@/lib/jalali';

// ==================== TYPES ====================
type ReportTab = 'sales' | 'pipeline' | 'staff' | 'finance' | 'compare' | 'production' | 'shipments';
type PeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly';

// v2.43.1 (r68) — StaffPerf is now the SHARED contract row from
// src/lib/staff-perf.ts (single source for the API handler AND this
// tab). The locally-declared interface previously read `name` while
// the API returned `userName` — the first real row crashed the tab
// with `undefined.charAt(0)`; importing the shared type makes that
// drift a compile error instead of a runtime crash.
import type { StaffPerfRow as StaffPerf } from '@/lib/staff-perf';

interface ReportCard {
  title: string;
  value: string;
  subtitle: string;
  change?: number;
  icon: React.ReactNode;
  color: string;
  bg: string;
}

interface ChartDataPoint {
  label: string;
  value: number;
  color?: string;
}

interface TopCenter {
  name: string;
  city: string;
  amount: number;
  orders: number;
  grade: string;
  change: number;
}

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCompact(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون';
  return toPersianNum(amount.toLocaleString());
}

// ==================== MINI BAR CHART (Pure CSS) ====================
function MiniBarChart({ data, height = 80 }: { data: ChartDataPoint[]; height?: number }) {
  const max = Math.max(...data.map(d => d.value), 1);

  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div
            className="w-full rounded-t-sm transition-all duration-500 hover:opacity-80 cursor-pointer relative group"
            style={{
              height: `${(d.value / max) * 100}%`,
              background: d.color || 'linear-gradient(180deg, #1F8B7D, #2E2A5C)',
              minHeight: '4px',
            }}
          >
            {/* Tooltip */}
            <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[11px] px-2 py-1 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
              {formatCompact(d.value)}
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
            </div>
          </div>
          <span className="text-[11px] text-gray-400 truncate w-full text-center">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

// ==================== HORIZONTAL BAR CHART ====================
function HorizontalBarChart({ data }: { data: ChartDataPoint[]; maxLabel?: string }) {
  const max = Math.max(...data.map(d => d.value), 1);

  return (
    <div className="space-y-2.5">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="text-[11px] text-gray-600 w-28 shrink-0 text-left truncate" title={d.label}>{d.label}</span>
          <div className="flex-1 h-7 bg-gray-100 rounded-lg overflow-hidden relative">
            <div
              className="h-full rounded-lg transition-all duration-700 flex items-center justify-end px-2"
              style={{ width: `${Math.max((d.value / max) * 100, 8)}%`, background: d.color || 'linear-gradient(90deg, #1F8B7D, #2E2A5C)' }}
            >
              <span className="text-[11px] font-bold text-white">{formatCompact(d.value)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== DONUT CHART (CSS) ====================
function DonutChart({ data, centerLabel, centerValue }: { data: ChartDataPoint[]; centerLabel: string; centerValue: string }) {
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-40 h-40">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          {data.map((d, i) => {
            const pct = (d.value / total) * 100;
            // Segment offset = sum of previous segments' percentages —
            // computed purely from data, no mutable accumulator
            // (react-hooks/immutability).
            const offset = data
              .slice(0, i)
              .reduce((s, prev) => s + (prev.value / total) * 100, 0);
            return (
              <circle
                key={i}
                cx="18" cy="18" r="14"
                fill="none"
                stroke={d.color}
                strokeWidth="4"
                strokeDasharray={`${pct} ${100 - pct}`}
                strokeDashoffset={`${-offset}`}
                className="transition-all duration-700"
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[11px] text-gray-400">{centerLabel}</p>
          <p className="text-lg font-bold text-gray-900">{centerValue}</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-3 mt-4">
        {data.map((d, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: d.color }} />
            <span className="text-[11px] text-gray-600">{d.label}</span>
            <span className="text-[11px] font-bold text-gray-900">{toPersianNum(Math.round((d.value / total) * 100))}٪</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== SHARED REPORT STATES (v2.18.0) ====================
function ReportLoading() {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
      <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
      <p className="text-sm text-gray-400">در حال دریافت دادهٔ واقعی...</p>
    </div>
  );
}

function ReportError({ message }: { message: string }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
      <p className="text-sm text-red-600">{message}</p>
    </div>
  );
}

function ReportEmpty({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
      <BarChart3 size={32} className="mx-auto mb-2 opacity-40" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

/** CSV download with a BOM so Persian text opens correctly in Excel. */
function exportCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = '\uFEFF' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ==================== SALES REPORT TAB ====================
function SalesReportTab() {
  const [period, setPeriod] = useState<PeriodType>('monthly');
  const [summary, setSummary] = useState<{ totalSales: number; totalReturns: number; netSales: number } | null>(null);
  // v2.18.0: the API returns `sales` — the old local type used a different
  // field name, so the truthiness filter was always false and the monthly
  // trend chart rendered permanently EMPTY.
  const [chartData, setChartData] = useState<Array<{ month: string; sales: number; invoices: number; returns: number }>>([]);
  const [topCenters, setTopCenters] = useState<TopCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // v2.18.0: the period selector is real — the API groups by day /
        // week / Jalali month / Jalali year depending on it.
        const [sumRes, topRes] = await Promise.allSettled([
          fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sales-summary', ...(period !== 'monthly' ? { period } : {}) }) }).then(r => r.json()),
          fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'top-centers' }) }).then(r => r.json()),
        ]);
        if (cancelled) return;
        // v2.58.0 (audit 85-b): a REJECTED fetch (network down) previously
        // fell through both `fulfilled` branches into `finally` — the KPIs
        // rendered zeros with no error state. In-body API errors already
        // reach setError above; transport failures now do too.
        if (sumRes.status === 'rejected') {
          setError('خطا در دریافت گزارش فروش — اتصال سرور برقرار نشد.');
        } else if (sumRes.value.summary) {
          setSummary(sumRes.value.summary);
          setChartData(sumRes.value.chartData || []);
        } else if (sumRes.value.error) {
          setError(String(sumRes.value.error));
        }
        if (topRes.status === 'rejected') {
          setError('خطا در دریافت گزارش فروش — اتصال سرور برقرار نشد.');
        } else if (Array.isArray(topRes.value.chartData)) {
          setTopCenters(topRes.value.chartData.map((c: { centerId: string; centerName: string; province: string; totalSales: number; documentCount: number }, i: number) => ({
            name: c.centerName,
            city: c.province,
            amount: c.totalSales,
            orders: c.documentCount,
            grade: i < 3 ? 'A' : 'B',
            change: 0,
          })));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [period]);

  const totalOrders = chartData.reduce((s, m) => s + m.invoices, 0);
  const kpiCards: ReportCard[] = [
    { title: 'فروش کل دوره', value: formatCompact(summary?.netSales ?? 0), subtitle: 'اسناد تأییدشدهٔ امسال', icon: <CircleDollarSign size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { title: 'تعداد سفارشات', value: toPersianNum(totalOrders), subtitle: 'فاکتورهای تأییدشده', icon: <FileText size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { title: 'میانگین سفارش', value: formatCompact(totalOrders > 0 ? (summary?.netSales ?? 0) / totalOrders : 0), subtitle: 'محاسبه از دادهٔ واقعی', icon: <TrendingUp size={16} />, color: '#d97706', bg: '#fffbeb' },
    { title: 'برگشت از فروش', value: formatCompact(summary?.totalReturns ?? 0), subtitle: 'اسناد برگشتی امسال', icon: <Target size={16} />, color: '#059669', bg: '#ecfdf5' },
  ];

  const monthlyData: ChartDataPoint[] = chartData
    .filter(m => m.sales > 0)
    .map(m => ({ label: m.month, value: Math.round(m.sales / 1_000_000), color: '#1F8B7D' }));

  const cityData: ChartDataPoint[] = topCenters.slice(0, 6).map(c => ({
    label: c.city || c.name,
    value: Math.round(c.amount / 1_000_000),
    color: '#0891b2',
  }));

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><BarChart3 size={16} className="text-teal-600" /> گزارش فروش</h3>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          {([['daily', 'روزانه'], ['weekly', 'هفتگی'], ['monthly', 'ماهانه'], ['yearly', 'سالانه']] as [PeriodType, string][]).map(([k, l]) => (
            <button key={k} onClick={() => setPeriod(k)} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${period === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>{l}</button>
          ))}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map((card, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
            <div className="flex justify-between mb-3">
              <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: card.bg, color: card.color }}>{card.icon}</div>
              {card.change !== undefined && (
                <span className={`text-xs font-bold flex items-center gap-0.5 px-2 py-0.5 rounded-full ${card.change >= 0 ? 'text-emerald-600 bg-emerald-50' : 'text-red-600 bg-red-50'}`}>
                  {card.change >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                  {toPersianNum(Math.abs(card.change))}٪
                </span>
              )}
            </div>
            <p className="text-xl font-bold text-gray-900 mb-0.5">{card.value}</p>
            <p className="text-[11px] text-gray-400">{card.title}</p>
          </div>
        ))}
      </div>

      {/* Chart Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Sales Trend */}
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 p-5">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-bold text-gray-900">
              {period === 'daily' ? 'روند فروش روزانه (۳۰ روز اخیر)' :
               period === 'weekly' ? 'روند فروش هفتگی (۱۲ هفتهٔ اخیر)' :
               period === 'yearly' ? 'روند فروش سالانه (۵ سال اخیر)' :
               'روند فروش ماهانه (سال شمسی جاری)'}
            </h4>
            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
              onClick={() => exportCsv('sales-trend.csv', [
                ['دوره', 'فروش (ریال)', 'تعداد فاکتور', 'برگشتی (ریال)'],
                ...chartData.map(m => [m.month, m.sales, m.invoices, m.returns]),
              ])}
            >
              <Download size={11} /> خروجی CSV
            </Button>
          </div>
          {monthlyData.length > 0 ? <MiniBarChart data={monthlyData} height={160} /> : (
            <p className="text-xs text-gray-400 text-center py-10">در این بازه فروش تأییدشده‌ای ثبت نشده است</p>
          )}
        </div>

        {/* Category Donut */}
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">سهم استان‌های برتر</h4>
          <DonutChart data={cityData.length > 0 ? cityData : []} centerLabel="فروش کل" centerValue={formatCompact(summary?.netSales ?? 0)} />
        </div>
      </div>

      {/* Top Centers + City breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2"><Award size={14} className="text-amber-500" /> برترین مراکز فروش</h4>
          <div className="space-y-3">
            {topCenters.slice(0, 5).map((c, i) => (
              <div key={i} className="flex items-center gap-3">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white shrink-0 ${i < 3 ? '' : 'bg-gray-300'}`} style={i < 3 ? { background: i === 0 ? '#d97706' : i === 1 ? '#6b7280' : '#92400e' } : undefined}>
                  {toPersianNum(i + 1)}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-gray-900 truncate">{c.name}</span>
                    <span className={`text-[11px] flex items-center gap-0.5 ${c.change >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {c.change >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}{toPersianNum(Math.abs(c.change))}٪
                    </span>
                  </div>
                  <span className="text-[11px] text-gray-400">{c.city} · {toPersianNum(c.orders)} سفارش</span>
                </div>
                <span className="text-xs font-bold text-gray-900 shrink-0">{formatCompact(c.amount)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4 flex items-center gap-2"><MapPin size={14} className="text-teal-600" /> فروش بر اساس شهر</h4>
          <HorizontalBarChart data={cityData} />
        </div>
      </div>
    </div>
  );
}

// ==================== PIPELINE REPORT TAB ====================
function PipelineReportTab() {
  // v2.18.0 — was 100% hardcoded (33 opportunities / 48.5B / 71% win rate).
  // Now fed by the real document-stage funnel from /api/reports.
  const [data, setData] = useState<{
    stages: Array<{ key: string; label: string; count: number; amount: number }>;
    conversion: Array<{ label: string; value: number }>;
    kpis: { totalOpportunities: number; pipelineValue: number; wonCount: number; lostCount: number; winRate: number; avgCloseDays: number };
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'pipeline-summary' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت گزارش کاریز');
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت گزارش کاریز');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;
  if (!data) return null;

  const stageColors: Record<string, string> = {
    lead: '#6366f1', review: '#0891b2', proforma: '#d97706', invoice: '#059669', cancelled: '#dc2626',
  };
  const pipelineData: ChartDataPoint[] = data.stages
    .filter(s => s.count > 0)
    .map(s => ({ label: s.label, value: s.count, color: stageColors[s.key] || '#94a3b8' }));
  const conversionData: ChartDataPoint[] = data.conversion.map((c, i) => ({
    label: c.label, value: c.value, color: ['#6366f1', '#0891b2', '#d97706', '#059669'][i % 4],
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Layers size={16} className="text-teal-600" /> گزارش کاریز فروش</h3>
        <Button
          variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
          onClick={() => exportCsv('pipeline-report.csv', [
            ['مرحله', 'تعداد سند', 'ارزش (ریال)'],
            ...data.stages.map(s => [s.label, s.count, s.amount]),
          ])}
        >
          <Download size={11} /> خروجی CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'کل فرصت‌ها', value: toPersianNum(data.kpis.totalOpportunities), sub: 'همهٔ اسناد غیربرگشتی', color: '#2E2A5C', bg: '#eef2ff' },
          { label: 'ارزش کاریز باز', value: formatCompact(data.kpis.pipelineValue), sub: 'پیش‌فاکتور + در جریان', color: '#1F8B7D', bg: '#ecfdf5' },
          { label: 'نرخ برد', value: toPersianNum(data.kpis.winRate) + '٪', sub: `${toPersianNum(data.kpis.wonCount)} موفق / ${toPersianNum(data.kpis.lostCount)} از دست‌رفته`, color: '#059669', bg: '#ecfdf5' },
          { label: 'میانگین بسته‌شدن', value: toPersianNum(data.kpis.avgCloseDays) + ' روز', sub: 'از ثبت تا صدور فاکتور', color: '#d97706', bg: '#fffbeb' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-4 border border-gray-100">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: s.bg, color: s.color }}><BarChart3 size={16} /></div>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-xs text-gray-900 font-medium mt-0.5">{s.label}</p>
            <p className="text-[11px] text-gray-400">{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">توزیع اسناد در مراحل</h4>
          {pipelineData.length > 0 ? (
            <DonutChart data={pipelineData} centerLabel="کل اسناد" centerValue={toPersianNum(data.kpis.totalOpportunities)} />
          ) : (
            <p className="text-xs text-gray-400 text-center py-10">سندی در کاریز ثبت نشده است</p>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">نرخ تبدیل بین مراحل (٪)</h4>
          {conversionData.length > 0 ? <HorizontalBarChart data={conversionData} /> : (
            <p className="text-xs text-gray-400 text-center py-10">برای محاسبهٔ نرخ تبدیل، دادهٔ کافی نیست</p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h4 className="text-sm font-bold text-gray-900 mb-4">ارزش هر مرحله (ریال)</h4>
        <HorizontalBarChart data={data.stages.map(s => ({ label: s.label, value: Math.round(s.amount / 1_000_000), color: stageColors[s.key] || '#94a3b8' }))} />
        <p className="text-[11px] text-gray-400 mt-2 text-center">مبالغ به میلیون ریال — از اسناد واقعی ثبت‌شده</p>
      </div>
    </div>
  );
}

// ==================== STAFF PERFORMANCE TAB ====================
function StaffReportTab() {
  // v2.18.0 — was five invented employees; now real per-creator stats.
  const [staff, setStaff] = useState<StaffPerf[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'staff-performance' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت عملکرد کارکنان');
        if (!cancelled) setStaff(json.chartData || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت عملکرد کارکنان');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;
  if (staff.length === 0) {
    return (
      <div>
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2 mb-4"><Users size={16} className="text-teal-600" /> عملکرد کارکنان فروش</h3>
        <ReportEmpty text="هنوز سندی توسط کارشناسان ثبت نشده است" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Users size={16} className="text-teal-600" /> عملکرد کارکنان فروش</h3>
        <Button
          variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
          onClick={() => exportCsv('staff-performance.csv', [
            ['کارشناس', 'عنوان', 'فروش (ریال)', 'سفارش', 'مراکز', 'کاریز', 'نرخ برد (٪)', 'میانگین معامله (ریال)'],
            ...staff.map(s => [s.userName, s.role, s.sales, s.orders, s.centers, s.pipeline, s.winRate, s.avgDealSize]),
          ])}
        >
          <Download size={11} /> خروجی CSV
        </Button>
      </div>

      {/* Staff Table */}
      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                <th className="py-3 px-4 text-right font-bold text-gray-500">کارشناس</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">فروش</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">سفارش</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">مراکز</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">کاریز</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">نرخ برد</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">میانگین معامله</th>
                <th className="py-3 px-3 text-center font-bold text-gray-500">رتبه</th>
              </tr>
            </thead>
            <tbody>
              {staff.map((s, i) => (
                <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ background: `linear-gradient(135deg, ${['#1F8B7D', '#6366f1', '#d97706', '#0891b2', '#7c3aed'][i % 5]}, #2E2A5C)` }}>
                        {(s.userName || '—').trim().charAt(0) || '؟'}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-gray-900">{s.userName || '—'}</p>
                        <p className="text-[11px] text-gray-400">{s.role}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-center font-bold text-gray-900">{formatCompact(s.sales)}</td>
                  <td className="py-3 px-3 text-center text-gray-600">{toPersianNum(s.orders)}</td>
                  <td className="py-3 px-3 text-center text-gray-600">{toPersianNum(s.centers)}</td>
                  <td className="py-3 px-3 text-center text-gray-600">{toPersianNum(s.pipeline)}</td>
                  <td className="py-3 px-3 text-center">
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${s.winRate >= 70 ? 'text-emerald-600 bg-emerald-50' : s.winRate >= 60 ? 'text-amber-600 bg-amber-50' : 'text-red-600 bg-red-50'}`}>
                      {toPersianNum(s.winRate)}٪
                    </span>
                  </td>
                  <td className="py-3 px-3 text-center text-gray-600">{formatCompact(s.avgDealSize)}</td>
                  <td className="py-3 px-3 text-center">
                    <span className={`w-7 h-7 rounded-full inline-flex items-center justify-center text-white text-[11px] font-bold ${i === 0 ? 'bg-amber-500' : i === 1 ? 'bg-gray-400' : i === 2 ? 'bg-amber-700' : 'bg-gray-200 text-gray-500'}`}>
                      {toPersianNum(i + 1)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Performance bars */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h4 className="text-sm font-bold text-gray-900 mb-4">مقایسه فروش کارکنان</h4>
        <HorizontalBarChart
          data={staff.map(s => ({ label: s.userName || '—', value: Math.round(s.sales / 1_000_000), color: '#1F8B7D' }))}
        />
        <p className="text-[11px] text-gray-400 mt-2 text-center">فروش تأییدشدهٔ امسال — به میلیون ریال</p>
      </div>
    </div>
  );
}

// ==================== FINANCE REPORT TAB ====================
function FinanceReportTab() {
  // v2.18.0 — was invented numbers (723.6M receivables / 87% ratio / fake
  // monthly trend); now real aggregates from billing + finance records.
  const [data, setData] = useState<{
    kpis: { receivables: number; collected: number; collectionRatio: number; avgCollectionDays: number; pendingChecks: number; pendingChecksCount: number; clearedChecks: number };
    monthly: Array<{ month: string; collected: number }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'finance-summary' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت تحلیل مالی');
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت تحلیل مالی');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;
  if (!data) return null;

  const trendData: ChartDataPoint[] = data.monthly
    .filter(m => m.collected > 0)
    .map(m => ({ label: m.month, value: Math.round(m.collected / 1_000_000), color: '#1F8B7D' }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><CreditCard size={16} className="text-teal-600" /> تحلیل مالی</h3>
        <Button
          variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
          onClick={() => exportCsv('finance-summary.csv', [
            ['شاخص', 'مقدار'],
            ['حساب‌های دریافتنی (ریال)', data.kpis.receivables],
            ['وصول‌شده (ریال)', data.kpis.collected],
            ['نسبت وصول (٪)', data.kpis.collectionRatio],
            ['میانگین روز وصول', data.kpis.avgCollectionDays],
            ['چک در انتظار سررسید (ریال)', data.kpis.pendingChecks],
            ['تعداد چک در انتظار', data.kpis.pendingChecksCount],
            ['چک وصول‌شده (ریال)', data.kpis.clearedChecks],
            [],
            ['ماه', 'وصول‌شده (ریال)'],
            ...data.monthly.map(m => [m.month, m.collected]),
          ])}
        >
          <Download size={11} /> خروجی CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'حساب‌های دریافتنی', value: formatCompact(data.kpis.receivables), sub: 'ماندهٔ فاکتورهای صادرشده', color: '#dc2626', bg: '#fef2f2' },
          { label: 'میانگین روز وصول', value: toPersianNum(data.kpis.avgCollectionDays) + ' روز', sub: 'از صدور تا تسویه', color: '#d97706', bg: '#fffbeb' },
          { label: 'چک در انتظار سررسید', value: toPersianNum(data.kpis.pendingChecksCount) + ' فقره', sub: formatCompact(data.kpis.pendingChecks) + ' ریال', color: '#0891b2', bg: '#ecfeff' },
          { label: 'نسبت وصول', value: toPersianNum(data.kpis.collectionRatio) + '٪', sub: formatCompact(data.kpis.collected) + ' از کل', color: '#059669', bg: '#ecfdf5' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-5 border border-gray-100">
            <p className="text-[11px] text-gray-400 mb-1">{s.label}</p>
            <p className="text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 mt-1">{s.sub}</p>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h4 className="text-sm font-bold text-gray-900 mb-4">روند وصول مطالبات ماهانه (سال شمسی جاری)</h4>
        {trendData.length > 0 ? (
          <MiniBarChart data={trendData} height={120} />
        ) : (
          <p className="text-xs text-gray-400 text-center py-10">در سال جاری پرداختی ثبت نشده است</p>
        )}
        <p className="text-[11px] text-gray-400 mt-2 text-center">مبالغ به میلیون ریال — از رکوردهای مالی واقعی</p>
      </div>
    </div>
  );
}

// ==================== COMPARE REPORT TAB ====================
function CompareReportTab() {
  // v2.18.0 — was invented per-company numbers; now real aggregation.
  // Non-admin users only see their own companies (server-side scope).
  const [companies, setCompanies] = useState<Array<{
    companyId: string; companyName: string; slug: string; color: string;
    sales: number; orders: number; centers: number;
  }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'company-compare' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت مقایسه شرکت‌ها');
        if (!cancelled) setCompanies(json.chartData || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت مقایسه شرکت‌ها');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;

  const slugIcon: Record<string, React.ReactNode> = {
    holding: <Layers size={18} />, bazargani: <Briefcase size={18} />,
    aria: <Heart size={18} />, bgl: <Star size={18} />,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Briefcase size={16} className="text-teal-600" /> مقایسه شرکت‌های هلدینگ</h3>
        {companies.length > 0 && (
          <Button
            variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
            onClick={() => exportCsv('company-compare.csv', [
              ['شرکت', 'فروش (ریال)', 'سفارشات', 'مراکز فعال'],
              ...companies.map(c => [c.companyName, c.sales, c.orders, c.centers]),
            ])}
          >
            <Download size={11} /> خروجی CSV
          </Button>
        )}
      </div>

      {companies.length === 0 ? (
        <ReportEmpty text="هنوز فروش تأییدشده‌ای برای مقایسه ثبت نشده است" />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {companies.map((c, i) => (
              <div key={c.companyId} className="bg-white rounded-2xl border border-gray-100 p-5 hover:shadow-md transition-all animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: `${c.color}15`, color: c.color }}>
                    {slugIcon[c.slug] || <Building2 size={18} />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-gray-900">{c.companyName}</p>
                    <span className="text-[11px] text-gray-400">{toPersianNum(c.orders)} سفارش تأییدشده</span>
                  </div>
                </div>
                <div className="space-y-2.5">
                  <div className="flex justify-between"><span className="text-[11px] text-gray-400">فروش</span><span className="text-xs font-bold text-gray-900">{formatCompact(c.sales)}</span></div>
                  <div className="flex justify-between"><span className="text-[11px] text-gray-400">سفارشات</span><span className="text-xs font-bold text-gray-900">{toPersianNum(c.orders)}</span></div>
                  <div className="flex justify-between"><span className="text-[11px] text-gray-400">مراکز فعال</span><span className="text-xs font-bold text-gray-900">{toPersianNum(c.centers)}</span></div>
                </div>
              </div>
            ))}
          </div>
          <div className="bg-white rounded-2xl border border-gray-100 p-5">
            <h4 className="text-sm font-bold text-gray-900 mb-4">مقایسه فروش شرکت‌ها (میلیون ریال)</h4>
            <HorizontalBarChart
              data={companies.map(c => ({ label: c.companyName, value: Math.round(c.sales / 1_000_000), color: c.color }))}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ==================== PRODUCTION REPORT TAB ====================
// v2.18.0 — the BGL «گزارش تولید» menu item (reports-production) used to
// fall through to the sales tab because activeTab='production' was unknown.
function ProductionReportTab() {
  const [data, setData] = useState<{
    shipments: Array<{ status: string; count: number }>;
    shipmentKpis: { total: number; active: number; delivered: number; returned: number; avgDeliveryDays: number };
    orders: Array<{ status: string; count: number }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'production-summary' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت گزارش تولید');
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت گزارش تولید');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;
  if (!data) return null;

  const shipmentColors: Record<string, string> = {
    preparing: '#d97706', ready: '#6366f1', 'in-transit': '#0891b2', delivered: '#059669', returned: '#dc2626',
  };
  const shipmentLabels: Record<string, string> = {
    preparing: 'در حال آماده‌سازی', ready: 'آماده بارگیری', 'in-transit': 'در راه', delivered: 'تحویل داده', returned: 'برگشتی',
  };
  const orderLabels: Record<string, string> = {
    pending: 'در انتظار تأیید', approved: 'تأییدشده', ordered: 'سفارش داده‌شده', rejected: 'رد شده',
  };

  const shipmentData: ChartDataPoint[] = data.shipments
    .filter(s => s.count > 0)
    .map(s => ({ label: shipmentLabels[s.status] || s.status, value: s.count, color: shipmentColors[s.status] || '#94a3b8' }));
  const orderData: ChartDataPoint[] = data.orders
    .filter(o => o.count > 0)
    .map(o => ({ label: orderLabels[o.status] || o.status, value: o.count, color: '#6366f1' }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Factory size={16} className="text-teal-600" /> گزارش تولید و ارسال</h3>
        <Button
          variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
          onClick={() => exportCsv('production-report.csv', [
            ['بخش', 'وضعیت', 'تعداد'],
            ...data.shipments.map(s => ['ارسال', shipmentLabels[s.status] || s.status, s.count]),
            ...data.orders.map(o => ['سفارش تولید', orderLabels[o.status] || o.status, o.count]),
          ])}
        >
          <Download size={11} /> خروجی CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {[
          { label: 'کل مرسوله‌ها', value: toPersianNum(data.shipmentKpis.total), color: '#2E2A5C', bg: '#eef2ff' },
          { label: 'ارسال فعال', value: toPersianNum(data.shipmentKpis.active), color: '#0891b2', bg: '#ecfeff' },
          { label: 'تحویل داده', value: toPersianNum(data.shipmentKpis.delivered), color: '#059669', bg: '#ecfdf5' },
          { label: 'برگشتی', value: toPersianNum(data.shipmentKpis.returned), color: '#dc2626', bg: '#fef2f2' },
          { label: 'میانگین زمان تحویل', value: toPersianNum(data.shipmentKpis.avgDeliveryDays) + ' روز', color: '#d97706', bg: '#fffbeb' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-[11px] text-gray-400 mb-1">{s.label}</p>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">مرسوله‌ها بر اساس وضعیت</h4>
          {shipmentData.length > 0 ? (
            <DonutChart data={shipmentData} centerLabel="کل مرسوله" centerValue={toPersianNum(data.shipmentKpis.total)} />
          ) : (
            <p className="text-xs text-gray-400 text-center py-10">هنوز ارسالی ثبت نشده است</p>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">سفارشات تولید بر اساس وضعیت</h4>
          {orderData.length > 0 ? (
            <HorizontalBarChart data={orderData} />
          ) : (
            <p className="text-xs text-gray-400 text-center py-10">سفارش تولیدی ثبت نشده است</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== SHIPMENT REPORT TAB ====================
// v2.19.0 — dedicated delivery/return report (تجمیع تحویل/برگشت):
// KPIs, carrier performance, Jalali monthly dispatch trend, recent table.
function ShipmentReportTab() {
  const [data, setData] = useState<{
    kpis: { total: number; active: number; delivered: number; returned: number; avgDeliveryDays: number; returnRate: number };
    statusBreakdown: Array<{ status: string; count: number }>;
    monthly: Array<{ label: string; year: number; month: number; dispatched: number; delivered: number; returned: number }>;
    carriers: Array<{ name: string; total: number; delivered: number; returned: number; active: number }>;
    recent: Array<{
      id: string; shipmentNumber: string | null; status: string; carrierName: string;
      documentNumber: string; centerName: string; city: string;
      dispatchedAt: string | null; deliveredAt: string | null; createdAt: string;
    }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'shipment-summary' }) });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'خطا در دریافت گزارش ارسال');
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت گزارش ارسال');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <ReportLoading />;
  if (error) return <ReportError message={error} />;
  if (!data) return null;

  const statusColors: Record<string, string> = {
    preparing: '#d97706', ready: '#6366f1', 'in-transit': '#0891b2', delivered: '#059669', returned: '#dc2626',
  };
  const statusLabels: Record<string, string> = {
    preparing: 'در حال آماده‌سازی', ready: 'آماده بارگیری', 'in-transit': 'در راه', delivered: 'تحویل داده', returned: 'برگشتی',
  };

  const statusData: ChartDataPoint[] = data.statusBreakdown
    .filter(s => s.count > 0)
    .map(s => ({ label: statusLabels[s.status] || s.status, value: s.count, color: statusColors[s.status] || '#94a3b8' }));

  const trendData = data.monthly.map(m => ({ label: m.label, value: m.dispatched }));
  const hasTrend = data.monthly.some(m => m.dispatched > 0 || m.delivered > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Truck size={16} className="text-teal-600" /> گزارش ارسال بار</h3>
        <div className="flex gap-2">
          {data.carriers.length > 0 && (
            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
              onClick={() => exportCsv('shipment-carriers.csv', [
                ['حمل‌کننده', 'کل', 'تحویل‌شده', 'برگشتی', 'فعال'],
                ...data.carriers.map(c => [c.name, c.total, c.delivered, c.returned, c.active]),
              ])}
            >
              <Download size={11} /> خروجی CSV حمل‌کنندگان
            </Button>
          )}
          {data.recent.length > 0 && (
            <Button
              variant="outline" size="sm" className="h-8 gap-1 text-[11px] rounded-lg"
              onClick={() => exportCsv('shipment-recent.csv', [
                ['شماره ارسال', 'فاکتور', 'مرکز', 'شهر', 'حمل‌کننده', 'وضعیت', 'تاریخ ارسال', 'تاریخ تحویل'],
                ...data.recent.map(r => [
                  r.shipmentNumber || '', r.documentNumber, r.centerName, r.city,
                  r.carrierName || 'نامشخص', statusLabels[r.status] || r.status,
                  r.dispatchedAt ? toJalaliString(r.dispatchedAt) : '—',
                  r.deliveredAt ? toJalaliString(r.deliveredAt) : '—',
                ]),
              ])}
            >
              <Download size={11} /> خروجی CSV مرسوله‌ها
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
        {[
          { label: 'کل مرسوله‌ها', value: toPersianNum(data.kpis.total), color: '#2E2A5C', bg: '#eef2ff' },
          { label: 'ارسال فعال', value: toPersianNum(data.kpis.active), color: '#0891b2', bg: '#ecfeff' },
          { label: 'تحویل داده', value: toPersianNum(data.kpis.delivered), color: '#059669', bg: '#ecfdf5' },
          { label: 'برگشتی', value: toPersianNum(data.kpis.returned), color: '#dc2626', bg: '#fef2f2' },
          { label: 'میانگین زمان تحویل', value: toPersianNum(data.kpis.avgDeliveryDays) + ' روز', color: '#d97706', bg: '#fffbeb' },
          { label: 'نرخ برگشت', value: toPersianNum(data.kpis.returnRate) + '٪', color: '#9333ea', bg: '#faf5ff' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-2xl p-4 border border-gray-100">
            <p className="text-[11px] text-gray-400 mb-1">{s.label}</p>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">مرسوله‌ها بر اساس وضعیت</h4>
          {statusData.length > 0 ? (
            <DonutChart data={statusData} centerLabel="کل مرسوله" centerValue={toPersianNum(data.kpis.total)} />
          ) : (
            <p className="text-xs text-gray-400 text-center py-10">هنوز ارسالی ثبت نشده است</p>
          )}
        </div>
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">روند ارسال ماهانه (۱۲ ماه شمسی)</h4>
          {hasTrend ? (
            <MiniBarChart data={trendData} height={120} />
          ) : (
            <p className="text-xs text-gray-400 text-center py-10">در ۱۲ ماه گذشته ارسالی ثبت نشده است</p>
          )}
        </div>
      </div>

      {/* Carrier performance */}
      {data.carriers.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 p-5">
          <h4 className="text-sm font-bold text-gray-900 mb-4">عملکرد حمل‌کنندگان</h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-right py-2 font-medium">حمل‌کننده</th>
                  <th className="text-center py-2 font-medium">کل</th>
                  <th className="text-center py-2 font-medium">تحویل‌شده</th>
                  <th className="text-center py-2 font-medium">برگشتی</th>
                  <th className="text-center py-2 font-medium">فعال</th>
                </tr>
              </thead>
              <tbody>
                {data.carriers.map((c) => (
                  <tr key={c.name} className="border-b border-gray-50 last:border-0">
                    <td className="py-2.5 font-medium text-gray-800">{c.name}</td>
                    <td className="text-center py-2.5 text-gray-700">{toPersianNum(c.total)}</td>
                    <td className="text-center py-2.5 text-emerald-600 font-medium">{toPersianNum(c.delivered)}</td>
                    <td className="text-center py-2.5 text-red-600 font-medium">{toPersianNum(c.returned)}</td>
                    <td className="text-center py-2.5 text-cyan-600 font-medium">{toPersianNum(c.active)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent shipments */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h4 className="text-sm font-bold text-gray-900 mb-4">آخرین مرسوله‌ها</h4>
        {data.recent.length === 0 ? (
          <p className="text-xs text-gray-400 text-center py-10">هنوز ارسالی ثبت نشده است</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 border-b border-gray-100">
                  <th className="text-right py-2 font-medium">شماره ارسال</th>
                  <th className="text-right py-2 font-medium">فاکتور</th>
                  <th className="text-right py-2 font-medium">مرکز / شهر</th>
                  <th className="text-right py-2 font-medium">حمل‌کننده</th>
                  <th className="text-center py-2 font-medium">وضعیت</th>
                  <th className="text-center py-2 font-medium">ارسال</th>
                  <th className="text-center py-2 font-medium">تحویل</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.id} className="border-b border-gray-50 last:border-0">
                    <td className="py-2.5 font-mono text-[11px] text-gray-700 text-right" dir="ltr">{r.shipmentNumber || '—'}</td>
                    <td className="py-2.5 text-gray-700 font-mono text-[11px] text-right" dir="ltr">{r.documentNumber || '—'}</td>
                    <td className="py-2.5 text-gray-700">{r.city ? `${r.centerName} (${r.city})` : r.centerName}</td>
                    <td className="py-2.5 text-gray-600">{r.carrierName || 'نامشخص'}</td>
                    <td className="text-center py-2.5">
                      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium" style={{ background: (statusColors[r.status] || '#94a3b8') + '18', color: statusColors[r.status] || '#64748b' }}>
                        {statusLabels[r.status] || r.status}
                      </span>
                    </td>
                    <td className="text-center py-2.5 text-gray-500">{r.dispatchedAt ? toJalaliString(r.dispatchedAt) : '—'}</td>
                    <td className="text-center py-2.5 text-gray-500">{r.deliveredAt ? toJalaliString(r.deliveredAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== MAIN REPORTS COMPONENT ====================
export default function SalesReports({ activeTab: propTab }: { activeTab?: string }) {
  // v2.26.0 — internal tabs are access-gated with the same menu-key
  // resolution the sidebar uses: a report tab that the company's catalog
  // (or the job-title matrix) hides is neither rendered nor reachable
  // (e.g. «تحلیل مالی» / «مقایسه شرکت‌ها» no longer appear in بازرگانی,
  // whose catalog never offered them).
  const { isTabAllowed } = useTabAccess();
  const TAB_MENU_KEYS: Record<ReportTab, string> = {
    sales: 'reports-sales',
    pipeline: 'reports-pipeline',
    staff: 'reports-staff',
    finance: 'reports-finance',
    compare: 'reports-compare',
    production: 'reports-production',
    shipments: 'reports-shipments',
  };
  const [activeTab, setActiveTab] = useState<ReportTab>(
    propTab === 'pipeline' ? 'pipeline' :
    propTab === 'staff' ? 'staff' :
    propTab === 'finance' ? 'finance' :
    propTab === 'compare' ? 'compare' :
    propTab === 'production' ? 'production' :
    propTab === 'shipments' ? 'shipments' :
    'sales'
  );

  // Keep the tab in sync when the sidebar navigates between report submenus
  // while this component stays mounted (same pattern as sales-docs).
  useEffect(() => {
    const known = ['sales', 'pipeline', 'staff', 'finance', 'compare', 'production', 'shipments'];
    if (propTab && known.includes(propTab)) {
      queueMicrotask(() => setActiveTab(propTab as ReportTab));
    }
  }, [propTab]);

  const allTabs: { key: ReportTab; label: string; icon: React.ReactNode }[] = [
    { key: 'sales', label: 'گزارش فروش', icon: <TrendingUp size={14} /> },
    { key: 'pipeline', label: 'کاریز فروش', icon: <Layers size={14} /> },
    { key: 'staff', label: 'عملکرد کارکنان', icon: <Users size={14} /> },
    { key: 'finance', label: 'تحلیل مالی', icon: <CreditCard size={14} /> },
    { key: 'compare', label: 'مقایسه شرکت‌ها', icon: <Briefcase size={14} /> },
    { key: 'production', label: 'تولید و ارسال', icon: <Factory size={14} /> },
    { key: 'shipments', label: 'ارسال بار', icon: <Truck size={14} /> },
  ];
  const tabs = allTabs.filter((t) => isTabAllowed(TAB_MENU_KEYS[t.key]));
  // Guarded tab: fall back to the first ALLOWED tab (also covers a direct
  // nav key whose access was revoked).
  const currentTab: ReportTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'sales');

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto" role="tablist" aria-label="گزارش‌ها">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={currentTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all whitespace-nowrap min-h-[36px] ${
                  currentTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
          {/* v2.18.0 — was a dead button; now opens the browser print dialog
              (چاپ / Save as PDF) over the rendered report. */}
          <Button variant="outline" className="h-9 gap-1.5 text-xs rounded-lg shrink-0" onClick={() => window.print()}>
            <Download size={13} /> خروجی PDF
          </Button>
        </div>
      </div>

      {/* Tab content */}
      {currentTab === 'sales' && <SalesReportTab />}
      {currentTab === 'pipeline' && <PipelineReportTab />}
      {currentTab === 'staff' && <StaffReportTab />}
      {currentTab === 'finance' && <FinanceReportTab />}
      {currentTab === 'compare' && <CompareReportTab />}
      {currentTab === 'production' && <ProductionReportTab />}
      {currentTab === 'shipments' && <ShipmentReportTab />}
    </div>
  );
}
