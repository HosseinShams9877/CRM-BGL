'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useTabAccess } from '@/components/access-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TICKET_TYPE_LABELS, TICKET_STATUS_LABELS, TICKET_PRIORITY_LABELS, WARRANTY_STATUS_LABELS } from '@/lib/business-model';
import { Search, Plus, Headphones, ShieldCheck, Wrench, ClipboardList, Clock, AlertTriangle, CheckCircle2, XCircle, Loader2, RefreshCw, Phone, Eye, ChevronDown } from 'lucide-react';

// ════════════════════════════════════════════════════════════════
//  AFTER-SALES — خدمات پس از فروش و گارانتی سریال‌محور (تولید —
//  بهبود گستر لیام ایرانیان)
//  تب ۱: تیکت‌های خدمات (ثبت، گردش وضعیت، حل و بستن)
//  تب ۲: استعلام گارانتی با شماره سریال دستگاه
// ════════════════════════════════════════════════════════════════

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد تومان';
  if (amount >= 1_000_000) return toPersianNum(Math.round(amount / 1_000_000)) + ' میلیون تومان';
  return toPersianNum(amount.toLocaleString()) + ' تومان';
}

interface ServiceTicket {
  id: string;
  ticketNumber: string | null;
  serialNumber: string | null;
  productCode: string | null;
  centerId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  type: string;
  status: string;
  priority: string;
  warrantyStatus: string;
  warrantyUntil: string | null;
  issue: string;
  resolution: string;
  cost: number;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  center?: { id: string; name: string; customerType?: string; mobile?: string | null; phone?: string | null } | null;
  _count?: { logs: number };
}

interface WarrantyResult {
  serial: { serialNumber: string; productCode: string | null; status: string; soldAt: string | null; center: { name: string } | null };
  product: { code: string; name: string; warrantyMonths: number; price: number } | null;
  warranty: { status: string; until: string | null; daysLeft: number | null };
  ticketHistory: Array<{ id: string; ticketNumber: string | null; type: string; status: string; createdAt: string; cost: number }>;
  ticketCount: number;
}

const STATUS_STYLE: Record<string, { color: string; bg: string }> = {
  open: { color: '#6366f1', bg: '#eef2ff' },
  in_progress: { color: '#0891b2', bg: '#ecfeff' },
  waiting_parts: { color: '#d97706', bg: '#fffbeb' },
  resolved: { color: '#059669', bg: '#ecfdf5' },
  closed: { color: '#6b7280', bg: '#f3f4f6' },
  rejected: { color: '#dc2626', bg: '#fef2f2' },
};

const PRIORITY_STYLE: Record<string, { color: string; bg: string }> = {
  low: { color: '#6b7280', bg: '#f3f4f6' },
  normal: { color: '#0891b2', bg: '#ecfeff' },
  high: { color: '#d97706', bg: '#fffbeb' },
  critical: { color: '#dc2626', bg: '#fef2f2' },
};

const WARRANTY_STYLE: Record<string, { color: string; bg: string }> = {
  in_warranty: { color: '#059669', bg: '#ecfdf5' },
  out_of_warranty: { color: '#dc2626', bg: '#fef2f2' },
  unknown: { color: '#6b7280', bg: '#f3f4f6' },
};

/** گردش مجاز وضعیت‌ها */
const NEXT_STATUSES: Record<string, string[]> = {
  open: ['in_progress', 'rejected'],
  in_progress: ['waiting_parts', 'resolved', 'rejected'],
  waiting_parts: ['in_progress', 'resolved'],
  resolved: ['closed'],
  closed: [],
  rejected: [],
};

// ── New ticket dialog ──
function NewTicketDialog({ open, onOpenChange, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [serialNumber, setSerialNumber] = useState('');
  const [serialChecked, setSerialChecked] = useState<WarrantyResult | 'not-found' | null>(null);
  const [checking, setChecking] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [type, setType] = useState('repair');
  const [priority, setPriority] = useState('normal');
  const [issue, setIssue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    if (!serialNumber.trim()) return;
    setChecking(true);
    setSerialChecked(null);
    try {
      const res = await fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'warranty-lookup', serialNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'سریال یافت نشد');
      setSerialChecked(data.data);
      if (data.data?.serial?.center?.name) setContactName((prev) => prev || data.data.serial.center.name);
    } catch {
      setSerialChecked('not-found');
    } finally {
      setChecking(false);
    }
  };

  const submit = async () => {
    if (!issue.trim()) {
      setError('شرح مشکل الزامی است.');
      return;
    }
    if (!serialNumber.trim() && !contactName.trim()) {
      setError('شماره سریال یا نام اعلام‌کننده را وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // v2.22.0 — a serial the lookup could NOT find is dropped before
      // submit. The hint below promises «تیکت بدون گارانتی ثبت می‌شود»,
      // but the API answers 404 for unknown serials (FK integrity: a
      // ticket's serialNumber must exist in InventorySerial). Dropping it
      // here keeps the promise — the ticket registers without the serial
      // link / warranty, exactly what the banner said would happen.
      const deadSerial = serialChecked === 'not-found';
      const res = await fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          serialNumber: deadSerial ? undefined : serialNumber.trim() || undefined,
          contactName: contactName || undefined,
          contactPhone: contactPhone || undefined,
          type,
          priority,
          issue,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت تیکت');
      toast.success(data.message || 'تیکت ثبت شد');
      onOpenChange(false);
      setSerialNumber(''); setContactName(''); setContactPhone(''); setIssue(''); setSerialChecked(null);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت تیکت');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Headphones size={18} className="text-teal-600" /> ثبت تیکت خدمات پس از فروش
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          {/* Serial lookup */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="aftersales-f189-1">شماره سریال دستگاه</label>
            <div className="flex items-center gap-2">
              <Input id="aftersales-f189-1" value={serialNumber} onChange={(e) => { setSerialNumber(e.target.value); setSerialChecked(null); }}
                placeholder="مثلاً: BGL-2024-00125" className="flex-1 h-10 rounded-lg" dir="ltr" />
              <Button onClick={lookup} disabled={checking || !serialNumber.trim()} variant="outline" size="sm"
                className="h-10 gap-1.5 text-xs rounded-lg shrink-0">
                {checking ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={14} />} استعلام گارانتی
              </Button>
            </div>
            {serialChecked === 'not-found' && (
              <p className="text-[11px] text-red-600 mt-1.5 flex items-center gap-1"><AlertTriangle size={11} /> این سریال در انبار یافت نشد — تیکت بدون گارانتی ثبت می‌شود.</p>
            )}
            {serialChecked && serialChecked !== 'not-found' && (
              <div className="mt-2 bg-gray-50 rounded-xl p-3 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-bold text-gray-900">{serialChecked.product?.name || serialChecked.serial.productCode || 'محصول نامشخص'}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: WARRANTY_STYLE[serialChecked.warranty.status]?.bg, color: WARRANTY_STYLE[serialChecked.warranty.status]?.color }}>
                    {WARRANTY_STATUS_LABELS[serialChecked.warranty.status]}
                  </span>
                  {serialChecked.warranty.daysLeft !== null && serialChecked.warranty.daysLeft > 0 && (
                    <span className="text-[11px] text-gray-500">{toPersianNum(serialChecked.warranty.daysLeft)} روز باقی‌مانده</span>
                  )}
                </div>
                {serialChecked.serial.soldAt && (
                  <p className="text-[11px] text-gray-400">تاریخ فروش: {new Date(serialChecked.serial.soldAt).toLocaleDateString('fa-IR')}</p>
                )}
                {serialChecked.serial.center?.name && (
                  <p className="text-[11px] text-gray-400">خریدار: {serialChecked.serial.center.name}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="aftersales-f225-2">نوع خدمات</label>
              <select id="aftersales-f225-2" value={type} onChange={(e) => setType(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
                {Object.entries(TICKET_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="aftersales-f231-3">اولویت</label>
              <select id="aftersales-f231-3" value={priority} onChange={(e) => setPriority(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
                {Object.entries(TICKET_PRIORITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="aftersales-f239-4">نام اعلام‌کننده</label><Input id="aftersales-f239-4" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="نام مشتری / مرکز" className="h-10 rounded-lg" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="aftersales-f240-5">تلفن تماس</label><Input id="aftersales-f240-5" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="۰۹۱۲..." className="h-10 rounded-lg" dir="ltr" /></div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">شرح مشکل <span className="text-red-500">*</span></label>
            <Textarea value={issue} onChange={(e) => setIssue(e.target.value)} rows={3} className="rounded-lg resize-none" placeholder="شرح دقیق مشکل، علائم و شرایط بروز..." />
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-11 rounded-xl text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت تیکت'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Ticket detail dialog ──
function TicketDetailDialog({ ticket, open, onOpenChange, onDone }: {
  ticket: ServiceTicket | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [detail, setDetail] = useState<ServiceTicket | null>(null);
  // v2.58.0 (audit 85-b): detail-fetch failures now have a visible state
  // (retry bumps reloadTick — ticket itself is a prop, not state).
  const [detailError, setDetailError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolution, setResolution] = useState('');
  const [cost, setCost] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !ticket) return;
    // Microtask: keeps setLoading(true) out of the effect body
    // (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      setLoading(true);
      setDetailError(null);
      fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', id: ticket.id }),
      })
        .then((r) => {
          // v2.58.0 (audit 85-b): a 403/500/network failure used to fall
          // through `.catch(() => undefined)` — the dialog opened with an
          // empty detail and zero feedback.
          if (!r.ok) throw new Error('خطا در دریافت جزئیات تیکت');
          return r.json();
        })
        .then((data) => {
          if (data.data) {
            setDetail(data.data);
            setResolution(data.data.resolution || '');
            setCost(String(data.data.cost || ''));
          } else {
            setDetail(null);
            setDetailError('جزئیات این تیکت یافت نشد.');
          }
        })
        .catch((e: unknown) => {
          setDetail(null);
          setDetailError(e instanceof Error ? e.message : 'خطا در دریافت جزئیات تیکت');
        })
        .finally(() => setLoading(false));
    });
  }, [open, ticket, reloadTick]);

  const setTicketStatus = async (status: string) => {
    if (!ticket) return;
    setBusy(true);
    try {
      const res = await fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set-status', id: ticket.id, status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا');
      toast.success(data.message || 'وضعیت تغییر کرد');
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا');
    } finally {
      setBusy(false);
    }
  };

  const resolveTicket = async () => {
    if (!ticket) return;
    setBusy(true);
    try {
      const res = await fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', id: ticket.id, resolution: resolution || undefined, cost: cost ? Number(cost) : undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا');
      toast.success(data.message || 'تیکت حل شد');
      onOpenChange(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا');
    } finally {
      setBusy(false);
    }
  };

  if (!ticket) return null;
  const t = detail || ticket;
  const st = STATUS_STYLE[t.status];
  const nextStatuses = NEXT_STATUSES[t.status] || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(36rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <Headphones size={18} className="text-teal-600" />
            تیکت {t.ticketNumber}
            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: st?.bg, color: st?.color }}>
              {TICKET_STATUS_LABELS[t.status]}
            </span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-10 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-teal-600" /></div>
        ) : detailError ? (
          <div className="py-8 text-center">
            <p className="text-xs text-red-600 bg-red-50 rounded-lg p-3">{detailError}</p>
            <button
              type="button"
              className="mt-3 text-xs text-teal-700 font-medium underline"
              onClick={() => { setDetailError(null); setReloadTick((n) => n + 1); }}
            >
              تلاش مجدد
            </button>
          </div>
        ) : (
          <div className="space-y-4 mt-2">
            {/* Info grid */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-[11px] text-gray-400 mb-0.5">نوع خدمات</p>
                <p className="font-bold text-gray-900">{TICKET_TYPE_LABELS[t.type] || t.type}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-[11px] text-gray-400 mb-0.5">اولویت</p>
                <p className="font-bold" style={{ color: PRIORITY_STYLE[t.priority]?.color }}>{TICKET_PRIORITY_LABELS[t.priority] || t.priority}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-[11px] text-gray-400 mb-0.5">سریال دستگاه</p>
                <p className="font-bold text-gray-900" dir="ltr">{t.serialNumber || '—'}</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-2.5">
                <p className="text-[11px] text-gray-400 mb-0.5">وضعیت گارانتی</p>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium inline-block"
                  style={{ background: WARRANTY_STYLE[t.warrantyStatus]?.bg, color: WARRANTY_STYLE[t.warrantyStatus]?.color }}>
                  {WARRANTY_STATUS_LABELS[t.warrantyStatus]}
                </span>
              </div>
            </div>

            {/* Customer */}
            {(t.center?.name || t.contactName || t.contactPhone) && (
              <div className="bg-white border border-gray-100 rounded-xl p-3">
                <p className="text-[11px] text-gray-400 mb-1">مشتری</p>
                <p className="text-sm font-bold text-gray-900">{t.center?.name || t.contactName}</p>
                {(t.contactPhone || t.center?.mobile || t.center?.phone) && (
                  <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1" dir="ltr">
                    <Phone size={10} /> {t.contactPhone || t.center?.mobile || t.center?.phone}
                  </p>
                )}
              </div>
            )}

            {/* Issue */}
            <div>
              <p className="text-[11px] text-gray-400 mb-1">شرح مشکل</p>
              <p className="text-sm text-gray-700 leading-6 bg-amber-50/50 border border-amber-100 rounded-xl p-3">{t.issue}</p>
            </div>

            {/* Resolve form (open tickets) */}
            {['open', 'in_progress', 'waiting_parts'].includes(t.status) && (
              <div className="bg-green-50/50 border border-green-100 rounded-xl p-3 space-y-2">
                <p className="text-xs font-bold text-green-800 flex items-center gap-1.5"><CheckCircle2 size={13} /> ثبت اقدام و حل تیکت</p>
                <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={2} className="rounded-lg resize-none text-xs"
                  placeholder="شرح اقدام انجام‌شده..." />
                <div className="flex items-center gap-2">
                  <Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="هزینه (تومان)" className="h-9 rounded-lg text-xs flex-1" dir="ltr" inputMode="decimal" />
                  <Button onClick={resolveTicket} disabled={busy} size="sm" className="h-9 gap-1 text-xs rounded-lg text-white"
                    style={{ background: 'linear-gradient(135deg, #059669, #065f46)' }}>
                    <CheckCircle2 size={13} /> حل شد
                  </Button>
                </div>
              </div>
            )}

            {/* Resolution shown */}
            {t.resolution && !['open', 'in_progress', 'waiting_parts'].includes(t.status) && (
              <div>
                <p className="text-[11px] text-gray-400 mb-1">اقدام انجام‌شده</p>
                <p className="text-sm text-gray-700 leading-6 bg-green-50 border border-green-100 rounded-xl p-3">{t.resolution}</p>
                {t.cost > 0 && <p className="text-[11px] text-gray-500 mt-1">هزینه: {formatCurrency(t.cost)}</p>}
              </div>
            )}

            {/* Status workflow */}
            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-gray-100">
              <span className="text-[11px] text-gray-400">انتقال به:</span>
              {nextStatuses.length === 0 ? (
                <span className="text-[11px] text-gray-400">این تیکت در وضعیت نهایی است.</span>
              ) : (
                nextStatuses.map((s) => (
                  <Button key={s} onClick={() => setTicketStatus(s)} disabled={busy} size="sm" variant="outline"
                    className="h-8 text-[11px] rounded-lg gap-1">
                    {s === 'rejected' ? <XCircle size={12} className="text-red-500" /> : s === 'resolved' ? <CheckCircle2 size={12} className="text-green-500" /> : <ChevronDown size={12} />}
                    {TICKET_STATUS_LABELS[s]}
                  </Button>
                ))
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Warranty lookup tab ──
function WarrantyLookupTab() {
  const [serialNumber, setSerialNumber] = useState('');
  const [result, setResult] = useState<WarrantyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lookup = async () => {
    if (!serialNumber.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/after-sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'warranty-lookup', serialNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'سریال یافت نشد');
      setResult(data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در استعلام');
    } finally {
      setLoading(false);
    }
  };

  const w = result?.warranty;

  return (
    <div className="space-y-4" dir="rtl">
      {/* Search box */}
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <label className="block text-sm font-bold text-gray-800 mb-2 flex items-center gap-1.5">
          <ShieldCheck size={16} className="text-teal-600" /> استعلام گارانتی با شماره سریال
        </label>
        <div className="flex items-center gap-2">
          <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && lookup()}
            placeholder="شماره سریال دستگاه را وارد کنید..." className="flex-1 h-11 rounded-lg" dir="ltr" />
          <Button onClick={lookup} disabled={loading || !serialNumber.trim()} className="h-11 gap-1.5 text-white text-sm rounded-lg px-4"
            style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />} استعلام
          </Button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          گارانتی به‌صورت خودکار از تاریخ فروش سریال + دورهٔ گارانتی محصول محاسبه می‌شود.
        </p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-center">
          <AlertTriangle size={28} className="mx-auto mb-2 text-red-400" />
          <p className="text-sm text-red-600">{error}</p>
        </div>
      )}

      {result && (
        <>
          {/* Warranty card */}
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="p-4 flex items-center justify-between flex-wrap gap-3"
              style={{ background: w?.status === 'in_warranty' ? '#ecfdf5' : w?.status === 'out_of_warranty' ? '#fef2f2' : '#f3f4f6' }}>
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shrink-0"
                  style={{ background: w?.status === 'in_warranty' ? 'linear-gradient(135deg, #059669, #065f46)' : w?.status === 'out_of_warranty' ? 'linear-gradient(135deg, #dc2626, #991b1b)' : 'linear-gradient(135deg, #6b7280, #374151)' }}>
                  {w?.status === 'in_warranty' ? <ShieldCheck size={22} /> : <AlertTriangle size={22} />}
                </div>
                <div>
                  <p className="text-lg font-bold" style={{ color: WARRANTY_STYLE[w?.status || 'unknown']?.color }}>
                    {WARRANTY_STATUS_LABELS[w?.status || 'unknown']}
                  </p>
                  <p className="text-xs text-gray-500">
                    {w?.until ? `تا تاریخ ${new Date(w.until).toLocaleDateString('fa-IR')}` : 'بدون تاریخ فروش ثبت‌شده'}
                    {w?.daysLeft !== null && w?.daysLeft !== undefined && w.daysLeft > 0 ? ` · ${toPersianNum(w.daysLeft)} روز باقی‌مانده` : ''}
                  </p>
                </div>
              </div>
              <span className="text-[11px] px-3 py-1.5 rounded-lg bg-white/80 font-mono font-bold text-gray-700" dir="ltr">
                {result.serial.serialNumber}
              </span>
            </div>
            <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <p className="text-[11px] text-gray-400 mb-0.5">محصول</p>
                <p className="font-bold text-gray-900">{result.product?.name || result.serial.productCode || '—'}</p>
                {result.product && <p className="text-[11px] text-gray-400 mt-0.5">گارانتی {toPersianNum(result.product.warrantyMonths)} ماهه</p>}
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-0.5">وضعیت سریال</p>
                <p className="font-bold text-gray-900">{result.serial.status === 'sold' ? 'فروش‌رفته' : result.serial.status === 'available' ? 'موجود' : result.serial.status === 'returned' ? 'مرجوعی' : result.serial.status}</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-0.5">تاریخ فروش</p>
                <p className="font-bold text-gray-900">{result.serial.soldAt ? new Date(result.serial.soldAt).toLocaleDateString('fa-IR') : '—'}</p>
              </div>
              <div>
                <p className="text-[11px] text-gray-400 mb-0.5">خریدار</p>
                <p className="font-bold text-gray-900">{result.serial.center?.name || '—'}</p>
              </div>
            </div>
          </div>

          {/* Ticket history */}
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="p-3 border-b border-gray-50 flex items-center gap-2">
              <ClipboardList size={15} className="text-teal-600" />
              <h4 className="text-sm font-bold text-gray-900">سابقهٔ خدمات این دستگاه</h4>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-bold">{toPersianNum(result.ticketCount)}</span>
            </div>
            {result.ticketHistory.length === 0 ? (
              <div className="p-8 text-center text-xs text-gray-400">تاکنون تیکتی برای این دستگاه ثبت نشده است</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {result.ticketHistory.map((t) => (
                  <div key={t.id} className="flex items-center gap-3 p-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: STATUS_STYLE[t.status]?.bg, color: STATUS_STYLE[t.status]?.color }}>
                      <Wrench size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-bold text-gray-900" dir="ltr">{t.ticketNumber}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: STATUS_STYLE[t.status]?.bg, color: STATUS_STYLE[t.status]?.color }}>
                          {TICKET_STATUS_LABELS[t.status]}
                        </span>
                        <span className="text-[11px] text-gray-400">{TICKET_TYPE_LABELS[t.type] || t.type}</span>
                      </div>
                      <p className="text-[11px] text-gray-400 mt-0.5">{new Date(t.createdAt).toLocaleDateString('fa-IR')}</p>
                    </div>
                    {t.cost > 0 && <span className="text-xs font-bold text-gray-700 shrink-0">{formatCurrency(t.cost)}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ════════════════════════════════════════════════════════════════
export default function AfterSales({ activeTab: propTab }: { activeTab?: string }) {
  const [tickets, setTickets] = useState<ServiceTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'tickets' | 'warranty'>(propTab === 'aftersales-warranty' ? 'warranty' : 'tickets');
  // v2.26.0 — tabs access-gated (aftersales-tickets / aftersales-warranty).
  const { isTabAllowed } = useTabAccess();
  const AS_TAB_MENU_KEYS: Record<string, string> = { tickets: 'aftersales-tickets', warranty: 'aftersales-warranty' };
  const currentTab: 'tickets' | 'warranty' =
    (tab === 'warranty' && isTabAllowed(AS_TAB_MENU_KEYS.warranty)) || tab === 'tickets'
      ? tab
      : (isTabAllowed(AS_TAB_MENU_KEYS.warranty) ? 'warranty' : 'tickets');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showNew, setShowNew] = useState(false);
  const [detailTicket, setDetailTicket] = useState<ServiceTicket | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [stats, setStats] = useState<Record<string, number> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tRes, sRes] = await Promise.all([
        fetch('/api/after-sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list', limit: 150 }),
        }),
        fetch('/api/after-sales', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stats' }),
        }),
      ]);
      const tData = await tRes.json();
      const sData = await sRes.json();
      if (!tRes.ok) throw new Error(tData.error || 'خطا در دریافت تیکت‌ها');
      setTickets(Array.isArray(tData.data) ? tData.data : []);
      setStats(sData.data || null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در دریافت تیکت‌ها');
    } finally {
      setLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  const filtered = useMemo(() => {
    return tickets.filter((t) => {
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (
          !(t.ticketNumber || '').toLowerCase().includes(q) &&
          !(t.serialNumber || '').toLowerCase().includes(q) &&
          !(t.center?.name || '').includes(q) &&
          !(t.contactName || '').includes(q) &&
          !t.issue.includes(q)
        ) return false;
      }
      return true;
    });
  }, [tickets, search, statusFilter]);

  return (
    <div className="space-y-4" dir="rtl">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        {[
          { label: 'باز', value: stats?.open ?? 0, icon: <AlertTriangle size={16} />, color: '#6366f1', bg: '#eef2ff' },
          { label: 'در حال انجام', value: stats?.inProgress ?? 0, icon: <Wrench size={16} />, color: '#0891b2', bg: '#ecfeff' },
          { label: 'در انتظار قطعه', value: stats?.waitingParts ?? 0, icon: <Clock size={16} />, color: '#d97706', bg: '#fffbeb' },
          { label: 'حل‌شدهٔ این ماه', value: stats?.resolvedThisMonth ?? 0, icon: <CheckCircle2 size={16} />, color: '#059669', bg: '#ecfdf5' },
          { label: 'در گارانتی', value: stats?.inWarranty ?? 0, icon: <ShieldCheck size={16} />, color: '#059669', bg: '#ecfdf5' },
          { label: 'خارج از گارانتی', value: stats?.outOfWarranty ?? 0, icon: <XCircle size={16} />, color: '#dc2626', bg: '#fef2f2' },
        ].map((s, i) => (
          <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100">
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
              <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
            </div>
            <p className="text-lg lg:text-xl font-bold" style={{ color: s.color }}>{toPersianNum(s.value)}</p>
            <p className="text-[11px] text-gray-400 lg:hidden">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            {isTabAllowed(AS_TAB_MENU_KEYS.tickets) && (
            <button onClick={() => setTab('tickets')} role="tab" aria-selected={currentTab === 'tickets'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${currentTab === 'tickets' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <Headphones size={14} /> تیکت‌های خدمات
              <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700">{toPersianNum(tickets.length)}</span>
            </button>
            )}
            {isTabAllowed(AS_TAB_MENU_KEYS.warranty) && (
            <button onClick={() => setTab('warranty')} role="tab" aria-selected={currentTab === 'warranty'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${currentTab === 'warranty' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
              <ShieldCheck size={14} /> استعلام گارانتی
            </button>
            )}
          </div>
          {currentTab === 'tickets' ? (
            <div className="flex items-center gap-2 flex-wrap">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                <option value="all">همهٔ وضعیت‌ها</option>
                {Object.entries(TICKET_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <div className="relative">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی تیکت، سریال، مشتری..." className="pr-8 h-9 w-52 rounded-lg text-xs border-gray-200" />
              </div>
              <Button onClick={() => setShowNew(true)} className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                <Plus size={13} /> تیکت جدید
              </Button>
            </div>
          ) : (
            <Button onClick={load} variant="outline" size="sm" className="h-9 gap-1.5 text-xs rounded-lg">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> به‌روزرسانی
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      {currentTab === 'warranty' ? (
        <WarrantyLookupTab />
      ) : loading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-teal-600" />
          <p className="text-sm text-gray-400">در حال دریافت تیکت‌ها...</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
          <Headphones size={36} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">تیکتی یافت نشد</p>
          <Button onClick={() => setShowNew(true)} variant="outline" size="sm" className="mt-3 h-9 gap-1.5 text-xs rounded-lg">
            <Plus size={13} /> ثبت اولین تیکت خدمات
          </Button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-[11px] text-gray-500">
                  <th className="py-3 px-3 text-right font-medium">شماره</th>
                  <th className="py-3 px-3 text-right font-medium">نوع</th>
                  <th className="py-3 px-3 text-right font-medium">مشتری</th>
                  <th className="py-3 px-3 text-right font-medium">سریال</th>
                  <th className="py-3 px-3 text-right font-medium">گارانتی</th>
                  <th className="py-3 px-3 text-right font-medium">اولویت</th>
                  <th className="py-3 px-3 text-right font-medium">وضعیت</th>
                  <th className="py-3 px-3 text-right font-medium">تاریخ</th>
                  <th className="py-3 px-3 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className="border-t border-gray-50 hover:bg-gray-50/50 transition-colors">
                    <td className="py-3 px-3 font-mono text-[11px] font-bold text-gray-700 text-right" dir="ltr">{t.ticketNumber}</td>
                    <td className="py-3 px-3 text-xs text-gray-600">{TICKET_TYPE_LABELS[t.type] || t.type}</td>
                    <td className="py-3 px-3">
                      <p className="text-xs font-bold text-gray-900">{t.center?.name || t.contactName || '—'}</p>
                      {(t.contactPhone || t.center?.mobile) && <p className="text-[11px] text-gray-400 text-right" dir="ltr">{t.contactPhone || t.center?.mobile}</p>}
                    </td>
                    <td className="py-3 px-3 font-mono text-[11px] text-gray-500 text-right" dir="ltr">{t.serialNumber || '—'}</td>
                    <td className="py-3 px-3">
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: WARRANTY_STYLE[t.warrantyStatus]?.bg, color: WARRANTY_STYLE[t.warrantyStatus]?.color }}>
                        {WARRANTY_STATUS_LABELS[t.warrantyStatus]}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: PRIORITY_STYLE[t.priority]?.bg, color: PRIORITY_STYLE[t.priority]?.color }}>
                        {TICKET_PRIORITY_LABELS[t.priority] || t.priority}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: STATUS_STYLE[t.status]?.bg, color: STATUS_STYLE[t.status]?.color }}>
                        {TICKET_STATUS_LABELS[t.status] || t.status}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-[11px] text-gray-400">{new Date(t.createdAt).toLocaleDateString('fa-IR')}</td>
                    <td className="py-3 px-3">
                      <Button size="sm" variant="outline" aria-label="مشاهدهٔ جزئیات تیکت" className="h-7 w-7 p-0 rounded-lg" onClick={() => { setDetailTicket(t); setShowDetail(true); }}>
                        <Eye size={12} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <NewTicketDialog open={showNew} onOpenChange={setShowNew} onDone={load} />
      <TicketDetailDialog ticket={detailTicket} open={showDetail} onOpenChange={setShowDetail} onDone={load} />
    </div>
  );
}
