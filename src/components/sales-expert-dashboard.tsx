'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toJalaliString, jalaliMonthName } from '@/lib/jalali';
import { listAllPages } from '@/hooks/use-api';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  Building2, FileText, Phone, Clock, Check,
  AlertTriangle, Calendar, MapPin,
  Target, ArrowUpRight, ArrowDownRight, CreditCard,
  CircleDollarSign, Users, BarChart3, Eye,
  Send, RefreshCw, Zap, Timer, Award,
  LayoutGrid, ArrowUp, ArrowDown, RotateCcw, Settings2,
} from 'lucide-react';
import { visibleWidgetKeys, WIDGET_CATALOG, type UserWidget, type WidgetKey } from '@/lib/dashboard-widgets';

// ==================== TYPES ====================
interface KPICardData {
  title: string;
  value: string;
  subtitle: string;
  /** v2.18.0 — optional: only render the trend badge when a REAL
   * period-over-period value exists (was a hardcoded +12%). */
  change?: number;
  /** optional: only render the progress bar when a real ratio exists. */
  progress?: number;
  color: string;
  icon: React.ReactNode;
}

interface PipelineStage {
  key: string;
  label: string;
  count: number;
  amount: number;
  color: string;
}

interface ScheduleItem {
  id: string;
  time: string;
  type: 'visit' | 'call' | 'followup' | 'meeting';
  title: string;
  center: string;
  city: string;
  status: 'done' | 'in_progress' | 'pending';
  note?: string;
}

interface RecentActivity {
  id: string;
  time: string;
  action: string;
  detail: string;
  type: 'order' | 'followup' | 'visit' | 'call' | 'invoice';
  center: string;
}

interface TopCenter {
  id: string;
  name: string;
  city: string;
  totalSales: number;
  ordersCount: number;
  trend: number;
  rank: number;
}

interface MonthlySales {
  month: string;
  target: number;
  actual: number;
}

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const pd = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (d) => pd[parseInt(d)]);
}

function formatCurrency(n: number): string {
  if (n >= 1e9) return toPersianNum((n / 1e9).toFixed(1)) + ' میلیارد';
  if (n >= 1e6) return toPersianNum((n / 1e6).toFixed(1)) + ' میلیون';
  if (n >= 1e3) return toPersianNum((n / 1e3).toFixed(0)) + ' هزار';
  return toPersianNum(n);
}

const TYPE_CONFIG = {
  visit: { label: 'مراجعه', color: '#1F8B7D', bg: '#f0fdfa', icon: <MapPin size={14} /> },
  call: { label: 'تماس', color: '#2563eb', bg: '#eff6ff', icon: <Phone size={14} /> },
  followup: { label: 'پیگیری', color: '#d97706', bg: '#fffbeb', icon: <Target size={14} /> },
  meeting: { label: 'جلسه', color: '#7c3aed', bg: '#f5f3ff', icon: <Users size={14} /> },
};

const ACTIVITY_CONFIG = {
  order: { label: 'سفارش', color: '#059669', bg: '#ecfdf5' },
  followup: { label: 'پیگیری', color: '#d97706', bg: '#fffbeb' },
  visit: { label: 'مراجعه', color: '#1F8B7D', bg: '#f0fdfa' },
  call: { label: 'تماس', color: '#2563eb', bg: '#eff6ff' },
  invoice: { label: 'فاکتور', color: '#7c3aed', bg: '#f5f3ff' },
};

// ==================== CIRCULAR PROGRESS ====================
function CircularProgress({ value, size = 140, strokeWidth = 10, color = '#1F8B7D' }: {
  value: number; size?: number; strokeWidth?: number; color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(value, 100)) : 0;
  const offset = circumference - (safeValue / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#f1f5f9" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          className="transition-all duration-1000 ease-out"
          style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>{toPersianNum(value)}٪</span>
        <span className="text-[11px] text-gray-400 mt-1">تکمیل تارگت</span>
      </div>
    </div>
  );
}

// ==================== MINI BAR CHART ====================
function MiniBarChart({ data, targetColor = '#e2e8f0', actualColor = '#1F8B7D' }: {
  data: MonthlySales[]; targetColor?: string; actualColor?: string;
}) {
  const maxVal = Math.max(...data.flatMap((d) => [d.target, d.actual]));

  return (
    <div className="flex items-end justify-between gap-2 h-36 px-1">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
          <div className="w-full flex items-end justify-center gap-0.5" style={{ height: '100px' }}>
            <div
              className="w-[40%] rounded-t-md animate-bar-grow opacity-0"
              style={{
                height: `${(d.target / maxVal) * 100}%`,
                background: targetColor,
                animationDelay: `${i * 80}ms`,
                minHeight: '4px',
              }}
            />
            <div
              className="w-[40%] rounded-t-md animate-bar-grow opacity-0"
              style={{
                height: `${(d.actual / maxVal) * 100}%`,
                background: actualColor,
                animationDelay: `${i * 80 + 40}ms`,
                minHeight: '4px',
              }}
            />
          </div>
          <span className="text-[11px] text-gray-500 font-medium leading-none">{d.month.slice(0, 3)}</span>
        </div>
      ))}
    </div>
  );
}

// ==================== KPI CARD ====================
function KpiCard({ data, delay = 0 }: { data: KPICardData; delay?: number }) {
  const showChange = typeof data.change === 'number' && Number.isFinite(data.change);
  const isPositive = (data.change ?? 0) >= 0;
  const showProgress = typeof data.progress === 'number' && Number.isFinite(data.progress);
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 hover:shadow-md transition-all duration-300 animate-fade-in-up opacity-0 group"
      style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-start justify-between mb-4">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
          style={{ background: `${data.color}12` }}>
          <span style={{ color: data.color }}>{data.icon}</span>
        </div>
        {showChange && (
          <div className={`flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full ${isPositive ? 'text-emerald-700 bg-emerald-50' : 'text-red-600 bg-red-50'}`}>
            {isPositive ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
            {toPersianNum(Math.abs(data.change!))}٪
          </div>
        )}
      </div>
      <div className="text-2xl font-extrabold text-gray-900 mb-1" dir="ltr">{data.value}</div>
      <div className="text-sm text-gray-500 mb-3">{data.title}</div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-400">{data.subtitle}</span>
        {showProgress && (
          <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all duration-1000" style={{ width: `${data.progress}%`, background: data.color }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== PIPELINE FUNNEL ====================
function PipelineFunnel({ stages }: { stages: PipelineStage[] }) {
  const maxCount = Math.max(...stages.map((s) => s.count));

  return (
    <div className="space-y-2.5">
      {stages.map((stage, i) => (
        <div key={stage.key} className="group animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 80}ms` }}>
          <div className="flex items-center gap-3 mb-1.5">
            <span className="text-sm font-bold text-gray-900 w-24">{stage.label}</span>
            <span className="text-xs text-gray-500">{toPersianNum(stage.count)} مورد</span>
            {stage.amount > 0 && (
              <span className="text-xs font-medium mr-auto" style={{ color: stage.color }}>
                {formatCurrency(stage.amount)} ریال
              </span>
            )}
          </div>
          <div className="w-full h-8 bg-gray-50 rounded-lg overflow-hidden">
            <div
              className="h-full rounded-lg transition-all duration-700 ease-out flex items-center pr-3"
              style={{
                width: `${(stage.count / maxCount) * 100}%`,
                background: `linear-gradient(to left, ${stage.color}20, ${stage.color})`,
                minWidth: '48px',
                animationDelay: `${i * 100}ms`,
              }}
            >
              <span className="text-xs font-bold text-white">{toPersianNum(stage.count)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== SCHEDULE TIMELINE ====================
function ScheduleTimeline({ items, onNavigate }: { items: ScheduleItem[]; onNavigate?: (key: string) => void }) {
  const statusConfig = {
    done: { label: 'انجام شده', color: '#059669', bg: '#ecfdf5', icon: <Check size={14} /> },
    in_progress: { label: 'در حال انجام', color: '#2563eb', bg: '#eff6ff', icon: <RefreshCw size={14} className="animate-spin" /> },
    pending: { label: 'در انتظار', color: '#94a3b8', bg: '#f8fafc', icon: <Clock size={14} /> },
  };

  return (
    <div className="space-y-0">
      {items.map((item, i) => {
        const tc = TYPE_CONFIG[item.type];
        const sc = statusConfig[item.status];
        return (
          <div key={item.id} className={`flex gap-3 pb-4 ${i < items.length - 1 ? 'border-r-2 border-dashed border-gray-200 mr-3 pr-5' : 'mr-3 pr-5'} animate-fade-in-up opacity-0`}
            style={{ animationDelay: `${i * 60}ms` }}>
            {/* Time */}
            <div className="w-12 shrink-0 text-left">
              <span className="text-xs font-bold text-gray-500" dir="ltr">{item.time}</span>
            </div>
            {/* Dot */}
            <div className="w-8 shrink-0 flex justify-center -mr-5">
              <div className="w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm mt-0.5"
                style={{ background: sc.color }} />
            </div>
            {/* Content */}
            <div className="flex-1 bg-white rounded-xl p-3.5 border border-gray-100 hover:shadow-sm transition-shadow min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="font-bold text-gray-900 text-sm truncate">{item.title}</span>
                <span className="px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0 flex items-center gap-1"
                  style={{ background: tc.bg, color: tc.color }}>
                  {tc.icon} {tc.label}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1"><Building2 size={11} />{item.center}</span>
                <span className="flex items-center gap-1"><MapPin size={11} />{item.city}</span>
              </div>
              {item.status === 'done' && item.note && (
                <div className="mt-2 text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-1.5 flex items-center gap-1">
                  <Check size={12} /> {item.note}
                </div>
              )}
              <div className="flex items-center justify-between mt-2">
                <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: sc.color, background: sc.bg }}>
                  {sc.icon} {sc.label}
                </span>
                {item.status === 'pending' && (
                  <Button
                    size="sm" variant="ghost" className="h-7 text-xs gap-1 text-gray-500 hover:text-teal-600"
                    onClick={() => (onNavigate ? onNavigate('calendar') : undefined)}
                  >
                    <Eye size={12} /> مشاهده
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== ACTIVITY FEED ====================
function ActivityFeed({ activities }: { activities: RecentActivity[] }) {
  return (
    <div className="space-y-3">
      {activities.map((a, i) => {
        const cfg = ACTIVITY_CONFIG[a.type];
        return (
          <div key={a.id} className="flex gap-3 animate-fade-in opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: cfg.bg }}>
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: cfg.color }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-gray-900 truncate">{a.action}</span>
                <span className="text-[11px] text-gray-400 shrink-0" dir="ltr">{a.time}</span>
              </div>
              <p className="text-xs text-gray-600 truncate mt-0.5">{a.detail}</p>
              <p className="text-[11px] text-gray-400 mt-1 flex items-center gap-1">
                <Building2 size={10} /> {a.center}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== TOP CENTERS TABLE ====================
function TopCentersTable({ centers }: { centers: TopCenter[] }) {
  const rankColors = ['#f59e0b', '#94a3b8', '#b45309'];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs w-10">#</th>
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs">مرکز</th>
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs">شهر</th>
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs">فروش</th>
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs">سفارش</th>
            <th className="text-right py-2.5 px-2 text-gray-500 font-medium text-xs">روند</th>
          </tr>
        </thead>
        <tbody>
          {centers.map((c, i) => (
            <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
              <td className="py-2.5 px-2">
                <div className="w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: rankColors[i] || '#94a3b8' }}>
                  {toPersianNum(c.rank)}
                </div>
              </td>
              <td className="py-2.5 px-2 font-medium text-gray-900">{c.name}</td>
              <td className="py-2.5 px-2 text-gray-600 text-xs">{c.city}</td>
              <td className="py-2.5 px-2 font-medium" style={{ color: '#1F8B7D' }}>{formatCurrency(c.totalSales)}</td>
              <td className="py-2.5 px-2 text-gray-600">{toPersianNum(c.ordersCount)}</td>
              <td className="py-2.5 px-2">
                <span className={`flex items-center gap-0.5 text-xs font-semibold ${c.trend >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                  {c.trend >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                  {toPersianNum(Math.abs(c.trend))}٪
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ==================== QUICK ACTIONS ====================
function QuickActions({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const actions = [
    { key: 'new-order', label: 'سفارش جدید', icon: <FileText size={20} />, color: '#1F8B7D', bg: '#f0fdfa' },
    { key: 'new-followup', label: 'پیگیری جدید', icon: <Target size={20} />, color: '#d97706', bg: '#fffbeb' },
    { key: 'log-visit', label: 'ثبت مراجعه', icon: <MapPin size={20} />, color: '#2563eb', bg: '#eff6ff' },
    { key: 'send-quote', label: 'ارسال پیش‌فاکتور', icon: <Send size={20} />, color: '#7c3aed', bg: '#f5f3ff' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3">
      {actions.map((action, i) => (
        <button
          key={action.key}
          onClick={() => onNavigate(action.key)}
          className="flex items-center gap-3 p-4 rounded-xl border border-gray-100 bg-white hover:shadow-md transition-all duration-200 animate-fade-in-up opacity-0 group"
          style={{ animationDelay: `${i * 80}ms` }}
        >
          <div className="w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110"
            style={{ background: action.bg, color: action.color }}>
            {action.icon}
          </div>
          <span className="text-sm font-bold text-gray-800">{action.label}</span>
        </button>
      ))}
    </div>
  );
}

// ==================== MAIN DASHBOARD ====================
export default function SalesExpertDashboard({ onNavigate, userName }: { onNavigate?: (tab: string) => void; userName?: string }) {
  const [filterPeriod, setFilterPeriod] = useState<'today' | 'week' | 'month'>('month');
  // v2.43.0 — per-user widget layout (visibility + order), same ownership
  // pattern as the personalized pipeline stages. null = system default.
  const [savedWidgets, setSavedWidgets] = useState<UserWidget[] | null>(null);
  const [widgetsLoaded, setWidgetsLoaded] = useState(false);
  const [showCustomize, setShowCustomize] = useState(false);

  // ── Real data state (replaces all hardcoded arrays) ──
  const [pipelineData, setPipelineData] = useState<PipelineStage[]>([]);
  const [scheduleData, setScheduleData] = useState<ScheduleItem[]>([]);
  const [recentActivities, setRecentActivities] = useState<RecentActivity[]>([]);
  const [topCenters, setTopCenters] = useState<TopCenter[]>([]);
  const [monthlySales, setMonthlySales] = useState<MonthlySales[]>([]);
  const [dashError, setDashError] = useState<string | null>(null);
  const [myCentersCount, setMyCentersCount] = useState(0);
  // v2.18.0 — real collection + overdue data (replaces hardcoded values)
  const [collectionStat, setCollectionStat] = useState<{ totalClaim: number; collected: number; ratio: number } | null>(null);
  const [overdueAlerts, setOverdueAlerts] = useState<Array<{ id: string; number: string; centerName: string; amount: number; overdueDays: number }>>([]);

  // v2.43.0 — load the personal widget layout FIRST: the data-load effect
  // below gates its fetches on which widgets are actually visible.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/dashboard');
        if (res.ok) {
          const data = await res.json();
          if (!cancelled) setSavedWidgets(data.widgets ?? null);
        }
      } catch { /* layout optional — defaults win */ }
      finally { if (!cancelled) setWidgetsLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, []);

  const visibleKeys = useMemo(() => visibleWidgetKeys(savedWidgets), [savedWidgets]);
  const isShown = useCallback((k: WidgetKey) => visibleKeys.includes(k), [visibleKeys]);

  useEffect(() => {
    // v2.43.0 — wait for the widget layout before the first data load
    // (avoids a full fetch round that a hidden-widget layout would waste).
    if (!widgetsLoaded) return;
    let cancelled = false;
    (async () => {
      try {
        // Sales documents → pipeline stages + recent activities
        // v2.43.0 — fetch gating: skip data for widgets the user HID.
        // kpi derives open-orders + approval counts from pipelineData.
        const needDocs = isShown('pipeline') || isShown('activities') || isShown('kpi');
        const docs = needDocs ? await listAllPages<{
          id: string; documentType: string; status: string; finalAmount: number; createdAt: string;
          center: { name: string } | null;
        }>('/api/sales-documents', 'list') : [];

        const stages: Record<string, { key: string; label: string; count: number; amount: number; color: string }> = {
          lead: { key: 'lead', label: 'سرنخ / پیش‌نویس', count: 0, amount: 0, color: '#94a3b8' },
          negotiation: { key: 'negotiation', label: 'در انتظار تأیید', count: 0, amount: 0, color: '#2563eb' },
          proforma: { key: 'proforma', label: 'تأیید شده', count: 0, amount: 0, color: '#d97706' },
          invoice: { key: 'invoice', label: 'فاکتور', count: 0, amount: 0, color: '#059669' },
          shipped: { key: 'shipped', label: 'ارسال شده', count: 0, amount: 0, color: '#1F8B7D' },
          paid: { key: 'paid', label: 'تسویه', count: 0, amount: 0, color: '#7c3aed' },
        };
        const acts: RecentActivity[] = [];
        for (const d of docs) {
          if (d.status === 'draft') { stages.lead.count++; stages.lead.amount += d.finalAmount; }
          else if (d.status === 'pending_approval') { stages.negotiation.count++; stages.negotiation.amount += d.finalAmount; }
          else if (d.status === 'approved') { stages.proforma.count++; stages.proforma.amount += d.finalAmount; }
          if (d.documentType === 'invoice') { stages.invoice.count++; stages.invoice.amount += d.finalAmount; }
          acts.push({
            id: d.id,
            time: (d.createdAt || '').slice(11, 16) || '—',
            action: d.documentType === 'invoice' ? 'صدور فاکتور' : 'ثبت پیش‌فاکتور',
            detail: `شماره سند ${d.id.slice(-6)}`,
            type: d.documentType === 'invoice' ? 'invoice' : 'order',
            center: d.center?.name || '—',
          });
        }
        if (!cancelled) {
          setPipelineData(Object.values(stages));
          setRecentActivities(acts.slice(0, 8));
        }

        // Today's activities → daily schedule (real data) — also feeds the
        // KPI «برنامهٔ امروز» card, so kpi keeps it alive.
        try {
          if (!isShown('schedule') && !isShown('kpi')) throw new Error('skip');
          const today = new Date();
          const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
          const actRes = await fetch('/api/activities', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list', page: 1, pageSize: 50, dateFrom: dayStart.toISOString(), dateTo: new Date(dayStart.getTime() + 86400000).toISOString() }),
          });
          if (actRes.ok) {
            const actData = await actRes.json();
            // v2.25.0 — the activities `list` action answers { items, ... }
            // (NOT `data`): the old `actData.data` read was ALWAYS undefined,
            // so the expert dashboard's «برنامهٔ امروز» section rendered
            // empty forever despite real rows existing. Caught by the
            // API-JSON-key contract rule (static check in verify-v2250).
            const items: ScheduleItem[] = (actData.items || []).map((a: { id: string; title: string; activityTime?: string; status: string; isPhoneCall?: boolean; completedAt?: string | null; center?: { name?: string; city?: string | null } | null }) => ({
              id: a.id,
              time: a.activityTime || '—',
              type: a.isPhoneCall ? 'call' : 'followup',
              title: a.title,
              center: a.center?.name || '—',
              city: a.center?.city || '—',
              status: a.status === 'done' ? 'done' : 'pending',
            }));
            if (!cancelled) setScheduleData(items);
          }
        } catch { /* schedule optional */ }

        // My active centers count (real data — kpi only)
        try {
          if (!isShown('kpi')) throw new Error('skip');
          const cRes = await fetch('/api/centers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list', page: 1, pageSize: 1 }),
          });
          if (cRes.ok) {
            const cData = await cRes.json();
            if (!cancelled) setMyCentersCount(Number(cData.total || cData.pagination?.total || 0));
          }
        } catch { /* centers count optional */ }

        // Top centers from reports API
        try {
          if (!isShown('performance') && !isShown('kpi')) throw new Error('skip');
          // Monthly sales summary → chart (real data)
          const sumRes = await fetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sales-summary' }),
          });
          if (sumRes.ok) {
            const sumData = await sumRes.json();
            const chart: MonthlySales[] = (sumData.chartData || sumData.data || []).map((m: { month: string; sales: number }) => ({
              month: m.month,
              target: 0,
              actual: Math.round((m.sales || 0) / 1e6),
            }));
            if (!cancelled) setMonthlySales(chart);
          }
        } catch { /* sales summary optional */ }
        try {
          if (!isShown('top_centers')) throw new Error('skip');
          const topRes = await fetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'top-centers' }),
          });
          const topData = await topRes.json();
          // v2.18.0 — top-centers returns { chartData } (never `items`);
          // reading topData.items left the table permanently empty.
          if (topRes.ok && Array.isArray(topData.chartData)) {
            setTopCenters(topData.chartData.slice(0, 5).map((c: { centerId: string; centerName: string; province: string; totalSales: number; documentCount: number }, i: number) => ({
              id: c.centerId,
              name: c.centerName,
              city: c.province || '',
              totalSales: c.totalSales,
              ordersCount: c.documentCount,
              trend: 0,
              rank: i + 1,
            })));
          }
        } catch { /* top-centers optional */ }

        // v2.18.0 — real collection stat + real overdue alerts from billing
        // (was: hardcoded 3.2B/1.8B/56% and two invented overdue invoices).
        try {
          if (!isShown('collection') && !isShown('overdue_alerts')) throw new Error('skip');
          const billRes = await fetch('/api/billing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list', pageSize: 200 }),
          });
          if (billRes.ok) {
            const billData = await billRes.json();
            const items: Array<{
              id: string; invoiceNumber: string | null; status: string; totalAmount: number;
              paidAmount: number; dueDate: string | null;
              centerAccount: { center: { name: string } | null } | null;
            }> = billData.items || [];
            const open = items.filter((inv) => inv.status !== 'void');
            const totalClaim = open.reduce((s, inv) => s + Math.max(0, inv.totalAmount - inv.paidAmount), 0);
            const collected = open.reduce((s, inv) => s + inv.paidAmount, 0);
            const ratio = collected + totalClaim > 0 ? Math.round((collected / (collected + totalClaim)) * 100) : 0;
            const overdue = open
              .filter((inv) => {
                if (inv.status === 'paid') return false;
                if (!inv.dueDate) return false;
                return new Date(inv.dueDate).getTime() < Date.now() && inv.totalAmount - inv.paidAmount > 0;
              })
              .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
              .slice(0, 3)
              .map((inv) => ({
                id: inv.id,
                number: inv.invoiceNumber || '—',
                centerName: inv.centerAccount?.center?.name || '—',
                amount: inv.totalAmount - inv.paidAmount,
                overdueDays: Math.max(1, Math.floor((Date.now() - new Date(inv.dueDate!).getTime()) / 86400000)),
              }));
            if (!cancelled) {
              setCollectionStat({ totalClaim, collected, ratio });
              setOverdueAlerts(overdue);
            }
          }
        } catch { /* billing optional */ }
      } catch (e) {
        // the 'skip' sentinels above land here — never surface them
        if (!cancelled && !(e instanceof Error && e.message === 'skip')) {
          setDashError(e instanceof Error ? e.message : 'خطا در دریافت داده‌ها');
        }
      }
    })();
    return () => { cancelled = true; };
    // v2.43.0 — re-run when the widget layout is known / changes so newly
    // shown widgets get their data (hidden ones skip their fetches).
  }, [widgetsLoaded, isShown]);

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'صبح بخیر';
    if (h < 17) return 'ظهر بخیر';
    return 'عصر بخیر';
  }, []);

  const todayStr = useMemo(() => {
    const parts = toJalaliString(new Date()).split('/');
    if (parts.length < 3) return '';
    const jMonth = parseInt(parts[1], 10);
    const jDay = parseInt(parts[2], 10);
    return `${toPersianNum(jDay)} ${jalaliMonthName(jMonth)} ${toPersianNum(parts[0])}`;
  }, []);

  const totalActual = monthlySales.reduce((s, m) => s + m.actual, 0);
  const currentMonthActual = monthlySales.length ? monthlySales[monthlySales.length - 1].actual : 0;
  const currentMonthTarget = monthlySales.length ? monthlySales[monthlySales.length - 1].target : 0;
  const previousMonthActual = monthlySales.length > 1 ? monthlySales[monthlySales.length - 2].actual : 0;
  const targetPercent = currentMonthTarget > 0 ? Math.round((currentMonthActual / currentMonthTarget) * 100) : 0;
  // v2.18.0 — real month-over-month change (was a hardcoded +12%).
  const monthChange = previousMonthActual > 0
    ? Math.round(((currentMonthActual - previousMonthActual) / previousMonthActual) * 100)
    : undefined;

  const openOrders = pipelineData.filter(s => s.key === 'lead' || s.key === 'negotiation').reduce((s, st) => s + st.count, 0);
  const approvedCount = pipelineData.filter(s => s.key === 'proforma').reduce((s, st) => s + st.count, 0);
  const overdueToday = scheduleData.filter(s => s.status === 'pending').length;
  const doneCount = scheduleData.filter(s => s.status === 'done').length;
  const totalSchedule = scheduleData.length;
  const schedulePercent = totalSchedule > 0 ? Math.round((doneCount / totalSchedule) * 100) : 0;

  const kpiCards: KPICardData[] = [
    {
      title: 'فروش ماه جاری',
      value: formatCurrency(currentMonthActual * 1e6) + ' ریال',
      subtitle: currentMonthTarget > 0 ? `تارگت: ${formatCurrency(currentMonthTarget * 1e6)}` : `${formatCurrency(totalActual * 1e6)} در سال جاری`,
      change: monthChange, progress: targetPercent || undefined, color: '#1F8B7D',
      icon: <CircleDollarSign size={20} />,
    },
    {
      title: 'سفارشات باز',
      value: toPersianNum(openOrders),
      subtitle: `${toPersianNum(approvedCount)} سند تأییدشده`,
      color: '#d97706',
      icon: <FileText size={20} />,
    },
    {
      title: 'مراکز فعال من',
      value: toPersianNum(myCentersCount),
      subtitle: 'در حیطهٔ فعالیت شما',
      color: '#2563eb',
      icon: <Building2 size={20} />,
    },
    {
      title: 'برنامهٔ امروز',
      value: toPersianNum(scheduleData.length),
      subtitle: `${toPersianNum(overdueToday)} در انتظار انجام`,
      progress: schedulePercent, color: '#dc2626',
      icon: <Phone size={20} />,
    },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* v2.18.0 — surface load errors instead of swallowing them */}
      {dashError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 flex items-center gap-2">
          <AlertTriangle size={14} className="text-red-500 shrink-0" />
          <p className="text-xs text-red-600">{dashError}</p>
        </div>
      )}

      {/* ===== GREETING BAR ===== */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 animate-fade-in-up">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-white text-xl font-bold"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              {(userName || 'م').trim().charAt(0)}
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-gray-900">{greeting}، {(userName || 'کاربر').split(' ')[0]} عزیز</h2>
              <div className="flex items-center gap-2 mt-1">
                <Badge className="text-[11px] bg-teal-50 text-teal-700 hover:bg-teal-50">کارشناس فروش</Badge>
                <Badge variant="outline" className="text-[11px]">شرکت بازرگانی</Badge>
                <span className="text-xs text-gray-400">{todayStr}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* v2.43.0 — per-user widget layout customization */}
            <button
              onClick={() => setShowCustomize(true)}
              className="h-9 px-3 rounded-xl flex items-center gap-1.5 text-xs font-medium text-teal-700 bg-teal-50 hover:bg-teal-100 transition-colors"
              title="شخصی‌سازی داشبورد"
              aria-label="شخصی‌سازی داشبورد"
            >
              <LayoutGrid size={14} />
              <span className="hidden sm:inline">شخصی‌سازی داشبورد</span>
              {savedWidgets ? <span aria-hidden className="text-[9px]">★</span> : null}
            </button>
            {/* Day progress */}
            <div className="text-center px-4">
              <div className="relative inline-flex items-center justify-center w-16 h-16">
                <svg width="64" height="64" className="-rotate-90">
                  <circle cx="32" cy="32" r="26" fill="none" stroke="#f1f5f9" strokeWidth="5" />
                  <circle cx="32" cy="32" r="26" fill="none" stroke="#1F8B7D" strokeWidth="5" strokeLinecap="round"
                    strokeDasharray={163.36} strokeDashoffset={163.36 - (schedulePercent / 100) * 163.36}
                    className="transition-all duration-1000" />
                </svg>
                <span className="absolute text-xs font-bold" style={{ color: '#1F8B7D' }}>{toPersianNum(schedulePercent)}٪</span>
              </div>
              <span className="text-[11px] text-gray-400 mt-1 block">برنامه روزانه</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===== WIDGET GRID — v2.43.0 =====
          Cards render in the user's saved ORDER; hidden widgets are simply
          absent (and their data was never fetched). kpi spans full width. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {isShown('kpi') && (
        <div className="lg:col-span-2">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {kpiCards.map((kpi, i) => (
            <KpiCard key={i} data={kpi} delay={i * 100} />
          ))}
        </div>
        </div>
        )}

        {isShown('performance') && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-200">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-base font-bold text-gray-900">عملکرد فروش</h3>
              <p className="text-xs text-gray-500 mt-0.5">مقایسه تارگت و فروش واقعی</p>
            </div>
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {(['month', 'week', 'today'] as const).map((p) => (
                <button key={p} onClick={() => setFilterPeriod(p)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    filterPeriod === p ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                  }`}>
                  {p === 'month' ? 'ماهانه' : p === 'week' ? 'هفتگی' : 'امروز'}
                </button>
              ))}
            </div>
          </div>

          {/* Circular progress */}
          <div className="flex justify-center mb-5">
            <CircularProgress value={targetPercent} color="#1F8B7D" />
          </div>

          {/* Legend */}
          <div className="flex items-center justify-center gap-6 mb-5">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ background: '#e2e8f0' }} />
              <span className="text-xs text-gray-500">تارگت</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-sm" style={{ background: '#1F8B7D' }} />
              <span className="text-xs text-gray-500">واقعی</span>
            </div>
          </div>

          {/* Bar chart */}
          <MiniBarChart data={monthlySales} />
        </div>
        )}

        {isShown('pipeline') && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-300">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="text-base font-bold text-gray-900">لوله فروش</h3>
              <p className="text-xs text-gray-500 mt-0.5">مراحل تبدیل مشتری</p>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-teal-50">
              <Zap size={14} className="text-teal-600" />
              <span className="text-xs font-bold text-teal-700">{toPersianNum(pipelineData.reduce((s, p) => s + p.count, 0))} فرصت</span>
            </div>
          </div>
          <PipelineFunnel stages={pipelineData} />
        </div>
        )}

        {/* Quick Actions + Stats */}
        {isShown('quick_actions') && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-400">
            <h3 className="text-base font-bold text-gray-900 mb-4">دسترسی سریع</h3>
            <QuickActions onNavigate={onNavigate || (() => {})} />
          </div>
        )}

        {/* Mini stat: collection — v2.18.0 real data from billing */}
        {isShown('collection') && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-500">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-gray-900">وصول مطالبات</h3>
              <CreditCard size={16} className="text-gray-400" />
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">کل طلب باز</span>
                <span className="text-sm font-bold text-red-600">{formatCurrency(collectionStat?.totalClaim ?? 0)} ریال</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">وصول شده</span>
                <span className="text-sm font-bold text-emerald-600">{formatCurrency(collectionStat?.collected ?? 0)} ریال</span>
              </div>
              <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-gradient-to-l from-teal-500 to-emerald-500 transition-all duration-700" style={{ width: `${collectionStat?.ratio ?? 0}%` }} />
              </div>
              <div className="flex justify-between text-[11px] text-gray-400">
                <span>وصول {toPersianNum(collectionStat?.ratio ?? 0)}٪</span>
                <span>{formatCurrency(collectionStat?.totalClaim ?? 0)} مانده</span>
              </div>
            </div>
          </div>
        )}

        {/* Overdue alerts — v2.18.0 real overdue invoices from billing */}
        {isShown('overdue_alerts') && (
          <div className="bg-red-50 rounded-2xl p-5 border border-red-100 animate-fade-in-up opacity-0 delay-600">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-red-500" />
                <h3 className="text-sm font-bold text-red-800">هشدار سررسید</h3>
              </div>
              <Badge className="text-[11px] bg-red-100 text-red-700 hover:bg-red-100">{toPersianNum(overdueAlerts.length)} مورد</Badge>
            </div>
            <div className="space-y-2">
              {overdueAlerts.length === 0 ? (
                <div className="bg-white rounded-xl p-3 border border-red-100 text-center">
                  <p className="text-xs text-gray-500">فاکتور سررسیدگذشته‌ای ندارید</p>
                </div>
              ) : overdueAlerts.map((inv) => (
                <div key={inv.id} className="bg-white rounded-xl p-3 border border-red-100">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-900">{inv.centerName}</span>
                    <span className="text-[11px] text-red-600 font-medium">{toPersianNum(inv.overdueDays)} روز</span>
                  </div>
                  <span className="text-[11px] text-gray-500">فاکتور {inv.number} — {formatCurrency(inv.amount)} ریال</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Today's Schedule */}
        {isShown('schedule') && (
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-300">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-teal-50 flex items-center justify-center">
                <Calendar size={18} className="text-teal-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">برنامه روزانه</h3>
                <p className="text-xs text-gray-500">{toPersianNum(doneCount)} از {toPersianNum(totalSchedule)} انجام شده</p>
              </div>
            </div>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center"
              style={{ background: `${schedulePercent >= 70 ? '#ecfdf5' : schedulePercent >= 40 ? '#fffbeb' : '#fef2f2'}` }}>
              <Timer size={18} style={{ color: schedulePercent >= 70 ? '#059669' : schedulePercent >= 40 ? '#d97706' : '#dc2626' }} />
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto scrollbar-thin pr-1">
            <ScheduleTimeline items={scheduleData} onNavigate={onNavigate} />
          </div>
        </div>
        )}

        {/* Activity Feed */}
        {isShown('activities') && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-400">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center">
                  <BarChart3 size={18} className="text-blue-600" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">فعالیت‌های اخیر</h3>
                  <p className="text-xs text-gray-500">آخرین عملکردهای شما</p>
                </div>
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto scrollbar-thin">
              <ActivityFeed activities={recentActivities} />
            </div>
          </div>
        )}

        {/* Top Centers */}
        {isShown('top_centers') && (
          <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 animate-fade-in-up opacity-0 delay-500">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-50 flex items-center justify-center">
                  <Award size={18} className="text-amber-600" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-gray-900">برترین مراکز</h3>
                  <p className="text-xs text-gray-500">مراکز کلیدی فروش شما</p>
                </div>
              </div>
            </div>
            <div className="max-h-64 overflow-y-auto scrollbar-thin">
              <TopCentersTable centers={topCenters} />
            </div>
          </div>
        )}
      </div>

      {/* v2.43.0 — widget layout editor */}
      <DashboardCustomizeDialog
        open={showCustomize}
        onOpenChange={setShowCustomize}
        saved={savedWidgets}
        onSaved={setSavedWidgets}
      />
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// DASHBOARD CUSTOMIZE DIALOG — v2.43.0
// Same UX contract as the pipeline-stage dialog (v2.34.6):
// checkbox = visibility, arrows = order, draft built lazily on
// open (no sync setState in effects), reset returns to defaults.
// ════════════════════════════════════════════════════════════
function DashboardCustomizeDialog({ open, onOpenChange, saved, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  saved: UserWidget[] | null;
  onSaved: (widgets: UserWidget[] | null) => void;
}) {
  const [draft, setDraft] = useState<UserWidget[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openDraft = (): UserWidget[] =>
    saved
      ? saved.map((w) => ({ ...w }))
      : WIDGET_CATALOG.map((w) => ({ key: w.key, visible: true }));

  const handleOpenChange = (v: boolean) => {
    if (v) { setErr(null); setDraft(openDraft()); }
    onOpenChange(true);
  };
  const ensureDraft = () => { if (!draft) setDraft(openDraft()); return draft ?? openDraft(); };

  const move = (idx: number, dir: -1 | 1) => {
    setDraft((prev) => {
      const next = [...(prev ?? openDraft())];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const save = async (reset = false) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/dashboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset ? { action: 'reset' } : { action: 'save', widgets: draft ?? openDraft() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
      onSaved(reset ? null : data.widgets);
      toast.success(reset ? 'داشبورد به حالت پیش‌فرض بازگشت' : 'چیدمان داشبورد شما ذخیره شد');
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  const rows: UserWidget[] = draft ?? openDraft();
  const visibleCount = rows.filter((w) => w.visible).length;

  // v2.43.0 FIX — Radix <Dialog> is a plain context provider: raw children
  // (our overlay div) render even when open=false, leaving a permanent
  // click-blocking layer over the page. Mount only when actually open.
  // (Same root cause found and fixed in the pipeline customize dialog.)
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) handleOpenChange(true); else onOpenChange(false); }}>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => onOpenChange(false)}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onFocus={ensureDraft}>
          <div className="p-5 border-b border-gray-100">
            <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <Settings2 size={16} className="text-teal-700" /> شخصی‌سازی داشبورد
            </h3>
            <p className="text-[11px] text-gray-400 mt-1">
              نمایش و ترتیب کارت‌های داشبورد — فقط برای خودتان. دادهٔ کارت‌های مخفی هرگز دریافت نمی‌شود.
            </p>
          </div>
          <div className="p-4 space-y-2">
            {rows.map((w, i) => {
              const meta = WIDGET_CATALOG.find((m) => m.key === w.key);
              return (
                <div key={w.key} className="flex items-center gap-2 bg-gray-50 rounded-xl p-2.5 border border-gray-100">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => move(i, -1)} disabled={i === 0}
                      className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-20"
                      aria-label={`جابه‌جایی ${meta?.title ?? w.key} به بالا`}>
                      <ArrowUp size={11} />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={i === rows.length - 1}
                      className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-20"
                      aria-label={`جابه‌جایی ${meta?.title ?? w.key} به پایین`}>
                      <ArrowDown size={11} />
                    </button>
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="block text-xs font-bold text-gray-800 truncate">{meta?.title ?? w.key}</span>
                    <span className="block text-[10px] text-gray-400 truncate">{meta?.desc}</span>
                  </div>
                  <label className="flex items-center gap-1 text-[11px] text-gray-500 shrink-0 cursor-pointer">
                    <input type="checkbox" checked={w.visible}
                      onChange={(e) => setDraft((prev) => (prev ?? openDraft()).map((x, j) => j === i ? { ...x, visible: e.target.checked } : x))}
                      className="accent-teal-600" />
                    نمایش
                  </label>
                </div>
              );
            })}
            {visibleCount === 0 && (
              <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg p-2">
                همه کارت‌ها مخفی شده‌اند — حداقل یک کارت باید نمایان باشد.
              </p>
            )}
            {err && <p className="text-[11px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">{err}</p>}
          </div>
          <div className="p-4 border-t border-gray-100 flex items-center gap-2">
            <button onClick={() => save(false)} disabled={busy || visibleCount === 0}
              className="h-9 px-4 rounded-lg bg-teal-600 text-white text-xs font-bold hover:bg-teal-700 disabled:opacity-40">
              ذخیره چیدمان من
            </button>
            <button onClick={() => save(true)} disabled={busy || !saved}
              className="h-9 px-3 rounded-lg border border-gray-200 text-gray-500 text-xs font-medium hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-40">
              <RotateCcw size={12} /> بازنشانی به پیش‌فرض
            </button>
            <button onClick={() => onOpenChange(false)} disabled={busy}
              className="h-9 px-3 rounded-lg text-gray-500 text-xs font-medium hover:bg-gray-50 mr-auto">انصراف</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}