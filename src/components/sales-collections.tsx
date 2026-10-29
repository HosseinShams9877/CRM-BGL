'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { toJalaliKey, jalaliMonthLength } from '@/lib/jalali';
import { toast } from 'sonner';
import SmsDialog from '@/components/sms-dialog';
import { buildCollectionReminderSms } from '@/lib/sms/provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  Search, Plus, CreditCard, AlertTriangle, Check, Building2, Clock, CircleDollarSign,
  Calendar, Phone, MessageCircle, MapPin, FileText, Banknote, ChevronDown,
} from 'lucide-react';
// v2.58.5 (R2) — the payment submit engine: ONE idempotency key per
// LOGICAL operation, surviving network loss and dialog reopen.
import { submitIdempotentPayment, resolvePendingPayment, type PaymentAttemptState } from '@/lib/payment-idempotency';

// ==================== TYPES ====================
type CollectionStatus = 'overdue' | 'due-soon' | 'pending' | 'partial' | 'paid' | 'disputed' | 'legal';

interface CollectionInvoice {
  id: string;
  number: string;
  centerId: string | null;
  centerName: string;
  city: string;
  personName: string;
  /** v2.43.0 — center contact phone (SMS prefill; may be null) */
  phone: string | null;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  issueDate: string;
  dueDate: string;
  overdueDays: number;
  status: CollectionStatus;
  lastAction: string;
  lastActionDate: string;
  nextFollowup: string;
  checkCount: number;
  notes: string;
}

// ==================== CONFIGS ====================
const STATUS_CFG: Record<CollectionStatus, { label: string; color: string; bg: string }> = {
  'overdue': { label: 'سررسید گذشته', color: '#dc2626', bg: '#fef2f2' },
  'due-soon': { label: 'نزدیک سررسید', color: '#d97706', bg: '#fffbeb' },
  'pending': { label: 'در انتظار پرداخت', color: '#6366f1', bg: '#eef2ff' },
  'partial': { label: 'پرداخت جزئی', color: '#0891b2', bg: '#ecfeff' },
  'paid': { label: 'تسویه شده', color: '#059669', bg: '#ecfdf5' },
  'disputed': { label: 'مورد اختلاف', color: '#7c3aed', bg: '#f5f3ff' },
  'legal': { label: 'اقدام حقوقی', color: '#dc2626', bg: '#fef2f2' },
};

const ACTION_TYPE_CFG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  'call': { label: 'تماس', color: '#0891b2', bg: '#ecfeff', icon: <Phone size={12} /> },
  'visit': { label: 'مراجعه', color: '#059669', bg: '#ecfdf5', icon: <MapPin size={12} /> },
  'sms': { label: 'پیامک', color: '#6366f1', bg: '#eef2ff', icon: <MessageCircle size={12} /> },
  'letter': { label: 'نامه', color: '#d97706', bg: '#fffbeb', icon: <FileText size={12} /> },
  'legal': { label: 'حقوقی', color: '#dc2626', bg: '#fef2f2', icon: <AlertTriangle size={12} /> },
  'payment': { label: 'پرداخت', color: '#059669', bg: '#ecfdf5', icon: <Check size={12} /> },
  'promise': { label: 'قول پرداخت', color: '#7c3aed', bg: '#f5f3ff', icon: <Calendar size={12} /> },
};

// v2.58.1 (audit F1) — module-level so the React compiler sees no impure
// call inside the component body.
// v2.58.5 (R2) — STABLE per invoice: a settle retry after a lost response
// replays the stored result (and the server's alreadySettled guard is the
// semantic backstop). Same invoice + same action = the same logical op.
function makeSettleKey(invoiceId: string): string {
  return `settle-${invoiceId}`;
}

// ==================== REAL DATA ADAPTER ====================
/** Raw issued-invoice shape from /api/billing (list action). */
interface ApiInvoice {
  id: string;
  invoiceNumber: string | null;
  status: 'issued' | 'paid' | 'void';
  totalAmount: number;
  paidAmount: number;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  centerAccount: { center: { id: string; name: string; phone: string | null } | null } | null;
  creator: { id: string; displayName: string } | null;
  payments: Array<{ id: string; amount: number; paymentDate: string | null; description: string }>;
}

function daysOverdue(due: string | null): number {
  if (!due) return 0;
  const d = new Date(due).getTime();
  if (Number.isNaN(d)) return 0;
  return Math.max(0, Math.floor((Date.now() - d) / 86400000));
}

/** Convert an issued invoice into a collections row. */
function invoiceToCollection(inv: ApiInvoice): CollectionInvoice {
  const remaining = Math.max(0, inv.totalAmount - inv.paidAmount);
  const overdue = daysOverdue(inv.dueDate);
  const status: CollectionStatus =
    inv.status === 'paid' ? 'paid' :
    inv.status === 'void' ? 'disputed' :
    remaining === 0 ? 'paid' :
    overdue > 0 ? 'overdue' : 'pending';
  return {
    id: inv.id,
    number: inv.invoiceNumber || '—',
    centerId: inv.centerAccount?.center?.id || null,
    centerName: inv.centerAccount?.center?.name || '—',
    phone: inv.centerAccount?.center?.phone || null,
    city: '',
    personName: inv.creator?.displayName || '—',
    totalAmount: inv.totalAmount,
    paidAmount: inv.paidAmount,
    remainingAmount: remaining,
    issueDate: (inv.issuedAt || inv.createdAt).slice(0, 10),
    dueDate: (inv.dueDate || '').slice(0, 10) || '—',
    overdueDays: overdue,
    status,
    lastAction: inv.payments.length > 0 ? 'ثبت پرداخت' : 'ارسال فاکتور',
    lastActionDate: (inv.payments[0]?.paymentDate || inv.createdAt).slice(0, 10),
    nextFollowup: '',
    checkCount: inv.payments.length,
    notes: '',
  };
}

// ==================== SAMPLE DATA (legacy, unused) ====================


// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد ریال';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون ریال';
  return toPersianNum(amount.toLocaleString()) + ' ریال';
}

function formatCompact(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون';
  return toPersianNum(amount.toLocaleString());
}

// ==================== STATS ====================
function CollectionsStats({ invoices }: { invoices: CollectionInvoice[] }) {
  const totalReceivable = invoices.reduce((s, i) => s + i.remainingAmount, 0);
  const overdue = invoices.filter(i => i.status === 'overdue' || i.status === 'legal');
  const overdueAmount = overdue.reduce((s, i) => s + i.remainingAmount, 0);
  const paid = invoices.filter(i => i.status === 'paid').length;
  const totalInvoices = invoices.length;
  const avgOverdueDays = overdue.length > 0 ? Math.round(overdue.reduce((s, i) => s + i.overdueDays, 0) / overdue.length) : 0;
  // v2.16.0 — REAL current Jalali month bounds (was: literal '۱۴۰۵/۰۶/۰۱'..'۳۱')
  const [ty, tm] = toJalaliKey().split('-').map(Number);
  const monthLen = jalaliMonthLength(ty, tm);
  const monthStart = `${ty}/${String(tm).padStart(2, '0')}/01`;
  const monthEnd = `${ty}/${String(tm).padStart(2, '0')}/${String(monthLen).padStart(2, '0')}`;
  const thisMonthDue = invoices.filter(i => i.dueDate >= monthStart && i.dueDate <= monthEnd).reduce((s, i) => s + i.remainingAmount, 0);

  const stats = [
    { label: 'کل مطالبات', value: formatCompact(totalReceivable), icon: <CircleDollarSign size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'معوق', value: formatCompact(overdueAmount), icon: <AlertTriangle size={16} />, color: '#dc2626', bg: '#fef2f2' },
    { label: 'سررسید این ماه', value: formatCompact(thisMonthDue), icon: <Calendar size={16} />, color: '#d97706', bg: '#fffbeb' },
    { label: 'تسویه شده', value: toPersianNum(paid) + '/' + toPersianNum(totalInvoices), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'میانگین تأخیر', value: toPersianNum(avgOverdueDays) + ' روز', icon: <Clock size={16} />, color: '#7c3aed', bg: '#f5f3ff' },
    { label: 'اقدام حقوقی', value: toPersianNum(invoices.filter(i => i.status === 'legal').length), icon: <FileText size={16} />, color: '#dc2626', bg: '#fef2f2' },
  ];

  return (
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
  );
}

// ==================== INVOICE ROW ====================
function CollectionRow({ inv, onAction, onSettle }: { inv: CollectionInvoice; onAction: (inv: CollectionInvoice, type?: string) => void; onSettle: (inv: CollectionInvoice) => void }) {
  const sc = STATUS_CFG[inv.status];
  const [expanded, setExpanded] = useState(false);
  const payPercent = inv.totalAmount > 0 ? Math.round((inv.paidAmount / inv.totalAmount) * 100) : 0;

  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden hover:shadow-sm transition-all animate-fade-in-up opacity-0">
      <button onClick={() => setExpanded(!expanded)} className="w-full text-right">
        <div className="flex items-center gap-3 p-4">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 relative" style={{ background: sc.bg, color: sc.color }}>
            <CreditCard size={18} />
            {inv.overdueDays > 0 && (
              <span className="absolute -top-1 -left-1 w-5 h-5 rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center">{toPersianNum(inv.overdueDays)}</span>
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-sm font-bold text-gray-900">{inv.number}</h4>
              <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-gray-500">
              <span className="flex items-center gap-1"><Building2 size={10} /> {inv.centerName}</span>
              <span className="flex items-center gap-1"><MapPin size={10} /> {inv.city}</span>
              {inv.checkCount > 0 && <span className="flex items-center gap-1"><Banknote size={10} /> {toPersianNum(inv.checkCount)} چک</span>}
            </div>
          </div>
          <div className="hidden md:flex flex-col items-end shrink-0 w-44">
            <p className="text-sm font-bold text-gray-900">{formatCurrency(inv.remainingAmount)}</p>
            <div className="w-full h-2 bg-gray-100 rounded-full mt-1.5 overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${payPercent}%`, background: payPercent === 100 ? '#059669' : inv.overdueDays > 0 ? '#dc2626' : '#d97706' }} />
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5">{toPersianNum(payPercent)}٪ پرداخت</p>
          </div>
          <div className="hidden sm:flex flex-col items-end shrink-0 w-24">
            <span className="text-xs text-gray-600">سررسید: {inv.dueDate}</span>
            <span className="text-[11px] text-gray-400">{inv.lastActionDate && 'آخرین: ' + inv.lastActionDate}</span>
          </div>
          <ChevronDown size={14} className={`text-gray-300 transition-transform ${expanded ? 'rotate-180' : ''} shrink-0`} />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-50 p-4 bg-gray-50/30 animate-fade-in">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <h5 className="text-xs font-bold text-gray-500 mb-1.5">اطلاعات فاکتور</h5>
              <div className="space-y-1 text-xs text-gray-600">
                <p>مبلغ کل: <span className="font-bold">{formatCurrency(inv.totalAmount)}</span></p>
                <p>پرداخت شده: <span className="font-bold text-emerald-600">{formatCurrency(inv.paidAmount)}</span></p>
                <p>مانده: <span className="font-bold text-red-600">{formatCurrency(inv.remainingAmount)}</span></p>
                <p>تاریخ صدور: {inv.issueDate}</p>
              </div>
            </div>
            <div>
              <h5 className="text-xs font-bold text-gray-500 mb-1.5">آخرین اقدام</h5>
              <p className="text-xs text-gray-700 leading-6">{inv.lastAction || '—'}</p>
              {inv.nextFollowup && (
                <p className="text-[11px] text-teal-600 mt-2 flex items-center gap-1"><Clock size={10} /> پیگیری بعدی: {inv.nextFollowup}</p>
              )}
            </div>
            <div>
              <h5 className="text-xs font-bold text-gray-500 mb-1.5">شخص تماس</h5>
              <p className="text-xs text-gray-700">{inv.personName}</p>
              <p className="text-[11px] text-gray-400">{inv.centerName}</p>
            </div>
          </div>
          {inv.notes && (
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-100 mb-4">
              <p className="text-xs text-amber-800 flex items-center gap-1.5"><AlertTriangle size={12} /> {inv.notes}</p>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 gap-1 text-xs rounded-lg text-white" style={{ background: '#1F8B7D' }} onClick={(e) => { e.stopPropagation(); onAction(inv); }}>
              <Plus size={12} /> ثبت اقدام
            </Button>
            {/* v2.18.0 — these buttons used to be dead (no handler); they now
                open the action dialog preselected with the matching type. */}
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg" onClick={(e) => { e.stopPropagation(); onAction(inv, 'call'); }}>
              <Phone size={12} /> تماس
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg" onClick={(e) => { e.stopPropagation(); onAction(inv, 'sms'); }}>
              <MessageCircle size={12} /> پیامک
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg" onClick={(e) => { e.stopPropagation(); onAction(inv, 'payment'); }}>
              <CreditCard size={12} /> ثبت پرداخت
            </Button>
            {/* v2.58.1 (audit F1) — «ثبت دریافت مانده و تسویه»: settlement is a
                REAL receipt for the remaining balance (mirrored onto the
                sales document + the center account), not a status flip. */}
            {inv.remainingAmount > 0 && inv.status !== 'paid' && (
              <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg text-emerald-700 hover:bg-emerald-50 border-emerald-200" onClick={(e) => { e.stopPropagation(); onSettle(inv); }}>
                <Banknote size={12} /> دریافت مانده و تسویه
              </Button>
            )}
            {inv.overdueDays > 30 && (
              <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg text-red-600 hover:bg-red-50 border-red-200" onClick={(e) => { e.stopPropagation(); onAction(inv, 'legal'); }}>
                <FileText size={12} /> اقدام حقوقی
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== NEW ACTION DIALOG (real save) ====================
/** v2.16.0 — the old dialog's ثبت اقدام button only closed the form.
 *  Payment actions POST to /api/billing add-payment (real financial
 *  effect, mirrors into the sales document per v2.13.0); every other
 *  action type registers a real follow-up activity on /api/activities
 *  tied to the invoice's center. */
function NewActionDialog({ open, onOpenChange, onSaved, invoices, preselected, preselectedType, pendingPaymentRef }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  invoices: CollectionInvoice[];
  preselected: CollectionInvoice | null;
  /** v2.18.0 — action type preset from the invoice card's quick buttons. */
  preselectedType?: string | null;
  /** v2.58.5 (R2) → v2.58.6 (P1) — the parent-held identity of the
   *  in-flight payment operation: survives closing/reopening THIS
   *  dialog after an unknown outcome. On top of that, the engine now
   *  keeps a durable OPAQUE per-invoice record (sessionStorage) so a
   *  page REFRESH restores the same key — and the dialog resolves the
   *  pending operation against the SERVER before a new payment. */
  pendingPaymentRef: React.RefObject<PaymentAttemptState | null>;
}) {
  const [invoiceId, setInvoiceId] = useState('');
  const [actionType, setActionType] = useState('call');
  const [amount, setAmount] = useState('');
  const [result, setResult] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v2.58.6 (P1) — the تعیین تکلیف banner: what became of the previous
  // payment whose outcome was UNKNOWN (server-verified answer).
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Reset asynchronously (react-hooks/set-state-in-effect)
      queueMicrotask(() => {
        setInvoiceId(preselected?.id || '');
        // v2.18.0 — seed the type preset from the quick button that opened
        // the dialog (fall back to the default).
        const t = preselectedType && ACTION_TYPE_CFG[preselectedType] ? preselectedType : 'call';
        setActionType(t);
        setAmount('');
        setResult('');
        setNotes('');
        setError(null);
        setPendingNotice(null);
      });
    }
  }, [open, preselected, preselectedType]);

  // v2.58.6 (P1) — BEFORE a new payment is attempted on this invoice, ask
  // the SERVER what became of the previous operation whose outcome was
  // UNKNOWN (502/504/network/refresh). The answer is definitive (the
  // idempotency row and the receipt share ONE transaction) and access-
  // gated; the banner tells the user, and a 'recorded' answer clears the
  // stale in-memory identity so the next payment is explicitly NEW.
  useEffect(() => {
    if (!open || actionType !== 'payment' || !invoiceId) return;
    let cancelled = false;
    (async () => {
      try {
        const outcome = await resolvePendingPayment(invoiceId);
        if (cancelled) return;
        if (outcome.kind === 'recorded') {
          if (pendingPaymentRef.current) {
            try {
              const invOf = JSON.parse(pendingPaymentRef.current.fingerprint)?.[0];
              if (invOf === invoiceId) pendingPaymentRef.current = null;
            } catch { /* malformed — leave it; the digest match governs */ }
          }
          setPendingNotice(
            `پرداخت قبلی شما با موفقیت ثبت شده بود (${outcome.amount.toLocaleString('fa-IR')} ریال). برای ثبت پرداخت جدید اقدام کنید.`,
          );
        } else if (outcome.kind === 'not-recorded') {
          setPendingNotice('بررسی سرور: پرداخت قبلی ثبت نشده بود — تلاش مجدد همان عملیات را ایمن تکمیل می‌کند.');
        } else if (outcome.kind === 'unknown') {
          setPendingNotice('نتیجهٔ پرداخت قبلی هنوز نامشخص است — تلاش مجدد، همان پرداخت را دوباره ثبت نمی‌کند.');
        }
      } catch {
        // the status query itself failed — the submit path still guards
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, actionType, invoiceId]);

  const submit = async () => {
    const inv = invoices.find((i) => i.id === invoiceId);
    if (!inv) {
      setError('انتخاب فاکتور الزامی است.');
      return;
    }
    if (!result.trim() && actionType !== 'payment') {
      setError('ثبت نتیجهٔ اقدام الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (actionType === 'payment') {
        const amt = Number(amount.replace(/[^0-9.]/g, ''));
        if (!Number.isFinite(amt) || amt <= 0) {
          throw new Error('مبلغ پرداخت باید عددی بزرگ‌تر از صفر باشد.');
        }
        // v2.58.5 (R2) — the SUBMIT ENGINE owns the idempotency key: one
        // key per LOGICAL operation. A network-lost response keeps the key
        // (the retry replays the stored result server-side instead of
        // booking the payment twice); a definite rejection or a success
        // drops it. The dialog stays OPEN on an unknown outcome so the
        // natural next click retries with the SAME key.
        const outcome = await submitIdempotentPayment({
          invoiceId: inv.id,
          amount: amt,
          description: [result.trim(), notes.trim()].filter(Boolean).join(' — ') || 'ثبت از ماژول وصول مطالبات',
        }, pendingPaymentRef.current);
        pendingPaymentRef.current = outcome.state;
        if (outcome.kind === 'success') {
          toast.success(outcome.replayed ? 'پرداخت قبلاً ثبت شده بود (نتیجهٔ همان ثبت بازگردانده شد).' : 'پرداخت با موفقیت ثبت شد');
          onOpenChange(false);
          onSaved();
        } else {
          // rejected/unknown → the dialog STAYS open: the message tells the
          // user what happened; the next click retries (same key on unknown)
          setError(outcome.error);
        }
        return;
      } else {
        const typeLabel = ACTION_TYPE_CFG[actionType]?.label || actionType;
        const res = await fetch('/api/activities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create',
            title: `اقدام وصول (${typeLabel}) — فاکتور ${inv.number}`,
            description: [result.trim(), notes.trim()].filter(Boolean).join(' — ') || undefined,
            activityDate: new Date().toISOString(),
            centerId: inv.centerId || undefined,
            isPhoneCall: actionType === 'call',
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطا در ثبت اقدام');
        toast.success('اقدام وصول ثبت شد');
      }
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت اقدام');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت اقدام وصول</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
        {actionType === 'payment' && pendingNotice && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2">{pendingNotice}</p>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescollections-f378-1">فاکتور *</label>
          <select id="salescollections-f378-1" aria-label="فاکتور" value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
            <option value="">انتخاب فاکتور...</option>
            {invoices.map((inv) => (
              <option key={inv.id} value={inv.id}>
                {inv.number} — {inv.centerName} (مانده: {inv.remainingAmount.toLocaleString('fa-IR')})
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescollections-f389-2">نوع اقدام</label>
            <select id="salescollections-f389-2" aria-label="نوع اقدام" value={actionType} onChange={(e) => setActionType(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
              {Object.entries(ACTION_TYPE_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescollections-f394-3">{actionType === 'payment' ? 'مبلغ (ریال) *' : 'مبلغ (ریال)'}</label><Input id="salescollections-f394-3" aria-label="مبلغ (ریال)" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="۰" className="h-10 rounded-lg" dir="ltr" /></div>
        </div>
        {actionType === 'payment' && (
          <p className="text-[11px] text-gray-400">مبلغ پرداخت به فاکتور انتخابی اضافه و در کارتابل حسابداری نیز ثبت می‌شود.</p>
        )}
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescollections-f399-4">نتیجه {actionType === 'payment' ? '' : '*'}</label><Input id="salescollections-f399-4" aria-label="نتیجه اقدام" value={result} onChange={(e) => setResult(e.target.value)} placeholder="توضیح نتیجه اقدام" className="h-10 rounded-lg" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salescollections-f400-5">یادداشت</label><Textarea id="salescollections-f400-5" aria-label="یادداشت" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات..." className="rounded-lg resize-none" rows={3} /></div>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : 'ثبت اقدام'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== MAIN COMPONENT ====================
export default function SalesCollections() {
  const [invoices, setInvoices] = useState<CollectionInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showNewAction, setShowNewAction] = useState(false);
  const [selectedInv, setSelectedInv] = useState<CollectionInvoice | null>(null);
  // v2.18.0 — quick buttons open the dialog with a preset action type
  const [selectedActionType, setSelectedActionType] = useState<string | null>(null);
  // v2.43.0 — REAL SMS send dialog (payment reminder per invoice row)
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsTarget, setSmsTarget] = useState<CollectionInvoice | null>(null);
  // v2.58.1 (audit F1) — settle-in-flight guard (one click = one receipt)
  const [settlingId, setSettlingId] = useState<string | null>(null);
  // v2.58.5 (R2) — the in-flight payment OPERATION identity, held by the
  // PARENT so it survives closing/reopening the dialog after a lost
  // response. In memory only; a refresh forgets it (server guards
  // backstop). Cleared on definite success/rejection by the engine.
  const pendingPaymentRef = useRef<PaymentAttemptState | null>(null);

  // v2.58.1 (audit F1) — «دریافت مانده و تسویه»: registers a REAL receipt for
  // the remaining balance via /api/billing mark-paid (server computes the
  // live remainder inside its transaction). A settle idempotency key makes
  // a network-level double-click physically incapable of producing two
  // receipts (the DB UNIQUE constraint enforces it server-side).
  const settleInvoice = async (inv: CollectionInvoice) => {
    if (settleingBusy(inv)) return;
    setSettlingId(inv.id);
    try {
      const res = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mark-paid',
          id: inv.id,
          idempotencyKey: makeSettleKey(inv.id),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت دریافت مانده');
      toast.success(data.message || 'دریافت مانده ثبت شد و فاکتور تسویه شد.');
      await loadInvoices();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ثبت دریافت مانده');
    } finally {
      setSettlingId(null);
    }
  };
  const settleingBusy = (inv: CollectionInvoice) => settlingId === inv.id;

  // ── Load real invoices from billing API ──
  const loadInvoices = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/billing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', pageSize: 200 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت فاکتورها');
      setInvoices((data.items || []).map(invoiceToCollection));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت فاکتورها');
      setInvoices([]);
    } finally {
      setLoading(false);
    }
  };

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `loadInvoices` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(loadInvoices);
  }, []);

  const filtered = useMemo(() => {
    return invoices.filter(inv => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!inv.number.includes(q) && !inv.centerName.includes(q) && !inv.personName.includes(q)) return false;
      }
      if (filterStatus !== 'all' && inv.status !== filterStatus) return false;
      return true;
    });
  }, [invoices, search, filterStatus]);

  return (
    <div className="space-y-4">
      {/* v2.18.0 — surface load errors / loading instead of a silent empty list */}
      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{loadError}</div>
      )}
      {loading && (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">در حال دریافت فاکتورها...</p>
        </div>
      )}
      {!loading && (
        <>
      <CollectionsStats invoices={invoices} />

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو شماره فاکتور، مرکز، شخص..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همه وضعیت‌ها</option>
            {Object.entries(STATUS_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <Dialog open={showNewAction} onOpenChange={setShowNewAction}>
            <DialogTrigger asChild>
              <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                <Plus size={13} /> اقدام جدید
              </Button>
            </DialogTrigger>
            <NewActionDialog open={showNewAction} onOpenChange={setShowNewAction} onSaved={loadInvoices} invoices={invoices} preselected={selectedInv} preselectedType={selectedActionType} pendingPaymentRef={pendingPaymentRef} />
          </Dialog>
        </div>
      </div>

      {/* Invoice list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <CreditCard size={32} className="mx-auto mb-2 opacity-40" /><p className="text-sm">فاکتوری یافت نشد</p>
          </div>
        ) : (
          filtered.map(inv => <CollectionRow key={inv.id} inv={inv} onAction={(i, type) => {
            // v2.43.0 — the SMS quick button now performs a REAL send (with
            // provider verdicts) instead of only logging a manual action.
            if (type === 'sms') { setSmsTarget(i); setSmsOpen(true); return; }
            setSelectedInv(i); setSelectedActionType(type ?? null); setShowNewAction(true);
          }} onSettle={(i) => { void settleInvoice(i); }} />)
        )}
      </div>
        </>
      )}
      {/* v2.43.0 — real SMS reminder send (provider-backed, logged in SmsLog) */}
      <SmsDialog
        open={smsOpen}
        onOpenChange={setSmsOpen}
        presetPhone={smsTarget?.phone || ''}
        presetText={
          smsTarget
            ? buildCollectionReminderSms({
                centerName: smsTarget.centerName,
                invoiceNumber: smsTarget.number,
                amountRial: smsTarget.remainingAmount,
                overdueDays: smsTarget.overdueDays,
                companyName: 'شرکت',
              })
            : ''
        }
        contextType="collection"
        centerName={smsTarget?.centerName || null}
        contextLabel={smsTarget ? `فاکتور ${smsTarget.number} — ${smsTarget.centerName} (مانده: ${formatCurrency(smsTarget.remainingAmount)})` : undefined}
        onSent={() => { void loadInvoices(); }}
      />
    </div>
  );
}
