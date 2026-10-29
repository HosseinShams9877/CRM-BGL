'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  TrendingUp, Building2, AlertTriangle, Clock, ArrowUpRight, ArrowDownRight,
  BarChart3, PieChart, Activity, Target, CreditCard, Shield, Award, Zap,
  Briefcase, Heart, Star, Timer, RefreshCw, Settings2, ChevronUp,
  ChevronDown, Check, X, Truck, Factory, Users, Wallet, Landmark, RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  HOLDING_TAB_CATALOG, visibleHoldingTabKeys,
  type HoldingTab, type HoldingTabKey,
} from '@/lib/holding-dashboard-sections';

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  if (typeof n === 'number' && !Number.isFinite(n)) return '۰';
  return String(n).replace(/[0-9]/g, (d) => persianDigits[parseInt(d)]);
}
function formatCurrency(n: number): string {
  if (n >= 1e9) return toPersianNum((n / 1e9).toFixed(1)) + ' میلیارد ریال';
  if (n >= 1e6) return toPersianNum((n / 1e6).toFixed(1)) + ' میلیون ریال';
  if (n >= 1e3) return toPersianNum((n / 1e3).toFixed(0)) + ' هزار ریال';
  return toPersianNum(n) + ' ریال';
}

// ==================== REPORT PAYLOAD TYPES ====================
/** One month of the REAL sales trend (v2.25.0 — /api/stats?trend=1). */
type TrendMonth = { key: string; label: string; total: number; companies: Record<string, number> };

type CompanyCard = {
  slug: string; name: string; type: string; color: string; accentColor: string;
  centerCount: number; followupCount: number;
  stats: { salesAmount: number; centersCount: number; proformasCount: number; followupsCount: number } | null;
};

/** /api/reports action=f finance-summary */
type FinanceData = {
  kpis: {
    receivables: number; collected: number; collectionRatio: number; avgCollectionDays: number;
    pendingChecks: number; pendingChecksCount: number; clearedChecks: number;
  };
  monthly: Array<{ month: string; collected: number }>;
};

/** /api/reports action=pipeline-summary */
type PipelineData = {
  stages: Array<{ key: string; label: string; count: number; amount: number }>;
  conversion: Array<{ label: string; value: number }>;
  kpis: { totalOpportunities: number; pipelineValue: number; wonCount: number; lostCount: number; winRate: number; avgCloseDays: number };
};

/** /api/reports action=staff-performance */
type StaffData = {
  chartData: Array<{
    userId: string; userName: string; role: string; sales: number; orders: number;
    centers: number; pipeline: number; winRate: number; avgDealSize: number;
  }>;
};

/** /api/reports action=top-centers */
type TopCentersData = {
  year: number;
  chartData: Array<{ centerId: string | null; centerName: string; province: string; totalSales: number; documentCount: number }>;
};

/** /api/reports action=shipment-summary */
type ShipmentData = {
  kpis: { total: number; active: number; delivered: number; returned: number; avgDeliveryDays: number; returnRate: number };
  statusBreakdown: Array<{ status: string; count: number }>;
  monthly: Array<{ label: string; year: number; month: number; dispatched: number; delivered: number; returned: number }>;
  carriers: Array<{ name: string; total: number; delivered: number; returned: number; active: number }>;
  recent: Array<{
    id: string; shipmentNumber: string; status: string; carrierName: string; documentNumber: string;
    centerName: string; city: string; dispatchedAt: string | null; deliveredAt: string | null; createdAt: string;
  }>;
};

/** /api/reports action=production-summary */
type ProductionData = {
  shipments: Array<{ status: string; count: number }>;
  shipmentKpis: { total: number; active: number; delivered: number; returned: number; avgDeliveryDays: number };
  orders: Array<{ status: string; count: number }>;
};

type OpsData = { production: ProductionData; shipment: ShipmentData };

const STATUS_LABELS: Record<string, string> = {
  draft: 'پیش‌نویس', submitted: 'ارسال‌شده', approved: 'تأییدشده', rejected: 'ردشده',
  cancelled: 'لغوشده', paid: 'پرداخت‌شده', partially_paid: 'پرداخت جزئی', void: 'باطل',
  preparing: 'در حال آماده‌سازی', ready: 'آماده ارسال', 'in-transit': 'در راه',
  delivered: 'تحویل‌شده', returned: 'برگشتی', planning: 'برنامه‌ریزی',
  'in-production': 'در حال تولید', completed: 'تکمیل‌شده', stopped: 'متوقف‌شده',
};

function statusLabel(s: string): string {
  return STATUS_LABELS[s] || s;
}

const ALERT_STYLES: Record<string, { bg: string; border: string; iconBg: string; iconColor: string }> = {
  danger: { bg: '#fef2f2', border: '#fecaca', iconBg: '#fee2e2', iconColor: '#dc2626' },
  warning: { bg: '#fffbeb', border: '#fde68a', iconBg: '#fef3c7', iconColor: '#d97706' },
  success: { bg: '#ecfdf5', border: '#a7f3d0', iconBg: '#d1fae5', iconColor: '#059669' },
  info: { bg: '#eff6ff', border: '#bfdbfe', iconBg: '#dbeafe', iconColor: '#2563eb' },
};

// ==================== KPI CARD ====================
function KpiCard({ icon, label, value, change, color, delay, subtitle }: {
  icon: React.ReactNode; label: string; value: string; change?: number; color: string; delay: number; subtitle?: string;
}) {
  const isPositive = change !== undefined && change >= 0;
  return (
    <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 hover:shadow-md hover:border-gray-200 transition-all duration-300 animate-fade-in opacity-0" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center justify-between mb-2">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${color}15` }}>
          <span style={{ color }}>{icon}</span>
        </div>
        {change !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${isPositive ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'}`}>
            {isPositive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
            <span>{toPersianNum(Math.abs(change))}٪</span>
          </div>
        )}
      </div>
      <div className="text-lg font-extrabold text-gray-900 mb-0.5">{value}</div>
      <div className="text-xs text-gray-500 font-medium">{label}</div>
      {subtitle && <div className="text-[11px] text-gray-400 mt-1">{subtitle}</div>}
    </div>
  );
}

// ==================== HORIZONTAL BAR ====================
function HBar({ value, max, color, label, showValue }: { value: number; max: number; color: string; label: string; showValue?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs text-gray-600 w-24 truncate font-medium">{label}</span>
      <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${pct}%`, background: color, minWidth: pct > 0 ? '8px' : '0' }} />
      </div>
      <span className="text-xs font-bold text-gray-700 w-14 text-left">{showValue || toPersianNum(pct) + '٪'}</span>
    </div>
  );
}

// ==================== MINI DONUT ====================
function MiniDonut({ value, max, color, label, size = 80 }: { value: number; max: number; color: string; label: string; size?: number }) {
  const pct = Math.min(max > 0 ? Math.round((value / max) * 100) : 0, 100);
  const r = (size - 12) / 2;
  const circumference = 2 * Math.PI * r;
  const strokeDasharray = `${(pct / 100) * circumference} ${circumference}`;
  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg className="w-full h-full -rotate-90" viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f3f4f6" strokeWidth="8" />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
            strokeDasharray={strokeDasharray} className="transition-all duration-1000" />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm font-extrabold text-gray-900">{toPersianNum(pct)}٪</span>
        </div>
      </div>
      <span className="text-[11px] text-gray-500 font-medium mt-1.5">{label}</span>
    </div>
  );
}

// ==================== RANK BADGE ====================
function RankBadge({ rank }: { rank: number }) {
  const colors = ['#f59e0b', '#94a3b8', '#cd7f32'];
  const icons = [<Award size={12} key="g" />, <Shield size={12} key="s" />, <Star size={12} key="b" />];
  if (rank <= 3) {
    return (
      <div className="w-6 h-6 rounded-full flex items-center justify-center text-white" style={{ background: colors[rank - 1] }}>
        {icons[rank - 1]}
      </div>
    );
  }
  return <span className="text-xs text-gray-400 font-bold">{toPersianNum(rank)}</span>;
}

// ==================== SECTION SHELL ====================
// v2.51.0 (r76): `iconBg` was declared `string` while EVERY caller passes
// {bg,color} — 10 tsc errors shipped in v2.50.0 (r75 QA ran eslint+dev only,
// never `next build`; setup.bat enforces the build gate, so the package
// would have failed on the user's machine). Type now matches the call sites.
function SectionCard({ title, subtitle, icon, iconBg, children, testId }: {
  title: string; subtitle?: string; icon: React.ReactNode; iconBg: { bg: string; color: string }; children: React.ReactNode; testId?: string;
}) {
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100" data-testid={testId}>
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: iconBg.bg, color: iconBg.color }}>
          {icon}
        </div>
        <div>
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
          {subtitle && <p className="text-[11px] text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

// ==================== MAIN COMPONENT ====================
/**
 * v2.50.0 (round 75) — داشبورد گزارشی قوی هلدینگ.
 * «دسترسی مدیر هلدینگ باید داشبورد قوی از بحث انواع گزارشات داشته باشد»:
 * the single oversight dashboard is now a TABBED reporting cockpit over the
 * REAL /api/reports aggregates (sales / finance / pipeline / staff / ops),
 * with a per-user customizable tab layout persisted in Meta
 * (holding_dashboard.<userId>) — the admin-level «سفارشی‌سازی» capability.
 */
export default function HoldingDashboard() {
  const [timeRange, setTimeRange] = useState<'7m' | '3m' | '1m'>('7m');
  // ── Real data: company list + per-company stats (admin holding view) ──
  const [companies, setCompanies] = useState<CompanyCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [, setLoadError] = useState<string | null>(null); // error surfaced via child states
  // v2.25.0 — the REAL monthly trend (approved invoices per Jalali month).
  const [trend, setTrend] = useState<TrendMonth[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  // ── v2.50.0 — tab layout (customizable, per-user, Meta-persisted) ──
  const [savedTabs, setSavedTabs] = useState<HoldingTab[] | null>(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draft, setDraft] = useState<HoldingTab[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);
  const visibleKeys = visibleHoldingTabKeys(savedTabs);
  const [activeTab, setActiveTab] = useState<HoldingTabKey>('overview');
  useEffect(() => {
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeTab)) {
      setActiveTab(visibleKeys[0]);
    }
  }, [visibleKeys, activeTab]);

  // ── v2.50.0 — lazy per-tab report cache ──
  const [reportCache, setReportCache] = useState<Partial<Record<HoldingTabKey, unknown>>>({});
  const [reportLoading, setReportLoading] = useState<Partial<Record<HoldingTabKey, boolean>>>({});
  const [reportError, setReportError] = useState<Partial<Record<HoldingTabKey, string>>>({});

  const monthsCount = timeRange === '7m' ? 7 : timeRange === '3m' ? 3 : 1;

  useEffect(() => {
    let cancelled = false;
    const loadAll = async () => {
      setLoading(true);
      try {
        const compRes = await fetch('/api/companies');
        const compData = await compRes.json();
        if (!compRes.ok) throw new Error(compData.error || 'خطا در دریافت شرکت‌ها');
        const comps: Array<{ id: string; slug: string; name: string; type: string; color: string; accentColor: string; centerCount: number; followupCount: number }> = compData;

        const withStats = await Promise.all(comps.map(async (c) => {
          try {
            const sRes = await fetch(`/api/stats?company=${c.slug}`);
            const sData = await sRes.json();
            return sRes.ok ? { ...c, stats: sData } : { ...c, stats: null };
          } catch {
            return { ...c, stats: null };
          }
        }));
        if (!cancelled) {
          setCompanies(withStats);
          setLastRefresh(new Date());
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'خطا در دریافت داده‌ها');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadAll();
    // v2.25.0 — «به‌روزرسانی خودکار» is REAL: a 60s interval re-fetches
    // the whole dashboard (the badge previously advertised auto-refresh
    // that never existed).
    const timer = setInterval(() => { void loadAll(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  // v2.25.0 — real trend series from approved invoices, re-fetched when the
  // time-range selector changes (the selector was decorative before).
  useEffect(() => {
    let cancelled = false;
    const loadTrend = async () => {
      try {
        const res = await fetch(`/api/stats?trend=1&months=${monthsCount}`);
        const data = await res.json();
        if (!cancelled && res.ok) setTrend(data.months || []);
      } catch { /* keep the last good series */ }
    };
    void loadTrend();
    const timer = setInterval(() => { void loadTrend(); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [monthsCount]);

  // ── v2.50.0 — load the per-user tab layout (holding scope) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/dashboard?scope=holding');
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data.tabs)) setSavedTabs(data.tabs);
      } catch { /* defaults — layout is an enhancement, never a blocker */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── v2.50.0 — lazy fetch of the active tab's report ──
  const fetchReport = useCallback(async (action: string, body: Record<string, unknown> = {}): Promise<unknown> => {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'خطا در دریافت گزارش');
    return data;
  }, []);

  const loadReport = useCallback(async (tab: HoldingTabKey, force = false) => {
    if (tab === 'overview') return;
    if (!force && reportCache[tab] !== undefined) return;
    setReportLoading((p) => ({ ...p, [tab]: true }));
    setReportError((p) => ({ ...p, [tab]: undefined }));
    try {
      let payload: unknown;
      if (tab === 'sales') {
        payload = (await fetchReport('top-centers', { limit: 10 })) as TopCentersData;
      } else if (tab === 'finance') {
        payload = (await fetchReport('finance-summary')) as FinanceData;
      } else if (tab === 'pipeline') {
        payload = (await fetchReport('pipeline-summary')) as PipelineData;
      } else if (tab === 'staff') {
        payload = (await fetchReport('staff-performance')) as StaffData;
      } else {
        const [production, shipment] = await Promise.all([
          fetchReport('production-summary') as Promise<ProductionData>,
          fetchReport('shipment-summary') as Promise<ShipmentData>,
        ]);
        payload = { production, shipment } as OpsData;
      }
      setReportCache((p) => ({ ...p, [tab]: payload }));
    } catch (e) {
      setReportError((p) => ({ ...p, [tab]: e instanceof Error ? e.message : 'خطا در دریافت گزارش' }));
    } finally {
      setReportLoading((p) => ({ ...p, [tab]: false }));
    }
  }, [reportCache, fetchReport]);

  useEffect(() => { void loadReport(activeTab); }, [activeTab, loadReport]);

  const refreshAll = useCallback(() => {
    if (activeTab === 'overview') {
      // v2.50.0 — manual refresh re-fetches BOTH overview datasets
      // (companies+stats and the trend series).
      (async () => {
        try {
          const compRes = await fetch('/api/companies');
          if (compRes.ok) {
            const comps = await compRes.json();
            const withStats = await Promise.all((comps as Array<Record<string, unknown>>).map(async (c) => {
              try {
                const sRes = await fetch(`/api/stats?company=${c.slug}`);
                const sData = await sRes.json();
                return sRes.ok ? { ...c, stats: sData } : { ...c, stats: null };
              } catch {
                return { ...c, stats: null };
              }
            }));
            setCompanies(withStats as CompanyCard[]);
            setLastRefresh(new Date());
          }
        } catch { /* keep the last good data */ }
        try {
          const r = await fetch(`/api/stats?trend=1&months=${monthsCount}`);
          if (r.ok) setTrend((await r.json()).months || []);
        } catch { /* keep the last good series */ }
      })();
    } else {
      void loadReport(activeTab, true);
    }
  }, [activeTab, loadReport, monthsCount]);

  // ── Customization save / reset ──
  const openCustomize = () => {
    const resolved = savedTabs ?? HOLDING_TAB_CATALOG.map((t) => ({ key: t.key, visible: true }));
    setDraft(resolved);
    setCustomizeOpen(true);
  };
  const saveLayout = async () => {
    setSavingLayout(true);
    try {
      const res = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', scope: 'holding', tabs: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیرهٔ چیدمان');
      setSavedTabs(data.tabs);
      setCustomizeOpen(false);
      toast.success('چیدمان داشبورد هلدینگ ذخیره شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ذخیرهٔ چیدمان');
    } finally {
      setSavingLayout(false);
    }
  };
  const resetLayout = async () => {
    setSavingLayout(true);
    try {
      const res = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset', scope: 'holding' }),
      });
      if (!res.ok) throw new Error('خطا در بازنشانی چیدمان');
      setSavedTabs(null);
      setCustomizeOpen(false);
      toast.success('چیدمان به حالت پیش‌فرض بازگشت');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در بازنشانی');
    } finally {
      setSavingLayout(false);
    }
  };
  const moveDraft = (idx: number, dir: -1 | 1) => {
    setDraft((p) => {
      const next = [...p];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return p;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  // ── Derived aggregates (overview) ──
  const totalSales = companies.reduce((s, c) => s + (c.stats?.salesAmount || 0), 0);
  const totalCenters = companies.reduce((s, c) => s + (c.stats?.centersCount || c.centerCount || 0), 0);
  const totalOverdue = companies.reduce((s, c) => s + (c.followupCount || 0), 0);
  const ranked = [...companies].sort((a, b) => (b.stats?.salesAmount || 0) - (a.stats?.salesAmount || 0));
  const maxTrend = Math.max(...trend.map((m) => m.total), 1);
  const trendCompanies = companies.filter((c) => c.slug !== 'holding');

  // Real alerts derived from per-company stats (no fabricated warnings)
  const realAlerts = companies
    .filter((c) => c.stats && c.stats.followupsCount > 0)
    .map((c) => ({
      id: c.slug,
      type: 'warning' as const,
      company: c.name,
      message: `${c.stats!.followupsCount} پیگیری فعال در جریان است`,
      icon: <Clock size={16} />,
      time: 'اکنون',
    }));

  // Sales share for pie (real amounts from stats)
  const salesShare = companies.map((c) => ({
    name: c.name.replace('شرکت ', ''),
    value: totalSales > 0 ? Math.round((c.stats?.salesAmount || 0) / totalSales * 100) : 0,
    color: c.accentColor,
  }));

  return (
    <div className="space-y-5 animate-fade-in" data-testid="holding-dashboard">
      {/* ===== HEADER ===== */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-extrabold text-gray-900">داشبورد گزارشی هلدینگ</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            نمای نظارتی عملکرد گروه شرکت‌های هلدینگ بهبود گستر (BGL) · {toPersianNum(companies.length)} شرکت
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* v2.50.0 — per-user tab layout customization (admin capability) */}
          <div className="relative">
            <button
              onClick={openCustomize}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-gray-200 bg-white text-xs font-bold text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
              title="سفارشی‌سازی بخش‌های داشبورد"
              data-testid="holding-customize-btn"
            >
              <Settings2 size={14} />
              سفارشی‌سازی
            </button>
            {customizeOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setCustomizeOpen(false)} />
                <div className="absolute top-full mt-2 left-0 z-50 w-80 bg-white rounded-2xl border border-gray-200 shadow-xl p-4" data-testid="holding-customize-panel">
                  <div className="flex items-center justify-between mb-1">
                    <h4 className="text-sm font-extrabold text-gray-900">سفارشی‌سازی داشبورد</h4>
                    <button onClick={() => setCustomizeOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
                  </div>
                  <p className="text-[11px] text-gray-400 leading-5 mb-3">
                    ترتیب و نمایانیِ بخش‌های گزارشی خودتان را تنظیم کنید. این چیدمان شخصی شماست و برای سایر مدیران تغییر نمی‌کند.
                  </p>
                  <div className="space-y-1.5 max-h-72 overflow-y-auto pl-1">
                    {draft.map((t, idx) => {
                      const meta = HOLDING_TAB_CATALOG.find((m) => m.key === t.key);
                      return (
                        <div key={t.key} className="flex items-center gap-2 rounded-xl border border-gray-100 p-2 hover:border-gray-200 transition-colors">
                          <button
                            onClick={() => setDraft((p) => p.map((x, i) => (i === idx ? { ...x, visible: !x.visible } : x)))}
                            className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 transition-colors ${t.visible ? 'bg-teal-600 text-white' : 'bg-gray-100 text-gray-400'}`}
                            title={t.visible ? 'پنهان کردن' : 'نمایش'}
                          >
                            {t.visible ? <Check size={13} /> : <X size={13} />}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-bold text-gray-800 truncate">{meta?.title ?? t.key}</div>
                            <div className="text-[10px] text-gray-400 truncate">{meta?.desc}</div>
                          </div>
                          <div className="flex flex-col gap-0.5">
                            <button onClick={() => moveDraft(idx, -1)} disabled={idx === 0} className="text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronUp size={13} /></button>
                            <button onClick={() => moveDraft(idx, 1)} disabled={idx === draft.length - 1} className="text-gray-400 hover:text-gray-700 disabled:opacity-30"><ChevronDown size={13} /></button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-100">
                    <button
                      onClick={saveLayout}
                      disabled={savingLayout || draft.every((t) => !t.visible)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white text-xs font-bold transition-colors"
                    >
                      {savingLayout ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
                      ذخیرهٔ چیدمان
                    </button>
                    <button
                      onClick={resetLayout}
                      disabled={savingLayout}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-gray-600 hover:bg-gray-50 text-xs font-bold transition-colors disabled:opacity-50"
                    >
                      <RotateCcw size={13} />
                      پیش‌فرض
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          {/* Time range selector (drives the trend series) */}
          <div className="flex rounded-xl border border-gray-200 bg-gray-50 p-0.5">
            {([['7m', '۷ ماه'], ['3m', '۳ ماه'], ['1m', '۱ ماه']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTimeRange(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-200 ${timeRange === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {l}
              </button>
            ))}
          </div>
          <button
            onClick={refreshAll}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-medium hover:bg-emerald-100 transition-colors"
            title={lastRefresh ? `آخرین به‌روزرسانی: ${lastRefresh.toLocaleTimeString('fa-IR')}` : 'در انتظار اولین دریافت'}
            data-testid="holding-refresh-btn"
          >
            <RefreshCw size={12} />
            به‌روزرسانی
          </button>
        </div>
      </div>

      {/* ===== v2.50.0 — TAB BAR (customizable order/visibility) ===== */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1" data-testid="holding-dash-tabs">
        {visibleKeys.map((key) => {
          const meta = HOLDING_TAB_CATALOG.find((m) => m.key === key);
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              data-testid={`holding-tab-${key}`}
              className={`px-4 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all duration-200 border ${
                isActive
                  ? 'bg-gray-900 text-white border-gray-900 shadow-sm'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              {meta?.title ?? key}
            </button>
          );
        })}
      </div>

      {/* ===== TAB CONTENT ===== */}
      {activeTab === 'overview' && (
        <div className="space-y-5">
          {/* KPI ROW */}
          <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-3">
            <KpiCard icon={<BarChart3 size={18} />} label="فروش کل گروه" value={formatCurrency(totalSales)} color="#1F8B7D" delay={0} subtitle="مجموع فروش ثبت‌شده" />
            <KpiCard icon={<Building2 size={18} />} label="مراکز فعال" value={toPersianNum(totalCenters)} color="#2980B9" delay={120} subtitle={`${toPersianNum(companies.length)} شرکت`} />
            <KpiCard icon={<Activity size={18} />} label="پیش‌فاکتورهای باز" value={toPersianNum(companies.reduce((s, c) => s + (c.stats?.proformasCount || 0), 0))} color="#6366f1" delay={240} subtitle="در انتظار تکمیل" />
            <KpiCard icon={<AlertTriangle size={18} />} label="پیگیری فعال" value={toPersianNum(totalOverdue)} color="#dc2626" delay={360} subtitle="در جریان گروه" />
            {loading && <KpiCard icon={<RefreshCw size={18} />} label="در حال دریافت" value="..." color="#94a3b8" delay={420} subtitle="داده‌های لحظه‌ای" />}
          </div>

          {/* CHART + PIE + ALERTS */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Monthly Trend Chart - Stacked */}
            <div className="lg:col-span-5 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">روند فروش ماهانه</h3>
                  <p className="text-[11px] text-gray-400 mt-0.5">مقایسه عملکرد شرکت‌ها (میلیارد ریال)</p>
                </div>
              </div>
              {/* Legend — v2.26.2: wraps on ≤320px (5 items × gap-4 overflowed
                  the card by 7px and pushed the whole document wider). */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
                {companies.map((c) => (
                  <div key={c.slug} className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ background: c.accentColor }} />
                    <span className="text-[11px] text-gray-500">{c.name.replace('شرکت ', '')}</span>
                  </div>
                ))}
                <div className="flex items-center gap-1.5">
                  <div className="w-2.5 h-2.5 rounded-sm bg-gray-800" />
                  <span className="text-[11px] text-gray-500">جمع کل</span>
                </div>
              </div>
              <div className="flex items-end justify-between gap-1.5 h-48 px-1">
                {trend.map((m) => {
                  // Display unit: میلیارد ریال (the chart's stated unit)
                  const totalB = m.total / 1e9;
                  return (
                    <div key={m.key} className="flex flex-col items-center gap-1 flex-1">
                      <span className="text-[11px] font-bold text-gray-600">{toPersianNum(totalB > 0 ? Number(totalB.toFixed(1)) : 0)}</span>
                      <div className="w-full flex flex-col gap-[1px]" style={{ height: `${maxTrend > 0 ? (m.total / maxTrend) * 100 : 0}%`, minHeight: m.total > 0 ? '10px' : '2px' }}>
                        {trendCompanies.map((c) => {
                          const v = m.companies?.[c.slug] || 0;
                          return v > 0
                            ? <div key={c.slug} className="w-full" style={{ flex: v, background: c.accentColor, opacity: 0.85 }} />
                            : null;
                        })}
                      </div>
                      <span className="text-[11px] text-gray-400 font-medium">{m.label}</span>
                    </div>
                  );
                })}
                {trend.length === 0 && (
                  <div className="flex items-center justify-center h-full text-[11px] text-gray-400">هنوز فاکتور تأییدشده‌ای ثبت نشده است</div>
                )}
              </div>
            </div>

            {/* Sales Share Pie */}
            <div className="lg:col-span-3 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <h3 className="text-sm font-bold text-gray-900 mb-1">سهم فروش شرکت‌ها</h3>
              <p className="text-[11px] text-gray-400 mb-4">توزیع درآمد گروه</p>
              <div className="flex justify-center mb-4">
                <div className="relative w-36 h-36">
                  <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                    {(() => {
                      const circumference = 2 * Math.PI * 48;
                      return salesShare.map((s, i) => {
                        const dashLength = (s.value / 100) * circumference;
                        const gap = circumference - dashLength;
                        // Segment offset = sum of previous segments' lengths —
                        // computed purely from data, no mutable accumulator
                        // (react-hooks/immutability).
                        const offset = salesShare
                          .slice(0, i)
                          .reduce((acc, prev) => acc + (prev.value / 100) * circumference, 0);
                        return (
                          <circle key={i} cx="60" cy="60" r="48" fill="none"
                            stroke={s.color} strokeWidth="18"
                            strokeDasharray={`${dashLength} ${gap}`}
                            strokeDashoffset={`${-offset}`}
                            className="transition-all duration-1000"
                          />
                        );
                      });
                    })()}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <span className="text-lg font-extrabold text-gray-900">{toPersianNum(100)}٪</span>
                    <span className="text-[11px] text-gray-400">مجموع</span>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {salesShare.map((s, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                      <span className="text-xs text-gray-700 font-medium">{s.name}</span>
                    </div>
                    <span className="text-xs font-bold text-gray-900">{toPersianNum(s.value)}٪</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Alerts Panel */}
            <div className="lg:col-span-4 bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
                    <AlertTriangle size={16} className="text-red-600" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-gray-900">هشدارها</h3>
                    <p className="text-[11px] text-gray-400">موارد نیازمند توجه مدیریت</p>
                  </div>
                </div>
                <span className="text-[11px] font-bold text-red-600 bg-red-50 px-2 py-0.5 rounded-full">{toPersianNum(realAlerts.length)} مورد</span>
              </div>
              <div className="space-y-2 max-h-[320px] overflow-y-auto">
                {realAlerts.map((alert) => {
                  const style = ALERT_STYLES[alert.type] || ALERT_STYLES.info;
                  return (
                    <div key={alert.id} className="rounded-xl p-2.5 border transition-colors hover:shadow-sm cursor-pointer" style={{ background: style.bg, borderColor: style.border }}>
                      <div className="flex items-start gap-2">
                        <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 mt-0.5" style={{ background: style.iconBg, color: style.iconColor }}>
                          {alert.icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="text-[11px] font-bold" style={{ color: style.iconColor }}>{alert.company}</span>
                            <span className="text-[11px] text-gray-400">· {alert.time}</span>
                          </div>
                          <p className="text-[11px] text-gray-700 leading-4">{alert.message}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {realAlerts.length === 0 && (
                  <div className="flex items-center justify-center py-8 text-[11px] text-gray-400">هیچ هشدار فعالی وجود ندارد</div>
                )}
              </div>
            </div>
          </div>

          {/* COMPANY COMPARISON TABLE (Full) */}
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100" data-testid="holding-compare-table">
            <SectionHeader
              icon={<PieChart size={16} className="text-indigo-600" />}
              bg="bg-indigo-50"
              title="مقایسه جامع عملکرد شرکت‌ها"
              subtitle="شاخص‌های کلیدی عملکرد (KPI) هر شرکت · رتبه‌بندی شده"
            />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-gray-100">
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">رتبه</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">شرکت</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">فروش (میلیارد)</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">سهم گروه</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">پیش‌فاکتور باز</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">مراکز</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">پیگیری فعال</th>
                  </tr>
                </thead>
                <tbody>
                  {ranked.map((c, i) => {
                    const rank = i + 1;
                    const sales = c.stats?.salesAmount || 0;
                    const centers = c.stats?.centersCount || c.centerCount || 0;
                    const proformas = c.stats?.proformasCount || 0;
                    const share = totalSales > 0 ? Math.round((sales / totalSales) * 100) : 0;
                    return (
                      <tr key={c.slug} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0" style={{ animationDelay: `${i * 80}ms` }}>
                        <td className="py-3 px-2"><RankBadge rank={rank} /></td>
                        <td className="py-3 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: `${c.accentColor}12`, color: c.accentColor }}>
                              {c.slug === 'bazargani' ? <Briefcase size={12} /> : c.slug === 'aria' ? <Heart size={12} /> : <Star size={12} />}
                            </div>
                            <div>
                              <p className="font-bold text-gray-900 text-xs">{c.name}</p>
                              <p className="text-[11px] text-gray-400">{c.type}</p>
                            </div>
                          </div>
                        </td>
                        <td className="py-3 px-2 font-extrabold text-gray-900 text-xs text-right" dir="ltr">{toPersianNum((sales / 1e9).toFixed(1))}</td>
                        <td className="py-3 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${share}%`, background: c.accentColor }} />
                            </div>
                            <span className="text-[11px] font-bold text-gray-600">{toPersianNum(share)}٪</span>
                          </div>
                        </td>
                        <td className="py-3 px-2 text-xs text-gray-700 font-bold">{toPersianNum(proformas)}</td>
                        <td className="py-3 px-2 text-xs text-gray-700 font-bold">{toPersianNum(centers)}</td>
                        <td className="py-3 px-2">
                          <span className="text-[11px] font-bold text-gray-600">{toPersianNum(c.followupCount || 0)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* TARGET DONUTS + SUMMARY + MONTHLY GROWTH */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Target Progress */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center">
                  <Target size={16} className="text-teal-600" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900">سهم شرکت‌ها از فروش</h3>
                  <p className="text-[11px] text-gray-400">نسبت فروش هر شرکت به کل گروه</p>
                </div>
              </div>
              <div className="flex flex-wrap justify-center gap-3 sm:gap-6 mb-4">
                {companies.map((c) => {
                  const sales = c.stats?.salesAmount || 0;
                  return <MiniDonut key={c.slug} value={sales} max={Math.max(totalSales, 1)} color={c.accentColor} label={c.name.replace('شرکت ', '')} size={72} />;
                })}
              </div>
              <div className="space-y-3">
                {companies.map((c) => {
                  const sales = c.stats?.salesAmount || 0;
                  const pct = totalSales > 0 ? Math.round((sales / totalSales) * 100) : 0;
                  return (
                    <div key={c.slug}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-gray-700">{c.name}</span>
                        <span className="text-[11px] text-gray-400">{formatCurrency(sales)}</span>
                      </div>
                      <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${c.accentColor}, ${c.accentColor}aa)` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Centers + summary */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                  <CreditCard size={16} className="text-amber-600" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900">مراکز و معاملات</h3>
                  <p className="text-[11px] text-gray-400">توزیع مراکز و خلاصهٔ گروه</p>
                </div>
              </div>
              <div className="space-y-3 mb-4">
                {companies.map((c) => (
                  <HBar key={c.slug} value={c.stats?.centersCount || c.centerCount || 0} max={Math.max(...companies.map((x) => x.stats?.centersCount || x.centerCount || 0), 1)} color={c.accentColor} label={c.name.replace('شرکت ', '')} />
                ))}
              </div>
              <div className="border-t border-gray-100 pt-4">
                <h4 className="text-[11px] font-bold text-gray-600 mb-3">خلاصه معاملات گروه</h4>
                <div className="grid grid-cols-3 gap-2">
                  <div className="text-center p-2.5 rounded-xl bg-emerald-50 border border-emerald-100">
                    <div className="text-base font-extrabold text-emerald-700">{toPersianNum(companies.reduce((s, c) => s + (c.stats?.proformasCount || 0), 0))}</div>
                    <div className="text-[11px] text-emerald-600 font-medium">پیش‌فاکتور باز</div>
                  </div>
                  <div className="text-center p-2.5 rounded-xl bg-red-50 border border-red-100">
                    <div className="text-base font-extrabold text-red-700">{toPersianNum(totalOverdue)}</div>
                    <div className="text-[11px] text-red-600 font-medium">پیگیری فعال</div>
                  </div>
                  <div className="text-center p-2.5 rounded-xl bg-blue-50 border border-blue-100">
                    <div className="text-base font-extrabold text-blue-700">{toPersianNum(totalCenters)}</div>
                    <div className="text-[11px] text-blue-600 font-medium">مراکز فعال</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Monthly Growth Rate */}
            <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <TrendingUp size={16} className="text-emerald-600" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-900">نرخ رشد ماهانه</h3>
                  <p className="text-[11px] text-gray-400">تغییرات فروش نسبت به ماه قبل (٪)</p>
                </div>
              </div>
              <div className="space-y-3">
                {trend.slice(1).map((m, i) => {
                  const prev = trend[i].total;
                  const growth = prev > 0 ? Math.round(((m.total - prev) / prev) * 100) : 0;
                  return (
                    <div key={m.key} className="flex items-center gap-3">
                      <span className="text-[11px] text-gray-500 w-16 font-medium">{m.label}</span>
                      <div className="flex-1 flex items-center gap-2">
                        <div className="flex-1 h-5 bg-gray-50 rounded-full overflow-hidden relative">
                          <div className="h-full rounded-full transition-all duration-700" style={{
                            width: `${Math.min(Math.abs(growth) * 3, 100)}%`,
                            background: growth >= 0 ? '#059669' : '#dc2626',
                            marginLeft: growth < 0 ? 'auto' : '0',
                            marginRight: growth < 0 ? '0' : 'auto',
                          }} />
                        </div>
                        <span className={`text-xs font-bold w-14 text-left ${growth >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                          {growth >= 0 ? '+' : ''}{toPersianNum(growth)}٪
                        </span>
                      </div>
                    </div>
                  );
                })}
                {trend.length < 2 && (
                  <div className="text-[11px] text-gray-400">برای محاسبهٔ رشد ماهانه حداقل دو ماه داده لازم است</div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== TAB: SALES ===== */}
      {activeTab === 'sales' && (
        <TabReportShell loading={!!reportLoading.sales} error={reportError.sales} onRetry={() => void loadReport('sales', true)}>
          {/* Monthly sales table by company — REAL trend data */}
          <SectionCard
            title="فروش ماهانه به تفکیک شرکت"
            subtitle={`${trend.length > 0 ? `از ${trend[0].label} تا ${trend[trend.length - 1].label}` : '—'} · مبنا: فاکتورهای تأییدشده`}
            icon={<BarChart3 size={16} className="text-teal-600" />}
            iconBg={{ bg: '#f0fdfa', color: '#0d9488' }}
            testId="holding-sales-monthly"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-gray-100">
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">ماه</th>
                    {trendCompanies.map((c) => (
                      <th key={c.slug} className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">{c.name.replace('شرکت ', '')}</th>
                    ))}
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">جمع گروه</th>
                  </tr>
                </thead>
                <tbody>
                  {trend.map((m) => (
                    <tr key={m.key} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                      <td className="py-2.5 px-2 font-bold text-gray-800 text-xs">{m.label}</td>
                      {trendCompanies.map((c) => {
                        const v = m.companies?.[c.slug] || 0;
                        return (
                          <td key={c.slug} className="py-2.5 px-2 text-center text-xs text-gray-700" dir="ltr">
                            {v > 0 ? toPersianNum((v / 1e6).toFixed(1)) + ' م' : '—'}
                          </td>
                        );
                      })}
                      <td className="py-2.5 px-2 text-center text-xs font-extrabold text-gray-900" dir="ltr">
                        {m.total > 0 ? toPersianNum((m.total / 1e6).toFixed(1)) + ' م' : '—'}
                      </td>
                    </tr>
                  ))}
                  {trend.length > 0 && (
                    <tr className="border-t-2 border-gray-100 bg-gray-50/50">
                      <td className="py-2.5 px-2 font-extrabold text-gray-900 text-xs">جمع دوره</td>
                      {trendCompanies.map((c) => {
                        const v = trend.reduce((s, m) => s + (m.companies?.[c.slug] || 0), 0);
                        return (
                          <td key={c.slug} className="py-2.5 px-2 text-center text-xs font-bold text-gray-800" dir="ltr">
                            {v > 0 ? toPersianNum((v / 1e6).toFixed(1)) + ' م' : '—'}
                          </td>
                        );
                      })}
                      <td className="py-2.5 px-2 text-center text-xs font-extrabold text-teal-700" dir="ltr">
                        {toPersianNum((trend.reduce((s, m) => s + m.total, 0) / 1e6).toFixed(1)) + ' م'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {trend.length === 0 && <EmptyHint text="هنوز فاکتور تأییدشده‌ای در این بازه ثبت نشده است" />}
            </div>
          </SectionCard>

          {/* Top centers — REAL /api/reports top-centers */}
          <SectionCard
            title="برترین مراکز خرید"
            subtitle={`پرمصرف‌ترین مراکز بر اساس مبلغ اسناد تأییدشده (سال جاری)`}
            icon={<Building2 size={16} className="text-blue-600" />}
            iconBg={{ bg: '#eff6ff', color: '#2563eb' }}
            testId="holding-sales-top-centers"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-gray-100">
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">رتبه</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">مرکز</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">استان</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">تعداد سند</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">مبلغ کل</th>
                  </tr>
                </thead>
                <tbody>
                  {(reportCache.sales as TopCentersData | undefined)?.chartData.map((c, i) => (
                    <tr key={c.centerId || i} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                      <td className="py-2.5 px-2"><RankBadge rank={i + 1} /></td>
                      <td className="py-2.5 px-2 font-bold text-gray-800 text-xs">{c.centerName}</td>
                      <td className="py-2.5 px-2 text-xs text-gray-500">{c.province || '—'}</td>
                      <td className="py-2.5 px-2 text-center text-xs font-bold text-gray-700">{toPersianNum(c.documentCount)}</td>
                      <td className="py-2.5 px-2 text-center text-xs font-extrabold text-gray-900">{formatCurrency(c.totalSales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!(reportCache.sales as TopCentersData | undefined)?.chartData?.length && !reportLoading.sales && (
                <EmptyHint text="در سال جاری سند تأییدشده‌ای ثبت نشده است" />
              )}
            </div>
          </SectionCard>
        </TabReportShell>
      )}

      {/* ===== TAB: FINANCE ===== */}
      {activeTab === 'finance' && (
        <TabReportShell loading={!!reportLoading.finance} error={reportError.finance} onRetry={() => void loadReport('finance', true)}>
          {(() => {
            const fin = reportCache.finance as FinanceData | undefined;
            return (
              <div className="space-y-5">
                {/* KPI row */}
                <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
                  <KpiCard icon={<Wallet size={18} />} label="طلب باز (مطالبات)" value={fin ? formatCurrency(fin.kpis.receivables) : '...'} color="#dc2626" delay={0} subtitle="فاکتورهای صادرشدهٔ تسویه‌نشده" />
                  <KpiCard icon={<Landmark size={18} />} label="وصول‌شده" value={fin ? formatCurrency(fin.kpis.collected) : '...'} color="#059669" delay={100} subtitle="کل پرداخت‌های ثبت‌شده" />
                  <KpiCard icon={<TrendingUp size={18} />} label="نرخ وصول" value={fin ? `${toPersianNum(fin.kpis.collectionRatio)}٪` : '...'} color="#1F8B7D" delay={200} subtitle="وصولی به کل تعهدات" />
                  <KpiCard icon={<Timer size={18} />} label="میانگین زمان وصول" value={fin ? `${toPersianNum(fin.kpis.avgCollectionDays)} روز` : '...'} color="#d97706" delay={300} subtitle="از صدور تا تسویه" />
                  <KpiCard icon={<CreditCard size={18} />} label="چک‌های در جریان" value={fin ? formatCurrency(fin.kpis.pendingChecks) : '...'} color="#6366f1" delay={400} subtitle={fin ? `${toPersianNum(fin.kpis.pendingChecksCount)} فقره سررسید آینده` : ''} />
                  <KpiCard icon={<Check size={18} />} label="چک‌های تسویه‌شده" value={fin ? formatCurrency(fin.kpis.clearedChecks) : '...'} color="#2980B9" delay={500} subtitle="چک‌های سررسیدگذشته" />
                  <KpiCard icon={<BarChart3 size={18} />} label="کل تعهدات مالی" value={fin ? formatCurrency(fin.kpis.receivables + fin.kpis.collected) : '...'} color="#94a3b8" delay={600} subtitle="طلب باز + وصول‌شده" />
                </div>

                {/* Monthly collected chart */}
                <SectionCard
                  title="روند وصولی ماهانه"
                  subtitle="پرداخت‌های ثبت‌شده در ماه‌های سال جاری (شمسی)"
                  icon={<Activity size={16} className="text-emerald-600" />}
                  iconBg={{ bg: '#ecfdf5', color: '#059669' }}
                  testId="holding-finance-monthly"
                >
                  <div className="flex items-end justify-between gap-1.5 h-44 px-1">
                    {fin?.monthly.map((m) => {
                      const maxC = Math.max(...(fin?.monthly.map((x) => x.collected) || [0]), 1);
                      const h = m.collected > 0 ? Math.max((m.collected / maxC) * 100, 4) : 2;
                      return (
                        <div key={m.month} className="flex flex-col items-center gap-1 flex-1">
                          <span className="text-[10px] font-bold text-gray-600">{m.collected > 0 ? toPersianNum((m.collected / 1e6).toFixed(1)) + 'م' : ''}</span>
                          <div className="w-full rounded-t-lg bg-gradient-to-t from-emerald-600 to-emerald-400 transition-all duration-1000" style={{ height: `${h}%`, opacity: m.collected > 0 ? 1 : 0.15 }} />
                          <span className="text-[10px] text-gray-400 font-medium">{m.month}</span>
                        </div>
                      );
                    })}
                  </div>
                </SectionCard>
              </div>
            );
          })()}
        </TabReportShell>
      )}

      {/* ===== TAB: PIPELINE ===== */}
      {activeTab === 'pipeline' && (
        <TabReportShell loading={!!reportLoading.pipeline} error={reportError.pipeline} onRetry={() => void loadReport('pipeline', true)}>
          {(() => {
            const pipe = reportCache.pipeline as PipelineData | undefined;
            const funnel = (pipe?.stages || []).filter((s) => s.key !== 'cancelled');
            const maxStageCount = Math.max(...funnel.map((s) => s.count), 1);
            return (
              <div className="space-y-5">
                {/* KPI row */}
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <KpiCard icon={<Zap size={18} />} label="ارزش لولهٔ فروش" value={pipe ? formatCurrency(pipe.kpis.pipelineValue) : '...'} color="#6366f1" delay={0} subtitle="پیش‌فاکتورهای باز" />
                  <KpiCard icon={<BarChart3 size={18} />} label="کل فرصت‌ها" value={pipe ? toPersianNum(pipe.kpis.totalOpportunities) : '...'} color="#2980B9" delay={100} subtitle="همهٔ اسناد فروش" />
                  <KpiCard icon={<Check size={18} />} label="معاملات برده" value={pipe ? toPersianNum(pipe.kpis.wonCount) : '...'} color="#059669" delay={200} subtitle="فاکتورهای صادرشده" />
                  <KpiCard icon={<X size={18} />} label="معاملات باخته" value={pipe ? toPersianNum(pipe.kpis.lostCount) : '...'} color="#dc2626" delay={300} subtitle="اسناد لغو/ردشده" />
                  <KpiCard icon={<TrendingUp size={18} />} label="نرخ برد" value={pipe ? `${toPersianNum(pipe.kpis.winRate)}٪` : '...'} color="#1F8B7D" delay={400} subtitle="برد به کل بسته‌شده" />
                  <KpiCard icon={<Timer size={18} />} label="میانگین چرخهٔ معامله" value={pipe ? `${toPersianNum(pipe.kpis.avgCloseDays)} روز` : '...'} color="#d97706" delay={500} subtitle="از ثبت تا صدور فاکتور" />
                </div>

                {/* REAL funnel — replaces the v2.25 fabricated distribution */}
                <SectionCard
                  title="قیف مراحل فروش گروه"
                  subtitle="تعداد و مبلغ اسناد در هر مرحله — دادهٔ واقعی گزارش کاریز"
                  icon={<Zap size={16} className="text-violet-600" />}
                  iconBg={{ bg: '#f5f3ff', color: '#7c3aed' }}
                  testId="holding-pipeline-funnel"
                >
                  <div className="space-y-2.5">
                    {funnel.map((s) => {
                      const colors: Record<string, string> = { lead: '#6366f1', qualified: '#8b5cf6', proposal: '#2563eb', negotiation: '#d97706', proforma: '#0891b2', invoice: '#059669' };
                      const color = colors[s.key] || '#64748b';
                      const w = Math.max((s.count / maxStageCount) * 100, s.count > 0 ? 14 : 4);
                      return (
                        <div key={s.key} className="flex items-center gap-2.5">
                          <span className="text-[11px] text-gray-500 w-20 text-left font-medium">{s.label}</span>
                          <div className="flex-1 h-8 bg-gray-50 rounded-lg overflow-hidden relative">
                            <div className="h-full rounded-lg transition-all duration-1000 flex items-center justify-between px-2" style={{
                              width: `${w}%`,
                              background: `linear-gradient(90deg, ${color}20, ${color}70)`,
                            }}>
                              <span className="text-[11px] font-bold" style={{ color }}>{toPersianNum(s.count)} سند</span>
                              <span className="text-[10px] text-gray-600 font-medium" dir="ltr">{s.amount > 0 ? formatCurrency(s.amount) : ''}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* REAL stage-to-stage conversion from the report */}
                  {pipe?.conversion && pipe.conversion.length > 0 && (
                    <div className="border-t border-gray-100 pt-3 mt-2">
                      <h4 className="text-[11px] font-bold text-gray-500 mb-2">نرخ تبدیل مرحله‌ای (واقعی)</h4>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {pipe.conversion.map((cv, i) => (
                          <span key={i} className="text-[11px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-md font-bold" dir="rtl">
                            {cv.label} ← {toPersianNum(cv.value)}٪
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </SectionCard>
              </div>
            );
          })()}
        </TabReportShell>
      )}

      {/* ===== TAB: STAFF ===== */}
      {activeTab === 'staff' && (
        <TabReportShell loading={!!reportLoading.staff} error={reportError.staff} onRetry={() => void loadReport('staff', true)}>
          <SectionCard
            title="رتبه‌بندی عملکرد کارکنان فروش"
            subtitle="بر اساس فروش ثبت‌شده، نرخ برد و ارزش کاریز — کل گروه"
            icon={<Users size={16} className="text-orange-600" />}
            iconBg={{ bg: '#fff7ed', color: '#ea580c' }}
            testId="holding-staff-table"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-gray-100">
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">رتبه</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">کارشناس</th>
                    <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">عنوان</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">فروش</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">سفارشات</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">ارزش کاریز</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">نرخ برد</th>
                    <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">میانگین هر معامله</th>
                  </tr>
                </thead>
                <tbody>
                  {(reportCache.staff as StaffData | undefined)?.chartData.map((s, i) => (
                    <tr key={s.userId} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                      <td className="py-2.5 px-2"><RankBadge rank={i + 1} /></td>
                      <td className="py-2.5 px-2 font-bold text-gray-800 text-xs">{s.userName}</td>
                      <td className="py-2.5 px-2 text-[11px] text-gray-500">{s.role}</td>
                      <td className="py-2.5 px-2 text-center text-xs font-extrabold text-gray-900">{formatCurrency(s.sales)}</td>
                      <td className="py-2.5 px-2 text-center text-xs font-bold text-gray-700">{toPersianNum(s.orders)}</td>
                      <td className="py-2.5 px-2 text-center text-xs text-gray-600">{formatCurrency(s.pipeline)}</td>
                      <td className="py-2.5 px-2 text-center">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${s.winRate >= 50 ? 'text-emerald-700 bg-emerald-50' : 'text-amber-700 bg-amber-50'}`}>
                          {toPersianNum(s.winRate)}٪
                        </span>
                      </td>
                      <td className="py-2.5 px-2 text-center text-xs text-gray-600">{formatCurrency(s.avgDealSize)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!(reportCache.staff as StaffData | undefined)?.chartData?.length && !reportLoading.staff && (
                <EmptyHint text="هنوز سند فروشی توسط کارشناسان ثبت نشده است" />
              )}
            </div>
          </SectionCard>
        </TabReportShell>
      )}

      {/* ===== TAB: OPS (production + shipment) ===== */}
      {activeTab === 'ops' && (
        <TabReportShell loading={!!reportLoading.ops} error={reportError.ops} onRetry={() => void loadReport('ops', true)}>
          {(() => {
            const ops = reportCache.ops as OpsData | undefined;
            const ship = ops?.shipment;
            const prod = ops?.production;
            return (
              <div className="space-y-5">
                {/* Shipment KPIs */}
                <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                  <KpiCard icon={<Truck size={18} />} label="کل ارسال‌ها" value={ship ? toPersianNum(ship.kpis.total) : '...'} color="#2980B9" delay={0} subtitle="۱۲ ماه اخیر" />
                  <KpiCard icon={<RefreshCw size={18} />} label="در جریان" value={ship ? toPersianNum(ship.kpis.active) : '...'} color="#d97706" delay={100} subtitle="آماده‌سازی/در راه" />
                  <KpiCard icon={<Check size={18} />} label="تحویل‌شده" value={ship ? toPersianNum(ship.kpis.delivered) : '...'} color="#059669" delay={200} subtitle="تحویل به مقصد" />
                  <KpiCard icon={<RotateCcw size={18} />} label="برگشتی" value={ship ? `${toPersianNum(ship.kpis.returned)} (${toPersianNum(ship.kpis.returnRate)}٪)` : '...'} color="#dc2626" delay={300} subtitle="نرخ برگشت" />
                  <KpiCard icon={<Timer size={18} />} label="میانگین زمان تحویل" value={ship ? `${toPersianNum(ship.kpis.avgDeliveryDays)} روز` : '...'} color="#6366f1" delay={400} subtitle="از ارسال تا تحویل" />
                  <KpiCard icon={<Factory size={18} />} label="سفارشات تولید" value={prod ? toPersianNum(prod.orders.reduce((s, o) => s + o.count, 0)) : '...'} color="#1F8B7D" delay={500} subtitle="کل وضعیت‌ها" />
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  {/* Production orders by status */}
                  <SectionCard
                    title="سفارشات تولید بر اساس وضعیت"
                    subtitle="گزارش تولید — توزیع واقعی وضعیت‌ها"
                    icon={<Factory size={16} className="text-teal-600" />}
                    iconBg={{ bg: '#f0fdfa', color: '#0d9488' }}
                    testId="holding-ops-production"
                  >
                    <div className="space-y-2.5">
                      {(prod?.orders || []).map((o) => {
                        const total = (prod?.orders || []).reduce((s, x) => s + x.count, 0) || 1;
                        const w = Math.round((o.count / total) * 100);
                        const colors: Record<string, string> = { planning: '#64748b', 'in-production': '#d97706', completed: '#059669', stopped: '#dc2626' };
                        const color = colors[o.status] || '#64748b';
                        return (
                          <div key={o.status} className="flex items-center gap-3">
                            <span className="text-xs text-gray-600 w-24 truncate font-medium">{statusLabel(o.status)}</span>
                            <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${Math.max(w, 4)}%`, background: color, opacity: 0.8 }} />
                            </div>
                            <span className="text-xs font-bold text-gray-700 w-10 text-left">{toPersianNum(o.count)}</span>
                          </div>
                        );
                      })}
                      {!(prod?.orders || []).length && <EmptyHint text="سفارش تولیدی ثبت نشده است" />}
                    </div>
                    {/* Shipment status breakdown */}
                    <div className="border-t border-gray-100 pt-4 mt-4">
                      <h4 className="text-[11px] font-bold text-gray-500 mb-3">وضعیت ارسال بار</h4>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {(ship?.statusBreakdown || []).map((sb) => (
                          <span key={sb.status} className="text-[11px] bg-gray-100 text-gray-700 px-2 py-0.5 rounded-md font-bold">
                            {statusLabel(sb.status)}: {toPersianNum(sb.count)}
                          </span>
                        ))}
                        {!(ship?.statusBreakdown || []).length && <span className="text-[11px] text-gray-400">ارسالی ثبت نشده است</span>}
                      </div>
                    </div>
                  </SectionCard>

                  {/* Carriers */}
                  <SectionCard
                    title="شرکت‌های حمل"
                    subtitle="حجم ارسال به تفکیک باربری (۱۰ مورد برتر)"
                    icon={<Truck size={16} className="text-blue-600" />}
                    iconBg={{ bg: '#eff6ff', color: '#2563eb' }}
                    testId="holding-ops-carriers"
                  >
                    <div className="space-y-2.5">
                      {(ship?.carriers || []).map((c) => {
                        const maxT = Math.max(...(ship?.carriers || []).map((x) => x.total), 1);
                        const w = Math.round((c.total / maxT) * 100);
                        return (
                          <div key={c.name} className="flex items-center gap-3">
                            <span className="text-xs text-gray-600 w-24 truncate font-medium">{c.name}</span>
                            <div className="flex-1 h-5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full bg-gradient-to-l from-blue-500 to-blue-300 transition-all duration-1000" style={{ width: `${Math.max(w, 4)}%` }} />
                            </div>
                            <span className="text-xs font-bold text-gray-700 w-24 text-left" dir="rtl">
                              {toPersianNum(c.total)} ارسال · {toPersianNum(c.delivered)} تحویل
                            </span>
                          </div>
                        );
                      })}
                      {!(ship?.carriers || []).length && <EmptyHint text="ارسالی ثبت نشده است" />}
                    </div>
                  </SectionCard>
                </div>

                {/* Recent shipments */}
                <SectionCard
                  title="آخرین ارسال‌ها"
                  subtitle="۱۵ ارسال اخیر بار"
                  icon={<Activity size={16} className="text-gray-600" />}
                  iconBg={{ bg: '#f3f4f6', color: '#4b5563' }}
                  testId="holding-ops-recent"
                >
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b-2 border-gray-100">
                          <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">شماره بار</th>
                          <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">مرکز مقصد</th>
                          <th className="text-right py-2.5 px-2 text-gray-400 font-bold text-[11px]">باربری</th>
                          <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">سند</th>
                          <th className="text-center py-2.5 px-2 text-gray-400 font-bold text-[11px]">وضعیت</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(ship?.recent || []).map((r) => (
                          <tr key={r.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                            <td className="py-2.5 px-2 text-xs font-bold text-gray-800 text-right" dir="ltr">{r.shipmentNumber}</td>
                            <td className="py-2.5 px-2 text-xs text-gray-700">{r.centerName}{r.city ? ` — ${r.city}` : ''}</td>
                            <td className="py-2.5 px-2 text-xs text-gray-500">{r.carrierName || 'نامشخص'}</td>
                            <td className="py-2.5 px-2 text-center text-xs text-gray-500" dir="ltr">{r.documentNumber || '—'}</td>
                            <td className="py-2.5 px-2 text-center">
                              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{statusLabel(r.status)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!(ship?.recent || []).length && <EmptyHint text="ارسالی ثبت نشده است" />}
                  </div>
                </SectionCard>
              </div>
            );
          })()}
        </TabReportShell>
      )}
    </div>
  );
}

// ==================== TAB REPORT SHELL ====================
function TabReportShell({ loading, error, onRetry, children }: {
  loading: boolean; error: string | undefined; onRetry: () => void; children: React.ReactNode;
}) {
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4" data-testid="holding-tab-error">
        <div className="w-12 h-12 rounded-2xl bg-red-50 border border-red-100 flex items-center justify-center">
          <AlertTriangle size={22} className="text-red-600" />
        </div>
        <p className="text-sm text-gray-600 font-medium">{error}</p>
        <button onClick={onRetry} className="px-4 py-2 rounded-xl bg-gray-900 text-white text-xs font-bold hover:bg-gray-800 transition-colors">
          تلاش مجدد
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-3" data-testid="holding-tab-loading">
        <RefreshCw size={22} className="animate-spin text-gray-400" />
        <p className="text-xs text-gray-400 font-medium">در حال دریافت گزارش…</p>
      </div>
    );
  }
  return <>{children}</>;
}

// ==================== SMALL HELPERS ====================
function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-[11px] text-gray-400">{text}</div>
  );
}

function SectionHeader({ icon, bg, title, subtitle }: {
  icon: React.ReactNode; bg: string; title: string; subtitle?: string;
}) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div className="flex items-center gap-2.5">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${bg}`}>
          {icon}
        </div>
        <div>
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
          {subtitle && <p className="text-[11px] text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}
