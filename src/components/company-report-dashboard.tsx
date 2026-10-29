'use client';

import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Building2, FileText, Phone, AlertTriangle, CheckCircle, ArrowUpRight, ArrowDownRight, BarChart3, Target, CreditCard, MapPin, ArrowLeftRight, CircleDollarSign, Star, Zap, Timer } from 'lucide-react';
import { COMPANY_DATA, MONTHS, type CompanyDatum, type CompanyReportDashboardProps } from './company-report-data';

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (d) => persianDigits[parseInt(d)]);
}
function formatCurrency(n: number): string {
  if (n >= 1e9) return toPersianNum((n / 1e9).toFixed(1)) + ' میلیارد ریال';
  if (n >= 1e6) return toPersianNum((n / 1e6).toFixed(1)) + ' میلیون ریال';
  if (n >= 1e3) return toPersianNum((n / 1e3).toFixed(0)) + ' هزار ریال';
  return toPersianNum(n) + ' ریال';
}

// ==================== COMPONENT ====================
export default function CompanyReportDashboard({ companySlug, companyName, companyType, color: _color, accent }: CompanyReportDashboardProps) {
  // ── Real stats fetched from /api/stats for this company ──
  const [stats, setStats] = useState<{ salesAmount: number; centersCount: number; proformasCount: number; followupsCount: number } | null>(null);
  const [, setLoadingStats] = useState(true); // loading flag intentionally unread (skeleton not rendered)

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/stats?company=${companySlug}`);
        const data = await res.json();
        if (!cancelled && res.ok) setStats(data);
      } catch {
        // keep null → zeros shown
      } finally {
        if (!cancelled) setLoadingStats(false);
      }
    })();
    return () => { cancelled = true; };
  }, [companySlug]);

  // Merge real stats over the display defaults (zeros where no real data exists)
  const d: CompanyDatum = {
    ...COMPANY_DATA[companySlug],
    totalSales: stats?.salesAmount ?? 0,
    lastMonthSales: 0,
    targetSales: 0,
    activeCenters: stats?.centersCount ?? 0,
    pipelineCount: stats?.proformasCount ?? 0,
    overdueFollowups: stats?.followupsCount ?? 0,
    pendingInvoices: 0,
    wonDeals: 0,
    lostDeals: 0,
    visits: 0,
    calls: 0,
    emails: 0,
    collectionRate: 0,
    winRate: 0,
    monthlySales: [],
    topCustomers: [],
    cityBreakdown: [],
    dailyTrend: [],
  };
  const salesChange = 0;
  const targetPct = 0;
  const maxMonthly = 1;
  const remaining = 0;
  const maxCity = 1;
  const maxDaily = 1;

  const statusStyle: Record<string, string> = {
    active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    pending: 'bg-amber-50 text-amber-700 border-amber-200',
    overdue: 'bg-red-50 text-red-700 border-red-200',
  };
  const statusLabel: Record<string, string> = { active: 'فعال', pending: 'در انتظار', overdue: 'سررسید' };

  // Pipeline stages for funnel
  const activePipelineStages = [
    { key: 'lead', label: 'سرنخ', count: d.pipelineStages.lead, color: '#6366f1' },
    { key: 'qualified', label: 'واجد شرایط', count: d.pipelineStages.qualified, color: '#8b5cf6' },
    { key: 'proposal', label: 'پیشنهاد قیمت', count: d.pipelineStages.proposal, color: '#2563eb' },
    { key: 'negotiation', label: 'مذاکره', count: d.pipelineStages.negotiation, color: '#d97706' },
  ];
  const maxPipeline = Math.max(...activePipelineStages.map(s => s.count), 1);

  // Collection aging
  const agingData = [
    { label: 'جاری', value: d.collectionAging.current, color: '#059669' },
    { label: '۱-۳۰ روز', value: d.collectionAging.d30, color: '#d97706' },
    { label: '۳۱-۶۰ روز', value: d.collectionAging.d60, color: '#ea580c' },
    { label: '۶۱-۹۰ روز', value: d.collectionAging.d90, color: '#dc2626' },
    { label: 'بیشتر از ۹۰', value: d.collectionAging.d90plus, color: '#991b1b' },
  ];
  const maxAging = Math.max(...agingData.map(a => a.value));

  return (
    <div className="space-y-5 animate-fade-in">
      {/* ===== HEADER ===== */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-gray-900">داشبورد گزارشی {companyName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">نمای عملکردی {companyType} · {toPersianNum(new Date().getMonth() + 1)}م</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="px-3 py-1.5 rounded-lg border font-bold text-xs" style={{ borderColor: `${accent}30`, background: `${accent}08`, color: accent }}>
            {companyType}
          </div>
        </div>
      </div>

      {/* ===== KPI ROW ===== */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3">
        {([
          { icon: <BarChart3 size={18} />, label: 'فروش ماه', value: formatCurrency(d.totalSales), change: salesChange, color: accent },
          { icon: <Target size={18} />, label: 'پیشرفت هدف', value: toPersianNum(targetPct) + '٪', color: '#2E2A5C', subtitle: formatCurrency(remaining) + ' مانده' },
          { icon: <Building2 size={18} />, label: 'مراکز فعال', value: toPersianNum(d.activeCenters) + '/' + toPersianNum(d.totalCenters), change: d.newCenters > 0 ? d.newCenters : undefined, color: '#2980B9' },
          { icon: <CreditCard size={18} />, label: 'نرخ وصول', value: toPersianNum(d.collectionRate) + '٪', color: d.collectionRate >= 75 ? '#059669' : '#d97706' },
          { icon: <ArrowLeftRight size={18} />, label: 'میانگین ماندگاری', value: toPersianNum(d.avgPaymentDays) + ' روز', color: d.avgPaymentDays <= 40 ? '#059669' : '#d97706' },
          { icon: <CircleDollarSign size={18} />, label: 'ارزش پایپلاین', value: formatCurrency(d.pipelineValue), color: '#ea580c' },
          { icon: <CheckCircle size={18} />, label: 'نرخ برد', value: toPersianNum(d.winRate) + '٪', color: '#059669' },
          { icon: <AlertTriangle size={18} />, label: 'سررسید گذشته', value: toPersianNum(d.overdueFollowups), color: d.overdueFollowups > 10 ? '#dc2626' : '#d97706' },
        ] as { icon: React.ReactNode; label: string; value: string; change?: number; subtitle?: string; color: string }[]).map((item, i) => (
          <div key={i} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-300 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-2" style={{ background: `${item.color}10`, color: item.color }}>{item.icon}</div>
            <div className="text-base font-extrabold text-gray-900 mb-0.5">{item.value}</div>
            <div className="text-[11px] text-gray-500 font-medium">{item.label}</div>
            {item.subtitle && (
              <div className="text-[11px] text-gray-400 mt-1">{item.subtitle}</div>
            )}
            {item.change !== undefined && (
              <div className={`flex items-center gap-0.5 mt-1 text-[11px] font-bold ${item.change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {item.change >= 0 ? <ArrowUpRight size={10} /> : <ArrowDownRight size={10} />}
                {toPersianNum(Math.abs(item.change))}٪
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ===== MONTHLY CHART + TARGET DONUT + DAILY TREND ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Monthly Sales Chart */}
        <div className="lg:col-span-5 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-sm font-bold text-gray-900">روند فروش ماهانه</h3>
              <p className="text-[11px] text-gray-400 mt-0.5">میلیارد ریال</p>
            </div>
            <div className="text-right">
              <div className="text-xs font-bold text-gray-900">هدف: {formatCurrency(d.targetSales)}</div>
              <div className="text-[11px] text-gray-400">رسیده: {formatCurrency(d.totalSales)}</div>
            </div>
          </div>
          <div className="flex items-end justify-between gap-3 h-44 px-1">
            {d.monthlySales.map((val, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5 flex-1">
                <span className="text-[11px] font-bold text-gray-600">{toPersianNum(val)}</span>
                <div className="w-full max-w-[36px] rounded-t-lg animate-bar-grow opacity-0" style={{
                  height: `${(val / maxMonthly) * 100}%`,
                  background: `linear-gradient(to top, ${accent}, ${accent}88)`,
                  animationDelay: `${i * 80}ms`,
                  minHeight: '6px',
                }} />
                <span className="text-[11px] text-gray-400 font-medium">{MONTHS[i].slice(0, 3)}</span>
              </div>
            ))}
          </div>
          {/* Growth indicator */}
          <div className={`mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${salesChange >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
            {salesChange >= 0 ? <TrendingUp size={14} className="text-emerald-600" /> : <TrendingDown size={14} className="text-red-600" />}
            <span className={`text-xs font-bold ${salesChange >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {salesChange >= 0 ? '+' : ''}{toPersianNum(salesChange)}٪ رشد نسبت به ماه قبل
            </span>
          </div>
        </div>

        {/* Target Donut + Collection */}
        <div className="lg:col-span-3 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-bold text-gray-900 mb-4">هدف و وصول</h3>
          <div className="flex flex-col items-center mb-4">
            <div className="relative w-28 h-28">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="48" fill="none" stroke="#f3f4f6" strokeWidth="10" />
                <circle cx="60" cy="60" r="48" fill="none" stroke={accent} strokeWidth="10" strokeLinecap="round"
                  strokeDasharray={`${(targetPct / 100) * 302} 302`} className="transition-all duration-1000" />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <Target size={16} style={{ color: accent }} />
                <span className="text-base font-extrabold text-gray-900 mt-0.5">{toPersianNum(targetPct)}٪</span>
              </div>
            </div>
            <span className="text-[11px] text-gray-400 mt-1">پیشرفت هدف فروش</span>
          </div>
          <div className="border-t border-gray-100 pt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold text-gray-700">نرخ وصول</span>
              <span className={`text-xs font-extrabold ${d.collectionRate >= 75 ? 'text-emerald-600' : 'text-amber-600'}`}>{toPersianNum(d.collectionRate)}٪</span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${d.collectionRate}%`, background: d.collectionRate >= 75 ? '#059669' : '#d97706' }} />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-[11px] text-gray-400">
              <span>پرداخت‌شده: {toPersianNum(d.totalInvoices - d.pendingInvoices)}</span>
              <span>در انتظار: {toPersianNum(d.pendingInvoices)}</span>
            </div>
          </div>
        </div>

        {/* Daily Trend */}
        <div className="lg:col-span-4 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-gray-900">روند هفتگی</h3>
              <p className="text-[11px] text-gray-400">فروش و بازدید روزانه (میلیارد)</p>
            </div>
          </div>
          <div className="space-y-3">
            {d.dailyTrend.map((t, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className="text-[11px] text-gray-500 w-16 font-medium">{t.day}</span>
                <div className="flex-1 h-5 bg-gray-50 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-700" style={{
                    width: `${(t.sales / maxDaily) * 100}%`,
                    background: `linear-gradient(90deg, ${accent}40, ${accent})`,
                  }} />
                </div>
                <span className="text-[11px] font-bold text-gray-700 w-10 text-left">{toPersianNum(t.sales)}</span>
                <div className="w-6 h-4 rounded bg-gray-50 flex items-center justify-center">
                  <MapPin size={9} className="text-gray-400" />
                </div>
                <span className="text-[11px] font-bold text-gray-500 w-6 text-left">{toPersianNum(t.visits)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ===== PIPELINE FUNNEL + COLLECTION AGING ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Pipeline Funnel */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center">
                <Zap size={16} className="text-violet-600" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-gray-900">قیف فروش</h3>
                <p className="text-[11px] text-gray-400">تعداد فرصت‌ها در هر مرحله</p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-extrabold" style={{ color: accent }}>{toPersianNum(d.pipelineCount)} فرصت</div>
              <div className="text-[11px] text-gray-400">ارزش: {formatCurrency(d.pipelineValue)}</div>
            </div>
          </div>
          <div className="space-y-2">
            {activePipelineStages.map((s, i) => {
              const width = Math.max((s.count / maxPipeline) * 100, 20);
              return (
                <div key={s.key} className="animate-fade-in opacity-0" style={{ animationDelay: `${i * 100}ms` }}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] font-bold text-gray-700">{s.label}</span>
                    <span className="text-[11px] font-bold" style={{ color: s.color }}>{toPersianNum(s.count)}</span>
                  </div>
                  <div className="h-7 bg-gray-50 rounded-lg overflow-hidden mx-auto transition-all duration-700" style={{ width: `${width}%` }}>
                    <div className="h-full rounded-lg flex items-center justify-end px-2" style={{ background: `${s.color}15`, borderLeft: `3px solid ${s.color}` }}>
                      {i < activePipelineStages.length - 1 && (
                        <span className="text-[11px] font-bold mr-auto" style={{ color: s.color }}>
                          → {activePipelineStages[i + 1].count > 0 ? toPersianNum(Math.round((activePipelineStages[i + 1].count / s.count) * 100)) : '۰'}٪
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          {/* Win/Loss summary */}
          <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-3 gap-2">
            <div className="text-center p-2 rounded-lg bg-emerald-50 border border-emerald-100">
              <div className="text-sm font-extrabold text-emerald-700">{toPersianNum(d.wonDeals)}</div>
              <div className="text-[11px] text-emerald-600">موفق</div>
            </div>
            <div className="text-center p-2 rounded-lg bg-red-50 border border-red-100">
              <div className="text-sm font-extrabold text-red-700">{toPersianNum(d.lostDeals)}</div>
              <div className="text-[11px] text-red-600">از دست رفته</div>
            </div>
            <div className="text-center p-2 rounded-lg bg-blue-50 border border-blue-100">
              <div className="text-sm font-extrabold text-blue-700">{toPersianNum(d.winRate)}٪</div>
              <div className="text-[11px] text-blue-600">نرخ برد</div>
            </div>
          </div>
        </div>

        {/* Collection Aging */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-orange-50 flex items-center justify-center">
              <Timer size={16} className="text-orange-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">سنی مطالبات</h3>
              <p className="text-[11px] text-gray-400">توزیع حساب‌های دریافتی بر اساس عمر</p>
            </div>
          </div>
          {/* Aging bars */}
          <div className="space-y-3 mb-4">
            {agingData.map((a, i) => (
              <div key={i} className="flex items-center gap-3 animate-fade-in opacity-0" style={{ animationDelay: `${i * 80}ms` }}>
                <span className="text-[11px] text-gray-600 w-20 font-medium">{a.label}</span>
                <div className="flex-1 h-6 bg-gray-50 rounded-lg overflow-hidden">
                  <div className="h-full rounded-lg transition-all duration-700 flex items-center justify-end px-2" style={{ width: `${(a.value / maxAging) * 100}%`, background: `${a.color}20`, borderLeft: `3px solid ${a.color}` }}>
                    <span className="text-[11px] font-bold" style={{ color: a.color }}>{toPersianNum(a.value)}٪</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Risk indicator */}
          <div className={`p-3 rounded-xl border ${d.collectionRate >= 75 ? 'bg-emerald-50 border-emerald-100' : d.collectionRate >= 65 ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100'}`}>
            <div className="flex items-center gap-2">
              {d.collectionRate >= 75 ? <CheckCircle size={16} className="text-emerald-600" /> : <AlertTriangle size={16} className={d.collectionRate >= 65 ? 'text-amber-600' : 'text-red-600'} />}
              <div>
                <span className={`text-xs font-bold ${d.collectionRate >= 75 ? 'text-emerald-700' : d.collectionRate >= 65 ? 'text-amber-700' : 'text-red-700'}`}>
                  {d.collectionRate >= 75 ? 'وضعیت مطلوب' : d.collectionRate >= 65 ? 'نیاز به بهبود' : 'بحرانی - اقدام فوری'}
                </span>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {toPersianNum(d.pendingInvoices)} فاکتور پرداخت‌نشده · میانگین {toPersianNum(d.avgPaymentDays)} روز ماندگاری
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== TOP CUSTOMERS + CITY BREAKDOWN ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Top Customers Table */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${accent}10`, color: accent }}>
              <Star size={16} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">مشتریان برتر</h3>
              <p className="text-[11px] text-gray-400">بالاترین حجم خرید در سال جاری</p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-right py-2 px-2 text-gray-400 font-bold text-[11px]">ردیف</th>
                  <th className="text-right py-2 px-2 text-gray-400 font-bold text-[11px]">نام مشتری</th>
                  <th className="text-right py-2 px-2 text-gray-400 font-bold text-[11px]">شهر</th>
                  <th className="text-right py-2 px-2 text-gray-400 font-bold text-[11px]">مجموع خرید</th>
                  <th className="text-right py-2 px-2 text-gray-400 font-bold text-[11px]">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {d.topCustomers.map((c, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
                    <td className="py-2.5 px-2 text-gray-400 font-bold text-[11px]">
                      {i < 3 ? (
                        <span className="w-5 h-5 rounded-full inline-flex items-center justify-center text-[11px] font-bold text-white" style={{ background: i === 0 ? '#f59e0b' : i === 1 ? '#94a3b8' : '#cd7f32' }}>{toPersianNum(i + 1)}</span>
                      ) : toPersianNum(i + 1)}
                    </td>
                    <td className="py-2.5 px-2 font-bold text-gray-900 text-xs">{c.name}</td>
                    <td className="py-2.5 px-2 text-gray-500 text-[11px] flex items-center gap-1"><MapPin size={10} />{c.city}</td>
                    <td className="py-2.5 px-2 font-extrabold text-gray-900 text-xs text-right" dir="ltr">{formatCurrency(c.amount)}</td>
                    <td className="py-2.5 px-2">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${statusStyle[c.status] || statusStyle.active}`}>
                        {statusLabel[c.status] || c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* City Breakdown */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <MapPin size={16} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">توزیع جغرافیایی فروش</h3>
              <p className="text-[11px] text-gray-400">سهم هر شهر از کل فروش</p>
            </div>
          </div>
          <div className="space-y-3">
            {d.cityBreakdown.map((c, i) => {
              void Math.round((c.sales / d.totalSales) * 100); // percentage shown via CSS width
              return (
                <div key={i} className="animate-fade-in opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-gray-700">{c.city}</span>
                      <span className="text-[11px] text-gray-400">({toPersianNum(c.centers)} مرکز)</span>
                    </div>
                    <span className="text-[11px] font-bold text-gray-600">{formatCurrency(c.sales)}</span>
                  </div>
                  <div className="h-5 bg-gray-50 rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-700" style={{
                      width: `${(c.sales / maxCity) * 100}%`,
                      background: `linear-gradient(90deg, ${accent}30, ${accent})`,
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ===== ACTIVITY REPORT + INVOICE STATUS ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Activity Report */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
              <Phone size={16} className="text-blue-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">گزارش فعالیت‌ها</h3>
              <p className="text-[11px] text-gray-400">تماس، بازدید و ایمیل ماهانه</p>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: 'تماس‌های تلفنی', value: d.calls, icon: <Phone size={14} />, color: '#2563eb', bg: '#eff6ff' },
              { label: 'بازدیدهای حضوری', value: d.visits, icon: <MapPin size={14} />, color: '#059669', bg: '#ecfdf5' },
              { label: 'ایمیل‌ها', value: d.emails, icon: <FileText size={14} />, color: '#8E44AD', bg: '#faf5ff' },
            ].map((item) => {
              const maxAct = Math.max(d.calls, d.visits, d.emails);
              return (
                <div key={item.label} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: item.bg, color: item.color }}>{item.icon}</div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-bold text-gray-800">{item.label}</span>
                      <span className="text-xs font-extrabold text-gray-900">{toPersianNum(item.value)}</span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${(item.value / maxAct) * 100}%`, background: item.color }} />
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="border-t border-gray-100 pt-3 grid grid-cols-3 gap-2">
              <div className="text-center p-2.5 rounded-xl bg-gray-50 border border-gray-100">
                <div className="text-base font-extrabold text-gray-900">{toPersianNum(d.wonDeals)}</div>
                <div className="text-[11px] text-gray-500 font-medium">معامله موفق</div>
              </div>
              <div className="text-center p-2.5 rounded-xl bg-gray-50 border border-gray-100">
                <div className="text-base font-extrabold text-gray-900">{toPersianNum(d.lostDeals)}</div>
                <div className="text-[11px] text-gray-500 font-medium">از دست رفته</div>
              </div>
              <div className="text-center p-2.5 rounded-xl bg-gray-50 border border-gray-100">
                <div className="text-base font-extrabold text-gray-900">{toPersianNum(d.newCenters)}</div>
                <div className="text-[11px] text-gray-500 font-medium">مرکز جدید</div>
              </div>
            </div>
          </div>
        </div>

        {/* Invoice Status */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
              <FileText size={16} className="text-amber-600" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-900">وضعیت فاکتورها</h3>
              <p className="text-[11px] text-gray-400">خلاصه صورتحساب‌ها و پایپلاین</p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-100 text-center">
                <div className="text-xl font-extrabold text-emerald-700">{toPersianNum(d.totalInvoices - d.pendingInvoices)}</div>
                <div className="text-[11px] text-emerald-600 font-medium mt-0.5">پرداخت‌شده</div>
              </div>
              <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-100 text-center">
                <div className="text-xl font-extrabold text-amber-700">{toPersianNum(d.pendingInvoices)}</div>
                <div className="text-[11px] text-amber-600 font-medium mt-0.5">در انتظار پرداخت</div>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-bold text-gray-700">میانگین ماندگاری فاکتور</span>
                <span className={`text-xs font-extrabold ${d.avgPaymentDays <= 40 ? 'text-emerald-600' : d.avgPaymentDays <= 50 ? 'text-amber-600' : 'text-red-600'}`}>{toPersianNum(d.avgPaymentDays)} روز</span>
              </div>
              <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-1000" style={{
                  width: `${Math.min((d.avgPaymentDays / 60) * 100, 100)}%`,
                  background: d.avgPaymentDays <= 40 ? '#059669' : d.avgPaymentDays <= 50 ? '#d97706' : '#dc2626',
                }} />
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px] text-gray-400">
                <span>مطلوب: زیر ۳۰ روز</span>
                <span>بحرانی: بالای ۵۰ روز</span>
              </div>
            </div>
            <div className="border-t border-gray-100 pt-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-bold text-gray-700">ارزش پایپلاین فروش</span>
                <span className="text-xs font-extrabold" style={{ color: accent }}>{formatCurrency(d.pipelineValue)}</span>
              </div>
              <div className="text-[11px] text-gray-500">{toPersianNum(d.pipelineCount)} فرصت فعال با میانگین {formatCurrency(d.avgDealSize)} به ازای هر معامله</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
