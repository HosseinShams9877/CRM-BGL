'use client';

import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { toJalaliString, gregorianIsoToJalaliString, jalaliStringToGregorianIso } from '@/lib/jalali';
// v2.36.0 (round 62) — popup Jalali calendar replaces the NATIVE type="date"
// (Gregorian!) input: call dates are now picked on a Shamsi popup too.
import { JalaliDatePicker } from '@/components/jalali-date-picker';
// v2.37.0 (round 63) — popup time picker replaces the native type="time" input.
import { TimePicker } from '@/components/time-picker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { useTabAccess } from '@/components/access-context';
import { PreCallBriefCard } from '@/components/ai-sales/pre-call-brief-card';
import {
  Plus, Search, Phone, PhoneCall, PhoneForwarded, PhoneMissed,
  Clock, User as UserIcon, MapPin, Calendar,
  Check, ChevronDown, ArrowRight, Volume2, Pause,
  RefreshCw, Timer, Loader2,
} from 'lucide-react';
// v2.44.0 (round 69) — «نهایتاً سی تماس آخری را نمایش بده؛ بقیه با مشاهده‌ی بیشتر»:
// pure reveal/paging contract shared with tests/call-list-pagination.test.ts.
import {
  CALLS_REVEAL_STEP, CALLS_FETCH_PAGE_SIZE,
  initCallListPaging, planRevealMore, applyReveal, applyFetchedPage, countRemaining,
  type CallListPaging,
} from '@/lib/call-list-pagination';

// ==================== TYPES ====================
type CallStatus = 'completed' | 'no-answer' | 'busy' | 'callback' | 'scheduled' | 'in-progress';
type CallDirection = 'inbound' | 'outbound';
type CallTab = 'log' | 'history' | 'scheduled';

interface CallRecord {
  id: string;
  centerName: string;
  personName: string;
  phone: string;
  city: string;
  direction: CallDirection;
  status: CallStatus;
  duration: string; // MM:SS or ''
  date: string; // Jalali display string (v2.18.0 — was raw Gregorian ISO)
  dateIso: string; // YYYY-MM-DD (Gregorian) for "today" filtering
  time: string;
  subject: string;
  result: string;
  notes: string;
  nextAction: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  recording?: boolean;
}

// ==================== CONFIGS ====================
const STATUS_CONFIG: Record<CallStatus, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  'completed': { label: 'تکمیل شده', color: '#059669', bg: '#ecfdf5', icon: <PhoneCall size={14} /> },
  'no-answer': { label: 'بدون پاسخ', color: '#dc2626', bg: '#fef2f2', icon: <PhoneMissed size={14} /> },
  'busy': { label: 'مشغول', color: '#d97706', bg: '#fffbeb', icon: <PhoneForwarded size={14} /> },
  'callback': { label: 'تماس مجدد', color: '#0891b2', bg: '#ecfeff', icon: <RefreshCw size={14} /> },
  'scheduled': { label: 'برنامه‌ریزی شده', color: '#6366f1', bg: '#eef2ff', icon: <Calendar size={14} /> },
  'in-progress': { label: 'در حال تماس', color: '#1F8B7D', bg: '#ecfdf5', icon: <Phone size={14} /> },
};

const PRIORITY_CFG = {
  high: { label: 'بالا', color: '#dc2626', bg: '#fef2f2' },
  medium: { label: 'متوسط', color: '#d97706', bg: '#fffbeb' },
  low: { label: 'پایین', color: '#059669', bg: '#ecfdf5' },
};

// v2.18.0 — DIRECTION_CONFIG removed: direction is stored on each record
// and rendered inline; the label map was never shown.

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

/** Convert a phone-call activity into a CallRecord. */
function activityToCall(a: ApiActivity): CallRecord {
  const status: CallStatus =
    a.status === 'done' ? 'completed' :
    a.status === 'cancelled' ? 'busy' :
    'scheduled';
  // v2.18.0 — session-recorded calls persist the phone number and the
  // conversation duration inside the description ("شماره: ..." /
  // "مدت مکالمه: MM:SS"). Parse them back so the list, the "today" stats
  // and تماس مجدد actually carry the data.
  const desc = a.description || '';
  const phoneMatch = desc.match(/شماره:\s*([0-9۰-۹+\-\s]{4,20})/);
  const durationMatch = desc.match(/مدت مکالمه:\s*(\d{1,3}:\d{2})/);
  return {
    id: a.id,
    centerName: a.center?.name || '—',
    personName: a.assignedUser?.displayName || '—',
    phone: phoneMatch ? phoneMatch[1].trim() : '',
    city: '',
    direction: 'outbound',
    status,
    duration: durationMatch ? durationMatch[1] : '',
    date: toJalaliString(a.activityDate),
    dateIso: a.activityDate.slice(0, 10),
    time: a.activityTime || '',
    subject: a.title,
    result: a.status === 'done' ? 'انجام شد' : '',
    notes: desc,
    nextAction: '',
    priority: 'medium',
    category: 'general',
  };
}

// ==================== SAMPLE DATA (legacy, unused) ====================


// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

// ==================== CALL STATS ====================
function CallStats({ calls }: { calls: CallRecord[] }) {
  // v2.18.0 — "today" used to be a HARDCODED Jalali date string compared
  // against a GREGORIAN ISO date — the match never fired and every
  // today-stat showed zero. Compare real Gregorian ISO dates instead.
  // v2.58.0 (audit 85-b): LOCAL date, not UTC — between 00:00 and 03:30
  // Tehran, the UTC slice still held YESTERDAY, so the "today" stats
  // counted the wrong day (dates are stored with the noon-local anchor
  // convention, see quick-activity.tsx).
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const todayCalls = calls.filter(c => c.dateIso === todayIso);
  const totalToday = todayCalls.length;
  const completedToday = todayCalls.filter(c => c.status === 'completed').length;
  const totalDuration = todayCalls.reduce((s, c) => {
    if (!c.duration) return s;
    const parts = c.duration.split(':').map(Number);
    return s + (parts[0] || 0) * 60 + (parts[1] || 0);
  }, 0);
  const noAnswer = todayCalls.filter(c => c.status === 'no-answer' || c.status === 'busy').length;
  const scheduled = calls.filter(c => c.status === 'scheduled').length;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
      {[
        { label: 'تماس‌های امروز', value: toPersianNum(totalToday), icon: <Phone size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
        { label: 'تکمیل شده', value: toPersianNum(completedToday), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
        { label: 'مدت مکالمه', value: `${toPersianNum(Math.floor(totalDuration / 60))}:${toPersianNum(String(totalDuration % 60).padStart(2, '0'))}`, icon: <Clock size={16} />, color: '#0891b2', bg: '#ecfeff' },
        { label: 'بدون پاسخ', value: toPersianNum(noAnswer), icon: <PhoneMissed size={16} />, color: '#dc2626', bg: '#fef2f2' },
        { label: 'برنامه‌ریزی شده', value: toPersianNum(scheduled), icon: <Calendar size={16} />, color: '#6366f1', bg: '#eef2ff' },
      ].map((s, i) => (
        <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
            <span className="text-[11px] text-gray-400">{s.label}</span>
          </div>
          <p className="text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
        </div>
      ))}
    </div>
  );
}

// ==================== CALL RECORD ROW ====================
function CallRow({ call, onCallback, onFollowup }: { call: CallRecord; onCallback: (c: CallRecord) => void; onFollowup: (c: CallRecord) => void }) {
  const sc = STATUS_CONFIG[call.status];
  const pc = PRIORITY_CFG[call.priority];
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-sm transition-all animate-fade-in-up opacity-0 group">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-right"
      >
        <div className="flex items-center gap-3 p-4">
          {/* Direction + Status icon */}
          <div className="relative">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: sc.bg, color: sc.color }}>
              {call.direction === 'inbound' ? <PhoneCall size={18} /> : <Phone size={18} />}
            </div>
            <div className={`absolute -bottom-0.5 -left-0.5 w-4 h-4 rounded-full flex items-center justify-center text-white text-[7px] font-bold ${call.direction === 'inbound' ? 'bg-emerald-500' : 'bg-indigo-500'}`}>
              {call.direction === 'inbound' ? '↓' : '↑'}
            </div>
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-sm font-bold text-gray-900 truncate">{call.centerName}</h4>
              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: pc.bg, color: pc.color }}>{pc.label}</span>
              {call.recording && <span className="text-[11px] text-red-400 flex items-center gap-0.5"><Volume2 size={9} /> ضبط</span>}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-gray-500">
              <span className="flex items-center gap-1"><UserIcon size={10} /> {call.personName}</span>
              <span className="flex items-center gap-1"><MapPin size={10} /> {call.city}</span>
              <span dir="ltr" className="flex items-center gap-1"><Phone size={10} /> {call.phone}</span>
            </div>
          </div>

          {/* Subject + Result */}
          <div className="hidden md:block w-48 shrink-0">
            <p className="text-xs font-medium text-gray-700 truncate">{call.subject}</p>
            {call.result && <p className="text-[11px] text-gray-400 truncate mt-0.5">{call.result}</p>}
          </div>

          {/* Duration + Status */}
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: sc.bg, color: sc.color }}>
              {sc.icon} {sc.label}
            </span>
            {call.duration && (
              <span className="text-[11px] text-gray-400 flex items-center gap-1"><Clock size={9} /> {call.duration}</span>
            )}
          </div>

          {/* Date */}
          <div className="hidden sm:flex flex-col items-end shrink-0 w-20">
            <span className="text-xs text-gray-600">{call.date}</span>
            <span className="text-[11px] text-gray-400">{call.time}</span>
          </div>

          <ChevronDown size={14} className={`text-gray-300 transition-transform ${expanded ? 'rotate-180' : ''} shrink-0`} />
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-gray-50 p-4 bg-gray-50/30 animate-fade-in">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h5 className="text-xs font-bold text-gray-500 mb-2">نتیجه تماس</h5>
              <p className="text-sm text-gray-700 leading-6">{call.result || 'نتیجه‌ای ثبت نشده'}</p>
            </div>
            <div>
              <h5 className="text-xs font-bold text-gray-500 mb-2">یادداشت‌ها</h5>
              <p className="text-sm text-gray-700 leading-6">{call.notes || 'یادداشتی ثبت نشده'}</p>
            </div>
          </div>
          {call.nextAction && (
            <div className="mt-3 p-3 bg-white rounded-lg border border-gray-100">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ArrowRight size={13} className="text-teal-600" />
                  <span className="text-xs font-bold text-gray-700">عملکرد بعدی:</span>
                  <span className="text-xs text-gray-600">{call.nextAction}</span>
                </div>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium">{call.category}</span>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" className="h-8 gap-1 text-xs rounded-lg text-white" style={{ background: '#1F8B7D' }} onClick={(e) => { e.stopPropagation(); onCallback(call); }}>
              <Phone size={12} /> تماس مجدد
            </Button>
            {/* v2.18.0 — the follow-up button was dead; it now opens a real
                follow-up dialog (activity on /api/activities). The messaging
                button was removed — no messaging subsystem exists to back it. */}
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg" onClick={(e) => { e.stopPropagation(); onFollowup(call); }}>
              <Plus size={12} /> پیگیری جدید
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== REAL CALL SESSION HELPERS (P1-7) ====================
/** Persian keypad digits → Latin, so `tel:` links dial correctly. */
function toLatinDigits(s: string): string {
  return s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function formatDuration(s: number): string {
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface CallSession {
  phone: string;
  centerName?: string;
}

// ==================== DIALER PAD (Quick — real keypad, Latin digits) ====================
function QuickDialer({ onCall }: { onCall: (phone: string) => void }) {
  const [number, setNumber] = useState('');
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <h3 className="text-sm font-bold text-gray-900 mb-3">شماره‌گیری سریع</h3>
      <div className="flex gap-2 mb-3">
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="شماره تلفن..."
          className="flex-1 h-10 rounded-lg text-sm"
          dir="ltr"
        />
        <Button
          onClick={() => onCall(number.trim())}
          disabled={!number.trim()}
          aria-label="شروع جلسهٔ تماس"
          className="h-10 w-10 p-0 rounded-lg text-white shrink-0"
          style={{ background: '#059669' }}
        >
          <Phone size={16} />
        </Button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        {['1','2','3','4','5','6','7','8','9','*','0','#'].map((d) => (
          <button
            key={d}
            onClick={() => setNumber(p => p + d)}
            aria-label={`رقم ${d}`}
            className="h-10 rounded-lg bg-gray-50 hover:bg-gray-100 text-sm font-bold text-gray-700 transition-colors active:bg-gray-200"
          >{d}</button>
        ))}
      </div>
    </div>
  );
}

// ==================== NEW CALL DIALOG (real: creates activity) ====================
function NewCallDialog({ centers, onCreated, open, onOpenChange, prefill }: {
  centers: Array<{ id: string; name: string }>;
  onCreated: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled from a tracked call session (P1-7). */
  prefill?: { phone?: string; durationSec?: number };
}) {
  const [centerId, setCenterId] = useState('');
  const [subject, setSubject] = useState('');
  // hydrated from prefill at mount (parent remounts via key when prefill changes)
  const [phone, setPhone] = useState(prefill?.phone ?? '');
  // v2.36.0 (round 62) — local-time 'today' (the old toISOString() slice
  // drifted to the PREVIOUS day between 00:00–03:30 Tehran time), written
  // through the Jalali bridge so picker and state can never disagree.
  const [date, setDate] = useState(() => jalaliStringToGregorianIso(toJalaliString(new Date())));
  const [time, setTime] = useState(new Date().toTimeString().slice(0, 5));
  const [category, setCategory] = useState('فروش');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!subject.trim()) {
      setError('موضوع تماس الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const meta: string[] = [];
      if (phone.trim()) meta.push(`شماره: ${phone.trim()}`);
      if (prefill?.durationSec && prefill.durationSec > 0) meta.push(`مدت مکالمه: ${formatDuration(prefill.durationSec)}`);
      const description = [...meta, notes.trim()].filter(Boolean).join('\n');
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: `[تماس: ${category}] ${subject}`,
          description,
          activityDate: date,
          activityTime: time,
          isPhoneCall: true,
          centerId: centerId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت تماس');
      toast.success('تماس با موفقیت ثبت شد');
      setSubject(''); setNotes(''); setPhone('');
      onOpenChange(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت تماس');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <Plus size={13} /> تماس جدید
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
        <DialogHeader><DialogTitle>ثبت تماس جدید</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f386-1">مرکز</label>
            <select id="salescalls-f386-1" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
              <option value="">بدون مرکز</option>
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          {/* v2.27.0 — Pre-Call AI Brief: once a center is picked, the AI
              suggests topics/questions grounded in that customer's real
              history BEFORE the rep dials. */}
          {centerId && (
            <PreCallBriefCard centerId={centerId} centerName={centers.find((c) => c.id === centerId)?.name} />
          )}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f393-2">تاریخ (شمسی)</label><JalaliDatePicker id="salescalls-f393-2" ariaLabel="تاریخ تماس (شمسی)" value={gregorianIsoToJalaliString(date)} onChange={(j) => setDate(jalaliStringToGregorianIso(j))} inputClassName="h-10 rounded-lg" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f394-3">ساعت</label><TimePicker id="salescalls-f394-3" ariaLabel="ساعت تماس" value={time} onChange={setTime} inputClassName="h-10 rounded-lg" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f398-4">شماره تماس</label>
              <Input id="salescalls-f398-4" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="۰۹۱۲..." className="h-10 rounded-lg" dir="ltr" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f402-5">دسته‌بندی</label>
              <select id="salescalls-f402-5" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
                <option>فروش</option><option>وصول</option><option>فنی</option><option>بازاریابی</option><option>پشتیبانی</option>
              </select>
            </div>
          </div>
          {prefill?.durationSec ? (
            <div className="flex items-center gap-2 text-xs text-teal-700 bg-teal-50 rounded-lg px-3 py-2">
              <Timer size={14} />
              مدت مکالمهٔ ثبت‌شده: <span className="font-mono font-bold" dir="ltr">{formatDuration(prefill.durationSec)}</span>
            </div>
          ) : null}
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f414-6">موضوع تماس *</label><Input id="salescalls-f414-6" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="موضوع" className="h-10 rounded-lg" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f415-7">یادداشت</label><Textarea id="salescalls-f415-7" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات تماس..." className="rounded-lg resize-none" rows={3} /></div>
          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت تماس'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== NEW FOLLOWUP DIALOG (v2.18.0) ====================
/** Real follow-up registration — creates a NON-call activity on
 *  /api/activities, optionally tied to the call's center. */
function NewFollowupDialog({ centers, onCreated, open, onOpenChange, prefill }: {
  centers: Array<{ id: string; name: string }>;
  onCreated: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: { centerId?: string; centerName?: string; subject?: string };
}) {
  const [centerId, setCenterId] = useState('');
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      queueMicrotask(() => {
        setCenterId(prefill?.centerId || '');
        setSubject(prefill?.subject || '');
        setNotes('');
        setError(null);
      });
    }
  }, [open, prefill]);

  const submit = async () => {
    if (!subject.trim()) {
      setError('موضوع پیگیری الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title: `[پیگیری] ${subject.trim()}`,
          description: notes.trim() || undefined,
          // v2.58.0 (audit 85-b): LOCAL date — a follow-up logged between
          // 00:00 and 03:30 Tehran used to be stored with YESTERDAY's UTC
          // date (the time field below was already local — mixed
          // conventions).
          activityDate: (() => {
            const n = new Date();
            return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
          })(),
          activityTime: new Date().toTimeString().slice(0, 5),
          isPhoneCall: false,
          centerId: centerId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت پیگیری');
      toast.success('پیگیری با موفقیت ثبت شد');
      onOpenChange(false);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت پیگیری');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت پیگیری جدید</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f491-8">مرکز</label>
          <select id="salescalls-f491-8" aria-label="مرکز" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
            <option value="">بدون مرکز</option>
            {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f498-9">موضوع پیگیری *</label>
          <Input id="salescalls-f498-9" aria-label="موضوع پیگیری" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="موضوع" className="h-10 rounded-lg" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescalls-f502-10">یادداشت</label>
          <Textarea id="salescalls-f502-10" aria-label="یادداشت پیگیری" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات پیگیری..." className="rounded-lg resize-none" rows={3} />
        </div>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : 'ثبت پیگیری'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== MAIN CALLS PAGE ====================
export default function SalesCalls({ activeTab: propTab }: { activeTab?: string }) {
  // calls-log → ثبت و لیست کامل | calls-history → تماس‌های انجام‌شده | calls-scheduled → برنامه‌ریزی‌شده
  const [activeTab, setActiveTab] = useState<CallTab>(
    propTab === 'history' ? 'history' : propTab === 'scheduled' ? 'scheduled' : 'log'
  );
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [showNewCall, setShowNewCall] = useState(false);
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  // v2.18.0 — follow-up dialog state (پیگیری جدید button on call cards)
  const [showNewFollowup, setShowNewFollowup] = useState(false);
  const [followupPrefill, setFollowupPrefill] = useState<{ centerId?: string; centerName?: string; subject?: string } | undefined>(undefined);

  // ── Real call session (P1-7): honest stopwatch + tel: dial-out ──
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [sessionSec, setSessionSec] = useState(0);
  const [sessionRunning, setSessionRunning] = useState(false);
  const [sessionPrefill, setSessionPrefill] = useState<{ phone?: string; durationSec?: number } | undefined>(undefined);

  useEffect(() => {
    if (!sessionRunning) return;
    const t = setInterval(() => setSessionSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [sessionRunning]);

  const startCallSession = (phone: string, centerName?: string) => {
    setCallSession({ phone, centerName });
    setSessionSec(0);
    setSessionRunning(false);
  };

  const endCallSession = () => {
    setSessionPrefill({ phone: callSession?.phone, durationSec: sessionSec });
    setCallSession(null);
    setSessionRunning(false);
    setShowNewCall(true);
  };

  const cancelCallSession = () => {
    setCallSession(null);
    setSessionRunning(false);
    setSessionSec(0);
  };

  // v2.44.0 (round 69) — progressive reveal state: the list renders the
  // LAST ۳۰ calls first; «مشاهده بیشتر» reveals ۳۰ more (fetching further
  // server pages of calls when the loaded window is exhausted).
  const [paging, setPaging] = useState<CallListPaging>(() => initCallListPaging(0, 0));
  const [fetchingMore, setFetchingMore] = useState(false);

  // ── Load real call activities ──
  // No synchronous setState: `loading` starts true and is only cleared
  // after the fetch resolves (react-hooks/set-state-in-effect compliant).
  // v2.44.0: server-side isPhoneCall filter → page 1 of CALLS ONLY (the old
  // mixed-activity fetch + client filter is kept as a belt-and-suspenders
  // `.filter(a => a.isPhoneCall)` on the items).
  const loadCalls = async () => {
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', page: 1, pageSize: CALLS_FETCH_PAGE_SIZE, isPhoneCall: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت تماس‌ها');
      const items = (data.items || []).filter((a: ApiActivity) => a.isPhoneCall).map(activityToCall);
      setCalls(items);
      setPaging(initCallListPaging(items.length, Number(data.total) || 0));
      setLoadError(null); // clear stale error only after a successful load
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت تماس‌ها');
      setCalls([]);
      setPaging(initCallListPaging(0, 0));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // kick off initial load without calling setState synchronously
    void (async () => { await loadCalls(); })();
  }, []);

  useEffect(() => {
    fetch('/api/centers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', pageSize: 200 }),
    })
      .then((r) => r.json())
      // v2.16.0 — /api/centers returns { success, data } (never `items`);
      // reading d.items left the customer dropdown permanently empty.
      .then((d) => setCenters(d.data || d.items || []))
      .catch(() => undefined);
  }, []);

  const handleCallback = (call: CallRecord) => {
    startCallSession(call.phone, call.centerName !== '—' ? call.centerName : undefined);
  };

  const handleFollowup = (call: CallRecord) => {
    // resolve the call's center back to an id so the follow-up activity
    // is attached to the same center
    const center = centers.find((c) => c.name === call.centerName);
    setFollowupPrefill({
      centerId: center?.id,
      centerName: call.centerName !== '—' ? call.centerName : undefined,
      subject: call.subject ? `پیگیری تماس: ${call.subject}` : undefined,
    });
    setShowNewFollowup(true);
  };

  const handleNewCall = (phone: string) => {
    startCallSession(phone);
  };

  const allTabs: { key: CallTab; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'log', label: 'ثبت تماس', icon: <Phone size={14} /> },
    { key: 'history', label: 'تاریخچه', icon: <Clock size={14} />, count: calls.filter(c => c.status !== 'scheduled').length },
    { key: 'scheduled', label: 'برنامه‌ریزی شده', icon: <Calendar size={14} />, count: calls.filter(c => c.status === 'scheduled').length },
  ];
  // v2.26.0 — access-gated tabs (same menu-key resolution as the sidebar).
  const { isTabAllowed } = useTabAccess();
  const CALL_TAB_MENU_KEYS: Record<string, string> = {
    log: 'calls-log',
    history: 'calls-history',
    scheduled: 'calls-scheduled',
  };
  const tabs = allTabs.filter((t) => isTabAllowed(CALL_TAB_MENU_KEYS[t.key]));
  const currentTab: CallTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'log');

  const filteredCalls = calls.filter(c => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!c.centerName.toLowerCase().includes(q) && !c.personName.toLowerCase().includes(q) && !c.phone.includes(q)) return false;
    }
    if (filterStatus !== 'all' && c.status !== filterStatus) return false;
    if (currentTab === 'scheduled' && c.status !== 'scheduled') return false;
    if (currentTab === 'history' && c.status === 'scheduled') return false;
    return true;
  });

  // v2.44.0 — the visible slice of the filtered view (max `paging.visibleCount`,
  // starts at ۳۰) + how many rows still sit behind the «مشاهده بیشتر» box.
  const visibleCalls = filteredCalls.slice(0, paging.visibleCount);
  const remainingCalls = countRemaining(paging, calls.length, filteredCalls.length);

  // v2.44.0 — «مشاهده بیشتر»: reveal the next ۳۰ loaded rows instantly; only
  // when the loaded window is exhausted (and the server counts more calls)
  // fetch the next CALLS_FETCH_PAGE_SIZE-row server page, append (dedup by id)
  // and keep revealing from there.
  const handleViewMore = async () => {
    const plan = planRevealMore(paging, calls.length, filteredCalls.length);
    if (plan.kind === 'none') return;
    if (plan.kind === 'reveal') {
      setPaging((p) => applyReveal(p, plan.count));
      return;
    }
    setFetchingMore(true);
    try {
      const res = await fetch('/api/activities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', page: plan.page, pageSize: CALLS_FETCH_PAGE_SIZE, isPhoneCall: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت تماس‌های بیشتر');
      const items = (data.items || []).filter((a: ApiActivity) => a.isPhoneCall).map(activityToCall);
      // dedup by id: rows created between page fetches can shift page boundaries
      const seen = new Set(calls.map((c) => c.id));
      const fresh = items.filter((c: CallRecord) => !seen.has(c.id));
      const merged = [...calls, ...fresh];
      const prevFilteredCount = filteredCalls.length;
      setCalls(merged);
      setPaging((p) => applyFetchedPage(p, {
        prevFilteredCount,
        newItemsCount: fresh.length,
        serverTotal: Number(data.total) || 0,
        loadedAfterCount: merged.length,
      }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در دریافت تماس‌های بیشتر');
    } finally {
      setFetchingMore(false);
    }
  };

  const formatDialTime = formatDuration;

  return (
    <div className="space-y-4">
      {/* v2.18.0 — surface load errors / loading instead of a silent empty list */}
      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{loadError}</div>
      )}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">در حال دریافت تماس‌ها...</p>
        </div>
      ) : (
        <CallStats calls={calls} />
      )}

      {/* ===== CALL SESSION OVERLAY (P1-7: honest tracking, real tel: dial-out) ===== */}
      {callSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl p-8 text-center shadow-2xl animate-scale-in max-w-[min(24rem,calc(100vw-2rem))] w-full mx-4">
            <div className="w-20 h-20 rounded-full mx-auto mb-4 flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #059669, #1F8B7D)' }}>
              <Phone size={32} className="text-white" />
            </div>
            <p className="text-base font-bold text-gray-900 mb-1">{callSession.centerName || 'جلسهٔ تماس'}</p>
            <p className="text-xl font-mono text-gray-700 mb-3" dir="ltr">{callSession.phone || '—'}</p>

            {/* Real dial-out: hands the number to the OS dialer / softphone (tel: protocol) */}
            {callSession.phone && (
              <a
                href={`tel:${toLatinDigits(callSession.phone)}`}
                className="inline-flex items-center gap-1.5 text-sm text-teal-700 hover:text-teal-900 font-medium mb-4 underline underline-offset-4"
                dir="rtl"
              >
                <Phone size={14} /> شماره‌گیری با سیستم تلفن
              </a>
            )}

            <p className="text-3xl font-mono text-gray-600 mb-1" dir="ltr">{formatDialTime(sessionSec)}</p>
            <p className="text-xs text-gray-400 mb-5">
              {sessionRunning ? 'در حال ثبت زمان مکالمه' : 'کرونومتر متوقف — پس از برقراری تماس، شروع کنید'}
            </p>

            <div className="flex items-center justify-center gap-3">
              <Button
                onClick={() => setSessionRunning((r) => !r)}
                aria-label={sessionRunning ? 'توقف موقت کرونومتر' : 'شروع کرونومتر مکالمه'}
                className="h-11 px-4 rounded-full text-white text-xs gap-1.5"
                style={{ background: sessionRunning ? '#d97706' : '#059669' }}
              >
                {sessionRunning ? <><Pause size={14} /> توقف موقت</> : <><Timer size={14} /> شروع مکالمه</>}
              </Button>
              <button
                onClick={endCallSession}
                aria-label="پایان تماس و ثبت در سیستم"
                title="پایان تماس و ثبت در سیستم"
                className="w-14 h-14 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors shadow-lg"
              >
                <Phone size={24} className="rotate-[135deg]" />
              </button>
              <Button
                variant="outline"
                onClick={cancelCallSession}
                aria-label="انصراف بدون ثبت"
                className="h-11 px-4 rounded-full text-xs"
              >
                بدون ثبت
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        {/* ===== MAIN CONTENT ===== */}
        <div className="flex-1 space-y-4">
          {/* Tabs + Toolbar */}
          <div className="bg-white rounded-xl border border-gray-100 p-3">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              {/* Tabs */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1" role="tablist" aria-label="نماهای تماس‌ها">
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    role="tab"
                    aria-selected={currentTab === tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${
                      currentTab === tab.key
                        ? 'bg-white text-gray-900 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                    {tab.count !== undefined && (
                      <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${currentTab === tab.key ? 'bg-teal-100 text-teal-700' : 'bg-gray-200 text-gray-500'}`}>
                        {toPersianNum(tab.count)}
                      </span>
                    )}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 flex-1">
                <div className="relative flex-1">
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
                </div>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                  <option value="all">همه وضعیت‌ها</option>
                  {Object.entries(STATUS_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <NewCallDialog
                  key={sessionPrefill ? `session:${sessionPrefill.phone ?? ''}:${sessionPrefill.durationSec ?? 0}` : 'manual'}
                  centers={centers}
                  onCreated={loadCalls}
                  open={showNewCall}
                  onOpenChange={(o) => {
                    setShowNewCall(o);
                    if (!o) setSessionPrefill(undefined);
                  }}
                  prefill={sessionPrefill}
                />
                <Dialog open={showNewFollowup} onOpenChange={setShowNewFollowup}>
                  <NewFollowupDialog
                    centers={centers}
                    onCreated={loadCalls}
                    open={showNewFollowup}
                    onOpenChange={setShowNewFollowup}
                    prefill={followupPrefill}
                  />
                </Dialog>
              </div>
            </div>
          </div>

          {/* Call list */}
          {/* v2.44.0 — at most the last ۳۰ calls render (paging.visibleCount);
              the rest sit behind the «مشاهده بیشتر» box below. */}
          <div className="space-y-2">
            {filteredCalls.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
                <Phone size={32} className="mx-auto mb-2 opacity-40" />
                <p className="text-sm">تماسی یافت نشد</p>
              </div>
            ) : (
              <>
                {visibleCalls.map((call) => (
                  <CallRow key={call.id} call={call} onCallback={handleCallback} onFollowup={handleFollowup} />
                ))}
                {remainingCalls > 0 && (
                  <button
                    type="button"
                    onClick={handleViewMore}
                    disabled={fetchingMore}
                    aria-label={`مشاهدهٔ ${toPersianNum(Math.min(CALLS_REVEAL_STEP, remainingCalls))} تماس بعدی از ${toPersianNum(remainingCalls)} تماس باقی‌مانده`}
                    className="w-full bg-white rounded-xl border border-dashed border-gray-200 hover:border-teal-300 hover:bg-teal-50/40 active:bg-teal-50/70 transition-all py-4 flex flex-col items-center justify-center gap-1 group disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {fetchingMore ? (
                      <Loader2 size={18} className="text-teal-600 animate-spin" />
                    ) : (
                      <ChevronDown size={18} className="text-teal-600 group-hover:translate-y-0.5 transition-transform" />
                    )}
                    <span className="text-sm font-bold text-gray-700">مشاهده بیشتر</span>
                    <span className="text-[11px] text-gray-400">
                      {toPersianNum(Math.min(CALLS_REVEAL_STEP, remainingCalls))} تماس بعدی · {toPersianNum(remainingCalls)} تماس باقی‌مانده
                    </span>
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {/* ===== RIGHT SIDEBAR: Quick Dialer + Recent Contacts ===== */}
        <div className="w-full lg:w-[300px] shrink-0 space-y-4">
          <QuickDialer onCall={handleNewCall} />

          {/* Recent contacts */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="text-sm font-bold text-gray-900 mb-3">تماس‌های اخیر</h3>
            <div className="space-y-2">
              {calls.filter(c => c.status === 'completed').slice(0, 5).map(c => (
                <button
                  key={c.id}
                  onClick={() => handleCallback(c)}
                  aria-label={`تماس مجدد با ${c.personName}`}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg hover:bg-gray-50 transition-colors text-right"
                >
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                    {c.personName.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-900 truncate">{c.personName}</p>
                    <p className="text-[11px] text-gray-400 truncate">{c.centerName}</p>
                  </div>
                  <Phone size={14} className="text-gray-300" />
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}