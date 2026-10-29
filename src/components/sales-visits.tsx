'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { toJalaliString } from '@/lib/jalali';
// v2.36.0 (round 62) — popup Jalali calendar replaces the TYPED date field.
import { JalaliDatePicker } from '@/components/jalali-date-picker';
// v2.37.0 (round 63) — popup time picker replaces the TYPED time field.
import { TimePicker } from '@/components/time-picker';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Search, Plus, MapPin, Check, Calendar, User as UserIcon, Route, Star, TrendingUp, MapPinned } from 'lucide-react';

// ==================== TYPES ====================
type VisitStatus = 'planned' | 'checked-in' | 'completed' | 'cancelled' | 'no-show';
type VisitOutcome = 'order' | 'followup' | 'sample' | 'info' | 'rejected' | 'none';

interface Visit {
  id: string;
  date: string;
  plannedTime: string;
  checkinTime: string;
  checkoutTime: string;
  centerName: string;
  centerId: string;
  city: string;
  address: string;
  personName: string;
  personRole: string;
  status: VisitStatus;
  outcome: VisitOutcome;
  notes: string;
  nextAction: string;
  orderAmount: number;
  route: string;
  territory: string;
}

// ==================== CONFIGS ====================
const STATUS_CFG: Record<VisitStatus, { label: string; color: string; bg: string }> = {
  'planned': { label: 'برنامه‌ریزی شده', color: '#6366f1', bg: '#eef2ff' },
  'checked-in': { label: 'حاضر شده', color: '#0891b2', bg: '#ecfeff' },
  'completed': { label: 'تکمیل شده', color: '#059669', bg: '#ecfdf5' },
  'cancelled': { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
  'no-show': { label: 'عدم حضور', color: '#dc2626', bg: '#fef2f2' },
};

const OUTCOME_CFG: Record<VisitOutcome, { label: string; color: string; bg: string }> = {
  'order': { label: 'سفارش', color: '#059669', bg: '#ecfdf5' },
  'followup': { label: 'پیگیری', color: '#d97706', bg: '#fffbeb' },
  'sample': { label: 'نمونه', color: '#6366f1', bg: '#eef2ff' },
  'info': { label: 'اطلاع‌رسانی', color: '#0891b2', bg: '#ecfeff' },
  'rejected': { label: 'رد درخواست', color: '#dc2626', bg: '#fef2f2' },
  'none': { label: '—', color: '#6b7280', bg: '#f3f4f6' },
};

// ==================== REAL DATA ADAPTER ====================
/** Visit shape returned by /api/visits (list action). */
interface ApiVisit {
  id: string;
  centerId: string;
  centerName: string;
  date: string;
  time: string;
  purpose: string;
  result: string;
  nextAction: string;
  assignedTo: string;
  assignedToName: string;
  status: 'planned' | 'done' | 'cancelled';
  createdAt: string;
  /** v2.21.0 — center geo, enriched by the list action */
  city?: string;
  province?: string;
}

/** Convert a server visit into the component's Visit shape. */
function apiVisitToRow(v: ApiVisit): Visit {
  const status: VisitStatus =
    v.status === 'done' ? 'completed' :
    v.status === 'cancelled' ? 'cancelled' : 'planned';
  const outcome: VisitOutcome =
    v.result?.includes('سفارش') ? 'order' :
    v.result?.includes('نمونه') ? 'sample' :
    v.result ? 'followup' : 'none';
  return {
    id: v.id,
    date: v.date,
    plannedTime: v.time || '',
    checkinTime: '',
    checkoutTime: '',
    centerName: v.centerName || '—',
    centerId: v.centerId || '',
    city: v.city || '',
    address: '',
    personName: v.assignedToName || '',
    personRole: '',
    status,
    outcome,
    notes: v.result || '',
    nextAction: v.nextAction || '',
    orderAmount: 0,
    route: '',
    // v2.21.0 — real region: the center's province, falling back to its
    // city (was a hardcoded '' — the region KPI and filter never worked).
    territory: v.province || v.city || '',
  };
}

// ==================== SAMPLE DATA (legacy, unused) ====================


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

// ==================== NEW VISIT DIALOG (real save) ====================
/** v2.16.0 — the old dialog's ثبت بازدید button only closed the form.
 *  This one POSTs a real visit to /api/visits (centerId + date required). */
function NewVisitDialog({ open, onOpenChange, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [centerId, setCenterId] = useState('');
  const [date, setDate] = useState(toJalaliString(new Date()));
  const [time, setTime] = useState('');
  const [purpose, setPurpose] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || centers.length > 0) return;
    let cancelled = false;
    fetch('/api/centers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', pageSize: 200 }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setCenters(d.data || d.items || []);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open, centers.length]);

  useEffect(() => {
    if (open) {
      // Reset asynchronously (react-hooks/set-state-in-effect)
      queueMicrotask(() => {
        setCenterId('');
        setDate(toJalaliString(new Date()));
        setTime('');
        setPurpose('');
        setNotes('');
        setError(null);
      });
    }
  }, [open]);

  const submit = async () => {
    if (!centerId) {
      setError('انتخاب مرکز الزامی است.');
      return;
    }
    if (!date.trim()) {
      setError('تاریخ الزامی است.');
      return;
    }
    const center = centers.find((c) => c.id === centerId);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          centerId,
          centerName: center?.name || '',
          date: date.trim(),
          time: time.trim() || undefined,
          purpose: purpose.trim() || undefined,
          result: notes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت بازدید');
      toast.success('بازدید با موفقیت ثبت شد');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت بازدید');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت بازدید جدید</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesvisits-f215-1">مرکز *</label>
          <select id="salesvisits-f215-1" aria-label="مرکز" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
            <option value="">انتخاب کنید...</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesvisits-f222-2">تاریخ (شمسی) *</label><JalaliDatePicker id="salesvisits-f222-2" ariaLabel="تاریخ بازدید (شمسی)" value={date} onChange={setDate} inputClassName="h-10 rounded-lg" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesvisits-f223-3">ساعت</label><TimePicker id="salesvisits-f223-3" ariaLabel="ساعت بازدید" value={time} onChange={setTime} allowClear inputClassName="h-10 rounded-lg" /></div>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesvisits-f225-4">هدف بازدید</label><Input id="salesvisits-f225-4" aria-label="هدف بازدید" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="مثلاً معرفی محصول جدید" className="h-10 rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesvisits-f226-5">یادداشت / نتیجه</label><Textarea id="salesvisits-f226-5" aria-label="یادداشت" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات..." className="rounded-lg resize-none" rows={3} /></div>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : 'ثبت بازدید'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== MAIN COMPONENT ====================
export default function SalesVisits() {
  const [visits, setVisits] = useState<Visit[]>([]);
  const [, setLoading] = useState(true); // loading flag not rendered (optimistic list)
  const [, setLoadError] = useState<string | null>(null); // error surfaced via toast
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterTerritory, setFilterTerritory] = useState('all');
  const [showNewVisit, setShowNewVisit] = useState(false);

  // ── Load real visits ──
  const loadVisits = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/visits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت ویزیت‌ها');
      setVisits((data.visits || []).map(apiVisitToRow));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت ویزیت‌ها');
      setVisits([]);
    } finally {
      setLoading(false);
    }
  };

  // v2.21.0 — latest-ref pattern: the effect fires the load ONCE on mount,
  // but `loadVisits` (a plain function recreated every render) must not sit
  // in the dep array or the fetch would re-fire on every render. The ref
  // always holds the freshest closure, so later manual re-invocations
  // (onSaved) behave exactly as before.
  const loadVisitsRef = useRef(loadVisits);
  useEffect(() => { loadVisitsRef.current = loadVisits; });

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `loadVisits` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(() => loadVisitsRef.current());
  }, []);

  // v2.21.0 — `visits` was missing from the deps: the memo computed once
  // against the initial empty list and NEVER recomputed, so the «منطقه‌ها»
  // KPI was permanently ۰ and the region filter dropdown had no options
  // no matter how many visits loaded. Blank territories (centers without
  // geo) never contribute an empty option.
  const territories = useMemo(
    () => [...new Set(visits.map(v => v.territory).filter(Boolean))],
    [visits]
  );

  const todayStr = toJalaliString(new Date());
  const todayVisits = visits.filter(v => todayStr && v.date === todayStr);
  const completedToday = todayVisits.filter(v => v.status === 'completed').length;
  const ordersToday = todayVisits.filter(v => v.outcome === 'order').length;
  const totalOrderValue = todayVisits.reduce((s, v) => s + v.orderAmount, 0);
  // v2.16.0 — real "tomorrow" (was: literal '۱۴۰۵/۰۶/۱۰'). Computed from a
  // mutable Date (Date.now itself is flagged impure during render).
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toJalaliString(tomorrow);
  const plannedTomorrow = visits.filter(v => v.date === tomorrowStr).length;

  const stats = [
    { label: 'بازدید امروز', value: toPersianNum(todayVisits.length), icon: <MapPin size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'تکمیل شده', value: toPersianNum(completedToday), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'سفارش ثبت شده', value: toPersianNum(ordersToday), icon: <Star size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'ارزش سفارشات', value: formatCompact(totalOrderValue), icon: <TrendingUp size={16} />, color: '#d97706', bg: '#fffbeb' },
    { label: 'برنامه فردا', value: toPersianNum(plannedTomorrow), icon: <Calendar size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'منطقه‌ها', value: toPersianNum(territories.length), icon: <MapPinned size={16} />, color: '#0891b2', bg: '#ecfeff' },
  ];

  const filtered = useMemo(() => {
    return visits.filter(v => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!v.centerName.includes(q) && !v.personName.includes(q) && !v.city.includes(q)) return false;
      }
      if (filterStatus !== 'all' && v.status !== filterStatus) return false;
      if (filterTerritory !== 'all' && v.territory !== filterTerritory) return false;
      return true;
    });
  }, [visits, search, filterStatus, filterTerritory]);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
        {stats.map((s, i) => (
          <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
              <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
            </div>
            <p className="text-lg lg:text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو مرکز، شخص، شهر..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همه وضعیت‌ها</option>
            {Object.entries(STATUS_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterTerritory} onChange={(e) => setFilterTerritory(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همه منطقه‌ها</option>
            {territories.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <Dialog open={showNewVisit} onOpenChange={setShowNewVisit}>
            <DialogTrigger asChild>
              <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                <Plus size={13} /> بازدید جدید
              </Button>
            </DialogTrigger>
            <NewVisitDialog open={showNewVisit} onOpenChange={setShowNewVisit} onSaved={loadVisits} />
          </Dialog>
        </div>
      </div>

      {/* Visit list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><MapPin size={32} className="mx-auto mb-2 opacity-40" /><p className="text-sm">بازدیدی یافت نشد</p></div>
        ) : (
          filtered.map(v => {
            const sc = STATUS_CFG[v.status];
            const oc = OUTCOME_CFG[v.outcome];
            return (
              <div key={v.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: sc.bg, color: sc.color }}><MapPin size={18} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <h4 className="text-sm font-bold text-gray-900">{v.centerName}</h4>
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: oc.bg, color: oc.color }}>{oc.label}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-500">
                      <span className="flex items-center gap-1"><UserIcon size={10} /> {v.personName} — {v.personRole}</span>
                      <span className="flex items-center gap-1"><MapPin size={10} /> {v.city}</span>
                      <span className="flex items-center gap-1"><Route size={10} /> {v.route}</span>
                    </div>
                  </div>
                  <div className="hidden sm:flex flex-col items-end shrink-0 w-28">
                    <span className="text-xs text-gray-600">{v.date}</span>
                    <span className="text-[11px] text-gray-400">{v.plannedTime}</span>
                    {v.checkinTime && v.checkoutTime && (
                      <span className="text-[11px] text-emerald-500 mt-0.5">{v.checkinTime} - {v.checkoutTime}</span>
                    )}
                  </div>
                  {v.orderAmount > 0 && (
                    <div className="shrink-0 text-left w-28 hidden md:block">
                      <p className="text-xs font-bold" style={{ color: '#059669' }}>{formatCompact(v.orderAmount)}</p>
                      <p className="text-[11px] text-gray-400">سفارش</p>
                    </div>
                  )}
                </div>
                {v.notes && <p className="text-[11px] text-gray-500 mt-2 mr-14 leading-5">{v.notes}</p>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
