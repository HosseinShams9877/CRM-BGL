'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — ANALYZED CALLS (v2.27.0)
// List + filters + upload audio + manual transcript + live status.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Upload, Keyboard, Search, RefreshCw, Trash2, Eye, PhoneIncoming, PhoneOutgoing, AlertTriangle, FileAudio,
} from 'lucide-react';

import {
  toPersianNum, faDateTime, AiSkeleton, AiEmptyState, AiErrorState, aiApiJson,
  StatusPill, TemperatureBadge, IntentBadge, loadCenters, type CenterOption,
} from './shared';
import { CallDetailDialog } from './call-detail';
import { AI_PIPELINE_STEPS } from '@/lib/ai/types';

interface CallRow {
  id: string; status: string; direction: string; source: string; title: string;
  durationSec: number; retryCount: number; failReason: string; createdAt: string; consent: string;
  center: { id: string; name: string } | null;
  contact: { id: string; title: string; person: string | null } | null;
  rep: { id: string; displayName: string } | null;
  transcript: { id: string; wordCount: number } | null;
  analyses: { id: string; intent: string; temperature: string; conversionScore: number; summary: string; needsReview: boolean }[];
}

export function AiCalls({ companySlug }: { companySlug: string }) {
  const [rows, setRows] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  // v2.58.0 (audit 85-b): immediate field value; `search` is the debounced
  // mirror that drives `load` — every keystroke used to fire a request.
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pageSize = 20;
  // v2.58.0 (audit 85-b): request-sequence guard — an older slow response
  // can no longer overwrite a newer one.
  const seqRef = useRef(0);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async (silent = false) => {
    const seq = ++seqRef.current;
    const res = await aiApiJson<{ items: CallRow[]; total: number }>('/api/ai-sales/calls', {
      action: 'list', companySlug: companySlug === 'holding' ? undefined : companySlug,
      status: statusFilter === 'all' ? undefined : statusFilter,
      search: search.trim() || undefined, page, pageSize,
    });
    if (seq !== seqRef.current) return; // stale response
    if (!silent) setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
    setError('');
    setRows(res.data.items || []);
    setTotal(res.data.total || 0);
  }, [companySlug, statusFilter, search, page]);

  // v2.58.0: debounced search commit (350ms).
  const onSearchInput = (value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => { setSearch(value); setPage(1); }, 350);
  };

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  // Live status: refresh every 8s while any recording is processing.
  useEffect(() => {
    const hasBusy = rows.some((r) => ['uploaded', 'queued', 'transcribing', 'analyzing'].includes(r.status));
    if (hasBusy) {
      timerRef.current = setInterval(() => { void load(true); }, 8000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [rows, load]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const handleDelete = async (row: CallRow) => {
    if (!window.confirm(`تماس «${row.center?.name || 'بدون مرکز'}» و تمام تحلیل‌های آن حذف شود؟ این عمل قابل بازگشت نیست.`)) return;
    const res = await aiApiJson('/api/ai-sales/calls', { action: 'delete', id: row.id, deleteAudio: true });
    if (res.ok) { toast.success('حذف شد.'); void load(true); }
    else toast.error(res.error || 'خطا در حذف');
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <FileAudio size={18} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
            تماس‌های تحلیل‌شده
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            مکالمات ضبط‌شده را بارگذاری کنید تا متن، تحلیل و اقدام بعدی به‌صورت خودکار استخراج شود.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5 bg-violet-600 hover:bg-violet-700">
            <Upload size={14} aria-hidden="true" /> بارگذاری فایل صوتی
          </Button>
          <Button size="sm" variant="outline" onClick={() => setManualOpen(true)} className="gap-1.5">
            <Keyboard size={14} aria-hidden="true" /> ثبت متن مکالمه
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search size={14} className="absolute right-2.5 top-2.5 text-slate-400" aria-hidden="true" />
          <input
            value={searchInput}
            onChange={(e) => onSearchInput(e.target.value)}
            placeholder="جست‌وجو بر اساس مرکز یا عنوان…"
            className="h-8 w-full rounded-lg border border-slate-300 bg-white pr-8 pl-3 text-xs outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label="فیلتر وضعیت"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">همه وضعیت‌ها</SelectItem>
            <SelectItem value="completed">تکمیل‌شده</SelectItem>
            <SelectItem value="queued">در صف</SelectItem>
            <SelectItem value="transcribing">در حال تبدیل به متن</SelectItem>
            <SelectItem value="analyzing">در حال تحلیل</SelectItem>
            <SelectItem value="failed">خطا</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }} className="h-8 gap-1 text-xs" aria-label="رفرش">
          <RefreshCw size={13} aria-hidden="true" /> رفرش
        </Button>
      </div>

      {/* Content */}
      {loading && <AiSkeleton rows={5} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}
      {!loading && !error && rows.length === 0 && (
        <AiEmptyState
          title="هنوز تماسی تحلیل نشده است"
          description="با «بارگذاری فایل صوتی» یک ضبط تماس را بفرستید تا تبدیل به متن و تحلیل شود، یا اگر فایل صوتی ندارید متن مکالمه را دستی ثبت کنید — تحلیل AI روی هر دو کار می‌کند."
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setUploadOpen(true)} className="bg-violet-600 hover:bg-violet-700 gap-1.5"><Upload size={13} /> بارگذاری صوت</Button>
              <Button size="sm" variant="outline" onClick={() => setManualOpen(true)} className="gap-1.5"><Keyboard size={13} /> ثبت متن</Button>
            </div>
          }
        />
      )}
      {!loading && !error && rows.length > 0 && (
        <>
          <div className="space-y-2">
            {rows.map((r) => {
              const analysis = r.analyses[0];
              const busy = ['uploaded', 'queued', 'transcribing', 'analyzing'].includes(r.status);
              const stepIdx = AI_PIPELINE_STEPS.findIndex((s) => s.key === r.status);
              return (
                <div
                  key={r.id}
                  className="group rounded-2xl border border-slate-200 bg-white p-3 transition hover:border-violet-300 hover:shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:hover:border-violet-700"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                      {r.direction === 'inbound'
                        ? <PhoneIncoming size={14} className="text-cyan-600 dark:text-cyan-400" aria-hidden="true" />
                        : <PhoneOutgoing size={14} className="text-slate-400" aria-hidden="true" />}
                      <button
                        type="button"
                        onClick={() => setDetailId(r.id)}
                        className="truncate text-sm font-bold text-slate-800 hover:text-violet-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-600 dark:text-slate-100 dark:hover:text-violet-400"
                      >
                        {r.title || r.center?.name || 'تماس بدون عنوان'}
                      </button>
                      {r.center && <span className="truncate text-xs text-slate-500 dark:text-slate-400">— {r.center.name}</span>}
                      <StatusPill status={r.status as never} />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id)} className="h-7 gap-1 px-2 text-[11px] opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label="مشاهده جزئیات">
                        <Eye size={12} /> جزئیات
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleDelete(r)} className="h-7 gap-1 px-2 text-[11px] text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950 opacity-100 md:opacity-0 md:group-hover:opacity-100" aria-label="حذف">
                        <Trash2 size={12} /> حذف
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    <span>{faDateTime(r.createdAt)}</span>
                    {r.rep && <span>کارشناس: {r.rep.displayName}</span>}
                    {r.durationSec > 0 && <span>مدت: {toPersianNum(Math.floor(r.durationSec / 60))} دقیقه</span>}
                    {r.transcript && <span>{toPersianNum(r.transcript.wordCount)} کلمه</span>}
                    {analysis && <TemperatureBadge temperature={analysis.temperature} />}
                    {analysis && <IntentBadge intent={analysis.intent} />}
                    {analysis && (
                      <span className={`rounded-full px-2 py-0.5 font-semibold ${analysis.conversionScore >= 60 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : analysis.conversionScore >= 40 ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' : 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300'}`}>
                        احتمال تبدیل {toPersianNum(analysis.conversionScore)}٪
                      </span>
                    )}
                  </div>
                  {r.status === 'failed' && r.failReason && (
                    <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:bg-rose-950/50 dark:text-rose-300">
                      <AlertTriangle size={12} aria-hidden="true" /> {r.failReason}
                    </p>
                  )}
                  {busy && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {AI_PIPELINE_STEPS.map((s, i) => (
                        <React.Fragment key={s.key}>
                          {i > 0 && <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">←</span>}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] ${i < stepIdx ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : i === stepIdx ? 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300 animate-pulse' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'}`}>
                            {s.label}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                  {analysis?.summary && !busy && (
                    <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-600 dark:text-slate-300">{analysis.summary}</p>
                  )}
                </div>
              );
            })}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2 text-xs">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="h-7">قبلی</Button>
              <span className="text-slate-500 dark:text-slate-400">صفحه {toPersianNum(page)} از {toPersianNum(totalPages)}</span>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="h-7">بعدی</Button>
            </div>
          )}
        </>
      )}

      {/* Dialogs — keyed by open state / entity so each session mounts fresh
          (state resets happen via remount, never via sync setState in effects) */}
      {uploadOpen && <UploadDialog key="upload-open" open={uploadOpen} onClose={() => setUploadOpen(false)} onDone={() => void load(true)} />}
      {manualOpen && <ManualTranscriptDialog key="manual-open" open={manualOpen} onClose={() => setManualOpen(false)} onDone={() => void load(true)} />}
      {detailId && <CallDetailDialog key={detailId} callId={detailId} open={!!detailId} onClose={() => setDetailId(null)} onChanged={() => void load(true)} />}
    </div>
  );
}

// ── Upload audio dialog ─────────────────────────────────────
function UploadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [centers, setCenters] = useState<CenterOption[]>([]);
  const [centerId, setCenterId] = useState('');
  const [contactId, setContactId] = useState('');
  const [direction, setDirection] = useState('outbound');
  const [consent, setConsent] = useState('granted');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // dialog mounts fresh per session (parent key) — only centers load here
    void loadCenters().then((c) => setCenters(c));
  }, []);

  const selectedCenter = centers.find((c) => c.id === centerId);

  const submit = async () => {
    if (!file) { toast.error('فایل صوتی را انتخاب کنید.'); return; }
    if (!centerId) { toast.error('مرکز مشتری را انتخاب کنید.'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('centerId', centerId);
      if (contactId) fd.append('contactId', contactId);
      fd.append('direction', direction);
      fd.append('consent', consent);
      if (title) fd.append('title', title);
      const res = await fetch('/api/ai-sales/calls/upload', { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error((data as { error?: string }).error || 'خطا در بارگذاری'); return; }
      toast.success('فایل بارگذاری شد — پردازش در پس‌زمینه آغاز شد.');
      onDone();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg" dir="rtl">
        <DialogHeader><DialogTitle className="text-base">بارگذاری فایل صوتی مکالمه</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <label htmlFor="ai-up-center" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">مرکز مشتری *</label>
            <Select value={centerId} onValueChange={(v) => { setCenterId(v); setContactId(''); }}>
              <SelectTrigger id="ai-up-center" className="h-9 text-xs"><SelectValue placeholder="انتخاب مرکز…" /></SelectTrigger>
              <SelectContent>
                {centers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {selectedCenter && selectedCenter.contacts.length > 0 && (
            <div>
              <label htmlFor="ai-up-contact" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">شخص تماس (اختیاری)</label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id="ai-up-contact" className="h-9 text-xs"><SelectValue placeholder="انتخاب شخص…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— بدون شخص خاص —</SelectItem>
                  {selectedCenter.contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.person ? `${c.person} (${c.title})` : c.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ai-up-direction" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">جهت تماس</label>
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger id="ai-up-direction" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">خروجی</SelectItem>
                  <SelectItem value="inbound">ورودی</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="ai-up-consent" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">رضایت ضبط</label>
              <Select value={consent} onValueChange={setConsent}>
                <SelectTrigger id="ai-up-consent" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="granted">با اطلاع مشتری</SelectItem>
                  <SelectItem value="not-required">مشمول رضایت نیست</SelectItem>
                  <SelectItem value="unknown">نامشخص</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label htmlFor="ai-up-title" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">عنوان (اختیاری)</label>
            <input
              id="ai-up-title" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="مثلاً: پیگیری پیش‌فاکتور ونتیلاتور"
              className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
            />
          </div>
          <div>
            <label htmlFor="ai-up-file" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">فایل صوتی *</label>
            <input
              id="ai-up-file" type="file" accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.aac,.flac,.opus"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="w-full text-xs text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-50 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-violet-700 hover:file:bg-violet-100 dark:text-slate-300 dark:file:bg-violet-950 dark:file:text-violet-300"
            />
            <p className="mt-1 text-[11px] text-slate-400">فرمت‌های مجاز: mp3, wav, m4a, webm, ogg, aac, flac, opus — حداکثر ۲۵ مگابایت</p>
          </div>
          <div className="flex justify-start gap-2 pt-1">
            <Button onClick={submit} disabled={submitting || !file || !centerId} className="gap-1.5 bg-violet-600 hover:bg-violet-700">
              {submitting ? 'در حال بارگذاری…' : 'بارگذاری و شروع پردازش'}
            </Button>
            <Button variant="outline" onClick={onClose}>انصراف</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Manual transcript dialog ────────────────────────────────
function ManualTranscriptDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [centers, setCenters] = useState<CenterOption[]>([]);
  const [centerId, setCenterId] = useState('');
  const [contactId, setContactId] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [direction, setDirection] = useState('outbound');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    // dialog mounts fresh per session (parent key) — only centers load here
    void loadCenters().then((c) => setCenters(c));
  }, []);

  const selectedCenter = centers.find((c) => c.id === centerId);

  const submit = async () => {
    if (!centerId) { toast.error('مرکز مشتری را انتخاب کنید.'); return; }
    if (!text.trim() || text.trim().length < 50) { toast.error('متن مکالمه را کامل وارد کنید (حداقل ۵۰ کاراکتر).'); return; }
    setSubmitting(true);
    const res = await aiApiJson('/api/ai-sales/calls', {
      action: 'create-manual', centerId, contactId: contactId === 'none' ? undefined : contactId,
      transcriptText: text.trim(), direction, title: title || undefined, consent: 'not-required',
    });
    setSubmitting(false);
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    toast.success('مکالمه ثبت شد — تحلیل AI آغاز شد.');
    onDone();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" dir="rtl">
        <DialogHeader><DialogTitle className="text-base">ثبت متن مکالمه (بدون فایل صوتی)</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="ai-mt-center" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">مرکز مشتری *</label>
              <Select value={centerId} onValueChange={(v) => { setCenterId(v); setContactId(''); }}>
                <SelectTrigger id="ai-mt-center" className="h-9 text-xs"><SelectValue placeholder="انتخاب مرکز…" /></SelectTrigger>
                <SelectContent>
                  {centers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {selectedCenter && selectedCenter.contacts.length > 0 && (
              <div>
                <label htmlFor="ai-mt-contact" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">شخص تماس (اختیاری)</label>
                <Select value={contactId} onValueChange={setContactId}>
                  <SelectTrigger id="ai-mt-contact" className="h-9 text-xs"><SelectValue placeholder="انتخاب شخص…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— بدون شخص خاص —</SelectItem>
                    {selectedCenter.contacts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>{c.person ? `${c.person} (${c.title})` : c.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="ai-mt-direction" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">جهت تماس</label>
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger id="ai-mt-direction" className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="outbound">خروجی</SelectItem>
                  <SelectItem value="inbound">ورودی</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label htmlFor="ai-mt-title" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">عنوان (اختیاری)</label>
              <input
                id="ai-mt-title" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="مثلاً: تماس درباره استعلام CPAP"
                className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs outline-none focus:border-violet-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>
          <div>
            <label htmlFor="ai-mt-text" className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">متن مکالمه *</label>
            <Textarea
              id="ai-mt-text" value={text} onChange={(e) => setText(e.target.value)} rows={9}
              placeholder={'متن مکالمه را وارد کنید. برای تفکیک گوینده‌ها می‌توانید بنویسید:\nکارشناس: سلام، وقت بخیر…\nمشتری: سلام…'}
              className="text-xs leading-6"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              اگر گوینده‌ها را با «کارشناس:» و «مشتری:» مشخص کنید، تفکیک گوینده دقیق‌تر خواهد بود؛ در غیر این صورت AI از محتوا تشخیص می‌دهد.
            </p>
          </div>
          <div className="flex justify-start gap-2 pt-1">
            <Button onClick={submit} disabled={submitting} className="gap-1.5 bg-violet-600 hover:bg-violet-700">
              {submitting ? 'در حال ثبت…' : 'ثبت و تحلیل'}
            </Button>
            <Button variant="outline" onClick={onClose}>انصراف</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
