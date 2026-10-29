'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — NEXT BEST ACTIONS (v2.27.0)
// Suggested → Approve → Execute (creates a REAL CRM Activity) →
// Complete. Every action shows its Reason + Confidence.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ListTodo, RefreshCw, Check, Play, X, Flag, Clock, AlertTriangle,
} from 'lucide-react';
import {
  faDate, AiSkeleton, AiEmptyState, AiErrorState, aiApiJson,
  ActionStatusBadge, ActionTypeBadge, ConfidenceBar,
} from './shared';
import { AI_APPROVAL_MODE_LABEL, type AiApprovalMode } from '@/lib/ai/types';

interface ActionRow {
  id: string; type: string; title: string; detail: string; priority: string;
  dueAt: string | null; reason: string; confidence: number; status: string;
  createdAt: string; dismissedReason: string;
  center: { id: string; name: string } | null;
  contact: { id: string; title: string; person: string | null } | null;
  assignee: { id: string; displayName: string } | null;
}

export function AiActions({ companySlug }: { companySlug: string }) {
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [mode, setMode] = useState<AiApprovalMode>('confirm');
  const [busyId, setBusyId] = useState('');
  // Snapshot of "now" captured when data loads — keeps render pure
  // (Date.now() during render is forbidden by the compiler rules).
  const [nowTs, setNowTs] = useState(0);

  const load = useCallback(async () => {
    const res = await aiApiJson<{ items: ActionRow[] }>('/api/ai-sales/actions', {
      action: 'list', companySlug: companySlug === 'holding' ? undefined : companySlug,
      status: statusFilter === 'open' ? undefined : statusFilter === 'open' ? 'suggested' : statusFilter,
    });
    setLoading(false);
    if (!res.ok || !res.data) { setError(res.error || 'خطا'); return; }
    setError('');
    let items = res.data.items || [];
    if (statusFilter === 'open') items = items.filter((a) => a.status === 'suggested' || a.status === 'approved');
    setRows(items);
    setNowTs(Date.now());
  }, [companySlug, statusFilter]);

  // No synchronous setState before the first await inside load — the
  // react-hooks v7 compiler rules reject sync setState in effects.
  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  useEffect(() => {
    void (async () => {
      const res = await aiApiJson<{ approvalMode: AiApprovalMode }>('/api/ai-sales/actions', {
        action: 'policy', companySlug: companySlug === 'holding' ? undefined : companySlug,
      });
      if (res.ok && res.data?.approvalMode) setMode(res.data.approvalMode);
    })();
  }, [companySlug]);

  const act = async (fn: 'approve' | 'execute' | 'dismiss' | 'complete', id: string) => {
    setBusyId(id);
    let body: Record<string, unknown> = { action: fn, id };
    if (fn === 'dismiss') {
      const reason = window.prompt('دلیل رد این اقدام چیست؟ (اختیاری)') ?? '';
      body = { ...body, reason };
    }
    const res = await aiApiJson('/api/ai-sales/actions', body);
    setBusyId('');
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    toast.success(
      fn === 'approve' ? 'تأیید شد — حالا می‌توانید اجرا کنید.'
        : fn === 'execute' ? 'اجرا شد و فعالیت در تقویم/فعالیت‌ها ثبت شد.'
        : fn === 'dismiss' ? 'رد شد.'
        : 'تکمیل شد.',
    );
    void load();
  };

  const overdue = (a: ActionRow) => nowTs > 0 && !!a.dueAt && new Date(a.dueAt).getTime() < nowTs && (a.status === 'suggested' || a.status === 'approved');

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <ListTodo size={18} className="text-violet-600 dark:text-violet-400" aria-hidden="true" />
            اقدامات پیشنهادی هوش مصنوعی
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            سیاست فعلی: <b>{AI_APPROVAL_MODE_LABEL[mode]}</b>
            {mode === 'auto' && ' — اقدامات پراطمینان خودکار اجرا می‌شوند.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-36 text-xs" aria-label="فیلتر وضعیت"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="open">باز</SelectItem>
              <SelectItem value="suggested">پیشنهادی</SelectItem>
              <SelectItem value="approved">تأییدشده</SelectItem>
              <SelectItem value="executed">اجرا شده</SelectItem>
              <SelectItem value="completed">تکمیل</SelectItem>
              <SelectItem value="dismissed">ردشده</SelectItem>
              <SelectItem value="all">همه</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }} className="h-8 gap-1 text-xs" aria-label="رفرش">
            <RefreshCw size={13} aria-hidden="true" /> رفرش
          </Button>
        </div>
      </div>

      {loading && <AiSkeleton rows={4} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}
      {!loading && !error && rows.length === 0 && (
        <AiEmptyState
          title="اقدام پیشنهادی بازی وجود ندارد"
          description="پس از تحلیل هر مکالمه، اقدامات بعدی با دلیل و میزان اطمینان اینجا پیشنهاد می‌شوند. یک مکالمه را در «تماس‌های تحلیل‌شده» ثبت کنید."
        />
      )}
      {!loading && !error && rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className={`rounded-2xl border p-3 ${overdue(a) ? 'border-rose-200 bg-rose-50/40 dark:border-rose-900 dark:bg-rose-950/20' : 'border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900'}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <ActionTypeBadge type={a.type} />
                  <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{a.title}</span>
                  <ActionStatusBadge status={a.status} />
                  {a.priority === 'high' && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950 dark:text-rose-300">اولویت بالا</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  {a.status === 'suggested' && (
                    <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => void act('approve', a.id)} className="h-7 gap-1 px-2 text-[11px]">
                      <Check size={12} aria-hidden="true" /> تأیید
                    </Button>
                  )}
                  {(a.status === 'suggested' || a.status === 'approved') && (
                    <Button size="sm" disabled={busyId === a.id} onClick={() => void act('execute', a.id)} className="h-7 gap-1 bg-emerald-600 px-2 text-[11px] hover:bg-emerald-700">
                      <Play size={12} aria-hidden="true" /> اجرا و ثبت فعالیت
                    </Button>
                  )}
                  {a.status === 'suggested' && (
                    <Button size="sm" variant="ghost" disabled={busyId === a.id} onClick={() => void act('dismiss', a.id)} className="h-7 gap-1 px-2 text-[11px] text-slate-500" aria-label="رد">
                      <X size={12} aria-hidden="true" /> رد
                    </Button>
                  )}
                  {a.status === 'executed' && (
                    <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => void act('complete', a.id)} className="h-7 gap-1 px-2 text-[11px]">
                      <Flag size={12} aria-hidden="true" /> تکمیل
                    </Button>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                {a.center && <span>مشتری: <b className="text-slate-700 dark:text-slate-200">{a.center.name}</b></span>}
                {a.contact?.person && <span>شخص: {a.contact.person}</span>}
                <span className="flex items-center gap-1">
                  <Clock size={11} aria-hidden="true" />
                  {a.dueAt ? (overdue(a) ? <span className="font-semibold text-rose-600 dark:text-rose-400">موعد گذشته: {faDate(a.dueAt)}</span> : `موعد: ${faDate(a.dueAt)}`) : 'بدون موعد'}
                </span>
                <ConfidenceBar confidence={a.confidence} />
              </div>
              <p className="mt-2 rounded-lg bg-slate-50 p-2 text-xs leading-6 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
                <b className="text-slate-700 dark:text-slate-200">چرا این اقدام؟ </b>{a.reason}
              </p>
              {a.detail && <p className="mt-1 text-[11px] leading-5 text-slate-500 dark:text-slate-400">{a.detail}</p>}
              {a.status === 'dismissed' && a.dismissedReason && (
                <p className="mt-1 flex items-center gap-1 text-[11px] text-slate-400"><AlertTriangle size={11} aria-hidden="true" /> دلیل رد: {a.dismissedReason}</p>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="text-center text-[11px] text-slate-400">
        «اجرا و ثبت فعالیت» یک فعالیت واقعی در ماژول فعالیت‌ها/تقویم ایجاد می‌کند — هیچ سیستم موازی ساخته نمی‌شود.
        {mode === 'auto' && ' در حالت اجرای خودکار، اقدامات با اطمینان بالا خودکار ثبت می‌شوند.'}
      </p>
    </div>
  );
}
