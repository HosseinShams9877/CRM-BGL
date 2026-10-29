'use client';

// ════════════════════════════════════════════════════════════════
// shipping-label.tsx — v2.46.0 (round 71)
//
// «سند ارسال مراسلات» — the dispatch/shipping LABEL that is issued
// AUTOMATICALLY when a sales invoice is issued (v2.39.0), redesigned
// in round 71 to the user's own A5 sample (برچسب بیمارستان حضرت
// ابوالفضل-1.pdf — «مشابه همین طرح طراحی گردد»):
//   • A5 portrait sheet (148×210mm), navy rounded outer frame
//   • brand block (issuing company logo) top-LEFT + تاریخ ارسال /
//     ساعت تحویل کالا به مقصد boxes top-right (sample layout)
//   • «نحوه پرداخت هزینه» box (light-cyan, cyan tab) with
//     پیش‌پرداخت / پس‌کرایه tick boxes + «نوع مرسوله» box
//   • «اطلاعات فرستنده» box (navy pill, navy circular icon badges)
//   • «اطلاعات گیرنده» box (cyan pill, cyan badges, name in LARGE
//     bold type — the single most important line on a carton)
//   • NEW «شماره سریال مرسوله» box — every printed sheet carries a
//     UNIQUE serial (LBL-YYMMDD-NNNN, «شماره سریال هم صادر شود»)
//     with a real scannable Code128 barcode (jsbarcode) + «کارتون ۱
//     از ۳» position + invoice & dispatch numbers
//   • «محتویات مرسوله» dashed strip + handling warning box with
//     warning/shield icons + the sample's decorative double wave at
//     the very bottom edge (navy + cyan)
//
// Serials are issued atomically server-side (append-only paper
// trail) — one A5 sheet per carton; the print run always issues
// serials FIRST so no sheet ever prints without one.
//
// Print architecture = DocumentPrintDialog's proven pattern: the
// sheets render through a body-level portal (.label-print-master,
// hidden on screen) and @media print display-isolates it so the
// REAL print output is the label alone (RTL, vector, selectable);
// each sheet breaks to its own A5 page.
// ════════════════════════════════════════════════════════════════
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  Printer, X, Package, Clock, MapPin, Phone, User, FileText, Truck,
  Loader2, CalendarDays, Check, ShieldCheck, AlertTriangle, Wallet,
  HandCoins, Hash,
} from 'lucide-react';
import JsBarcode from 'jsbarcode';
import { toJalaliString } from '@/lib/jalali';
import { toPersianTime } from '@/lib/time-utils';
import { TimePicker } from '@/components/time-picker';
import { JalaliDatePicker } from '@/components/jalali-date-picker';
import { toPersianNum } from './sales-docs-shared';
import {
  PARCEL_TYPES, DEFAULT_PARCEL_TYPE, type ParcelType,
  PAYMENT_METHODS, derivePaymentMethod, formatCartonPosition,
  type PaymentMethodValue,
} from '@/lib/dispatch-label';

// ── API payload shapes (/api/shipments action='label') ──────
export interface LabelShipment {
  id: string;
  shipmentNumber: string | null;
  status: string;
  itemsSummary: string;
  notes: string;
}

export interface LabelDocument {
  id: string;
  documentNumber: string | null;
  documentType: string;
  issuedAt: string | null;
  createdAt: string;
  paymentTerms: string | null;
  salesExpertName: string | null;
  salesExpertMobile: string | null;
  itemCount: number;
}

export interface LabelItem {
  productName: string;
  quantity: number;
  unit: string | null;
}

export interface LabelBuyer {
  name?: string;
  address?: string;
  city?: string;
  province?: string;
  phone?: string;
  postalCode?: string;
  contactName?: string;
}

export interface LabelCompany {
  name: string | null;
  logo: string | null;
  tagline: string | null;
  address: string | null;
  phone: string | null;
}

/** v2.46.0 — one issued carton serial (LBL-YYMMDD-NNNN). */
export interface LabelCartonRow {
  id: string;
  serial: string;
  cartonIndex: number;
  cartonTotal: number;
}

export interface ShippingLabelPayload {
  shipment: LabelShipment | null;
  document: LabelDocument;
  cartonLabels?: LabelCartonRow[];
  items: LabelItem[];
  buyer: LabelBuyer;
  company: LabelCompany | null;
}

/** Print-time details the desk sets in the dialog before printing. */
export interface LabelPrintInputs {
  dispatchDate: string; // Jalali 'YYYY/MM/DD'
  deliveryTime: string; // 'HH:MM' or ''
  parcelType: ParcelType;
  paymentMethod: PaymentMethodValue | null; // sample's tick boxes
}

// ── helpers ─────────────────────────────────────────────────
function pn(n: number | string | null | undefined): string {
  return toPersianNum(n ?? '');
}

/** Address line: province، city، address (comma-joined, no empties). */
function buyerAddressLine(buyer: LabelBuyer): string {
  const head = [buyer.province, buyer.city].filter(Boolean).join('، ');
  const rest = buyer.address?.trim() || '';
  if (head && rest) return `${head}، ${rest}`;
  return head || rest || '..........................................';
}

/** Tick box (checkbox square) of the sample's option boxes. */
function Tick({ on, size = 9 }: { on: boolean; size?: number }) {
  return (
    <span className={`lbl-check${on ? ' is-on' : ''}`} aria-hidden>
      {on ? <Check size={size} strokeWidth={3.4} /> : null}
    </span>
  );
}

// ── scannable Code128 barcode (jsbarcode → SVG) ─────────────
function Barcode({ value, className }: { value: string; className?: string }) {
  const ref = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !value) return;
    try {
      JsBarcode(el, value, {
        format: 'CODE128',
        displayValue: false,
        height: 34,
        width: 1.5,
        margin: 0,
        background: '#ffffff',
        lineColor: '#003B73',
      });
    } catch {
      // invalid payload → leave the SVG blank; the serial text below
      // still identifies the carton unambiguously
    }
  }, [value]);
  return <svg ref={ref} className={className} />;
}

// ── the A5 sheet (user's sample design, BGL data) ───────────
function LabelSheet({
  payload,
  inputs,
  serial,
}: {
  payload: ShippingLabelPayload;
  inputs: LabelPrintInputs;
  serial: LabelCartonRow | null;
}) {
  const { document: doc, shipment, items, buyer, company } = payload;
  const buyerName = buyer.name?.trim() || '—';
  const phone = buyer.phone?.replace(/\s+/g, '') || '';
  const companyPhone = company?.phone?.replace(/\s+/g, '') || '';
  const expert = doc.salesExpertName?.trim() || '';
  const expertMobile = doc.salesExpertMobile?.replace(/\s+/g, '') || '';
  const deliveryTime = inputs.deliveryTime ? toPersianTime(inputs.deliveryTime) : '.............';
  const contents = shipment?.itemsSummary
    || items
      .slice(0, 4)
      .map((it) => `${pn(it.quantity)} ${it.productName}`)
      .join(' · ')
    || '—';

  return (
    <div dir="rtl" className="lbl-sheet">
      {/* ── header: meta boxes top-RIGHT + brand top-LEFT (sample) ── */}
      <header className="lbl-head">
        <div className="lbl-meta-stack">
          <div className="lbl-meta-box">
            <span className="lbl-meta-cap"><CalendarDays size={10} /> تاریخ ارسال</span>
            <span className="lbl-meta-val">{pn(inputs.dispatchDate) || '.....'}</span>
          </div>
          <div className="lbl-meta-box lbl-meta-strong">
            <span className="lbl-meta-cap"><Clock size={10} /> ساعت تحویل کالا به مقصد</span>
            <span className="lbl-meta-val" dir="ltr">{deliveryTime}</span>
          </div>
        </div>
        <div className="lbl-brand">
          {company?.logo ? (
            <img src={company.logo} alt={company.name || 'لوگو'} className="lbl-logo" />
          ) : (
            <span className="lbl-logo-fallback"><Truck size={16} /></span>
          )}
          <div className="lbl-brand-text">
            <p className="lbl-brand-name">{company?.name || '—'}</p>
            {company?.tagline ? <p className="lbl-brand-tag">{company.tagline}</p> : null}
          </div>
        </div>
      </header>

      {/* ── option boxes: نحوه پرداخت هزینه + نوع مرسوله (sample) ── */}
      <div className="lbl-opt-row">
        <section className="lbl-opt-box lbl-pay-box">
          <p className="lbl-opt-title">نحوه پرداخت هزینه</p>
          <div className="lbl-opt-choices">
            {PAYMENT_METHODS.map((m, i) => (
              <span key={m.value} className="lbl-opt">
                <Tick on={inputs.paymentMethod === m.value} />
                {i === 0 ? <Wallet size={11} className="lbl-opt-ico" /> : <HandCoins size={11} className="lbl-opt-ico" />}
                {m.label}
              </span>
            ))}
          </div>
        </section>
        <section className="lbl-opt-box">
          <p className="lbl-opt-title">
            <span className="lbl-badge-ico"><Truck size={9} /></span>
            نوع مرسوله
            <span className="lbl-badge-ico"><Package size={9} /></span>
          </p>
          <div className="lbl-opt-choices">
            {PARCEL_TYPES.map((p) => (
              <span key={p.value} className="lbl-opt">
                <Tick on={inputs.parcelType === p.value} />
                {p.label}
              </span>
            ))}
          </div>
        </section>
      </div>

      {/* ── sender box (navy pill — sample: اطلاعات فرستنده) ── */}
      <section className="lbl-box">
        <span className="lbl-pill">اطلاعات فرستنده</span>
        <div className="lbl-row">
          <span className="lbl-ico"><User size={9} /></span>
          <span className="lbl-row-label">نام فرستنده:</span>
          <span className="lbl-row-value">{company?.name || '—'}</span>
        </div>
        <div className="lbl-div" />
        <div className="lbl-row">
          <span className="lbl-ico"><MapPin size={9} /></span>
          <span className="lbl-row-label">آدرس فرستنده:</span>
          <span className="lbl-row-value">{company?.address?.trim() || '..........................................'}</span>
        </div>
        <div className="lbl-div" />
        <div className="lbl-row">
          <span className="lbl-ico"><Phone size={9} /></span>
          <span className="lbl-row-label">تلفن تماس فرستنده:</span>
          <span className="lbl-row-value" dir="ltr">{companyPhone ? pn(companyPhone) : '..................'}</span>
          {expert ? (
            <span className="lbl-row-sub">
              · کارشناس فروش: {expert}
              {expertMobile ? <> — <span dir="ltr">{pn(expertMobile)}</span></> : null}
            </span>
          ) : null}
        </div>
      </section>

      {/* ── recipient box (cyan pill — the heart of the label) ── */}
      <section className="lbl-box lbl-box-cyan lbl-receiver">
        <span className="lbl-pill">اطلاعات گیرنده</span>
        <p className="lbl-recipient-name">{buyerName}</p>
        <p className="lbl-line lbl-line-address">
          <MapPin size={11} className="lbl-ico-inline lbl-ico-cyan" />
          {buyerAddressLine(buyer)}
        </p>
        <div className="lbl-contact-row">
          {buyer.contactName ? (
            <span className="lbl-contact">
              <span className="lbl-ico lbl-ico-cyan"><User size={9} /></span>
              {buyer.contactName}
            </span>
          ) : null}
          <span className="lbl-contact lbl-contact-phone">
            <span className="lbl-ico lbl-ico-cyan"><Phone size={9} /></span>
            <span dir="ltr">{phone ? pn(phone) : '..................'}</span>
          </span>
          {buyer.postalCode ? (
            <span className="lbl-contact lbl-line-dim">
              <span className="lbl-ico lbl-ico-cyan"><Hash size={9} /></span>
              <span dir="ltr">{pn(buyer.postalCode)}</span>
            </span>
          ) : null}
        </div>
      </section>

      {/* ── serial box (v2.46.0 — شماره سریال هم صادر شود) ── */}
      <section className="lbl-serial">
        <span className="lbl-pill">شماره سریال مرسوله</span>
        {serial ? (
          <>
            <Barcode value={serial.serial} className="lbl-barcode" />
            <p className="lbl-serial-no" dir="ltr">{serial.serial}</p>
            <p className="lbl-serial-pos">{formatCartonPosition(serial.cartonIndex, serial.cartonTotal)}</p>
          </>
        ) : (
          <div className="lbl-serial-pending">
            <p className="lbl-serial-pending-title">شماره سریال هنگام چاپ صادر می‌شود</p>
            <p className="lbl-serial-pending-sub">
              هر برگ A5 یک شماره سریال یکتا (با بارکد) برای همان کارتون دریافت می‌کند.
            </p>
          </div>
        )}
        <div className="lbl-doc-row">
          <span className="lbl-doc-cell">شماره فاکتور: <b dir="ltr">{doc.documentNumber || '—'}</b></span>
          <span className="lbl-doc-sep" aria-hidden />
          <span className="lbl-doc-cell">شماره سند ارسال: <b dir="ltr">{shipment?.shipmentNumber || '—'}</b></span>
          {doc.itemCount > 0 ? (
            <>
              <span className="lbl-doc-sep" aria-hidden />
              <span className="lbl-doc-cell">{pn(doc.itemCount)} قلم کالا</span>
            </>
          ) : null}
        </div>
      </section>

      {/* ── contents strip ── */}
      <section className="lbl-contents">
        <span className="lbl-pill lbl-pill-contents"><FileText size={9} /> محتویات مرسوله</span>
        <p className="lbl-contents-text">{contents}</p>
      </section>

      {/* ── handling warning + wave footer (sample) ── */}
      <footer className="lbl-warning">
        <AlertTriangle size={17} className="lbl-warning-ico" />
        <div className="lbl-warning-text">
          <p className="lbl-warning-title">لطفاً با احتیاط حمل و نقل شود</p>
          <p className="lbl-warning-sub">
            محتویات تجهیزات پزشکی است — مرسوله را تنها به رابط فوق یا انبار مقصد تحویل دهید.
          </p>
        </div>
        <ShieldCheck size={19} className="lbl-warning-shield" />
      </footer>

      <svg className="lbl-wave" viewBox="0 0 100 12" preserveAspectRatio="none" aria-hidden>
        <path d="M0,5.2 C 12,2.4 24,8.2 38,5.4 C 52,2.6 66,7.8 78,5.0 C 88,2.9 95,5.6 100,4.6 L100,12 L0,12 Z" fill="#00AEEF" />
        <path d="M0,8.2 C 14,5.8 30,10.4 48,8.0 C 64,5.9 80,9.8 100,7.6 L100,12 L0,12 Z" fill="#003B73" />
      </svg>
    </div>
  );
}

// ── label CSS (injected once) — v2.46.0 sample design ───────
// palette of the user's A5 sample: navy #003B73 / cyan #00AEEF /
// light-cyan #E8F7FD — rounded frames, pill section headers,
// circular icon badges, tick boxes, double wave footer.
const LABEL_CSS = `
@media screen {
  .label-print-master { display: none; }
  .lbl-sheet {
    width: 148mm; min-height: 206mm; margin: 0 auto; background: #fff;
    font-family: 'Vazirmatn', Tahoma, sans-serif; color: #1A1A1A;
    display: flex; flex-direction: column; direction: rtl; position: relative;
    font-size: 11px; line-height: 1.55; box-sizing: border-box;
    box-shadow: 0 8px 32px rgba(0,0,0,.18);
  }
  .lbl-sheet + .lbl-sheet { margin-top: 8mm; }
}
@media print {
  @page { size: 148mm 210mm; margin: 0; }
  html, body { background: #fff !important; }
  .no-print { display: none !important; }
  body > *:not(.label-print-master) { display: none !important; }
  .label-print-master { display: block !important; }
  .lbl-sheet {
    position: static; margin: 0; box-shadow: none;
    page-break-after: always; break-after: page;
    page-break-inside: avoid; break-inside: avoid;
  }
  .lbl-sheet:last-child { page-break-after: auto; break-after: auto; }
}

/* ── sheet frame (navy rounded outer border of the sample) ── */
.lbl-sheet {
  --navy: #003B73; --cyan: #00AEEF; --cyan-bg: #E8F7FD;
  --ink: #1A1A1A; --muted: #5b6470; --line: #c9d4de;
  border: 0.8mm solid var(--navy); border-radius: 5mm;
  padding: 5mm 5mm 13mm; overflow: hidden;
  gap: 3.4mm;
}
.lbl-sheet, .lbl-sheet * { box-sizing: border-box; }

/* ── header: meta boxes (right) + brand (left) ── */
.lbl-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 3mm; }
.lbl-meta-stack { display: flex; flex-direction: column; gap: 1.6mm; flex-shrink: 0; min-width: 34mm; }
.lbl-meta-box {
  border: 0.4mm solid var(--cyan); border-radius: 2.4mm; background: var(--cyan-bg);
  padding: 1.4mm 2.6mm 1.2mm; text-align: center;
}
.lbl-meta-strong { border-color: var(--navy); background: #fff; border-width: 0.5mm; }
.lbl-meta-cap {
  display: flex; align-items: center; justify-content: center; gap: 1mm;
  font-size: 7.5px; font-weight: 700; color: var(--navy); white-space: nowrap;
}
.lbl-meta-val { display: block; font-size: 12px; font-weight: 800; color: var(--ink); margin-top: 0.3mm; }
.lbl-brand { display: flex; align-items: center; gap: 2.2mm; min-width: 0; }
.lbl-logo { width: 20mm; height: auto; max-height: 13mm; object-fit: contain; }
.lbl-logo-fallback {
  width: 13mm; height: 13mm; border-radius: 3mm; background: var(--navy); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.lbl-brand-text { min-width: 0; }
.lbl-brand-name { font-size: 13px; font-weight: 800; margin: 0; color: var(--navy); }
.lbl-brand-tag { font-size: 8px; font-weight: 600; color: var(--muted); margin: 0.6mm 0 0; }

/* ── option boxes (نحوه پرداخت هزینه / نوع مرسوله) ── */
.lbl-opt-row { display: flex; gap: 2.6mm; }
.lbl-opt-box {
  flex: 1; border: 0.4mm solid var(--navy); border-radius: 2.6mm;
  padding: 1.8mm 2.6mm 1.6mm; background: #fff;
}
.lbl-pay-box { border-color: var(--cyan); background: var(--cyan-bg); }
.lbl-opt-title {
  display: flex; align-items: center; justify-content: center; gap: 1.4mm;
  font-size: 9px; font-weight: 800; color: var(--navy); margin: 0 0 1.2mm;
  white-space: nowrap;
}
.lbl-badge-ico {
  width: 3.6mm; height: 3.6mm; border-radius: 99px; background: var(--navy); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.lbl-opt-choices {
  display: flex; justify-content: center; flex-wrap: nowrap; gap: 3.2mm;
}
.lbl-opt {
  display: inline-flex; align-items: center; gap: 1.1mm;
  font-size: 9.5px; font-weight: 700; color: var(--ink); white-space: nowrap;
}
.lbl-opt-ico { color: var(--navy); }
.lbl-check {
  width: 3mm; height: 3mm; border: 0.35mm solid var(--navy); border-radius: 0.7mm;
  background: #fff; display: inline-flex; align-items: center; justify-content: center;
  color: #fff; flex-shrink: 0; padding: 0;
}
.lbl-check.is-on { background: var(--navy); }

/* ── section boxes with pill headers on the border ── */
.lbl-box {
  position: relative; border: 0.5mm solid var(--navy); border-radius: 3mm;
  background: #fff; padding: 3.4mm 3.2mm 2.2mm;
}
.lbl-pill {
  position: absolute; top: -2.7mm; right: 5mm; z-index: 1;
  background: var(--navy); color: #fff; font-size: 8.5px; font-weight: 700;
  padding: 0.5mm 3.6mm; border-radius: 99px; line-height: 1.7;
  display: inline-flex; align-items: center; gap: 1mm;
}
.lbl-box-cyan { border-color: var(--cyan); }
.lbl-box-cyan .lbl-pill { background: var(--cyan); }

/* sender rows */
.lbl-row { display: flex; align-items: center; gap: 1.6mm; min-height: 4.6mm; }
.lbl-ico {
  width: 4.2mm; height: 4.2mm; border-radius: 99px; background: var(--navy); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.lbl-ico-cyan { background: var(--cyan); }
.lbl-ico-inline { vertical-align: -2px; margin-left: 1.2mm; color: var(--cyan); background: none; width: auto; height: auto; }
.lbl-row-label { font-weight: 700; color: var(--navy); font-size: 9.5px; white-space: nowrap; }
.lbl-row-value { flex: 1; font-weight: 600; font-size: 10.5px; }
.lbl-row-sub { font-size: 9px; color: var(--muted); white-space: nowrap; }
.lbl-div { border-top: 1px dotted var(--line); margin: 1.2mm 0; }

/* recipient box */
.lbl-receiver { text-align: center; padding-top: 4mm; }
.lbl-recipient-name {
  font-size: 20px; font-weight: 800; margin: 0; color: var(--ink);
  line-height: 1.4; text-align: center;
}
.lbl-line { font-size: 10.5px; color: var(--ink); margin: 1.2mm 0 0; }
.lbl-line-address { text-align: center; font-weight: 600; }
.lbl-line-dim { color: var(--muted); font-size: 9.5px; }
.lbl-contact-row {
  display: flex; justify-content: center; align-items: center; gap: 4mm;
  flex-wrap: wrap; margin-top: 1.6mm;
}
.lbl-contact {
  display: inline-flex; align-items: center; gap: 1.4mm;
  font-size: 10.5px; color: var(--ink); font-weight: 600;
}
.lbl-contact-phone { font-size: 14.5px; font-weight: 800; letter-spacing: 0.4px; }
.lbl-contact-phone .lbl-ico { width: 4.8mm; height: 4.8mm; }

/* ── serial box (v2.46.0) ── */
.lbl-serial {
  position: relative; border: 0.6mm solid var(--navy); border-radius: 3mm;
  background: #fff; padding: 3.6mm 3mm 2mm; text-align: center;
}
.lbl-barcode { display: block; height: 9mm; width: auto; max-width: 100%; margin: 0 auto; }
.lbl-serial-no {
  font-family: 'Courier New', monospace; font-size: 12.5px; font-weight: 800;
  letter-spacing: 1.2px; margin: 1.2mm 0 0; color: var(--ink);
}
.lbl-serial-pos {
  font-size: 10.5px; font-weight: 800; color: var(--navy); margin: 0.8mm 0 0;
}
.lbl-serial-pending { padding: 1.6mm 0 1.2mm; }
.lbl-serial-pending-title { font-size: 10.5px; font-weight: 800; color: var(--navy); margin: 0; }
.lbl-serial-pending-sub { font-size: 8.5px; color: var(--muted); margin: 0.8mm 0 0; }
.lbl-doc-row {
  display: flex; justify-content: center; align-items: center; gap: 2mm;
  flex-wrap: wrap; margin-top: 1.6mm; padding-top: 1.4mm;
  border-top: 1px dotted var(--line);
}
.lbl-doc-cell { font-size: 8.5px; font-weight: 600; color: var(--muted); white-space: nowrap; }
.lbl-doc-cell b { color: var(--ink); font-size: 9.5px; }
.lbl-doc-sep { width: 1px; height: 3.2mm; background: var(--line); }

/* contents strip */
.lbl-contents {
  position: relative; border: 0.4mm dashed #9ca3af; border-radius: 3mm;
  padding: 3.2mm 2.8mm 1.8mm; margin-top: 3.6mm; background: #fafafa;
}
.lbl-pill-contents { right: 4mm; top: -2.6mm; background: var(--muted); }
.lbl-contents-text { font-size: 10px; font-weight: 700; color: var(--ink); margin: 0; line-height: 1.7; }

/* warning box + wave footer */
.lbl-warning {
  margin-top: auto; border: 0.5mm solid var(--navy); border-radius: 3mm;
  background: #fff; padding: 2.6mm 3mm; display: flex; align-items: center; gap: 2.6mm;
}
.lbl-warning-ico { color: var(--navy); flex-shrink: 0; }
.lbl-warning-text { flex: 1; min-width: 0; }
.lbl-warning-title { font-size: 10.5px; font-weight: 800; color: var(--navy); margin: 0; }
.lbl-warning-sub { font-size: 8.5px; color: #0090c8; margin: 0.6mm 0 0; line-height: 1.65; }
.lbl-warning-shield { color: var(--navy); flex-shrink: 0; margin-right: 1mm; }
.lbl-wave {
  position: absolute; bottom: 0; left: 0; right: 0; width: 100%; height: 9.5mm;
  display: block; z-index: 0;
}
.lbl-sheet > *:not(.lbl-wave) { position: relative; z-index: 1; }

@media print {
  .lbl-pill { background: var(--navy) !important; color: #fff !important; }
  .lbl-box-cyan .lbl-pill { background: var(--cyan) !important; }
  .lbl-pay-box, .lbl-meta-box { background: var(--cyan-bg) !important; }
  .lbl-ico, .lbl-ico-cyan, .lbl-badge-ico, .lbl-check.is-on { background: var(--navy) !important; color: #fff !important; }
  .lbl-box-cyan .lbl-ico, .lbl-ico-cyan { background: var(--cyan) !important; }
  .lbl-check { background: #fff !important; }
  .lbl-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

let labelCssInjected = false;
function InjectLabelCss() {
  useEffect(() => {
    if (labelCssInjected) return;
    const style = document.createElement('style');
    style.id = 'label-print-css';
    style.textContent = LABEL_CSS;
    document.head.appendChild(style);
    labelCssInjected = true;
    return () => { /* keep injected across dialogs */ };
  }, []);
  return null;
}

// ── dialog wrapper ──────────────────────────────────────────
export default function ShippingLabelDialog({
  open,
  onOpenChange,
  invoiceId,
  invoiceNumber,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The ISSUED invoice document id the label belongs to. */
  invoiceId: string | null;
  /** Optional display hint for the dialog title while loading. */
  invoiceNumber?: string | null;
}) {
  const [payload, setPayload] = useState<ShippingLabelPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // print-time inputs: dispatch date defaults to TODAY (Jalali)
  const [dispatchDate, setDispatchDate] = useState('');
  const [deliveryTime, setDeliveryTime] = useState('');
  const [parcelType, setParcelType] = useState<ParcelType>(DEFAULT_PARCEL_TYPE);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethodValue | null>(null);
  // v2.46.0 — carton serials: issued rows + desired carton count
  const [serials, setSerials] = useState<LabelCartonRow[]>([]);
  const [cartonCount, setCartonCount] = useState('1');
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !invoiceId) return;
    let cancelled = false;
    // Reset state asynchronously (react-hooks/set-state-in-effect — same
    // pattern as the other dialogs in this codebase).
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      setPayload(null);
      // dispatch date defaults to TODAY (Jalali)
      setDispatchDate(toJalaliString(new Date().toISOString()) || '');
      setDeliveryTime('');
      setParcelType(DEFAULT_PARCEL_TYPE);
      setPaymentMethod(null);
      setSerials([]);
      setCartonCount('1');
      setIssueError(null);
    });
    (async () => {
      try {
        const res = await fetch('/api/shipments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'label', salesDocumentId: invoiceId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'خطا در دریافت سند ارسال');
        if (!cancelled) {
          const p = data.data as ShippingLabelPayload;
          setPayload(p);
          const rows = Array.isArray(p.cartonLabels) ? p.cartonLabels : [];
          setSerials(rows);
          setCartonCount(String(Math.max(rows.length, 1)));
          // payment tick default comes from the invoice's terms text
          setPaymentMethod(derivePaymentMethod(p.document?.paymentTerms));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'خطا در دریافت سند ارسال');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, invoiceId]);

  if (!invoiceId) return null;

  const inputs: LabelPrintInputs = { dispatchDate, deliveryTime, parcelType, paymentMethod };

  /** Issue (or top-up) the carton serials for the requested count.
   *  Append-only: requesting fewer than already issued changes nothing
   *  (serials are the paper trail) — the print run then prints ALL
   *  issued sheets so a replacement run can reproduce every carton. */
  const ensureSerials = async (): Promise<LabelCartonRow[]> => {
    const count = Math.min(99, Math.max(1, parseInt(cartonCount, 10) || 1));
    if (serials.length >= count) return serials;
    setIssuing(true);
    setIssueError(null);
    try {
      const res = await fetch('/api/shipments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'issue-label-serials',
          salesDocumentId: invoiceId,
          cartonCount: count,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در صدور شماره سریال برچسب');
      const rows = (data.data?.cartonLabels ?? []) as LabelCartonRow[];
      setSerials(rows);
      setCartonCount(String(Math.max(rows.length, 1)));
      return rows;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'خطا در صدور شماره سریال برچسب';
      setIssueError(msg);
      return serials;
    } finally {
      setIssuing(false);
    }
  };

  /** Print: serials first (every sheet carries one), then window.print. */
  const handlePrint = async () => {
    await ensureSerials();
    // let React commit the freshly rendered sheets before the print
    // dialog snapshot (portal + preview both re-render)
    setTimeout(() => window.print(), 250);
  };

  const sheets: Array<LabelCartonRow | null> =
    serials.length > 0 ? serials : [null];

  return (
    <>
      <InjectLabelCss />
      {createPortal(
        <div className="label-print-master">
          {payload
            ? sheets.map((s) => (
              <LabelSheet key={s?.id ?? 'pending'} payload={payload} inputs={inputs} serial={s} />
            ))
            : null}
        </div>,
        document.body,
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-[min(46rem,calc(100vw-2rem))] max-h-[92vh] p-0 overflow-hidden" dir="rtl">
          <div className="no-print flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-100 flex-wrap gap-2">
            <DialogTitle className="text-sm font-bold text-gray-800">
              سند ارسال مراسلات — برچسب کارتون‌ها {invoiceNumber ? <span dir="ltr" className="font-mono">{invoiceNumber}</span> : ''}
            </DialogTitle>
            <div className="flex items-center gap-2">
              <button onClick={handlePrint} disabled={!payload || issuing}
                className="h-8 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 disabled:opacity-40 text-white text-xs font-bold flex items-center gap-1.5 transition-colors">
                {issuing ? <Loader2 size={13} className="animate-spin" /> : <Printer size={13} />}
                صدور سریال و چاپ ({toPersianNum(sheets.filter(Boolean).length || sheets.length)})
              </button>
              <button onClick={() => onOpenChange(false)}
                className="h-8 px-3 rounded-lg border border-gray-200 text-gray-600 text-xs font-medium flex items-center gap-1.5 hover:bg-gray-50 transition-colors">
                <X size={13} /> بستن
              </button>
            </div>
          </div>

          {/* ── print-time inputs (تاریخ/ساعت/نوع مرسوله/پرداخت/سریال) ── */}
          <div className="no-print bg-gray-50 border-b border-gray-100 px-4 py-3 space-y-3">
            <div className="flex flex-wrap items-end gap-4">
              <div className="w-36">
                <label className="block text-[11px] font-bold text-gray-500 mb-1.5" htmlFor="shiplabel-date">تاریخ ارسال</label>
                <JalaliDatePicker
                  id="shiplabel-date"
                  value={dispatchDate}
                  onChange={setDispatchDate}
                  ariaLabel="تاریخ ارسال مرسوله"
                  inputClassName="h-9 rounded-lg text-xs w-full"
                />
              </div>
              <div className="w-36">
                <label className="block text-[11px] font-bold text-gray-500 mb-1.5">ساعت تحویل کالا به مقصد</label>
                <TimePicker
                  value={deliveryTime}
                  onChange={setDeliveryTime}
                  ariaLabel="ساعت تحویل کالا به مقصد"
                  placeholder="مثلاً ۱۸:۳۰"
                  inputClassName="h-9 rounded-lg text-xs w-full"
                  allowClear
                />
              </div>
              <div>
                <span className="block text-[11px] font-bold text-gray-500 mb-1.5">نوع مرسوله</span>
                <div className="flex items-center gap-1.5">
                  {PARCEL_TYPES.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setParcelType(p.value)}
                      aria-pressed={parcelType === p.value}
                      className={`h-9 px-3 rounded-lg text-[11px] font-bold border transition-all ${
                        parcelType === p.value
                          ? 'bg-teal-600 text-white border-teal-600 shadow-sm'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-teal-300 hover:text-teal-700'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="block text-[11px] font-bold text-gray-500 mb-1.5">نحوه پرداخت هزینه</span>
                <div className="flex items-center gap-1.5">
                  {PAYMENT_METHODS.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => setPaymentMethod(paymentMethod === m.value ? null : m.value)}
                      aria-pressed={paymentMethod === m.value}
                      className={`h-9 px-3 rounded-lg text-[11px] font-bold border transition-all ${
                        paymentMethod === m.value
                          ? 'bg-sky-700 text-white border-sky-700 shadow-sm'
                          : 'bg-white text-gray-500 border-gray-200 hover:border-sky-300 hover:text-sky-700'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="w-28">
                <label className="block text-[11px] font-bold text-gray-500 mb-1.5" htmlFor="shiplabel-cartons">تعداد کارتون</label>
                <input
                  id="shiplabel-cartons"
                  type="number" min={1} max={99} step={1}
                  value={cartonCount}
                  onChange={(e) => setCartonCount(e.target.value)}
                  className="h-9 w-full rounded-lg border border-gray-200 px-2 text-xs font-bold text-gray-700 focus:outline-none focus:ring-2 focus:ring-teal-200"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 min-h-[30px]">
              {serials.length > 0 ? (
                <>
                  <span className="text-[11px] font-bold text-gray-500">شماره سریال‌های صادرشده:</span>
                  {serials.map((s) => (
                    <span key={s.id} className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-white border border-teal-200 text-[10px] font-mono font-bold text-teal-800" dir="ltr">
                      {s.serial}
                      <span className="text-teal-500">({toPersianNum(s.cartonIndex)}/{toPersianNum(s.cartonTotal)})</span>
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-[11px] text-gray-400">
                  هنوز شماره سریالی صادر نشده — با دکمهٔ «صدور سریال و چاپ» برای هر کارتون یک شمارهٔ یکتا صادر و چاپ می‌شود.
                </span>
              )}
              {issueError ? (
                <span className="text-[11px] text-red-600 bg-red-50 rounded-lg px-2 py-1">{issueError}</span>
              ) : null}
            </div>
            <p className="text-[11px] text-gray-400 leading-5">
              این سند ارسال هم‌زمان با صدور فاکتور به‌صورت خودکار صادر شده است — مقادیر بالا فقط روی برچسب چاپ می‌شوند.
              هر کارتون یک برگ A5 عمودی با شماره سریال و بارکد اختصاصی می‌گیرد. شماره‌های سریال صادرشده حذف نمی‌شوند (سابقهٔ ارسال).
            </p>
          </div>

          {/* ── preview: exactly the sheets the print run produces ── */}
          <div className="overflow-y-auto bg-gray-200 no-print" style={{ maxHeight: 'calc(92vh - 195px)' }} data-label-preview>
            {loading ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-gray-500">
                <Loader2 size={22} className="animate-spin" />
                <p className="text-xs">در حال دریافت سند ارسال…</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 px-6 text-center">
                <p className="text-xs text-red-600 bg-red-50 rounded-xl px-4 py-3">{error}</p>
              </div>
            ) : payload ? (
              <>
                {sheets.map((s) => (
                  <LabelSheet key={s?.id ?? 'pending'} payload={payload} inputs={inputs} serial={s} />
                ))}
                <p className="no-print text-center text-[11px] text-gray-500 mt-3 pb-2 px-4">
                  خروجی چاپ: {serials.length > 0 ? `${toPersianNum(serials.length)} برگ A5 عمودی (یک برگ برای هر کارتون)` : 'یک برگ A5 عمودی'} — برای چسباندن روی کارتون‌ها
                </p>
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

