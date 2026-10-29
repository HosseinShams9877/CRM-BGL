'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, Receipt, CreditCard, Building2, ChevronDown, Edit3, Printer, Send, Check, X, User as UserIcon, Users, Banknote, FileCheck, Undo2, RefreshCw, FilterX, LayoutList, Package } from 'lucide-react';
import { apiCall, useApiListAll, ListState, withToast } from '@/hooks/use-api';
import dynamic from 'next/dynamic';
// v2.58.0 (audit 85-d #5): the ۱۲۰۰-line print engine (charts + barcode +
// multiple company templates) only loads when the user actually opens the
// print dialog — it no longer ships in the sales-docs first paint.
const DocumentPrintDialog = dynamic(() => import('@/components/document-print'), { ssr: false });
import PaginationControls from '@/components/ui/pagination-controls';
import type { PrintDocData } from '@/components/document-print';
// v2.39.0 — the auto-issued dispatch label (سند ارسال مراسلات)
import ShippingLabelDialog from '@/components/shipping-label';

import { type DocTab, type ApiSalesDocument, type ApiSalesDocumentDetail, type CheckRow, type ProformaCenterOption, PROFORMA_STATUS, INVOICE_STATUS, RETURN_STATUS, CHECK_STATUS, toPersianNum, formatCurrency, formatCompact, jdate, paymentMethodLabel } from './sales-docs-shared';
import { NewProformaDialog, NewReturnDialog, QuickSaleDialog, EditDocDialog } from './sales-docs-dialogs';

// ==================== REJECT DIALOG (reason required) ====================
/** v2.16.0 — the backend REQUIRES a rejection comment («دلیل رد سند الزامی
 *  است», HTTP 400); the old one-click رد button never sent one, so every
 *  rejection died with a 400. */
function RejectDialog({ open, onOpenChange: _onOpenChange, docId, busy, onSubmit }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docId: string;
  busy: boolean;
  onSubmit: (comment: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Reset asynchronously (react-hooks/set-state-in-effect)
      queueMicrotask(() => {
        setReason('');
        setLocalError(null);
      });
    }
  }, [open]);

  const submit = () => {
    if (!reason.trim()) {
      setLocalError('دلیل رد سند الزامی است.');
      return;
    }
    onSubmit(reason.trim());
  };

  return (
    <DialogContent className="max-w-[min(24rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>رد سند</DialogTitle></DialogHeader>
      <div className="space-y-3 mt-2">
        {localError && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{localError}</p>}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocs-f95-1">دلیل رد *</label>
          <Textarea id="salesdocs-f95-1"
            aria-label="دلیل رد سند"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً: قیمت‌ها نیاز به بازنگری دارد"
            className="rounded-lg resize-none"
            rows={3}
            autoFocus
          />
        </div>
        <p className="text-[11px] text-gray-400" dir="ltr">{docId.slice(-8)}</p>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold bg-red-600 hover:bg-red-700">
          {busy ? 'در حال ثبت...' : 'ثبت رد سند'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== DOCUMENT ROW (v2.34.10 — table layout) ====================
/** One expandable table row pair: summary row + detail row. Same workflow
 *  features as the old card (items, totals, approvals, print, edit, reject) —
 *  the reference-design table is now the presentation layer. */
function DocumentRow({
  doc,
  statusCfg,
  icon,
  typeLabel,
  onChanged,
  centers,
  onInvoiceIssued,
}: {
  doc: ApiSalesDocument;
  statusCfg: Record<string, { label: string; color: string; bg: string }>;
  icon: React.ReactNode;
  typeLabel: string;
  onChanged: () => void;
  centers: Array<{ id: string; name: string }>;
  /** v2.39.0 — opens the carton-label dialog for an issued invoice
   *  (auto after approval; re-print from the row button). */
  onInvoiceIssued: (invoiceId: string, invoiceNumber: string | null) => void;
}) {
  const sc = statusCfg[doc.status] || statusCfg.draft;
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<ApiSalesDocumentDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPrint, setShowPrint] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectBusy, setRejectBusy] = useState(false);
  // v2.20.0 — the document edit dialog (update action was previously
  // unreachable from the UI).
  const [showEdit, setShowEdit] = useState(false);

  const loadDetail = async () => {
    try {
      const res = await apiCall<{ success: boolean; data: ApiSalesDocumentDetail }>('/api/sales-documents', 'get', { id: doc.id });
      setDetail(res.data);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'خطا در دریافت جزئیات');
    }
  };

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) await loadDetail();
  };

  /** Print button works even when row is collapsed — fetches detail on demand. */
  const openPrint = async () => {
    if (!detail) await loadDetail();
    setShowPrint(true);
  };

  const doAction = async (action: 'submit-approval' | 'approve' | 'reject' | 'cancel') => {
    setBusy(true);
    setActionError(null);
    const labels: Record<string, string> = {
      'submit-approval': 'سند به تأیید ارسال شد',
      'approve': 'سند تأیید شد',
      'reject': 'سند رد شد',
      'cancel': 'سند لغو شد',
    };
    // v2.39.0 — approval returns `derived` when it ISSUED an invoice
    // (proforma derivation / direct invoice): the سند ارسال مراسلات was
    // auto-issued with it, so the carton-label dialog opens immediately.
    let resDerived: { invoiceId?: string; invoiceNumber?: string | null; shipmentNumber?: string | null } | undefined;
    const ok = await withToast(
      () => apiCall<{ derived?: { invoiceId?: string; invoiceNumber?: string | null; shipmentNumber?: string | null } }>('/api/sales-documents', action, { id: doc.id }).then((r) => {
        resDerived = r.derived;
        return r;
      }),
      labels[action] || 'عملیات انجام شد'
    );
    if (ok) {
      setExpanded(false);
      onChanged();
      if (action === 'approve' && resDerived?.invoiceId) {
        if (resDerived.shipmentNumber) {
          toast.success(`سند ارسال ${resDerived.shipmentNumber} به‌صورت خودکار صادر شد`);
        }
        onInvoiceIssued(resDerived.invoiceId, resDerived.invoiceNumber ?? null);
      }
    } else {
      setActionError('عملیات ناموفق بود — جزئیات در اعلان');
    }
    setBusy(false);
  };

  /** v2.16.0 — rejection with the REQUIRED reason comment (was: bare
   *  reject without comment → guaranteed 400). */
  const doReject = async (comment: string) => {
    setRejectBusy(true);
    setActionError(null);
    const ok = await withToast(
      () => apiCall('/api/sales-documents', 'reject', { id: doc.id, comment }),
      'سند رد شد'
    );
    setRejectBusy(false);
    if (ok) {
      setShowReject(false);
      setExpanded(false);
      onChanged();
    }
  };

  const printData: PrintDocData | null = detail ? {
    documentNumber: doc.documentNumber || doc.id.slice(-8),
    documentType: doc.documentType,
    status: doc.status,
    createdAt: doc.createdAt,
    issuedAt: doc.issuedAt,
    centerName: doc.center?.name || '—',
    centerCity: '',
    centerPhone: '',
    description: detail.description || '',
    items: (detail.items || []).map((it) => ({
      productName: it.productName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      totalPrice: it.totalPrice,
      discount: it.discount,
      // v2.31.8 — invoice format: واحد column + کد کالا under the name
      // v2.31.9 — the form-captured unit wins; کد IRC joins the sub-line
      unit: it.unit || it.product?.unit || 'عدد',
      productCode: it.product?.code || null,
      productIrc: it.product?.ircCode || null,
    })),
    totalAmount: doc.totalAmount,
    discountAmount: doc.discountAmount,
    taxAmount: doc.taxAmount,
    finalAmount: doc.finalAmount,
    creatorName: doc.creator?.displayName || '—',
    // v2.31.7 — issuing-company branding (آریا مدیکال letterhead + logo)
    companyName: detail.company?.name ?? null,
    companyLogo: detail.company?.logo ?? null,
    // v2.31.8 — letterhead tagline + registered payments feed the redesigned
    // invoice format (subtitle line + «اطلاعات پرداخت» box).
    companyTagline: detail.company?.tagline ?? null,
    // v2.31.9 — Lian proforma format: header payment terms, sales-expert
    // contact, seller profile + bank account (from the issuing company)
    // and the buyer identity (creation-time snapshot, falling back to
    // live center master data on legacy rows).
    paymentTerms: detail.paymentTerms || null,
    salesExpertName: detail.salesExpertName || null,
    salesExpertMobile: detail.salesExpertMobile || null,
    buyerSnapshot: detail.buyerSnapshot || '',
    buyerCenter: detail.center ? {
      name: detail.center.name,
      nationalId: detail.center.nationalId,
      economicCode: detail.center.economicCode,
      postalCode: detail.center.postalCode,
      contactName: detail.center.contactName,
      address: detail.center.address,
      city: detail.center.city,
      province: detail.center.province,
      phone: detail.center.phone,
    } : null,
    companyProfile: detail.company ? {
      nationalId: detail.company.nationalId,
      address: detail.company.address,
      phone: detail.company.phone,
      postalCode: detail.company.postalCode,
      // v2.35.0 — the two sender addresses registered once in company
      // settings, auto-pulled into every proforma/invoice print.
      headOfficeAddress: detail.company.headOfficeAddress,
      factoryAddress: detail.company.factoryAddress,
      // v2.42.0 — انتخابگر نشانی فرستنده: the per-document print choice
      // captured by the form ('main_office' / 'factory' / null).
      senderAddressType: detail.senderAddressType ?? null,
      bankName: detail.company.bankName,
      bankAccountHolder: detail.company.bankAccountHolder,
      bankAccountNumber: detail.company.bankAccountNumber,
      bankSheba: detail.company.bankSheba,
      // v2.48.0 — company-level printed terms: registered once in company
      // settings (brand change → every future print auto-updates).
      proformaNote: detail.company.proformaNote ?? null,
      // v2.54.0 — per-company footer website (globe icon); null → the
      // global app.website fallback at print time.
      website: detail.company.website ?? null,
    } : null,
    payments: (detail.financeRecords || []).map((r) => ({
      method: r.paymentMethod,
      amount: r.amount,
      date: r.paymentDate,
    })),
    // v2.52.0 — per-company A4 print template (تفکیک قالب چاپ): the
    // issuing company's Company.printTemplate ('lian' for بازرگانی after
    // the round-77 backfill; null → 'bgl' default everywhere else).
    // Resolved inside the sheet via the pure print-templates registry.
    printTemplate: detail.company?.printTemplate ?? null,
  } : null;

  const paidAmount = detail?.financeRecords?.reduce((s, r) => s + r.amount, 0) || 0;
  const remaining = Math.max(0, doc.finalAmount - paidAmount);

  return (
    <>
      <tr
        className={`border-b border-gray-50 transition-colors cursor-pointer ${expanded ? 'bg-teal-50/40' : 'hover:bg-gray-50/70'}`}
        onClick={() => { void toggle(); }}
      >
        <td className="py-3 px-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: sc.bg, color: sc.color }}>{icon}</div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-gray-900 truncate" title={doc.documentNumber || doc.id}>{doc.documentNumber || 'بدون شماره'}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">
                {toPersianNum(doc._count.items)} قلم{doc.version && doc.version > 1 ? ` · ویرایش ${toPersianNum(doc.version)}` : ''}
              </p>
            </div>
          </div>
        </td>
        <td className="py-3 px-3">
          <span className="flex items-center gap-1 text-xs text-gray-700 min-w-0">
            <Building2 size={12} className="text-gray-400 shrink-0" />
            <span className="truncate max-w-[160px]" title={doc.center?.name}>{doc.center?.name || 'بدون مرکز'}</span>
          </span>
        </td>
        <td className="py-3 px-3 hidden md:table-cell">
          <span className="flex items-center gap-1 text-xs text-gray-600">
            <UserIcon size={12} className="text-gray-400 shrink-0" />
            {doc.creator?.displayName || '—'}
          </span>
        </td>
        <td className="py-3 px-3 text-left">
          <p className="text-xs font-bold text-gray-900 whitespace-nowrap">{formatCurrency(doc.finalAmount)}</p>
        </td>
        <td className="py-3 px-3 hidden lg:table-cell">
          <p className="text-xs text-gray-500 whitespace-nowrap">{jdate(doc.createdAt)}</p>
          <p className="text-[11px] text-gray-400">{typeLabel}</p>
        </td>
        <td className="py-3 px-3 text-center">
          <span className="text-[11px] font-medium px-2 py-1 rounded-full whitespace-nowrap" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
        </td>
        <td className="py-3 px-3">
          <div className="flex items-center justify-center gap-1">
            {/* v2.39.0 — carton-label print for issued invoices (re-print
                anytime; the dialog also auto-opens right after issuance) */}
            {doc.documentType === 'invoice' && doc.status === 'approved' && (
              <button
                onClick={(e) => { e.stopPropagation(); onInvoiceIssued(doc.id, doc.documentNumber); }}
                aria-label={`برچسب ارسال ${doc.documentNumber || ''}`}
                title="برچسب ارسال مرسولات (کارتون)"
                className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
              >
                <Package size={14} />
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); void openPrint(); }}
              aria-label={`چاپ ${typeLabel} ${doc.documentNumber || ''}`}
              title="چاپ / PDF"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-teal-700 hover:bg-teal-50 transition-colors"
            >
              <Printer size={14} />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void toggle(); }}
              aria-label={expanded ? 'بستن جزئیات' : 'نمایش جزئیات'}
              aria-expanded={expanded}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            >
              <ChevronDown size={14} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td colSpan={7} className="p-0 border-b border-gray-100">
            <div className="bg-gray-50/60 p-4 animate-fade-in">
              {actionError && <p className="text-xs text-red-600 mb-2">{actionError}</p>}
              {!detail ? (
                <p className="text-xs text-gray-400 text-center py-4">در حال دریافت اقلام...</p>
              ) : (
                <>
                  <table className="w-full text-xs mb-3">
                    <thead>
                      <tr className="text-gray-400 border-b border-gray-200">
                        <th className="py-2 text-right font-medium">محصول</th>
                        <th className="py-2 text-center font-medium">تعداد</th>
                        <th className="py-2 text-left font-medium">قیمت واحد</th>
                        <th className="py-2 text-left font-medium">جمع</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.items.map((item) => (
                        <tr key={item.id} className="border-b border-gray-100">
                          <td className="py-2 text-gray-900 font-medium">{item.productName}</td>
                          <td className="py-2 text-center text-gray-600">{toPersianNum(item.quantity)}</td>
                          <td className="py-2 text-left text-gray-600">{formatCurrency(item.unitPrice)}</td>
                          <td className="py-2 text-left font-bold text-gray-900">{formatCurrency(item.totalPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex items-center justify-between bg-white rounded-lg p-3 border border-gray-100">
                    <div className="text-xs text-gray-500 space-y-0.5">
                      <p>جمع: {formatCurrency(doc.totalAmount)}</p>
                      <p>تخفیف: {formatCurrency(doc.discountAmount)}</p>
                      <p>مالیات: {formatCurrency(doc.taxAmount)}</p>
                      {detail.financeRecords.length > 0 && (
                        <p className="text-emerald-700">پرداخت ثبت‌شده: {formatCurrency(paidAmount)}</p>
                      )}
                    </div>
                    <div className="text-left">
                      <p className="text-[11px] text-gray-400">مبلغ کل</p>
                      <p className="text-lg font-bold" style={{ color: '#1F8B7D' }}>{formatCurrency(doc.finalAmount)}</p>
                      {remaining > 0 && detail.financeRecords.length > 0 && (
                        <p className="text-[11px] text-red-600">مانده: {formatCurrency(remaining)}</p>
                      )}
                    </div>
                  </div>

                  {/* Document workflow actions */}
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {(doc.status === 'draft' || doc.status === 'rejected') && (
                      <Button size="sm" disabled={busy} onClick={() => doAction('submit-approval')} className="h-8 gap-1 text-xs rounded-lg text-white" style={{ background: '#1F8B7D' }}>
                        <Send size={12} /> ارسال به تأیید
                      </Button>
                    )}
                    {(doc.status === 'draft' || doc.status === 'rejected') && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setShowEdit(true)} className="h-8 gap-1 text-xs rounded-lg">
                        <Edit3 size={12} /> ویرایش
                      </Button>
                    )}
                    {doc.status === 'pending_approval' && (
                      <>
                        <Button size="sm" disabled={busy} onClick={() => doAction('approve')} className="h-8 gap-1 text-xs rounded-lg bg-emerald-600 text-white">
                          <Check size={12} /> تأیید
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => setShowReject(true)} variant="outline" className="h-8 gap-1 text-xs rounded-lg text-red-600 border-red-200 hover:bg-red-50">
                          <X size={12} /> رد
                        </Button>
                      </>
                    )}
                    {doc.status !== 'cancelled' && doc.status !== 'approved' && (
                      <Button size="sm" disabled={busy} onClick={() => doAction('cancel')} variant="outline" className="h-8 gap-1 text-xs rounded-lg">
                        <X size={12} /> لغو
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-8 gap-1 text-xs rounded-lg" onClick={openPrint}>
                      <Printer size={12} /> چاپ / PDF
                    </Button>
                  </div>
                </>
              )}
            </div>
          </td>
        </tr>
      )}

      {/* v2.20.0 — edit dialog for draft/rejected documents.
       *  Radix portals these to <body>, so placing them in the row fragment
       *  renders nothing in-place (no invalid <tbody> children in the DOM). */}
      <EditDocDialog
        open={showEdit}
        onOpenChange={setShowEdit}
        doc={doc}
        centers={centers}
        onEdited={() => { void loadDetail(); onChanged(); }}
      />
      <DocumentPrintDialog open={showPrint} onOpenChange={setShowPrint} doc={printData} />
      <Dialog open={showReject} onOpenChange={setShowReject}>
        <RejectDialog open={showReject} onOpenChange={setShowReject} docId={doc.id} busy={rejectBusy} onSubmit={doReject} />
      </Dialog>
    </>
  );
}

// ==================== CHECKS TABLE (v2.34.10 — table layout) ====================
/** v2.16.0 semantics preserved: rows are the invoices' REAL finance records
 *  (per-payment amount/method/date); future-dated payments are pending. */
function ChecksTable({ checks }: { checks: CheckRow[] }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden animate-fade-in-up opacity-0">
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[760px]">
          <thead>
            <tr className="bg-gray-50/80 text-gray-500 border-b border-gray-100">
              <th className="py-3 px-3 text-right font-bold">شماره / مرجع</th>
              <th className="py-3 px-3 text-right font-bold">فاکتور</th>
              <th className="py-3 px-3 text-right font-bold">مرکز</th>
              <th className="py-3 px-3 text-left font-bold">مبلغ</th>
              <th className="py-3 px-3 text-right font-bold">سررسید</th>
              <th className="py-3 px-3 text-center font-bold">روش</th>
              <th className="py-3 px-3 text-center font-bold">وضعیت</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((ch) => {
              const sc = CHECK_STATUS[ch.status];
              return (
                <tr key={ch.id} className="border-b border-gray-50 hover:bg-gray-50/70 transition-colors">
                  <td className="py-3 px-3">
                    <p className="text-xs font-bold text-gray-900 text-right" dir="ltr">{ch.number}</p>
                    {ch.description && <p className="text-[11px] text-gray-400 mt-0.5 truncate max-w-[180px]" title={ch.description}>{ch.description}</p>}
                  </td>
                  <td className="py-3 px-3 text-xs text-gray-600 text-right" dir="ltr">{ch.invoiceNumber}</td>
                  <td className="py-3 px-3">
                    <span className="flex items-center gap-1 text-xs text-gray-700">
                      <Building2 size={12} className="text-gray-400 shrink-0" />
                      <span className="truncate max-w-[160px]" title={ch.centerName}>{ch.centerName}</span>
                    </span>
                  </td>
                  <td className="py-3 px-3 text-left text-xs font-bold text-gray-900 whitespace-nowrap">{formatCurrency(ch.amount)}</td>
                  <td className="py-3 px-3 text-xs text-gray-500 whitespace-nowrap">{ch.dueDate}</td>
                  <td className="py-3 px-3 text-center">
                    {ch.method ? (
                      <span className="text-[11px] font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-600">{ch.method}</span>
                    ) : <span className="text-xs text-gray-300">—</span>}
                  </td>
                  <td className="py-3 px-3 text-center">
                    <span className="text-[11px] font-medium px-2 py-1 rounded-full whitespace-nowrap" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==================== TAB STATS (v2.34.10 — per-tab summary cards) ====================
function TabStats({ items }: { items: Array<{ label: string; value: string; icon: React.ReactNode; color: string; bg: string }> }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {items.map((s, i) => (
        <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
            <span className="text-[11px] text-gray-400 hidden lg:block leading-4">{s.label}</span>
          </div>
          <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
          <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
        </div>
      ))}
    </div>
  );
}

// ==================== MAIN ====================
export default function SalesDocs({ activeTab: propTab, initialSearch, userDisplayName, activeCompanySlug }: { activeTab?: string; initialSearch?: string; /** v2.31.9 — prefills «کارشناس فروش» in the proforma form. */ userDisplayName?: string; /** v2.31.9 — seller card shown in the proforma form before a center is picked. */ activeCompanySlug?: string; }) {
  // v2.16.0 — 'returns' was missing from the initial-state map, so the
  // مرجوعی‌ها menu landed on the proformas tab.
  const [activeTab, setActiveTab] = useState<DocTab>(
    propTab === 'invoices' ? 'invoices' : propTab === 'checks' ? 'checks' : propTab === 'returns' ? 'returns' : 'proformas'
  );
  // v2.26.0 — global-search deep link: the document's number arrives from
  // the topbar search so the exact row is immediately visible in the list.
  const [search, setSearch] = useState(initialSearch || '');
  const [filterStatus, setFilterStatus] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const [centers, setCenters] = useState<ProformaCenterOption[]>([]);
  // v2.39.0 — the carton-label dialog target (سند ارسال مراسلات): the
  // issued invoice whose label is showing. Auto-set after approval /
  // quick-sale issuance, or by the row's برچسب ارسال button.
  const [labelDoc, setLabelDoc] = useState<{ id: string; number: string | null } | null>(null);

  // v2.34.10 — «اسناد من» personal scope: every user opens the page on
  // THEIR OWN documents (user request: «هر کاربر پیش فاکتورهای خودش رو در
  // یک تب ببینه و فاکتورهاشم همینطور»); privileged roles can switch to
  // «همهٔ اسناد». Standard roles are always personal (API-enforced).
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [canViewAll, setCanViewAll] = useState(false);
  const mineOnly = scope === 'mine';

  // v2.34.10 — the list response carries canViewAll (role capability) so
  // the switch is only rendered for users who could ever see colleagues'
  // documents (admin / finance).
  useEffect(() => {
    apiCall<{ canViewAll?: boolean }>('/api/sales-documents', 'list', { pageSize: 1 })
      .then((res) => setCanViewAll(res.canViewAll === true))
      .catch(() => undefined);
  }, []);

  // v2.16.0 — keep the tab in sync when the sidebar navigates between
  // submenus while this component stays mounted (React preserves the
  // instance, so useState's initial value alone would be ignored).
  useEffect(() => {
    if (propTab === 'invoices' || propTab === 'checks' || propTab === 'returns' || propTab === 'proformas') {
      const tab = propTab;
      queueMicrotask(() => setActiveTab(tab));
    }
  }, [propTab]);

  // Real data: proformas + invoices + returns.
  // v2.16.0 — useApiListAll walks EVERY page (the server caps pageSize at
  // 100); with 150 documents the old single-page fetch hid 50 of them.
  // v2.34.10 — the mineOnly scope rides along on every list call.
  const proformasQ = useApiListAll<ApiSalesDocument>('/api/sales-documents', 'list', { type: 'proforma', mineOnly }, [refreshKey]);
  const invoicesQ = useApiListAll<ApiSalesDocument>('/api/sales-documents', 'list', { type: 'invoice', mineOnly }, [refreshKey]);
  const returnsQ = useApiListAll<ApiSalesDocument>('/api/sales-documents', 'list', { type: 'return', mineOnly }, [refreshKey]);

  useEffect(() => {
    // Load centers for the new-proforma dropdown.
    // v2.16.0 — /api/centers returns { success, data } (NOT `items`);
    // reading res.items left the customer dropdown permanently empty.
    // v2.31.9 — the full buyer identity block now flows into the proforma
    // form's «مشخصات خریدار» pre-fill (nationalId/economicCode/postalCode/
    // contactName/address + owning company slug for the seller card).
    apiCall<{ data?: ProformaCenterOption[]; items?: ProformaCenterOption[] }>('/api/centers', 'list', { pageSize: 200 })
      .then((res) => setCenters(res.data || res.items || []))
      .catch(() => undefined);
  }, [refreshKey]);

  // v2.16.0 — checks & payments are built from the invoices' REAL finance
  // records (per-payment amount, method, date). The old code fabricated one
  // row per paid invoice using the FULL invoice amount and "cleared" status —
  // a partial cash payment displayed as fully collected.
  const [financeDetails, setFinanceDetails] = useState<Record<string, ApiSalesDocumentDetail['financeRecords']>>({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const map: Record<string, ApiSalesDocumentDetail['financeRecords']> = {};
      for (const inv of invoicesQ.items) {
        if (inv._count.financeRecords > 0) {
          try {
            const d = await apiCall<{ data: ApiSalesDocumentDetail }>('/api/sales-documents', 'get', { id: inv.id });
            map[inv.id] = d.data.financeRecords || [];
          } catch { /* skip this invoice */ }
        }
      }
      if (!cancelled) setFinanceDetails(map);
    })();
    return () => { cancelled = true; };
  }, [invoicesQ.items]);

  const checks = useMemo<CheckRow[]>(() => {
    // Snapshot of "now" taken WITHOUT Date.now() (flagged impure in render)
    const nowMs = new Date().getTime();
    const rows: CheckRow[] = [];
    for (const inv of invoicesQ.items) {
      const records = financeDetails[inv.id] || [];
      records.forEach((r, idx) => {
        // A payment dated in the future (e.g. a post-dated cheque) is still
        // pending collection; anything dated today or earlier is received.
        const payDate = r.paymentDate ? new Date(r.paymentDate) : null;
        const future = payDate ? !isNaN(payDate.getTime()) && payDate.getTime() > nowMs : false;
        rows.push({
          id: r.id || `${inv.id}-fin-${idx}`,
          number: r.referenceNumber || `${inv.documentNumber || inv.id.slice(-6)}-${idx + 1}`,
          invoiceNumber: inv.documentNumber || '—',
          centerName: inv.center?.name || '—',
          amount: r.amount,
          checkDate: jdate(r.paymentDate || inv.issuedAt || inv.createdAt),
          dueDate: jdate(r.paymentDate || inv.issuedAt || inv.createdAt),
          status: future ? 'pending' : 'cleared',
          description: r.description || '',
          method: paymentMethodLabel(r.paymentMethod),
        });
      });
    }
    return rows;
  }, [invoicesQ.items, financeDetails]);

  const proformas = proformasQ.items;
  const invoices = invoicesQ.items;
  const returns = returnsQ.items;
  const loading = proformasQ.loading || invoicesQ.loading || returnsQ.loading;
  const error = proformasQ.error || invoicesQ.error || returnsQ.error;

  const paidTotal = useMemo(
    () => checks.filter((c) => c.status === 'cleared').reduce((s, c) => s + c.amount, 0),
    [checks]
  );

  // v2.21.0 — converted to a useCallback so the memoised filters below can
  // declare it honestly in their dep arrays (the plain function was
  // recreated every render and the exhaustive-deps rule refused the memos
  // as written).
  const filterDocs = useCallback(
    (docs: ApiSalesDocument[]) =>
      docs.filter((d) => {
        if (search.trim()) {
          const q = search.trim().toLowerCase();
          if (
            !(d.documentNumber || '').toLowerCase().includes(q) &&
            !(d.center?.name || '').includes(q) &&
            !(d.creator?.displayName || '').includes(q)
          ) return false;
        }
        if (filterStatus !== 'all' && d.status !== filterStatus) return false;
        return true;
      }),
    [search, filterStatus]
  );

  const filteredProformas = useMemo(() => filterDocs(proformas), [filterDocs, proformas]);
  const proformaPages = Math.max(1, Math.ceil(filteredProformas.length / pageSize));
  const safePage = Math.min(page, proformaPages);
  const pagedProformas = filteredProformas.slice((safePage - 1) * pageSize, safePage * pageSize);
  const filteredInvoices = useMemo(() => filterDocs(invoices), [filterDocs, invoices]);
  const filteredChecks = useMemo(
    () => checks.filter((ch) => (!search.trim() || ch.number.includes(search) || ch.centerName.includes(search)) && (filterStatus === 'all' || ch.status === filterStatus)),
    [checks, search, filterStatus]
  );

  const filteredReturns = useMemo(() => filterDocs(returns), [filterDocs, returns]);

  const tabs: { key: DocTab; label: string; icon: React.ReactNode; count: number }[] = [
    { key: 'proformas', label: 'پیش‌فاکتورها', icon: <FileCheck size={14} />, count: proformas.length },
    { key: 'invoices', label: 'فاکتورها', icon: <Receipt size={14} />, count: invoices.length },
    { key: 'checks', label: 'چک‌ها و پرداخت‌ها', icon: <CreditCard size={14} />, count: checks.length },
    { key: 'returns', label: 'مرجوعی‌ها', icon: <Undo2 size={14} />, count: returns.length },
  ];

  const currentStatusCfg = activeTab === 'proformas' ? PROFORMA_STATUS : activeTab === 'invoices' ? INVOICE_STATUS : activeTab === 'returns' ? RETURN_STATUS : CHECK_STATUS;
  const refresh = () => setRefreshKey((k) => k + 1);

  /** v2.39.0 — open the carton-label dialog (سند ارسال مرسلات) for an
   *  issued invoice: after approval/quick-sale issuance or re-print. */
  const openLabelFor = useCallback((invoiceId: string, invoiceNumber: string | null) => {
    setLabelDoc({ id: invoiceId, number: invoiceNumber });
  }, []);

  // v2.34.10 — per-tab summary cards (reference-design layout), always
  // computed from the CURRENT scope so «اسناد من» numbers stay personal.
  const tabStats = useMemo(() => {
    const active = (list: ApiSalesDocument[]) => list.filter((d) => d.status === 'draft' || d.status === 'pending_approval');
    const approved = (list: ApiSalesDocument[]) => list.filter((d) => d.status === 'approved');
    const sum = (list: ApiSalesDocument[]) => list.filter((d) => d.status !== 'cancelled').reduce((s, d) => s + d.finalAmount, 0);
    const scopeWord = mineOnly ? 'من' : 'همه';
    if (activeTab === 'proformas') return [
      { label: `پیش‌فاکتورهای ${scopeWord}`, value: toPersianNum(proformas.length), icon: <FileCheck size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
      { label: 'در جریان', value: toPersianNum(active(proformas).length), icon: <Send size={16} />, color: '#6366f1', bg: '#eef2ff' },
      { label: 'تأییدشده', value: toPersianNum(approved(proformas).length), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
      { label: 'جمع مبلغ', value: formatCompact(sum(proformas)), icon: <Banknote size={16} />, color: '#d97706', bg: '#fffbeb' },
    ];
    if (activeTab === 'invoices') return [
      { label: `فاکتورهای ${scopeWord}`, value: toPersianNum(invoices.length), icon: <Receipt size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
      { label: 'صادر شده', value: toPersianNum(approved(invoices).length), icon: <FileCheck size={16} />, color: '#059669', bg: '#ecfdf5' },
      { label: 'جمع فروش', value: formatCompact(sum(invoices)), icon: <Banknote size={16} />, color: '#0891b2', bg: '#ecfeff' },
      { label: 'وصول‌شده', value: formatCompact(paidTotal), icon: <Check size={16} />, color: '#d97706', bg: '#fffbeb' },
    ];
    if (activeTab === 'checks') {
      const pending = checks.filter((c) => c.status === 'pending');
      return [
        { label: 'پرداخت‌های ثبت‌شده', value: toPersianNum(checks.length), icon: <CreditCard size={16} />, color: '#0891b2', bg: '#ecfeff' },
        { label: 'در انتظار وصول', value: toPersianNum(pending.length), icon: <Banknote size={16} />, color: '#d97706', bg: '#fffbeb' },
        { label: 'وصول‌شده', value: formatCompact(paidTotal), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
        { label: 'مبلغ در انتظار', value: formatCompact(pending.reduce((s, c) => s + c.amount, 0)), icon: <Banknote size={16} />, color: '#6366f1', bg: '#eef2ff' },
      ];
    }
    return [
      { label: `مرجوعی‌های ${scopeWord}`, value: toPersianNum(returns.length), icon: <Undo2 size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
      { label: 'در جریان', value: toPersianNum(active(returns).length), icon: <Send size={16} />, color: '#6366f1', bg: '#eef2ff' },
      { label: 'تأییدشده', value: toPersianNum(approved(returns).length), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
      { label: 'جمع مبلغ', value: formatCompact(sum(returns)), icon: <Banknote size={16} />, color: '#d97706', bg: '#fffbeb' },
    ];
  }, [activeTab, proformas, invoices, returns, checks, paidTotal, mineOnly]);

  const hasActiveFilters = search.trim() !== '' || filterStatus !== 'all';

  const docTableHead = (
    <thead>
      <tr className="bg-gray-50/80 text-gray-500 border-b border-gray-100">
        <th className="py-3 px-3 text-right font-bold">شماره سند</th>
        <th className="py-3 px-3 text-right font-bold">مشتری</th>
        <th className="py-3 px-3 text-right font-bold">کارشناس</th>
        <th className="py-3 px-3 text-left font-bold">مبلغ نهایی</th>
        <th className="py-3 px-3 text-right font-bold">تاریخ</th>
        <th className="py-3 px-3 text-center font-bold">وضعیت</th>
        <th className="py-3 px-3 text-center font-bold">عملیات</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-4">

      {/* v2.34.10 — hero header (reference-design gradient band) */}
      <div
        className="relative overflow-hidden rounded-2xl p-6 lg:p-7 text-white animate-fade-in-up opacity-0"
        style={{ background: 'linear-gradient(250deg, #0d9488 0%, #1F8B7D 45%, #064e3b 100%)' }}
      >
        <div aria-hidden className="absolute -left-20 -top-28 w-80 h-80 rounded-full bg-white/10 pointer-events-none" />
        <div aria-hidden className="absolute -left-6 -bottom-32 w-64 h-64 rounded-full bg-white/5 pointer-events-none" />
        <div className="relative flex flex-col lg:flex-row lg:items-center gap-5">
          <div className="flex-1 min-w-0">
            <h2 className="text-xl lg:text-2xl font-bold flex items-center gap-2.5">
              <span className="w-10 h-10 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center shrink-0">
                <LayoutList size={19} />
              </span>
              اسناد فروش و فاکتورها
            </h2>
            <p className="text-[13px] text-white/80 mt-2.5 leading-6 max-w-xl">
              {mineOnly
                ? 'نمای شخصی — پیش‌فاکتورها، فاکتورها، چک‌ها و مرجوعی‌های ثبت‌شدهٔ توسط شما'
                : 'نمای کامل مجموعه — همهٔ اسناد ثبت‌شدهٔ واحد شما'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <NewProformaDialog centers={centers} onCreated={refresh} userDisplayName={userDisplayName} activeCompanySlug={activeCompanySlug} hero />
            {/* v2.39.0 — quick-sale issuance auto-opens the carton label */}
            <QuickSaleDialog centers={centers} onCreated={refresh} onInvoiceIssued={openLabelFor} hero />
            <NewReturnDialog centers={centers} invoices={invoices} onCreated={refresh} hero />
            <button
              onClick={refresh}
              disabled={loading}
              aria-label="به‌روزرسانی فهرست اسناد"
              title="به‌روزرسانی"
              className="h-10 w-10 rounded-lg flex items-center justify-center bg-white/15 text-white border border-white/30 hover:bg-white/25 transition-colors disabled:opacity-50"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>
      </div>

      {/* Tabs + scope switch + filters */}
      <div className="bg-white rounded-xl border border-gray-100 p-3 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          {/* v2.34.10 — document-type pills (reference design) */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="tablist" aria-label="انواع سند">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => { setActiveTab(tab.key); setFilterStatus('all'); setSearch(''); }}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all border ${
                  activeTab === tab.key
                    ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-teal-300 hover:text-teal-700'
                }`}
              >
                {tab.icon}
                {tab.label}
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${activeTab === tab.key ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'}`}>
                  {toPersianNum(tab.count)}
                </span>
              </button>
            ))}
          </div>

          {/* v2.34.10 — «اسناد من / همهٔ اسناد» scope switch (privileged roles only) */}
          {canViewAll && (
            <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 shrink-0 self-start lg:self-auto" role="group" aria-label="دامنهٔ اسناد">
              <button
                onClick={() => { setScope('mine'); setPage(1); }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                  mineOnly ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
                aria-pressed={mineOnly}
              >
                <UserIcon size={13} /> اسناد من
              </button>
              <button
                onClick={() => { setScope('all'); setPage(1); }}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold transition-all ${
                  !mineOnly ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
                aria-pressed={!mineOnly}
              >
                <Users size={13} /> همهٔ اسناد
              </button>
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی شماره سند، مشتری یا کارشناس..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" aria-label="جستجوی اسناد" />
          </div>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600" aria-label="فیلتر وضعیت">
            <option value="all">همه وضعیت‌ها</option>
            {Object.entries(currentStatusCfg).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button
            onClick={() => { setSearch(''); setFilterStatus('all'); }}
            disabled={!hasActiveFilters}
            className="h-9 px-3 rounded-lg border border-gray-200 text-gray-600 text-xs font-medium hover:bg-gray-50 flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <FilterX size={13} /> حذف فیلترها
          </button>
        </div>
      </div>

      {/* v2.34.10 — per-tab summary cards */}
      <TabStats items={tabStats} />

      {/* Document lists (reference-design tables) */}
      <div className="space-y-3">
        {activeTab === 'proformas' && (
          loading || error || filteredProformas.length === 0 ? (
            <ListState loading={loading} error={error} empty={filteredProformas.length === 0} onRetry={refresh} />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-100 overflow-hidden animate-fade-in-up opacity-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-xs min-w-[820px]">
                    {docTableHead}
                    <tbody>
                      {pagedProformas.map((p) => (
                        <DocumentRow key={p.id} doc={p} statusCfg={PROFORMA_STATUS} icon={<FileCheck size={15} />} typeLabel="پیش‌فاکتور" onChanged={refresh} centers={centers} onInvoiceIssued={openLabelFor} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <PaginationControls page={safePage} totalPages={proformaPages} total={filteredProformas.length} onPageChange={setPage} label="سند" />
            </>
          )
        )}
        {activeTab === 'invoices' && (
          loading || error || filteredInvoices.length === 0 ? (
            <ListState loading={loading} error={error} empty={filteredInvoices.length === 0} onRetry={refresh} />
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden animate-fade-in-up opacity-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[820px]">
                  {docTableHead}
                  <tbody>
                    {filteredInvoices.map((inv) => (
                      <DocumentRow key={inv.id} doc={inv} statusCfg={INVOICE_STATUS} icon={<Receipt size={15} />} typeLabel="فاکتور" onChanged={refresh} centers={centers} onInvoiceIssued={openLabelFor} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}
        {activeTab === 'checks' && (
          loading || error || filteredChecks.length === 0 ? (
            <ListState loading={loading} error={error} empty={filteredChecks.length === 0} onRetry={refresh} />
          ) : (
            <ChecksTable checks={filteredChecks} />
          )
        )}
        {activeTab === 'returns' && (
          loading || error || filteredReturns.length === 0 ? (
            <ListState loading={loading} error={error} empty={filteredReturns.length === 0} onRetry={refresh} />
          ) : (
            <div className="bg-white rounded-xl border border-gray-100 overflow-hidden animate-fade-in-up opacity-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[820px]">
                  {docTableHead}
                  <tbody>
                    {filteredReturns.map((r) => (
                      <DocumentRow key={r.id} doc={r} statusCfg={RETURN_STATUS} icon={<Undo2 size={15} />} typeLabel="مرجوعی" onChanged={refresh} centers={centers} onInvoiceIssued={openLabelFor} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}
      </div>

      {/* v2.39.0 — the auto-issued dispatch label (سند ارسال مرسلات):
          opens automatically after an invoice is issued (approval /
          quick-sale) and re-opens from the row's برچسب ارسال button. */}
      <ShippingLabelDialog
        open={labelDoc !== null}
        onOpenChange={(v) => { if (!v) setLabelDoc(null); }}
        invoiceId={labelDoc?.id ?? null}
        invoiceNumber={labelDoc?.number ?? null}
      />
    </div>
  );
}
