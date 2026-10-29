'use client';

import React, { useState, useMemo, useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { ChevronRight, ChevronLeft, Plus, Clock, MapPin, Phone, Building2, User as UserIcon, Calendar as CalIcon, Check, AlertTriangle, Target, Flag, List, LayoutGrid, X, Handshake } from 'lucide-react';
import { gregorianToJalali, jalaliToGregorian, jalaliMonthLength, toJalaliKey, parseJalaliDate, jalaliPartsToString } from '@/lib/jalali';
// v2.36.0 (round 62) — popup Jalali calendar replaces the TYPED date field.
import { JalaliDatePicker } from '@/components/jalali-date-picker';
// v2.37.0 (round 63) — popup time picker replaces the TYPED time field.
import { TimePicker } from '@/components/time-picker';

// ==================== TYPES ====================
type EventCategory = 'visit' | 'call' | 'meeting' | 'followup' | 'task' | 'deadline';
type ViewMode = 'month' | 'week' | 'day' | 'agenda';

interface CalendarEvent {
  id: string;
  title: string;
  date: string; // Jalali 'YYYY-MM-DD' key (matches grid cells)
  startTime: string; // HH:MM
  endTime: string;
  category: EventCategory;
  centerName: string;
  personName: string;
  city: string;
  description: string;
 priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'done' | 'cancelled';
  isDone: boolean;
}

// ==================== CONFIGS ====================
const CATEGORY_CONFIG: Record<EventCategory, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  visit: { label: 'مراجعه حضوری', color: '#059669', bg: '#ecfdf5', icon: <MapPin size={12} /> },
  call: { label: 'تماس تلفنی', color: '#0891b2', bg: '#ecfeff', icon: <Phone size={12} /> },
  meeting: { label: 'جلسه', color: '#7c3aed', bg: '#f5f3ff', icon: <Handshake size={12} /> },
  followup: { label: 'پیگیری', color: '#d97706', bg: '#fffbeb', icon: <Target size={12} /> },
  task: { label: 'وظیفه', color: '#2E2A5C', bg: '#eef2ff', icon: <Check size={12} /> },
  deadline: { label: 'مهلت', color: '#dc2626', bg: '#fef2f2', icon: <AlertTriangle size={12} /> },
};

const PRIORITY_CONFIG = {
  high: { label: 'بالا', color: '#dc2626' },
  medium: { label: 'متوسط', color: '#d97706' },
  low: { label: 'پایین', color: '#059669' },
};

const JALALI_MONTHS = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const JALALI_WEEKDAYS = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

// ==================== REAL DATA ADAPTER ====================
/** Raw activity shape from /api/activities. */
interface ApiActivity {
  id: string;
  title: string;
  description: string;
  activityDate: string;
  activityTime: string;
  status: 'pending' | 'done' | 'cancelled';
  isPhoneCall: boolean;
  center: { id: string; name: string } | null;
  assignedUser: { id: string; displayName: string } | null;
}

/** Convert an activity into a calendar event.
 *  v2.16.0: the API stores Gregorian activityDate — the calendar grid is
 *  Jalali, so the event's date key is the CONVERTED Jalali date. The old
 *  code compared raw Gregorian strings against Jalali cell keys, so no
 *  event ever matched a day cell. */
function activityToEvent(a: ApiActivity): CalendarEvent {
  const isCall = a.isPhoneCall;
  const d = new Date(a.activityDate);
  const [jy, jm, jd] = isNaN(d.getTime())
    ? gregorianToJalali(2026, 1, 1)
    : gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  return {
    id: a.id,
    title: a.title,
    date: `${jy}-${String(jm).padStart(2, '0')}-${String(jd).padStart(2, '0')}`,
    startTime: a.activityTime || '',
    endTime: '',
    category: isCall ? 'call' : 'task',
    centerName: a.center?.name || '',
    personName: a.assignedUser?.displayName || '',
    city: '',
    description: a.description || '',
    priority: 'medium',
    status: a.status,
    isDone: a.status === 'done',
  };
}

// ==================== SAMPLE DATA (legacy, unused) ====================


// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

/** v2.16.0 — REAL Jalali month grid.
 *  Replaces the fake generator that hard-coded 31 days for every month,
 *  derived the first weekday from `(year*3 + month*2) % 7` and stamped
 *  every cell with a literal `1405-…` key. Month lengths now come from
 *  jalaliMonthLength (29/30/31 as appropriate), the leading weekday is
 *  the real one, and cells carry their true (year, month, day) —
 *  including year rollover on the Farvardin/Esfand borders. */
interface GridCell {
  day: number;
  isCurrentMonth: boolean;
  dateStr: string; // Jalali 'YYYY-MM-DD'
  isToday: boolean;
}
function getJalaliMonthGrid(year: number, month: number, todayKey: string): GridCell[][] {
  const daysInMonth = jalaliMonthLength(year, month);

  // Weekday column (0=شنبه … 6=جمعه) of the 1st of the month
  const [gy, gm, gd] = jalaliToGregorian(year, month, 1);
  const firstWeekday = (new Date(gy, gm - 1, gd).getDay() + 1) % 7;

  const key = (y: number, m: number, d: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevLen = jalaliMonthLength(prevYear, prevMonth);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  const cells: GridCell[] = [];
  for (let i = firstWeekday - 1; i >= 0; i--) {
    const d = prevLen - i;
    cells.push({ day: d, isCurrentMonth: false, dateStr: key(prevYear, prevMonth, d), isToday: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const k = key(year, month, d);
    cells.push({ day: d, isCurrentMonth: true, dateStr: k, isToday: k === todayKey });
  }
  let nextDay = 1;
  while (cells.length % 7 !== 0 || cells.length < 35) {
    cells.push({
      day: nextDay,
      isCurrentMonth: false,
      dateStr: key(nextYear, nextMonth, nextDay),
      isToday: false,
    });
    nextDay++;
  }

  const weeks: GridCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ==================== EVENT DOT INDICATORS ====================
function EventDots({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5 mt-1 flex-wrap">
      {events.slice(0, 4).map((e) => (
        <div key={e.id} className="w-2 h-2 rounded-full shrink-0" style={{ background: CATEGORY_CONFIG[e.category].color }} title={e.title} />
      ))}
      {events.length > 4 && <span className="text-[8px] text-gray-400">+{toPersianNum(events.length - 4)}</span>}
    </div>
   );
}

// ==================== EVENT CARD ====================
function EventCard({ event, onToggle }: { event: CalendarEvent; onToggle: (id: string) => void }) {
  const cat = CATEGORY_CONFIG[event.category];
  return (
    <div className={`group rounded-xl border p-3 transition-all hover:shadow-md ${event.isDone ? 'bg-gray-50/80 border-gray-100' : 'bg-white border-gray-100'}`}>
      <div className="flex items-start gap-2.5">
        <button
          onClick={() => onToggle(event.id)}
          className={`mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-all ${event.isDone ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 hover:border-gray-400'}`}
        >
          {event.isDone && <Check size={12} className="text-white" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${event.isDone ? 'opacity-50' : ''}`} style={{ background: cat.bg, color: cat.color }}>
              {cat.icon} {cat.label}
            </span>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: PRIORITY_CONFIG[event.priority].color }} />
          </div>
          <h4 className={`text-sm font-bold mb-1 ${event.isDone ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{event.title}</h4>
          <div className="flex items-center gap-3 text-[11px] text-gray-500 mb-1.5">
            <span className="flex items-center gap-1"><Clock size={11} /> {event.startTime || '—'}</span>
            <span className="flex items-center gap-1"><Building2 size={11} /> {event.centerName}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-gray-400">
            <span className="flex items-center gap-1"><UserIcon size={11} /> {event.personName}</span>
            <span className="flex items-center gap-1"><MapPin size={11} /> {event.city}</span>
          </div>
          {event.description && (
            <p className={`text-xs mt-2 text-gray-400 leading-5 ${event.isDone ? 'line-through' : ''}`}>{event.description}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ==================== NEW EVENT DIALOG (real save) ====================
/** v2.16.0 — the old dialog's submit button only closed the form; nothing
 *  was persisted. This one POSTs a real activity to /api/activities.
 *  Categories are limited to the two the backend actually distinguishes
 *  (task vs phone-call) — the legacy 6-category select collapsed to
 *  "task" on reload anyway. */
function NewEventDialog({ open, onOpenChange, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const todayParts = toJalaliKey().split('-');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(jalaliPartsToString(Number(todayParts[0]), Number(todayParts[1]), Number(todayParts[2])));
  const [time, setTime] = useState('');
  const [isCall, setIsCall] = useState(false);
  const [centerId, setCenterId] = useState('');
  const [description, setDescription] = useState('');
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
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
      // Reset asynchronously — no synchronous setState in the effect body
      // (react-hooks/set-state-in-effect), matching the dialogs pattern in
      // sales-docs-dialogs.tsx.
      queueMicrotask(() => {
        setTitle('');
        setDate(jalaliPartsToString(Number(todayParts[0]), Number(todayParts[1]), Number(todayParts[2])));
        setTime('');
        setIsCall(false);
        setCenterId('');
        setDescription('');
        setError(null);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    if (!title.trim()) {
      setError('عنوان رویداد الزامی است.');
      return;
    }
    const parts = parseJalaliDate(date);
    if (!parts) {
      setError('تاریخ را به فرمت ۱۴۰۵/۰۶/۱۵ وارد کنید.');
      return;
    }
    const [gy, gm, gd] = jalaliToGregorian(parts[0], parts[1], parts[2]);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: title.trim(),
          description: description.trim() || undefined,
          activityDate: new Date(gy, gm - 1, gd, 12).toISOString(),
          activityTime: time.trim() || undefined,
          isPhoneCall: isCall,
          centerId: centerId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت رویداد');
      toast.success('رویداد با موفقیت ثبت شد');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت رویداد');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت رویداد جدید</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f306-1">عنوان *</label><Input id="salescalendar-f306-1" aria-label="عنوان رویداد" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان رویداد" className="h-10 rounded-lg" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f308-2">تاریخ (شمسی) *</label><JalaliDatePicker id="salescalendar-f308-2" ariaLabel="تاریخ رویداد (شمسی)" value={date} onChange={setDate} inputClassName="h-10 rounded-lg" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f309-3">نوع</label>
            <select id="salescalendar-f309-3" aria-label="نوع رویداد" value={isCall ? 'call' : 'task'} onChange={(e) => setIsCall(e.target.value === 'call')} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
              <option value="task">وظیفه / جلسه</option>
              <option value="call">تماس تلفنی</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f317-4">ساعت</label>
          {/* v2.37.0 (round 63) — popup time picker replaces the typed field */}
          <TimePicker id="salescalendar-f317-4" ariaLabel="ساعت رویداد" value={time} onChange={setTime} allowClear inputClassName="h-10 rounded-lg" />
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f320-5">مرکز / مشتری (اختیاری)</label>
          <select id="salescalendar-f320-5" aria-label="مرکز یا مشتری" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
            <option value="">— بدون مرکز —</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalendar-f326-6">توضیحات</label><Input id="salescalendar-f326-6" aria-label="توضیحات" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="توضیحات اختیاری" className="h-10 rounded-lg" /></div>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : 'ثبت رویداد'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== MAIN CALENDAR ====================
export default function SalesCalendar() {
  // v2.16.0 — year/month are real state initialized from TODAY's Jalali
  // date (was: month=6, year=1405 constants, "امروز" button jumped to 6).
  const todayKey = toJalaliKey();
  const [todayParts] = useState(() => todayKey.split('-').map(Number));
  const [currentMonth, setCurrentMonth] = useState(todayParts[1]);
  const [currentYear, setCurrentYear] = useState(todayParts[0]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [, setLoading] = useState(true); // loading flag not rendered (events list is optimistic)
  const [, setLoadError] = useState<string | null>(null); // error surfaced via toast
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [showAddDialog, setShowAddDialog] = useState(false);

  // ── Load real activities as calendar events ──
  const loadEvents = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', pageSize: 200 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت رویدادها');
      setEvents((data.items || []).map(activityToEvent));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت رویدادها');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `loadEvents` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(loadEvents);
  }, []);

  // v2.23.0 — the done-toggle used to be client-only state: the check
  // filled, the card struck through, and a reload resurrected the event
  // as pending (nothing was ever sent to the server). It now persists
  // through /api/activities update — optimistic flip, revert on failure.
  const toggleDone = (id: string) => {
    // Compute the next value from the CURRENT render's list BEFORE any
    // setState: React defers the updater callback, so reading it inside
    // the updater would race the fetch payload (it fired with the stale
    // pre-toggle value — the exact bug the v2.23.0 battery caught).
    const target = events.find(e => e.id === id);
    if (!target) return;
    const nextIsDone = !target.isDone;
    setEvents(prev => prev.map(e => e.id === id
      ? { ...e, isDone: nextIsDone, status: nextIsDone ? 'done' : 'pending' }
      : e));
    void (async () => {
      try {
        const res = await fetch('/api/activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update', id, status: nextIsDone ? 'done' : 'pending' }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'خطا در به‌روزرسانی وضعیت رویداد');
        }
      } catch (e) {
        // Revert the optimistic flip — the server is the referee.
        setEvents(prev => prev.map(ev => ev.id === id
          ? { ...ev, isDone: !nextIsDone, status: !nextIsDone ? 'done' : 'pending' }
          : ev));
        toast.error(e instanceof Error ? e.message : 'خطا در به‌روزرسانی وضعیت رویداد');
      }
    })();
  };

  const grid = useMemo(() => getJalaliMonthGrid(currentYear, currentMonth, todayKey), [currentYear, currentMonth, todayKey]);

  const getEventsForDate = (dateStr: string) => {
    return events.filter(e => {
      if (e.date !== dateStr) return false;
      if (filterCategory !== 'all' && e.category !== filterCategory) return false;
      return true;
    });
  };

  const selectedEvents = selectedDate ? getEventsForDate(selectedDate) : [];
  const isToday = (dateStr: string) => dateStr === todayKey;

  // Month navigation with year rollover (was: month wrapped 12↔1 while the
  // year stayed frozen at 1405)
  const prevMonth = () => {
    if (currentMonth > 1) setCurrentMonth((m) => m - 1);
    else { setCurrentMonth(12); setCurrentYear((y) => y - 1); }
  };
  const nextMonth = () => {
    if (currentMonth < 12) setCurrentMonth((m) => m + 1);
    else { setCurrentMonth(1); setCurrentYear((y) => y + 1); }
  };
  const goToday = () => {
    setCurrentYear(todayParts[0]);
    setCurrentMonth(todayParts[1]);
  };

  // Stats
  const todayEvents = events.filter(e => e.date === todayKey);
  const pendingCount = events.filter(e => !e.isDone).length;
  const todayPending = todayEvents.filter(e => !e.isDone).length;
  const highPriorityCount = events.filter(e => e.priority === 'high' && !e.isDone).length;

  return (
    <div className="flex flex-col lg:flex-row gap-4 min-h-[calc(100vh-120px)]">
      {/* ===== LEFT: CALENDAR GRID ===== */}
      <div className="flex-1 flex flex-col">
        {/* Stats bar */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'رویدادهای امروز', value: toPersianNum(todayPending), color: '#1F8B7D', bg: '#ecfdf5', icon: <CalIcon size={16} /> },
            { label: 'در انتظار انجام', value: toPersianNum(pendingCount), color: '#d97706', bg: '#fffbeb', icon: <Clock size={16} /> },
            { label: 'اولویت بالا', value: toPersianNum(highPriorityCount), color: '#dc2626', bg: '#fef2f2', icon: <Flag size={16} /> },
          ].map((s, i) => (
            <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 80}ms` }}>
              <div className="flex items-center gap-2 mb-1.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
                <span className="text-[11px] text-gray-400">{s.label}</span>
              </div>
              <p className="text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Calendar header */}
        <div className="bg-white rounded-t-xl border border-gray-100 border-b-0 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-bold text-gray-900">{JALALI_MONTHS[currentMonth - 1]} {toPersianNum(currentYear)}</h2>
              <span className="text-xs text-gray-400">شمسی</span>
            </div>
            <div className="flex items-center gap-2">
              {/* Category filter */}
              <div className="flex items-center gap-1 mr-2">
                {(['all','visit','call','meeting','followup','task','deadline'] as const).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setFilterCategory(cat)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                      filterCategory === cat
                        ? 'text-white shadow-sm'
                        : 'text-gray-500 hover:bg-gray-50'
                    }`}
                    style={filterCategory === cat ? { background: cat === 'all' ? '#2E2A5C' : CATEGORY_CONFIG[cat as EventCategory]?.color || '#2E2A5C' } : undefined}
                  >
                    {cat === 'all' ? 'همه' : CATEGORY_CONFIG[cat as EventCategory]?.label}
                  </button>
                ))}
              </div>

              {/* View mode */}
              <div className="flex items-center border border-gray-200 rounded-lg overflow-hidden">
                <button onClick={() => setViewMode('month')} className={`p-1.5 transition-colors ${viewMode === 'month' ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-50'}`}><LayoutGrid size={14} /></button>
                <button onClick={() => setViewMode('agenda')} className={`p-1.5 transition-colors ${viewMode === 'agenda' ? 'bg-gray-900 text-white' : 'text-gray-400 hover:bg-gray-50'}`}><List size={14} /></button>
              </div>

              {/* Nav */}
              <button onClick={prevMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="ماه قبل"><ChevronRight size={16} /></button>
              <button onClick={goToday} className="px-2.5 py-1.5 rounded-lg bg-gray-100 text-gray-600 text-xs font-medium hover:bg-gray-200">امروز</button>
              <button onClick={nextMonth} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500" title="ماه بعد"><ChevronLeft size={16} /></button>

              {/* Add */}
              <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
                <DialogTrigger asChild>
                  <Button className="h-8 gap-1 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                    <Plus size={13} /> رویداد جدید
                  </Button>
                </DialogTrigger>
                <NewEventDialog open={showAddDialog} onOpenChange={setShowAddDialog} onSaved={loadEvents} />
              </Dialog>
            </div>
          </div>
        </div>

        {viewMode === 'month' ? (
          /* ===== MONTH GRID VIEW ===== */
          <div className="bg-white rounded-b-xl border border-gray-100 overflow-hidden">
            {/* Weekday headers */}
            <div className="grid grid-cols-7 border-b border-gray-100">
              {JALALI_WEEKDAYS.map((d, i) => (
                <div key={i} className={`text-center py-2.5 text-xs font-bold ${i === 6 ? 'text-red-400' : 'text-gray-500'}`}>{d}</div>
              ))}
            </div>
            {/* Day cells */}
            <div className="grid grid-cols-7">
              {grid.flatMap((week) => week.map((cell, ci) => {
                const dayEvents = getEventsForDate(cell.dateStr);
                const today = isToday(cell.dateStr);
                const selected = selectedDate === cell.dateStr;
                return (
                  <button
                    key={`${cell.day}-${ci}`}
                    onClick={() => setSelectedDate(cell.dateStr)}
                    className={`relative border-b border-r border-gray-50 p-2 min-h-[90px] text-right transition-colors hover:bg-gray-50/50 ${
                      !cell.isCurrentMonth ? 'bg-gray-50/30' : ''
                    } ${selected ? 'bg-teal-50/50 ring-2 ring-inset ring-teal-400/30' : ''}`}
                  >
                    <span className={`text-sm font-medium inline-flex items-center justify-center w-7 h-7 rounded-full ${
                      today ? 'bg-teal-500 text-white' : cell.isCurrentMonth ? 'text-gray-900' : 'text-gray-300'
                    }`}>
                      {toPersianNum(cell.day)}
                    </span>
                    <EventDots events={dayEvents} />
                    {dayEvents.length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {dayEvents.slice(0, 2).map(e => (
                          <div key={e.id} className="text-[11px] font-medium truncate px-1.5 py-0.5 rounded" style={{ background: `${CATEGORY_CONFIG[e.category].color}15`, color: CATEGORY_CONFIG[e.category].color }}>
                            {e.isDone ? '✓ ' : ''}{e.startTime} {e.title}
                          </div>
                        ))}
                        {dayEvents.length > 2 && (
                          <div className="text-[11px] text-gray-400 px-1.5">+{toPersianNum(dayEvents.length - 2)} دیگر</div>
                        )}
                      </div>
                    )}
                  </button>
                );
              }))}
            </div>
          </div>
        ) : (
          /* ===== AGENDA VIEW ===== */
          <div className="bg-white rounded-b-xl border border-gray-100 overflow-hidden">
            <div className="divide-y divide-gray-50">
              {events.filter(e => filterCategory === 'all' || e.category === filterCategory).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)).map((event, i) => {
                const cat = CATEGORY_CONFIG[event.category];
                return (
                  <div key={event.id} className="flex items-center gap-4 p-4 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0" style={{ animationDelay: `${i * 30}ms` }}>
                    <div className="w-16 text-center shrink-0">
                      <p className="text-lg font-bold text-gray-900">{toPersianNum(event.date.split('-')[2])}</p>
                      <p className="text-[11px] text-gray-400">{JALALI_MONTHS[parseInt(event.date.split('-')[1]) - 1]}</p>
                    </div>
                    <div className={`w-1 h-12 rounded-full shrink-0`} style={{ background: cat.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${event.isDone ? 'opacity-50' : ''}`} style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
                        <h4 className={`text-sm font-bold ${event.isDone ? 'text-gray-400 line-through' : 'text-gray-900'}`}>{event.title}</h4>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-400">
                        <span className="flex items-center gap-1"><Clock size={10} /> {event.startTime}</span>
                        <span className="flex items-center gap-1"><Building2 size={10} /> {event.centerName}</span>
                        <span className="flex items-center gap-1"><UserIcon size={10} /> {event.personName}</span>
                      </div>
                    </div>
                    <button onClick={() => toggleDone(event.id)} className={`w-6 h-6 rounded-full border-2 flex items-center justify-center shrink-0 transition-all ${event.isDone ? 'bg-emerald-500 border-emerald-500' : 'border-gray-300 hover:border-gray-400'}`}>
                      {event.isDone && <Check size={12} className="text-white" />}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ===== RIGHT: SELECTED DATE DETAIL ===== */}
      <div className="w-full lg:w-[380px] shrink-0">
        <div className="bg-white rounded-xl border border-gray-100 p-4 sticky top-20">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-gray-900">
              {selectedDate
                ? `${toPersianNum(selectedDate.split('-')[2])} ${JALALI_MONTHS[parseInt(selectedDate.split('-')[1]) - 1]}`
                : 'انتخاب تاریخ'}
            </h3>
            {selectedDate && (
              <button onClick={() => setSelectedDate(null)} className="text-gray-400 hover:text-gray-600 p-1"><X size={14} /></button>
            )}
          </div>

          {selectedDate ? (
            <div className="space-y-3 max-h-[60vh] overflow-y-auto scrollbar-thin">
              {selectedEvents.length === 0 ? (
                <div className="text-center py-8 text-gray-400">
                  <CalIcon size={32} className="mx-auto mb-2 opacity-40" />
                  <p className="text-sm">رویدادی یافت نشد</p>
                </div>
              ) : (
                selectedEvents.map(event => (
                  <EventCard key={event.id} event={event} onToggle={toggleDone} />
                ))
              )}
            </div>
          ) : (
            /* Upcoming events — v2.37.0 (round 63): truly FUTURE events
               (today onwards), where quick-activity's «ثبت در تقویم»
               rows land. */
            <div className="space-y-3">
              <p className="text-xs text-gray-400 font-medium mb-3">رویدادهای پیش‌رو</p>
              {(() => {
                const upcoming = events
                  .filter(e => !e.isDone && e.date >= todayKey)
                  .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))
                  .slice(0, 5);
                if (upcoming.length === 0) {
                  return (
                    <p className="text-[11px] text-gray-300 py-2">رویداد پیش‌رویی ثبت نشده است.</p>
                  );
                }
                return upcoming.map(event => {
                const cat = CATEGORY_CONFIG[event.category];
                return (
                  <button
                    key={event.id}
                    onClick={() => setSelectedDate(event.date)}
                    className="w-full text-right rounded-xl border border-gray-100 p-3 hover:bg-gray-50 hover:shadow-sm transition-all"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: cat.color }} />
                      <span className="text-xs font-bold text-gray-900 truncate flex-1">{event.title}</span>
                      <span className="text-[11px] text-gray-400">{toPersianNum(event.date.split('-')[2])}/{toPersianNum(event.date.split('-')[1])}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-400 mr-4">
                      <span className="flex items-center gap-0.5"><Clock size={9} /> {event.startTime}</span>
                      <span className="flex items-center gap-0.5"><Building2 size={9} /> {event.centerName}</span>
                    </div>
                  </button>
                );
                });
              })()}
            </div>
          )}

          {/* Legend */}
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-[11px] text-gray-400 font-medium mb-2">راهنما</p>
            <div className="grid grid-cols-2 gap-1.5">
              {Object.entries(CATEGORY_CONFIG).map(([k, v]) => (
                <div key={k} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                  <div className="w-2.5 h-2.5 rounded" style={{ background: v.color }} />
                  {v.label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}