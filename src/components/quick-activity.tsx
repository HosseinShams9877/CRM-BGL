'use client';
// ════════════════════════════════════════════════════════════
// quick-activity.tsx — v2.34.7 QuickActivityScreen
//
// v2.34.0 base (spec §10): one click from the menu → the FULL form, no
// intermediate dialog; after a successful save the form resets in place
// (type kept) so back-to-back logging needs zero re-navigation.
//
// v2.34.7 — the screen is now the sales expert's personal task board
// (user request, round 55b):
//   • تاریخ (Jalali date) next to ساعت — tasks are PLANNED for a day,
//     land on that day in تقویم, and the list below follows the chosen date
//   • ویس — record a voice note with the mic; it is saved with the task,
//     can be played back here, and is transcribed to text (either right
//     away, or later via «تبدیل به متن»)
//   • مسئول انجام (دسترسی) — assign the task to yourself or a colleague
//     sharing your companies; the assignee sees it in their calendar too
//   • the list shows the chosen day's own tasks with done-toggle, center,
//     assignee, voice playback and transcript
//
// v2.34.9 — round 56 (user request): the type list is trimmed to the four
// kinds the sales floor actually uses — تماس / ویزیت حضوری / فعالیت اداری /
// سایر — and a new OPTIONAL «محصولات مرتبط» box lets the expert tick which
// catalog products the activity was about (snapshot [{id,name}] on
// Activity.products; shown as badges here and on the center dossier).
// ════════════════════════════════════════════════════════════
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Zap, Phone, MapPin, ClipboardList, MoreHorizontal, Package, Check, Loader2, Mic, Square, Trash2, Play, FileText, User as UserIcon, Calendar as CalIcon, CalendarClock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { CenterCombobox, PickedCenter } from '@/components/center-combobox';
import { toJalaliString, toJalaliKey, parseJalaliDate, jalaliToGregorian, jalaliPartsToString } from '@/lib/jalali';
// v2.36.0 (round 62) — popup Jalali calendar replaces the TYPED date
// field: selection is click-only, per the user's requirement.
import { JalaliDatePicker } from '@/components/jalali-date-picker';
// v2.37.0 (round 63) — popup TIME picker (ساعت هم کلیکی) + the smart
// «ثبت در تقویم» future detection.
import { TimePicker } from '@/components/time-picker';
import { isFutureDateTime, nowTimeValue, toPersianTime } from '@/lib/time-utils';
import { MAX_VOICE_SECONDS } from '@/lib/activity-voice';
import { parseActivityProducts, type ActivityProductRef } from '@/lib/activity-products';

type ActivityKind = 'call' | 'visit' | 'admin' | 'other';

// v2.34.9 — round 56: ONLY these four types (user request «بقیه رو پاک کن»).
// Legacy rows still carry [جلسه]/[بازاریابی]/[پشتیبانی]/[یادداشت] prefixes in
// their titles — they keep rendering untouched; only the picker is trimmed.
const KINDS: { key: ActivityKind; label: string; icon: React.ReactNode; flags: { isPhoneCall?: boolean; isOnsiteVisit?: boolean }; prefix: string }[] = [
  { key: 'call', label: 'تماس', icon: <Phone size={13} />, flags: { isPhoneCall: true }, prefix: '[تماس]' },
  { key: 'visit', label: 'ویزیت حضوری', icon: <MapPin size={13} />, flags: { isOnsiteVisit: true }, prefix: '[ویزیت]' },
  { key: 'admin', label: 'فعالیت اداری', icon: <ClipboardList size={13} />, flags: {}, prefix: '[اداری]' },
  { key: 'other', label: 'سایر', icon: <MoreHorizontal size={13} />, flags: {}, prefix: '[سایر]' },
];

interface TodayRow {
  id: string;
  title: string;
  description: string;
  time: string;
  status: 'pending' | 'done' | 'cancelled';
  centerName: string | null;
  assignedName: string | null;
  hasVoice: boolean;
  voiceTranscript: string;
  products: ActivityProductRef[];
}

interface Colleague { id: string; displayName: string; me: boolean }

/** Catalog product row for the «محصولات مرتبط» picker (/api/products list). */
interface CatalogProduct { id: string; name: string; code: string }

/** Pick the best audio mimeType this browser can actually record. */
function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const t of candidates) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /* keep probing */ }
  }
  return null;
}

function fmtSecs(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function QuickActivityScreen() {
  const [kind, setKind] = useState<ActivityKind>('call');
  const [center, setCenter] = useState<PickedCenter | null>(null);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(() => {
    const [y, m, d] = toJalaliKey().split('-');
    return jalaliPartsToString(Number(y), Number(m), Number(d));
  });
  const [time, setTime] = useState(() => nowTimeValue());
  const [assignee, setAssignee] = useState('');
  const [colleagues, setColleagues] = useState<Colleague[]>([]);
  // ── v2.34.9 product tags: catalog + ticked ids ──
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [productQuery, setProductQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [today, setToday] = useState<TodayRow[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── voice note state ──
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [voiceBlob, setVoiceBlob] = useState<Blob | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recorderMime = useMemo(() => pickRecorderMime(), []);
  const [transcriptBusyId, setTranscriptBusyId] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playRef = useRef<HTMLAudioElement | null>(null);

  const [todayJalali] = useState(() => toJalaliString(new Date()));

  // ── data loaders ──
  const loadList = useCallback(async (jalaliDate: string) => {
    const parts = parseJalaliDate(jalaliDate);
    if (!parts) return;
    const [gy, gm, gd] = jalaliToGregorian(parts[0], parts[1], parts[2]);
    const iso = new Date(gy, gm - 1, gd, 12).toISOString().slice(0, 10);
    try {
      const res = await fetch('/api/activities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', dateFrom: iso, dateTo: iso, mineOnly: true, pageSize: 50 }),
      });
      const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
      setToday((data.items ?? []).map((a) => ({
        id: String(a.id),
        title: String(a.title ?? ''),
        description: String(a.description ?? ''),
        time: String(a.activityTime ?? ''),
        status: (a.status as TodayRow['status']) ?? 'pending',
        centerName: (a.center as { name?: string } | null)?.name ?? null,
        assignedName: (a.assignedUser as { displayName?: string } | null)?.displayName ?? null,
        hasVoice: Boolean(a.voiceNoteFileId),
        voiceTranscript: String(a.voiceTranscript ?? ''),
        products: parseActivityProducts(typeof a.products === 'string' ? a.products : null),
      })));
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => {
    queueMicrotask(() => { void loadList(date); });
  }, [date, loadList]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/activities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'colleagues' }),
    })
      .then((r) => r.json())
      .then((d: { items?: Colleague[] }) => { if (!cancelled && Array.isArray(d.items)) setColleagues(d.items); })
      .catch(() => undefined);
    // v2.34.9 — active catalog for the «محصولات مرتبط» picker (silent
    // best-effort: an empty catalog simply hides the checkboxes).
    fetch('/api/products', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', pageSize: 100, active: true }),
    })
      .then((r) => r.json())
      .then((d: { items?: CatalogProduct[] }) => { if (!cancelled && Array.isArray(d.items)) setCatalog(d.items); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // Default responsible = the writer themself (async — no sync setState
  // in the effect body, matching the dialogs pattern in sales-docs-dialogs.tsx).
  useEffect(() => {
    queueMicrotask(() => {
      setAssignee((cur) => {
        if (cur) return cur;
        const me = colleagues.find((c) => c.me);
        return me ? me.id : cur;
      });
    });
  }, [colleagues]);

  // v2.34.9 — ticked catalog products → snapshot [{id,name}] payload.
  const pickedProducts = useMemo(
    () => catalog.filter((p) => picked.includes(p.id)).map((p) => ({ id: p.id, name: p.name })),
    [catalog, picked],
  );
  const filteredCatalog = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
  }, [catalog, productQuery]);

  const kindDef = useMemo(() => KINDS.find((k) => k.key === kind)!, [kind]);

  const flash = (ok: boolean, text: string) => {
    setToast({ ok, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  };

  // ── voice recorder controls ──
  const stopRecording = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (autoStopRef.current) { clearTimeout(autoStopRef.current); autoStopRef.current = null; }
    setRecording(false);
    try { mediaRef.current?.stop(); } catch { /* already stopped */ }
  }, []);

  const startRecording = async () => {
    if (!recorderMime || !navigator.mediaDevices?.getUserMedia) {
      // v2.58.1 (audit F8): distinguish "unsupported browser" from a
      // NON-SECURE context (getUserMedia requires HTTPS or localhost — a
      // LAN http://192.168.x.x address leaves mediaDevices undefined).
      flash(
        false,
        navigator.mediaDevices
          ? 'مرورگر شما ضبط صدا (MediaRecorder) را پشتیبانی نمی‌کند.'
          : 'ضبط صدا فقط در نشست امن (localhost یا HTTPS) کار می‌کند؛ آدرس شبکهٔ فعلی پشتیبانی نمی‌شود.',
      );
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, { mimeType: recorderMime });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorderMime.split(';')[0] });
        if (voiceUrl) URL.revokeObjectURL(voiceUrl);
        setVoiceBlob(blob.size > 0 ? blob : null);
        setVoiceUrl(blob.size > 0 ? URL.createObjectURL(blob) : null);
      };
      mediaRef.current = rec;
      rec.start(250);
      setRecording(true);
      setRecSecs(0);
      timerRef.current = setInterval(() => { setRecSecs((s) => s + 1); }, 1000);
      // hard cap outside the state updater (StrictMode-safe)
      autoStopRef.current = setTimeout(() => { stopRecording(); }, MAX_VOICE_SECONDS * 1000);
    } catch (e) {
      // v2.58.1 (audit F8): clear, distinct Persian messages for the two
      // real failure classes instead of one generic sentence.
      const name = e instanceof DOMException ? e.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        flash(false, 'دسترسی به میکروفون رد شد. از تنظیمات مرورگر مجوز ضبط صدا را فعال کنید و دوباره تلاش کنید.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        flash(false, 'میکروفونی روی این دستگاه پیدا نشد.');
      } else {
        flash(false, 'شروع ضبط صدا ممکن نشد؛ یک‌بار دیگر تلاش کنید.');
      }
    }
  };

  const discardVoice = () => {
    stopRecording();
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    setVoiceBlob(null);
    setVoiceUrl(null);
    setRecSecs(0);
  };

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (autoStopRef.current) clearTimeout(autoStopRef.current);
    if (voiceUrl) URL.revokeObjectURL(voiceUrl);
    if (playRef.current) { playRef.current.pause(); }
    // v2.58.1 (audit F8): a recording left RUNNING at unmount kept the
    // microphone stream open (recording indicator + camera light on).
    // Stop the recorder AND its tracks directly — onstop's setState on an
    // unmounted component is a harmless no-op, but the stream must be
    // released synchronously right here.
    try {
      mediaRef.current?.stream.getTracks().forEach((t) => t.stop());
      mediaRef.current?.stop();
    } catch { /* already stopped */ }
  }, [voiceUrl]);

  // ── save ──
  const save = async () => {
    if (!subject.trim()) { flash(false, 'موضوع فعالیت را بنویسید'); return; }
    const parts = parseJalaliDate(date);
    if (!parts) { flash(false, 'تاریخ را به فرمت ۱۴۰۵/۰۶/۱۵ وارد کنید'); return; }
    setSaving(true);
    try {
      const [gy, gm, gd] = jalaliToGregorian(parts[0], parts[1], parts[2]);
      const isoDate = new Date(gy, gm - 1, gd, 12).toISOString();
      const title = `${kindDef.prefix} ${subject.trim()}`;
      const common = {
        title,
        description: description.trim(),
        activityDate: isoDate,
        activityTime: time,
        centerId: center?.id || '',
        assignedTo: assignee || '',
        // v2.34.9 — optional product tags [{id,name}] (snapshot).
        products: pickedProducts,
        ...kindDef.flags,
      };

      let transcriptText: string | null = null;
      let transcriptError: string | null = null;
      if (voiceBlob) {
        const fd = new FormData();
        fd.append('audio', voiceBlob, 'voice-note.webm');
        fd.append('title', title);
        fd.append('description', description.trim());
        fd.append('activityDate', isoDate);
        fd.append('activityTime', time);
        if (center?.id) fd.append('centerId', center.id);
        if (assignee) fd.append('assignedTo', assignee);
        if (kindDef.flags.isPhoneCall) fd.append('isPhoneCall', 'true');
        if (kindDef.flags.isOnsiteVisit) fd.append('isOnsiteVisit', 'true');
        if (pickedProducts.length > 0) fd.append('products', JSON.stringify(pickedProducts));
        fd.append('transcribe', 'true');
        const res = await fetch('/api/activities/voice', { method: 'POST', body: fd });
        const data = (await res.json()) as { error?: string; transcript?: string | null; transcriptError?: string | null };
        if (!res.ok) throw new Error(data.error || 'خطا در ثبت فعالیت صوتی');
        transcriptText = data.transcript ?? null;
        transcriptError = data.transcriptError ?? null;
      } else {
        const res = await fetch('/api/activities', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'create', ...common, centerId: center?.id || undefined, assignedTo: assignee || undefined }),
        });
        const data = (await res.json()) as { error?: string };
        if (!res.ok) throw new Error(data.error || 'خطا در ثبت فعالیت');
      }

      // v2.37.0 — round 63: a FUTURE date/time schedules the row into
      // the calendar (upcoming activities) instead of logging it as done.
      const future = isFutureDateTime(date, time);
      flash(true, future
        ? `در تقویم ثبت شد — ${kindDef.label}${center ? ` برای «${center.name}»` : ''} · ${toPersianTime(time)} ${toPersianTime(date)}${pickedProducts.length > 0 ? ` · ${pickedProducts.length} محصول` : ''}${transcriptText ? ' · ویس متن شد' : transcriptError ? ' · ویس ذخیره شد (متن بعداً)' : ''}`
        : `ثبت شد — ${kindDef.label}${center ? ` برای «${center.name}»` : ''}${pickedProducts.length > 0 ? ` · ${pickedProducts.length} محصول` : ''}${transcriptText ? ' · ویس متن شد' : transcriptError ? ' · ویس ذخیره شد (متن بعداً)' : ''}`);
      setSubject(''); setDescription('');
      setPicked([]); setProductQuery('');
      discardVoice();
      const now = new Date();
      setTime(nowTimeValue(now));
      await loadList(date);
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'خطا در ثبت');
    } finally {
      setSaving(false);
    }
  };

  // ── task board actions ──
  const toggleDone = async (row: TodayRow) => {
    const next = row.status === 'done' ? 'pending' : 'done';
    setToday((rows) => rows.map((r) => (r.id === row.id ? { ...r, status: next } : r)));
    try {
      const res = await fetch('/api/activities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update', id: row.id, status: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setToday((rows) => rows.map((r) => (r.id === row.id ? { ...r, status: row.status } : r)));
      flash(false, 'تغییر وضعیت ذخیره نشد.');
    }
  };

  const playVoice = (id: string) => {
    if (playRef.current) { playRef.current.pause(); playRef.current = null; }
    if (playingId === id) { setPlayingId(null); return; }
    const audio = new Audio(`/api/activities/voice?id=${encodeURIComponent(id)}`);
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => { setPlayingId(null); flash(false, 'پخش ویس ممکن نشد.'); };
    playRef.current = audio;
    setPlayingId(id);
    void audio.play().catch(() => { setPlayingId(null); flash(false, 'پخش ویس ممکن نشد.'); });
  };

  const transcribeLater = async (row: TodayRow) => {
    setTranscriptBusyId(row.id);
    try {
      const res = await fetch('/api/activities/voice', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'transcribe', id: row.id }),
      });
      const data = (await res.json()) as { error?: string; transcript?: string };
      if (!res.ok) throw new Error(data.error || 'تبدیل به متن ناموفق بود.');
      setToday((rows) => rows.map((r) => (r.id === row.id ? { ...r, voiceTranscript: data.transcript ?? '' } : r)));
      setOpenTranscript(row.id);
      flash(true, 'ویس به متن تبدیل شد.');
    } catch (e) {
      flash(false, e instanceof Error ? e.message : 'تبدیل به متن ناموفق بود.');
    } finally {
      setTranscriptBusyId(null);
    }
  };

  const dateParts = parseJalaliDate(date);
  // v2.37.0 — round 63 (user request): when the picked Jalali date AND
  // time are in the FUTURE, the button stops logging a done-activity and
  // instead SCHEDULES the row into the calendar's upcoming activities.
  const isFuture = dateParts ? isFutureDateTime(date, time) : false;
  const doneCount = today.filter((r) => r.status === 'done').length;
  const meLabel = colleagues.find((c) => c.me)?.displayName ?? '';

  return (
    <div className="max-w-3xl mx-auto space-y-4" data-quick-activity>
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <Zap size={18} />
        </div>
        <div>
          <h2 className="text-base font-bold text-gray-900">ثبت سریع فعالیت</h2>
          <p className="text-xs text-gray-400">دفترچهٔ کارهای روزانه — با تاریخ، مسئول و ویس · می‌رود توی تقویم {todayJalali ? `· امروز ${todayJalali}` : ''}</p>
        </div>
      </div>

      {toast && (
        <div className={'rounded-xl border p-3 text-xs ' + (toast.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600')} data-quick-toast role="status">
          {toast.ok ? <Check size={13} className="inline align-middle me-1" /> : null} {toast.text}
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
        {/* type chips */}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="نوع فعالیت">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              data-kind={k.key}
              onClick={() => setKind(k.key)}
              className={'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition ' +
                (kind === k.key ? 'border-teal-600 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500 hover:border-gray-300')}
            >
              {k.icon} {k.label}
            </button>
          ))}
        </div>

        {/* center combobox (optional — personal tasks allowed) */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5">مرکز / مشتری <span className="text-gray-300">(اختیاری — برای کار شخصی خالی بگذارید)</span></label>
          <CenterCombobox value={center} onChange={setCenter} placeholder="جستجوی نام مرکز یا شهر…" />
        </div>

        {/* subject */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="qa-subject">موضوع</label>
          <Input
            id="qa-subject" data-qa-subject value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
            placeholder="مثلاً: پیگیری پیش‌فاکتور تلفنی"
            className="h-10 rounded-lg text-xs"
          />
        </div>

        {/* description */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="qa-desc">توضیحات</label>
          <Textarea id="qa-desc" data-qa-desc value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="rounded-lg text-xs" placeholder="خلاصهٔ گفتگو / نتیجه…" />
        </div>

        {/* v2.34.9 — related products (optional checkbox picker) */}
        <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-3 space-y-2" data-qa-products-box>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5">
              <Package size={13} /> محصولات مرتبط
              <span className="text-gray-300 font-normal">(اختیاری — این فعالیت دربارهٔ کدام محصولات بود؟)</span>
            </p>
            {picked.length > 0 && (
              <button type="button" onClick={() => setPicked([])} data-qa-products-clear className="text-[11px] text-gray-400 hover:text-red-500 transition-colors">
                پاک کردن انتخاب‌ها ({picked.length})
              </button>
            )}
          </div>
          {catalog.length === 0 ? (
            <p className="text-[11px] text-gray-400">محصولی در کاتالوگ ثبت نشده است.</p>
          ) : (
            <>
              {catalog.length > 8 && (
                <Input
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  placeholder="جستجوی محصول…"
                  aria-label="جستجوی محصول"
                  className="h-9 rounded-lg text-xs bg-white"
                />
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-44 overflow-y-auto" role="group" aria-label="محصولات مرتبط">
                {filteredCatalog.map((p) => {
                  const on = picked.includes(p.id);
                  return (
                    <label
                      key={p.id}
                      className={'flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition select-none ' + (on ? 'border-teal-300 bg-teal-50/70' : 'border-gray-200 bg-white hover:border-gray-300')}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => setPicked((ids) => (on ? ids.filter((x) => x !== p.id) : [...ids, p.id]))}
                        className="accent-teal-600 w-4 h-4 shrink-0"
                        data-qa-product={p.id}
                      />
                      <span className="text-xs text-gray-700 truncate">{p.name}</span>
                    </label>
                  );
                })}
                {filteredCatalog.length === 0 && <p className="text-[11px] text-gray-400 col-span-full">محصولی مطابق جستجو پیدا نشد.</p>}
              </div>
              {pickedProducts.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {pickedProducts.map((p) => (
                    <span key={p.id} className="text-[10px] text-teal-700 bg-teal-50 border border-teal-100 rounded-full px-2 py-0.5">{p.name}</span>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* voice note */}
        <div className="rounded-xl border border-gray-100 bg-gray-50/50 p-3 space-y-2" data-qa-voice-box>
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-gray-600 flex items-center gap-1.5"><Mic size={13} /> یادداشت صوتی <span className="text-gray-300">(به‌جای تایپ، حرف بزنید — بعداً متن می‌شود)</span></p>
            {recorderMime ? (
              recording ? (
                <Button type="button" variant="outline" size="sm" onClick={stopRecording} data-qa-rec-stop className="h-8 gap-1.5 text-xs rounded-lg border-red-200 text-red-600 hover:bg-red-50">
                  <Square size={12} /> توقف ({fmtSecs(recSecs)})
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  {voiceBlob && (
                    <>
                      <span className="text-[11px] text-gray-400">{Math.round(voiceBlob.size / 1024)} KB</span>
                      <Button type="button" variant="outline" size="sm" onClick={discardVoice} data-qa-rec-discard className="h-8 gap-1 text-xs rounded-lg text-gray-500">
                        <Trash2 size={12} /> حذف ویس
                      </Button>
                    </>
                  )}
                  <Button type="button" size="sm" onClick={startRecording} data-qa-rec-start className="h-8 gap-1.5 text-xs rounded-lg px-4 text-white" style={{ background: 'linear-gradient(135deg, #C2410C, #7C2D12)' }}>
                    <Mic size={12} /> {voiceBlob ? 'ضبط مجدد' : 'ضبط ویس'}
                  </Button>
                </div>
              )
            ) : (
              <span className="text-[11px] text-gray-400">مرورگر ضبط صدا را پشتیبانی نمی‌کند</span>
            )}
          </div>
          {recording && (
            <div className="flex items-center gap-2 text-xs text-red-600">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> در حال ضبط… {fmtSecs(recSecs)} / {fmtSecs(MAX_VOICE_SECONDS)}
            </div>
          )}
          {voiceUrl && !recording && <audio src={voiceUrl} controls className="w-full h-9" data-qa-voice-preview />}
        </div>

        {/* date + time + assignee */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="qa-date">تاریخ (شمسی)</label>
            <div data-qa-date>
              <JalaliDatePicker
                id="qa-date" ariaLabel="تاریخ فعالیت (شمسی)" value={date} onChange={setDate}
                inputClassName="h-10 rounded-lg text-xs"
              />
            </div>
            <div className="flex gap-1 mt-1">
              <button type="button" onClick={() => { const [y, m, d] = toJalaliKey().split('-'); setDate(jalaliPartsToString(Number(y), Number(m), Number(d))); }} className="text-[10px] text-teal-700 hover:underline">امروز</button>
              <span className="text-[10px] text-gray-300">|</span>
              <button type="button" onClick={() => { const t = new Date(); t.setDate(t.getDate() + 1); const k = toJalaliKey(t); const [y, m, d] = k.split('-'); setDate(jalaliPartsToString(Number(y), Number(m), Number(d))); }} className="text-[10px] text-teal-700 hover:underline">فردا</button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="qa-time">ساعت</label>
            <div data-qa-time>
              <TimePicker id="qa-time" ariaLabel="ساعت فعالیت" value={time} onChange={setTime} inputClassName="h-10 rounded-lg text-xs" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5" htmlFor="qa-assignee">مسئول انجام (دسترسی)</label>
            <select
              id="qa-assignee" data-qa-assignee value={assignee} onChange={(e) => setAssignee(e.target.value)}
              className="w-full h-10 rounded-lg border border-gray-200 px-2 text-xs bg-white"
              aria-label="مسئول انجام فعالیت"
            >
              {colleagues.length === 0 && <option value="">— خودم —</option>}
              {colleagues.map((c) => (
                <option key={c.id} value={c.id}>{c.me ? `خودم (${c.displayName})` : c.displayName}</option>
              ))}
            </select>
          </div>
        </div>
        {!dateParts && <p className="text-[11px] text-red-500" role="alert">تاریخ نامعتبر است — فرمت درست: ۱۴۰۵/۰۶/۱۵</p>}

        {/* v2.37.0 — future date/time → the save becomes a calendar schedule */}
        {isFuture && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-[11px] text-indigo-700 flex items-center gap-1.5" role="status" data-qa-future-hint>
            <CalendarClock size={13} className="shrink-0" />
            تاریخ و ساعت انتخابی در آینده است — با ثبت، این فعالیت به‌عنوان برنامهٔ پیش‌رو در تقویم قرار می‌گیرد.
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Button
            onClick={save}
            disabled={saving || !dateParts}
            data-qa-save
            data-qa-mode={isFuture ? 'calendar' : 'activity'}
            className="h-10 gap-1.5 text-white text-xs rounded-lg px-6 transition-all"
            style={isFuture
              ? { background: 'linear-gradient(135deg, #4F46E5, #2E2A5C)' }
              : { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : isFuture ? <CalendarClock size={14} /> : <Check size={14} />}
            {saving ? 'در حال ثبت…' : isFuture ? 'ثبت در تقویم (Enter)' : 'ثبت فعالیت (Enter)'}
          </Button>
          {voiceBlob && <span className="text-[11px] text-gray-400">ویس همراه فعالیت ذخیره و متن می‌شود</span>}
        </div>
      </div>

      {/* task board for the chosen date */}
      <div className="bg-white rounded-2xl border border-gray-100 p-4" data-qa-task-board>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
            <CalIcon size={13} className="text-teal-600" />
            کارهای {dateParts ? date : ''} {meLabel ? <span className="text-gray-400 font-normal">({meLabel})</span> : ''}
            {isFuture && <span className="text-[10px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-1.5 py-0.5" data-qa-future-chip>پیش‌رو</span>}
          </p>
          {today.length > 0 && (
            <span className="text-[11px] text-gray-400">{doneCount}/{today.length} انجام‌شده</span>
          )}
        </div>
        {today.length === 0 ? (
          <p className="text-xs text-gray-400 py-3">برای این تاریخ کاری ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-gray-50">
            {today.map((a) => (
              <li key={a.id} className="py-2 space-y-1">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => { void toggleDone(a); }}
                      aria-label={a.status === 'done' ? 'برگرداندن به حالت انجام‌نشده' : 'علامت‌گذاری به‌عنوان انجام‌شده'}
                      className={'w-[18px] h-[18px] shrink-0 rounded-md border-2 flex items-center justify-center transition ' + (a.status === 'done' ? 'border-emerald-500 bg-emerald-500' : 'border-gray-300 hover:border-gray-400')}
                    >
                      {a.status === 'done' && <Check size={11} className="text-white" />}
                    </button>
                    <span className={'font-medium truncate ' + (a.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-700')}>{a.title}</span>
                    {a.assignedName && a.assignedName !== meLabel && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-purple-600 bg-purple-50 border border-purple-100 rounded-full px-1.5 py-0.5"><UserIcon size={10} /> {a.assignedName}</span>
                    )}
                    {!a.centerName && <span className="shrink-0 text-[10px] text-gray-400 bg-gray-50 border border-gray-100 rounded-full px-1.5 py-0.5">شخصی</span>}
                    {a.products.map((p) => (
                      <span key={p.id} className="shrink-0 text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-1.5 py-0.5">{p.name}</span>
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-gray-400">
                    {a.centerName && <span className="hidden sm:inline text-[11px] text-gray-500 truncate max-w-[140px]">{a.centerName}</span>}
                    {a.hasVoice && (
                      <button type="button" onClick={() => playVoice(a.id)} aria-label={playingId === a.id ? 'توقف پخش ویس' : 'پخش ویس'} data-qa-play-voice={a.id}
                        className={'p-1 rounded-md border transition ' + (playingId === a.id ? 'border-orange-300 bg-orange-50 text-orange-600' : 'border-gray-200 hover:border-gray-300')}>
                        {playingId === a.id ? <Square size={11} /> : <Play size={11} />}
                      </button>
                    )}
                    {a.hasVoice && (a.voiceTranscript ? (
                      <button type="button" onClick={() => setOpenTranscript(openTranscript === a.id ? null : a.id)} data-qa-toggle-transcript={a.id}
                        className="p-1 rounded-md border border-gray-200 hover:border-gray-300" aria-label="نمایش متن ویس">
                        <FileText size={11} className={openTranscript === a.id ? 'text-teal-600' : ''} />
                      </button>
                    ) : (
                      <button type="button" onClick={() => { void transcribeLater(a); }} disabled={transcriptBusyId === a.id} data-qa-transcribe={a.id}
                        className="p-1 rounded-md border border-gray-200 hover:border-teal-300 disabled:opacity-50" aria-label="تبدیل ویس به متن" title="تبدیل ویس به متن">
                        {transcriptBusyId === a.id ? <Loader2 size={11} className="animate-spin" /> : <FileText size={11} />}
                      </button>
                    ))}
                    <span dir="ltr">{a.time || ''}</span>
                  </div>
                </div>
                {a.hasVoice && openTranscript === a.id && a.voiceTranscript && (
                  <p className="text-[11px] text-gray-600 bg-teal-50/60 border border-teal-100 rounded-lg px-2.5 py-1.5 leading-5" data-qa-transcript={a.id}>متن ویس: {a.voiceTranscript}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
