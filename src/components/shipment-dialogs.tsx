'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { listAllPages } from '@/hooks/use-api';
import { toJalaliString } from '@/lib/jalali';
import {
  SHIPMENT_STATUSES,
  SHIPMENT_STATUS_INFO,
  SHIPMENT_TRANSITIONS,
  ShipmentStatus,
} from '@/lib/shipment-status';
import { Truck, Package, Hash } from 'lucide-react';

// ═════════════════════════════════════════════════════════════
//  Shared shipment dialogs (v2.17.0).
//  Used by BOTH the sales pipeline (ثبت ارسال on an invoice card /
//  drag-to-dispatch) and the production workspace's ارسال و بارنامه
//  tab — one dialog, one contract, no drift.
// ═════════════════════════════════════════════════════════════

/** Minimal approved-document row the picker needs. */
export interface ShippableDoc {
  id: string;
  documentNumber: string | null;
  documentType: string;
  status: string;
  finalAmount: number;
  centerId: string | null;
  center: { id: string; name: string } | null;
  _count?: { items?: number };
}

export interface ShipmentRow {
  id: string;
  shipmentNumber: string | null;
  salesDocumentId: string;
  status: ShipmentStatus;
  carrierName: string;
  trackingCode: string;
  itemsSummary: string;
  weight: string;
  notes: string;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  creator?: { id: string; displayName: string } | null;
  salesDocument?: {
    id: string;
    documentNumber: string | null;
    documentType: string;
    status: string;
    finalAmount: number;
    center: { id: string; name: string; city?: string | null } | null;
  } | null;
}

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

/** Load every approved invoice document (walks all pages — v2.16.0 rule). */
async function loadShippableDocs(): Promise<ShippableDoc[]> {
  const all = await listAllPages<ShippableDoc>('/api/sales-documents', 'list', {
    status: 'approved',
  });
  // Invoice-type docs first (a derived invoice exists for every approved
  // proforma since v2.13.0; proformas are kept as a legacy fallback).
  return all
    .filter((d) => d.documentType === 'invoice' || d.documentType === 'proforma')
    .sort((a, b) => (a.documentType === b.documentType ? 0 : a.documentType === 'invoice' ? -1 : 1));
}

// ── New shipment dialog ─────────────────────────────────────
export function NewShipmentDialog({
  open,
  onOpenChange,
  onSaved,
  presetDoc,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
  /** Pipeline passes the card's document so the picker starts preselected. */
  presetDoc?: { id: string; documentNumber: string | null; centerName?: string | null } | null;
}) {
  const [docs, setDocs] = useState<ShippableDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docId, setDocId] = useState('');
  const [docSearch, setDocSearch] = useState('');
  const [carrierName, setCarrierName] = useState('');
  const [trackingCode, setTrackingCode] = useState('');
  const [itemsSummary, setItemsSummary] = useState('');
  const [weight, setWeight] = useState('');
  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<ShipmentStatus>('preparing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const run = async () => {
      // Reset + load asynchronously (react-hooks/set-state-in-effect)
      await Promise.resolve();
      if (cancelled) return;
      setDocId(presetDoc?.id || '');
      setDocSearch('');
      setCarrierName('');
      setTrackingCode('');
      setItemsSummary('');
      setWeight('');
      setNotes('');
      setStatus('preparing');
      setError(null);
      setDocsLoading(true);
      try {
        const rows = await loadShippableDocs();
        if (!cancelled) setDocs(rows);
      } catch {
        if (!cancelled) setDocs([]);
      } finally {
        if (!cancelled) setDocsLoading(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [open, presetDoc?.id]);

  const filteredDocs = useCallback(() => {
    const q = docSearch.trim();
    if (!q) return docs.slice(0, 60);
    return docs
      .filter((d) => (d.documentNumber || '').includes(q) || (d.center?.name || '').includes(q))
      .slice(0, 60);
  }, [docs, docSearch]);

  const submit = async () => {
    if (!docId) {
      setError('انتخاب سند فروش الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          salesDocumentId: docId,
          carrierName,
          trackingCode,
          itemsSummary,
          weight,
          notes,
          status,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت ارسال');
      toast.success('ارسال بار با موفقیت ثبت شد');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت ارسال');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت ارسال بار</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

        {/* Document picker */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">سند فاکتور *</label>
          {presetDoc ? (
            <div className="h-10 rounded-lg border border-teal-200 bg-teal-50 px-3 flex items-center gap-2 text-xs text-teal-800">
              <Hash size={12} />
              <span className="font-mono" dir="ltr">{presetDoc.documentNumber || '—'}</span>
              {presetDoc.centerName && <span className="truncate">· {presetDoc.centerName}</span>}
            </div>
          ) : (
            <>
              <Input
                aria-label="جستجوی سند"
                value={docSearch}
                onChange={(e) => setDocSearch(e.target.value)}
                placeholder="جستجوی شماره سند یا نام مرکز..."
                className="h-9 rounded-lg mb-2 text-xs"
              />
              <select
                aria-label="انتخاب سند"
                value={docId}
                onChange={(e) => setDocId(e.target.value)}
                className="w-full h-10 rounded-lg border border-gray-200 px-3 text-xs bg-white text-gray-700"
              >
                <option value="">{docsLoading ? 'در حال بارگذاری اسناد...' : 'انتخاب سند تأییدشده...'}</option>
                {filteredDocs().map((d) => (
                  <option key={d.id} value={d.id}>
                    {(d.documentNumber || d.id.slice(-8))} — {d.center?.name || 'بدون مرکز'}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="shipmentdialogs-f220-1">حمل‌کننده</label>
            <Input id="shipmentdialogs-f220-1" aria-label="حمل‌کننده" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} placeholder="باربری / پست..." className="h-10 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="shipmentdialogs-f224-2">کد رهگیری</label>
            <Input id="shipmentdialogs-f224-2" aria-label="کد رهگیری" value={trackingCode} onChange={(e) => setTrackingCode(e.target.value)} placeholder="اختیاری" className="h-10 rounded-lg" dir="ltr" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="shipmentdialogs-f231-3">اقلام ارسالی</label>
            <Input id="shipmentdialogs-f231-3" aria-label="اقلام ارسالی" value={itemsSummary} onChange={(e) => setItemsSummary(e.target.value)} placeholder="مثلاً ۲ دستگاه" className="h-10 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="shipmentdialogs-f235-4">وزن</label>
            <Input id="shipmentdialogs-f235-4" aria-label="وزن" value={weight} onChange={(e) => setWeight(e.target.value)} placeholder="اختیاری" className="h-10 rounded-lg" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">وضعیت اولیه</label>
          <div className="flex items-center gap-2">
            {(['preparing', 'ready', 'in-transit'] as ShipmentStatus[]).map((s) => {
              const info = SHIPMENT_STATUS_INFO[s];
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={`h-9 px-3 rounded-lg text-xs font-bold border transition-all ${
                    status === s ? 'border-transparent shadow-sm' : 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                  style={status === s ? { background: info.bg, color: info.color } : undefined}
                >
                  {info.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="shipmentdialogs-f263-5">توضیحات</label>
          <Textarea id="shipmentdialogs-f263-5" aria-label="توضیحات ارسال" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات..." className="rounded-lg resize-none" rows={2} />
        </div>

        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <Truck size={14} className="ml-1" /> {busy ? 'در حال ثبت...' : 'ثبت ارسال'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ── Status advance chip row (production tab + pipeline cards) ──
export function ShipmentStatusActions({
  shipment,
  onDone,
  compact = false,
}: {
  shipment: ShipmentRow;
  onDone: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const nexts = SHIPMENT_TRANSITIONS[shipment.status] || [];

  const move = async (to: ShipmentStatus) => {
    setBusy(true);
    try {
      const res = await fetch('/api/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-status', id: shipment.id, status: to }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تغییر وضعیت');
      toast.success(`وضعیت ارسال به «${SHIPMENT_STATUS_INFO[to].label}» تغییر کرد`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در تغییر وضعیت');
    } finally {
      setBusy(false);
    }
  };

  if (nexts.length === 0) return null;

  return (
    <div className={`flex items-center gap-1.5 ${compact ? '' : 'mt-1'}`}>
      {nexts.map((s) => {
        const info = SHIPMENT_STATUS_INFO[s];
        return (
          <button
            key={s}
            onClick={() => move(s)}
            disabled={busy}
            title={`تغییر وضعیت به ${info.label}`}
            className={`h-6 px-2 rounded-md text-[11px] font-bold border border-transparent transition-colors disabled:opacity-50 ${compact ? '' : 'px-2.5 h-7 text-[11px]'}`}
            style={{ background: info.bg, color: info.color }}
          >
            {info.label} →
          </button>
        );
      })}
    </div>
  );
}

// ── Shared presentational bits ──
export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  const info = SHIPMENT_STATUS_INFO[status] || SHIPMENT_STATUS_INFO.preparing;
  return (
    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: info.bg, color: info.color }}>
      <Package size={9} /> {info.label}
    </span>
  );
}

/** Jalali display helper for shipment dates. */
export function shipmentDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  return toJalaliString(iso);
}

export { toPersianNum, SHIPMENT_STATUSES };
