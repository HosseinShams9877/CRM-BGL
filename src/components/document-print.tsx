'use client';

import React, { useState, useEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Printer, Download, X, ZoomIn, ZoomOut, Maximize2, MapPin, Phone, Globe } from 'lucide-react';
import { toJalaliString } from '@/lib/jalali';
import { letterheadIdentity, paymentMethodLabel, numberToPersianWords, resolveBuyerIdentity, resolveSenderAddressLines } from './sales-docs-shared';
// v2.48.0 — company-level printed terms (شرایط چاپی شرکت) for the
// «توضیحات / شرایط» box: same pure resolver as the settings preview.
import { proformaTermsLines } from '@/lib/company-profile';
// v2.52.0 — per-company print template registry (pure, unit-tested).
import { resolvePrintTemplate, type PrintTemplate } from '@/lib/print-templates';
import { ZOOM_FIT, computeFitScale, stepZoom, zoomAtEdge, type ZoomState } from '@/lib/print-zoom';

// ═══════════════════════════════════════════════════════════
// Professional A4 portrait document print template.
// v2.31.8 — redesigned after the official آریا مدیکال invoice
// format: black table headers with white text, badge-style
// section titles sitting on the box top edge («مشخصات فروشنده»
// / «مشخصات خریدار»), a 7-column items table (incl. واحد and
// the product code under each item name), a three-box bottom
// strip (اطلاعات پرداخت / خلاصه صورتحساب / توضیحات), dotted
// signature boxes and a solid black closing bar.
// v2.31.9 — upgraded to the official Lian proforma format
// (پیش‌فاکتور فروش): header payment terms, full seller/buyer
// identity blocks (شناسه ملی، کد اقتصادی، نشانی، کد پستی،
// کارشناس خرید/فروش), کد IRC under the item name and the
// «اطلاعات حساب» bank box in the bottom strip.
// PDF export = browser print-to-PDF (vector, selectable text).
// v2.49.0 (round 74) — UI-only redesign after the user's BGL reference
// image: Emerald/Teal (#00897B banner / #00796B ink) + Deep-Navy (#1A2340)
// waves, seller & buyer boxes with two SEPARATE address rows (نشانی دفتر
// مرکزی then نشانی کارخانه), centered table headers on white rows, a
// distinct «مبلغ قابل پرداخت به حروف» strip, iconed footer band.
// Data flow / resolvers / bindings untouched (task: visual only).
// v2.52.0 (round 77) — per-company template separation (تفکیک قالب چاپ):
// the palette is no longer a pair of module constants — every sheet
// resolves its template from Company.printTemplate ('bgl' default keeps
// the exact v2.49.0 colors; 'lian' = the بازرگانی reference: sea-green
// banner #2B826F, #006C66 ink, dark-purple waves #34284D + the signature
// indigo→teal gradient divider). Pure registry: src/lib/print-templates.ts.
// ═══════════════════════════════════════════════════════════

export interface PrintDocItem {
  productName: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount: number;
  description?: string;
  /** v2.31.8 — واحد column (defaults to «عدد»). */
  unit?: string | null;
  /** v2.31.8 — product code printed under the item name. */
  productCode?: string | null;
  /** v2.31.9 — کد IRC printed next to کد کالا (Lian proforma format). */
  productIrc?: string | null;
}

export type InvoiceMode = 'official' | 'unofficial';

export interface PrintDocPayment {
  method: string | null;
  amount: number;
  date: string | null;
}

export interface PrintDocData {
  documentNumber: string;
  documentType: 'proforma' | 'invoice' | 'return';
  status: string;
  createdAt: string;
  issuedAt?: string | null;
  /** v2.52.0 — per-company print template key (Company.printTemplate of
   *  the issuing company): null/undefined/unknown → 'bgl' (exact legacy
   *  look), 'lian' → the بازرگانی reference design. Resolved once in
   *  DocumentSheet via resolvePrintTemplate (pure registry). */
  printTemplate?: string | null;
  centerName: string;
  centerCity?: string;
  centerPhone?: string;
  description?: string;
  items: PrintDocItem[];
  totalAmount: number;
  discountAmount: number;
  taxAmount: number;
  finalAmount: number;
  creatorName: string;
  /** v2.31.7 — issuing company branding: when the document belongs to a
   *  subsidiary (e.g. آریا مدیکال) the letterhead prints that company's
   *  name + logo instead of the global holding identity. */
  companyName?: string | null;
  companyLogo?: string | null;
  /** v2.31.8 — issuing-company tagline printed under the org name
   *  (v2.31.11: آریا مدیکال → «فروش دستگاه‌های کمک تنفسی – واجد شرایط
   *  ارز دولتی», بهبود گستر لیام ایرانیان → «تولیدکنندهٔ دستگاه‌های خلوص‌سنج»). */
  companyTagline?: string | null;
  /** v2.31.9 — Lian proforma format. */
  /** Header payment terms (شرایط پرداخت: نقدی / اعتباری / ...). */
  paymentTerms?: string | null;
  /** کارشناس فروش + موبایل (defaults to the creator's name). */
  salesExpertName?: string | null;
  salesExpertMobile?: string | null;
  /** Buyer identity as entered in the data-entry form (JSON snapshot
   *  string; '' = legacy row → live center fallback). */
  buyerSnapshot?: string;
  /** Live center master data backing the snapshot fallback. */
  buyerCenter?: {
    name?: string | null;
    nationalId?: string | null;
    economicCode?: string | null;
    postalCode?: string | null;
    contactName?: string | null;
    address?: string | null;
    city?: string | null;
    province?: string | null;
    phone?: string | null;
  } | null;
  /** Issuing-company sender profile + bank account (شناسه ملی، نشانی،
   *  تلفن، کد پستی، بانک/دارنده/حساب/شبا); null → dotted placeholders.
   *  v2.41.0 (r56 port) — headOfficeAddress / factoryAddress are
   *  registered ONCE in company settings and auto-pulled here. */
  companyProfile?: {
    nationalId?: string | null;
    address?: string | null;
    phone?: string | null;
    postalCode?: string | null;
    /** نشانی دفتر مرکزی (sender profile, round 56). */
    headOfficeAddress?: string | null;
    /** نشانی کارخانه (sender profile, round 56). */
    factoryAddress?: string | null;
    /** v2.42.0 — انتخابگر نشانی فرستنده: 'main_office' → چاپ فقط نشانی
     *  دفتر مرکزی؛ 'factory' → فقط کارخانه؛ null → رفتار پیش‌فرض دو-نشانی. */
    senderAddressType?: string | null;
    bankName?: string | null;
    bankAccountHolder?: string | null;
    bankAccountNumber?: string | null;
    bankSheba?: string | null;
    /** v2.48.0 — company-level printed terms: newline-separated lines
     *  replacing the built-in defaults of the «توضیحات / شرایط» box
     *  (null/empty → pre-v2.48.0 default wording, unchanged). */
    proformaNote?: string | null;
    /** v2.54.0 — per-company website for the footer contact band (globe
     *  icon); null → the global app.website setting (unchanged legacy
     *  behavior for companies without their own site). */
    website?: string | null;
  } | null;
  /** v2.31.8 — registered payments feed the «اطلاعات پرداخت» box. */
  payments?: PrintDocPayment[];
}

interface CompanyInfo {
  name: string;
  companyName: string;
  website: string;
  address: string;
  phone: string;
  economicCode: string;
}

const TYPE_TITLES: Record<string, string> = {
  proforma: 'پیش‌فاکتور فروش',
  invoice: 'فاکتور فروش',
  return: 'برگشت از فروش',
};

const STATUS_LABELS: Record<string, string> = {
  draft: 'پیش‌نویس',
  pending_approval: 'در انتظار تأیید',
  approved: 'صادر شده',
  rejected: 'رد شده',
  cancelled: 'لغو شده',
};

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatMoney(amount: number): string {
  return toPersianNum(Math.round(amount).toLocaleString('en-US'));
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

/** v2.16.0 — date formatting goes through the SHARED lib/jalali module.
 *  The previously inlined copy had a wrong leap-year term
 *  (floor(gy2/4) instead of floor((gy2+3)/4)), which put the print
 *  date one day behind the app for 3 out of 4 years
 *  (reported: 2026-08-26 → app «۴ شهریور», print «۳ شهریور»). */
function jDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = toJalaliString(iso);
  if (!s) return '—';
  return toPersianNum(s);
}

/** Compact date for the payments box (Jalali, no weekday noise). */
function jDateShort(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = toJalaliString(iso);
  return s ? toPersianNum(s) : '';
}


// ── v2.49.0 BGL reference palette (تصویر مرجع کاربر — دور ۷۴) ──
// Primary: Emerald/Teal · Secondary: Deep Navy · Background: White.
// Two-shade teal system: banner/footer #00897B (large white text) and
// interactive ink #00796B (small white text — WCAG/print-safe contrast).
// v2.52.0 — these are now the 'bgl' entry of src/lib/print-templates.ts;
// they remain here as the PRINT_CSS fallback defaults (a sheet without
// an inline template style renders the exact legacy look).
const BRAND_TEAL = '#00897B';   // banner + footer band
const ACTION_TEAL = '#00796B';  // tabs, table header, final row, labels
const DEEP_NAVY = '#1A2340';    // header/footer waves

function Field({ label, value, ltr, strong }: { label: string; value: string; ltr?: boolean; strong?: boolean }) {
  return (
    <p className={`doc-field${strong ? ' doc-field-strong' : ''}`}>
      <span className="doc-field-label">{label}: </span>
      <span className="doc-field-value" dir={ltr ? 'ltr' : undefined}>{value}</span>
    </p>
  );
}


// ── the A4 sheet (v2.35.0 reference format, ported r59) ──
function DocumentSheet({ doc, company, mode }: { doc: PrintDocData; company: CompanyInfo; mode: InvoiceMode }) {
  const official = mode === 'official';
  // v2.52.0 — per-company template: the sheet's graphic language. 'bgl'
  // (null/unknown/legacy) resolves to the exact v2.49.0 palette; 'lian'
  // switches to the بازرگانی reference look. Everything below reads
  // colors from `tpl` — zero other layout changes per template except
  // the optional gradient divider.
  const tpl: PrintTemplate = resolvePrintTemplate(doc.printTemplate);
  // v2.54.0 — per-sheet gradient ids for the Arya banner sweep. React's
  // useId is unique per rendered instance (the on-screen preview AND
  // the body-level print master each get their own id), so the two
  // sheets never fight over a shared SVG defs id. Colons from useId
  // are stripped: url(#…) references stay plain, printable fragments.
  // v2.55.0 — the yasteb footer ribbon gets its own id (two defs per
  // sheet at most: banner sweep + ribbon).
  const gradId = `doc-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const ribbonId = `doc-ribbon-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const bannerFill = tpl.bannerGradient ? `url(#${gradId})` : tpl.palette.banner;
  // v2.55.0 — mirrored wave geometry (yasteb): tall LEFT / streak
  // thick at RIGHT; every other template keeps the exact v2.49.0 d.
  const bannerBodyD = tpl.mirrorWave
    ? 'M0,0 L1000,0 L1000,2 C850,6 700,26 540,55 C370,86 220,118 0,122 Z'
    : 'M0,0 L1000,0 L1000,122 C780,118 630,86 460,55 C300,26 150,6 0,2 Z';
  const bannerWaveD = tpl.mirrorWave
    ? 'M1000,2 C850,6 700,26 540,55 C370,86 220,118 0,122 C220,124 370,100 540,68 C700,36 850,16 1000,30 Z'
    : 'M0,2 C150,6 300,26 460,55 C630,86 780,118 1000,122 C780,124 630,100 460,68 C300,36 150,16 0,30 Z';
  const title = official
    ? 'صورتحساب فروش کالا و خدمات'
    : TYPE_TITLES[doc.documentType] || 'سند فروش';
  const itemCount = doc.items.length;
  const identity = letterheadIdentity(
    doc.companyName ? { name: doc.companyName, logo: doc.companyLogo, tagline: doc.companyTagline } : null,
    company,
  );
  const sellerProfile = doc.companyProfile || {};
  const sellerPhone = sellerProfile.phone || company.phone;
  // v2.54.0 — per-company website (globe icon): the issuing company's own
  // site wins; companies without one keep the global app.website (the
  // exact pre-v2.54.0 footer).
  const sellerWebsite = (sellerProfile.website || '').trim();
  const buyer = resolveBuyerIdentity(doc.buyerSnapshot, doc.buyerCenter || { name: doc.centerName });
  const buyerName = buyer.name || doc.centerName;
  const buyerCityProvince = [buyer.province, buyer.city].filter(Boolean).join(' / ');
  const sellerExpert = doc.salesExpertName || doc.creatorName;
  // pad rows to keep the table visually substantial while the sheet
  // fits ONE A4 page (v2.49.0: ≤8 total rows; docs with 10+ items flow
  // to a second page exactly as before — measured print audit r74)
  const padRows = Math.max(0, Math.min(6, 8 - itemCount));

  // v2.42.0 — sender address lines now run through the shared resolver:
  // an explicit per-document choice (senderAddressType) prints ONLY that
  // address; null keeps the v2.35.0 two-address default; an unregistered
  // selection degrades to the default (never an empty labelled line).
  const senderAddressLines = resolveSenderAddressLines({
    headOffice: sellerProfile.headOfficeAddress,
    factory: sellerProfile.factoryAddress,
    legacy: sellerProfile.address || company.address,
    senderAddressType: sellerProfile.senderAddressType ?? null,
  });
  const legacyAddress = sellerProfile.address || company.address || null;

  // payments strip (v2.31.9 lives under the bank box; the summary box
  // keeps the paid/remaining totals)
  const payments = (doc.payments || []).slice(0, 3);
  const paidAmount = (doc.payments || []).reduce((s, p) => s + p.amount, 0);
  const remaining = Math.max(0, doc.finalAmount - paidAmount);

  // header payment line for the meta box (نحوه پرداخت row)
  const paymentLine =
    doc.paymentTerms
    || (doc.payments && doc.payments.length > 0 ? paymentMethodLabel(doc.payments[0].method) : null)
    || '—';

  return (
    <div
      dir="rtl"
      className="doc-sheet"
      // v2.55.0 — yasteb capability hooks: zebra rows + dark org-name
      // ink. Both attrs stay ABSENT for bgl/lian/aria (zero regression:
      // the CSS rules are attribute-scoped and never fire).
      data-zebra={tpl.zebra ? '1' : undefined}
      data-name-dark={tpl.bannerNameColor ? '1' : undefined}
      style={{
        // v2.52.0 — template palette as CSS custom properties: overrides
        // the PRINT_CSS defaults (which stay 'bgl') for this sheet only.
        // Works in print media too (inline style > stylesheet rule).
        '--brand': tpl.palette.ink,
        '--banner': tpl.palette.banner,
        '--dark': tpl.palette.wave,
        '--line': tpl.palette.line,
        '--soft': tpl.palette.soft,
        // v2.54.0 — tint overrides (Arya blue family). bgl/lian keep
        // null → the PRINT_CSS defaults above render byte-identically.
        ...(tpl.tints ? { '--meta-soft': tpl.tints.metaSoft, '--strip-line': tpl.tints.stripLine } : {}),
        // v2.55.0 — yasteb: zebra tint + the navy org-name ink color
        ...(tpl.zebra ? { '--zebra': tpl.zebra } : {}),
        ...(tpl.bannerNameColor ? { '--banner-name-ink': tpl.bannerNameColor } : {}),
      } as React.CSSProperties}
    >
      {/* ── brand banner: teal sweep (tall right / short left) with the
              dark-purple wave riding the left edge, tapering right —
              geometry mapped pixel-exact from the reference format.
              v2.54.0 — gradient templates paint the header's CSS
              background with the SAME horizontal sweep the SVG body
              path uses below it (both anchored right='from',
              left='to' — the two areas join seamlessly because the
              gradient varies only along x). ── */}
      <header
        className="doc-banner"
        style={tpl.bannerGradient ? {
          // v2.55.0 — optional mid stop (yasteb): keeps the sweep vivid
          // mid-banner; without it the render is the exact two-stop
          // v2.54.0 gradient.
          background: `linear-gradient(to left, ${tpl.bannerGradient.from}${tpl.bannerGradient.mid ? `, ${tpl.bannerGradient.mid}` : ''}, ${tpl.bannerGradient.to})`,
        } : undefined}
      >
        <div className="doc-banner-inner">
          {/* v2.53.0 — '-white' logos (the BGL full lockup) print directly
                  on the banner with NO white plate — the round-77/78
                  references show the all-white lockup sitting on the teal
                  banner itself. Dark logos keep the legacy white plate. */}
          <div className={`doc-banner-logo${identity.whiteLogo ? ' doc-banner-logo-white' : ''}`}>
            <img
              src={identity.logoSrc}
              alt={doc.companyName ? `لوگوی ${doc.companyName}` : 'لوگوی شرکت'}
              className="doc-banner-logo-img"
            />
          </div>
          <div className="doc-banner-org">
            {!identity.fullLockup ? (
              <>
                <h1 className="doc-banner-name">{identity.orgName}</h1>
                {identity.tagline ? <p className="doc-banner-tagline">{identity.tagline}</p> : null}
              </>
            ) : null}
          </div>
          {/* v2.54.0 — the Arya reference prints the brand slogan on the
                  banner's LEFT side, in white over the blue sweep (RTL
                  flex: the last child lands at the left edge). Only
                  templates with a slogan render this block — bgl/lian
                  keep the exact pre-v2.54.0 banner. */}
          {tpl.bannerSlogan ? (
            <div className="doc-banner-slogan" aria-hidden="true">
              <p className="doc-banner-slogan-fa">{tpl.bannerSlogan.fa}</p>
              <p className="doc-banner-slogan-en" dir="ltr">{tpl.bannerSlogan.en}</p>
            </div>
          ) : null}
        </div>
        <svg className="doc-banner-wave" viewBox="0 0 1000 130" preserveAspectRatio="none" aria-hidden="true">
          {/* v2.49.0 — teal body: bottom edge sweeps from short-left (y≈2)
              down to full-height-right (y≈122); the banner stays taller on
              the right where the logo block sits (reference composition).
              v2.52.0 — fill from the sheet's template palette.
              v2.54.0 — gradient templates (Arya) fill the body with a
              linearGradient instead: 'from' at the RIGHT edge (the
              logo/name side) sweeping to 'to' at the LEFT edge.
              v2.55.0 — the optional mid stop lands at offset 0.5;
              mirrored templates (yasteb) sweep tall at the LEFT instead. */}
          {tpl.bannerGradient ? (
            <defs>
              <linearGradient id={gradId} x1="1" y1="0" x2="0" y2="0">
                <stop offset="0" stopColor={tpl.bannerGradient.from} />
                {tpl.bannerGradient.mid ? (
                  <stop offset="0.5" stopColor={tpl.bannerGradient.mid} />
                ) : null}
                <stop offset="1" stopColor={tpl.bannerGradient.to} />
              </linearGradient>
            </defs>
          ) : null}
          <path
            d={bannerBodyD}
            fill={bannerFill}
          />
          {/* v2.49.0 — deep-navy wave riding the same edge: ~28px thick at
              the left, truly tapering to ≈2px at the right (reference).
              v2.52.0 — fill from the template wave color (bgl: deep navy,
              lian: dark purple-indigo #34284D).
              v2.55.0 — mirrored templates (yasteb) ride the streak thick
              at the RIGHT edge under the logo (the reference cyan
              swoosh); the path itself comes from the template flag. */}
          <path
            d={bannerWaveD}
            fill={tpl.palette.wave}
          />
        </svg>
      </header>

      {/* ── meta row: date/number/payment box on the LEFT (user round 56),
              document title block + status chip on the right ── */}
      <section className="doc-meta-row">
        <div className="doc-title-block">
          <h2 className="doc-main-title">{title}</h2>
          <p className="doc-main-sub">{identity.orgName}{identity.tagline ? ` – ${identity.tagline}` : ''}</p>
          <span className="doc-status-chip">وضعیت: {statusLabel(doc.status)}</span>
        </div>
        <table className="doc-meta-box">
          <tbody>
            <tr>
              <td className="doc-meta-label">شماره</td>
              <td className="doc-meta-value" dir="ltr">{doc.documentNumber}</td>
            </tr>
            <tr>
              <td className="doc-meta-label">تاریخ صدور</td>
              <td className="doc-meta-value">{jDate(doc.issuedAt || doc.createdAt)}</td>
            </tr>
            <tr>
              <td className="doc-meta-label">شرایط پرداخت</td>
              <td className="doc-meta-value">{paymentLine}</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ── official notice strip ── */}
      {official && (
        <div className="doc-official-strip">
          صدور این صورتحساب مطابق مادهٔ ۱۶۹ قانون مالیات‌های مستقیم و دستورالعمل سازمان امور مالیاتی انجام شده است.
        </div>
      )}

      {/* ── seller: teal-tabbed box, reference field order (v2.49.0) ── */}
      <section className="doc-party">
        <span className="doc-tab">مشخصات فروشنده</span>
        <div className="doc-party-grid">
          <Field label="نام شرکت" value={identity.orgName} strong />
          <Field label="شناسه ملی" value={sellerProfile.nationalId ? toPersianNum(sellerProfile.nationalId) : '..................'} ltr />
          <Field label="کد اقتصادی" value={company.economicCode || '..................'} ltr />
          <Field label="تلفن" value={sellerPhone ? toPersianNum(sellerPhone) : '—'} ltr />
          <Field label="کد پستی" value={sellerProfile.postalCode ? toPersianNum(sellerProfile.postalCode) : '..................'} ltr />
          <Field label="کارشناس فروش" value={sellerExpert || '—'} />
          {doc.salesExpertMobile ? (
            <Field label="موبایل کارشناس" value={toPersianNum(doc.salesExpertMobile)} ltr />
          ) : null}
        </div>
        {/* v2.49.0 (task §9) — دو ردیف مستقل نشانی: «نشانی دفتر مرکزی» و
            دقیقاً در ردیف پایین «نشانی کارخانه»؛ هر ردیف Label مستقل،
            قابلیت چندخط‌شدن و تفکیک کامل. Data همان resolver v2.42.0 است:
            انتخاب صریح سند → همان نشانی؛ پیش‌فرض → هر دو به همین ترتیب. */}
        <div className="doc-party-addresses">
          {senderAddressLines.length > 0 ? (
            senderAddressLines.map((line, i) => (
              <div key={i} className="doc-addr-row">
                <span className="doc-addr-label">{line.label || 'نشانی'}:</span>
                <span className="doc-addr-value">{line.value}</span>
              </div>
            ))
          ) : (
            <div className="doc-addr-row">
              <span className="doc-addr-label">نشانی:</span>
              <span className="doc-addr-value">..................</span>
            </div>
          )}
        </div>
      </section>

      {/* ── buyer: teal-tabbed box harmonized with the seller box (v2.49.0) ── */}
      <section className="doc-party">
        <span className="doc-tab">مشخصات خریدار</span>
        <div className="doc-party-grid">
          <Field label="نام / شرکت" value={buyerName} strong />
          <Field label="شناسهٔ ملی" value={buyer.nationalId ? toPersianNum(buyer.nationalId) : '..................'} ltr />
          <Field label="کد اقتصادی" value={buyer.economicCode || (official ? '..................' : '—')} ltr />
          <Field label="استان / شهر" value={buyerCityProvince || '—'} />
          <Field label="تلفن" value={buyer.phone ? toPersianNum(buyer.phone) : '—'} ltr />
          <Field label="کد پستی" value={buyer.postalCode ? toPersianNum(buyer.postalCode) : (official ? '..................' : '—')} ltr />
          <Field label="کارشناس خرید" value={buyer.contactName || '—'} />
        </div>
        <div className="doc-party-addresses">
          <div className="doc-addr-row">
            <span className="doc-addr-label">نشانی:</span>
            <span className="doc-addr-value">{buyer.address || '..................'}</span>
          </div>
        </div>
      </section>

      {/* ── items: solid teal header, 7 columns ── */}
      <table className="doc-table">
        <thead>
          <tr>
            <th className="w-rownum">ردیف</th>
            <th className="w-desc">شرح کالا / خدمت</th>
            <th className="w-qty">تعداد</th>
            <th className="w-unit">واحد</th>
            <th className="w-price">قیمت واحد (ریال)</th>
            <th className="w-price">تخفیف (ریال)</th>
            <th className="w-price">مبلغ کل (ریال)</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={i}>
              <td className="c-center">{toPersianNum(i + 1)}</td>
              <td className="c-rtl">
                <span className="doc-item-name">{it.productName}</span>
                {it.productCode ? <span className="doc-item-code">کد کالا: {toPersianNum(it.productCode)}</span> : null}
                {it.productIrc ? <span className="doc-item-code">IRC: <span dir="ltr">{it.productIrc}</span></span> : null}
                {it.description ? <span className="doc-item-note"> — {it.description}</span> : null}
              </td>
              <td className="c-center">{toPersianNum(it.quantity)}</td>
              <td className="c-center">{it.unit || 'عدد'}</td>
              <td className="c-num" dir="ltr">{formatMoney(it.unitPrice)}</td>
              <td className="c-num" dir="ltr">{it.discount ? formatMoney(it.discount) : '—'}</td>
              <td className="c-num c-strong" dir="ltr">{formatMoney(it.totalPrice)}</td>
            </tr>
          ))}
          {Array.from({ length: padRows }).map((_, i) => (
            <tr key={`pad-${i}`} className="doc-pad-row">
              <td className="c-center">{toPersianNum(itemCount + i + 1)}</td>
              <td /><td /><td /><td /><td /><td />
            </tr>
          ))}
        </tbody>
      </table>

      {/* ── three-box strip: notes/terms / summary / bank account.
              The final «مبلغ قابل پرداخت» row is SOLID TEAL (reference
              format) with white text. v2.49.0 — «به حروف» moved OUT of the
              notes box into its own distinct strip below (task §15). ── */}
      <section className="doc-bottom">
        <div className="doc-box doc-box-notes">
          <span className="doc-tab">توضیحات / شرایط</span>
          {doc.description ? <p className="doc-note-line">توضیحات سند: {doc.description}</p> : null}
          <ul className="doc-terms-list">
            {/* v2.48.0 — terms lines come from the shared resolver: the
                company-level proformaNote (registered once in company
                settings) REPLACES the built-in defaults; null keeps the
                exact pre-v2.48.0 wording (zero legacy regression). */}
            {proformaTermsLines(doc.companyProfile?.proformaNote, {
              official,
              documentType: doc.documentType,
            }).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="doc-box doc-box-sum">
          <span className="doc-tab">خلاصه صورتحساب</span>
          <div className="doc-sum-row"><span>جمع مبلغ</span><span dir="ltr">{formatMoney(doc.totalAmount)}</span></div>
          <div className="doc-sum-row"><span>تخفیف</span><span dir="ltr">{formatMoney(doc.discountAmount)}</span></div>
          {doc.taxAmount > 0 ? (
            <div className="doc-sum-row"><span>ارزش افزوده</span><span dir="ltr">{formatMoney(doc.taxAmount)}</span></div>
          ) : (
            <div className="doc-sum-row doc-sum-novat"><span>ارزش افزوده (٪۰)</span><span dir="ltr">۰</span></div>
          )}
          {payments.length > 0 ? (
            <>
              <div className="doc-sum-row"><span>جمع پرداختی</span><span dir="ltr">{formatMoney(paidAmount)}</span></div>
              <div className="doc-sum-row"><span>ماندهٔ قابل پرداخت</span><span dir="ltr">{formatMoney(remaining)}</span></div>
            </>
          ) : null}
          <div className="doc-sum-row doc-sum-final"><span>مبلغ قابل پرداخت</span><span dir="ltr">{formatMoney(doc.finalAmount)}</span></div>
        </div>
        <div className="doc-box doc-box-bank">
          <span className="doc-tab">اطلاعات حساب</span>
          <div className="doc-pay-row"><span>نام بانک</span><span className="doc-pay-val">{sellerProfile.bankName || '..................'}</span></div>
          <div className="doc-pay-row"><span>نام دارنده</span><span className="doc-pay-val">{sellerProfile.bankAccountHolder || identity.orgName}</span></div>
          <div className="doc-pay-row"><span>شماره حساب</span><span className="doc-pay-val" dir="ltr">{sellerProfile.bankAccountNumber ? toPersianNum(sellerProfile.bankAccountNumber) : '..................'}</span></div>
          <div className="doc-pay-row"><span>شماره شبا</span><span className="doc-pay-val" dir="ltr">{sellerProfile.bankSheba || '..................'}</span></div>
          {payments.length > 0 ? (
            <>
              <div className="doc-pay-sep" />
              {payments.map((p, i) => (
                <div className="doc-pay-row" key={i}>
                  <span>{paymentMethodLabel(p.method)}{p.date ? ` · ${jDateShort(p.date)}` : ''}</span>
                  <span dir="ltr">{formatMoney(p.amount)}</span>
                </div>
              ))}
            </>
          ) : (
            <div className="doc-pay-empty">
              {doc.documentType === 'proforma'
                ? 'پرداخت پس از تأیید پیش‌فاکتور و صدور فاکتور رسمی ثبت می‌شود.'
                : 'پرداختی ثبت نشده است — تسویه بر اساس توافق طرفین.'}
            </div>
          )}
        </div>
      </section>

      {/* ── v2.49.0 (task §15) — مبلغ قابل پرداخت به حروف: نوار مستقل و
              گرافیکی متمایز از توضیحات عادی (پس‌زمینهٔ فیروزه‌ای روشن +
              لبهٔ برجستهٔ Teal). مقدار همان numberToPersianWords موجود است. ── */}
      <div className="doc-words-strip">
        <span className="doc-words-label">مبلغ قابل پرداخت به حروف:</span>
        <span className="doc-words-value">{doc.finalAmount > 0 ? `${numberToPersianWords(doc.finalAmount)} ریال` : '—'}</span>
      </div>

      {/* ── official VAT breakdown table (ماده 169) ── */}
      {official && doc.taxAmount > 0 && (
        <table className="doc-table doc-vat-table">
          <thead>
            <tr>
              <th>ردیف</th>
              <th>نوع کالا / خدمت</th>
              <th>مبلغ بدون مالیات (ریال)</th>
              <th>نرخ مالیات</th>
              <th>مبلغ مالیات (ریال)</th>
              <th>مبلغ با مالیات (ریال)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="c-center">{toPersianNum(1)}</td>
              <td className="c-rtl">فروش کالا و خدمات موضوع این صورتحساب</td>
              <td className="c-num" dir="ltr">{formatMoney(doc.totalAmount - doc.discountAmount)}</td>
              <td className="c-center">٪{doc.totalAmount > 0 ? toPersianNum(Math.round((doc.taxAmount / (doc.totalAmount - doc.discountAmount || 1)) * 100)) : '۰'}</td>
              <td className="c-num" dir="ltr">{formatMoney(doc.taxAmount)}</td>
              <td className="c-num c-strong" dir="ltr">{formatMoney(doc.finalAmount)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {/* ── official serial strip ── */}
      {official && (
        <div className="doc-official-footer">
          <div className="doc-serial">
            <span>شماره سریال صورتحساب:</span>
            <span dir="ltr" className="doc-serial-no">{doc.documentNumber}</span>
          </div>
          <div className="doc-serial">
            <span>تاریخ و شماره ثبت / شناسهٔ ملی فروشنده:</span>
            <span>{company.economicCode || '..................'}</span>
          </div>
        </div>
      )}

      {/* ── signatures: seller right / buyer left — subtle bordered boxes
              with generous stamp space + dashed signature baseline (§17) ── */}
      <footer className="doc-sign">
        <div className="doc-sign-cell">
          <span className="doc-sign-label">
            مهر و امضای فروشنده{official ? ' (الزامی)' : ''}
          </span>
          <span className="doc-sign-line" aria-hidden="true" />
        </div>
        <div className="doc-sign-cell">
          <span className="doc-sign-label">
            مهر و امضای خریدار{official ? ' (الزامی)' : ''}
          </span>
          <span className="doc-sign-line" aria-hidden="true" />
        </div>
      </footer>

      {/* ── v2.52.0 — the Lian signature gradient divider: a slim
              indigo→teal gradient bar between the signature boxes and the
              footer band (pixel-mapped from the round-77 reference).
              'bgl' has divider:null → renders nothing (exact v2.49.0). ── */}
      {tpl.divider ? (
        <div
          className="doc-divider-bar"
          style={{
            background: `linear-gradient(to right, ${tpl.divider.from}, ${tpl.divider.to})`,
          }}
          aria-hidden="true"
        />
      ) : null}

      {/* ── teal footer band: sender contact block with reference icons
              (v2.42.0 address selection kept) + wave from the template palette.
              v2.54.0 — gradient templates (Arya) paint the band with a
              VERTICAL top→bottom sweep instead of the solid var(--banner);
              the website falls back: company profile → global setting.
              v2.55.0 — yasteb: the band runs the gradient HORIZONTALLY
              (to left: light right edge → navy left), the amber ribbon
              sweeps across it below the contact line, and the English
              tagline prints at the right end over the light zone. ── */}
      <footer
        className={`doc-footer-band${tpl.footerRibbon ? ' doc-footer-band-ribbon' : ''}`}
        style={tpl.footerGradient ? {
          background: tpl.footerGradient.horizontal
            ? `linear-gradient(to left, ${tpl.footerGradient.from}${tpl.footerGradient.mid ? `, ${tpl.footerGradient.mid}` : ''}, ${tpl.footerGradient.to})`
            : `linear-gradient(180deg, ${tpl.footerGradient.from}, ${tpl.footerGradient.to})`,
        } : undefined}
      >
        {/* v2.55.0 — the Yas-Tab amber signature ribbon: a slim diagonal
                band sweeping from the band's top (~47% across) down to its
                bottom-right (~74%), tapering — pixel-mapped from the
                reference's gold streak. Behind the contact text (z0). */}
        {tpl.footerRibbon ? (
          <svg className="doc-footer-ribbon" viewBox="0 0 1000 70" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id={ribbonId} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor={tpl.footerRibbon.from} />
                <stop offset="1" stopColor={tpl.footerRibbon.to} />
              </linearGradient>
            </defs>
            <path
              d="M470,0 C600,4 690,28 740,58 L740,66 C690,38 610,18 470,12 Z"
              fill={`url(#${ribbonId})`}
            />
          </svg>
        ) : null}
        <div className="doc-footer-contact">
          <span className="doc-footer-item">
            <MapPin size={11} strokeWidth={2.2} aria-hidden="true" />
            <span>{senderAddressLines[0]?.value || legacyAddress || company.address || '—'}</span>
          </span>
          <span className="doc-footer-sep">·</span>
          <span className="doc-footer-item" dir="ltr">
            <Phone size={11} strokeWidth={2.2} aria-hidden="true" />
            <span>{sellerPhone ? toPersianNum(sellerPhone) : '—'}</span>
          </span>
          {(sellerWebsite || company.website) ? (
            <>
              <span className="doc-footer-sep">·</span>
              <span className="doc-footer-item" dir="ltr">
                <Globe size={11} strokeWidth={2.2} aria-hidden="true" />
                <span>{sellerWebsite || company.website}</span>
              </span>
            </>
          ) : null}
        </div>
        {/* v2.55.0 — the Yas-Tab footer tagline: small English brand line
                at the band's right end (navy ink over the light zone —
                the reference's «Medical Products · For A Healthier Life»). */}
        {tpl.footerSlogan ? (
          <div className="doc-footer-slogan" dir="ltr" aria-hidden="true">
            {tpl.footerSlogan.fa ? (
              <span className="doc-footer-slogan-fa">{tpl.footerSlogan.fa}</span>
            ) : null}
            <span className="doc-footer-slogan-en">{tpl.footerSlogan.en}</span>
          </div>
        ) : null}
        {/* v2.49.0 — wave riding the band's bottom edge: thick at the
            left, tapering right — mirrors the header wave (reference).
            v2.52.0 — fill from the template wave color.
            v2.55.0 — yasteb overrides the footer wave color (deep navy
            #002158) without touching the banner's cyan streak. */}
        <svg className="doc-footer-wave" viewBox="0 0 1000 130" preserveAspectRatio="none" aria-hidden="true">
          <path
            d="M0,130 L0,30 C210,36 420,52 640,62 C820,70 930,78 1000,84 L1000,130 Z"
            fill={tpl.footerWave || tpl.palette.wave}
          />
        </svg>
      </footer>
    </div>
  );
}


/** v2.31.9 — numberToPersianWords moved to sales-docs-shared.ts (the
 *  proforma form's live «مبلغ به حروف» preview shares the implementation). */



const PRINT_CSS = `
@media screen {
  /* v2.40.0 — min-height:100vh dropped: the root is now the dialog's
     flex-1 scroll area, so its height comes from the full-screen dialog. */
  .doc-print-root { padding: 24px; background: #e5e7eb; }
  .doc-print-master { display: none; }
  .doc-sheet {
    width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff;
    padding: 0; box-shadow: 0 6px 24px rgba(0,0,0,.14);
    font-family: 'Vazirmatn', Tahoma, sans-serif; color: #1f2937;
    display: flex; flex-direction: column; font-size: 11.5px; line-height: 1.7;
    direction: rtl; position: relative; overflow: hidden; border-radius: 6px;
  }
  .doc-sheet-pad { padding: 0 12mm; }
  /* v2.40.0 — zoom stage: sized to scale×natural so the scroll container
     tracks the VISUAL page size. overflow:hidden clips only the inner's
     unscaled LAYOUT overflow; flex centering keeps the sheet optically
     centered for any scale. */
  .doc-zoom-stage {
    display: flex; justify-content: center; align-items: flex-start;
    overflow: hidden; margin: 0 auto;
  }
  .doc-zoom-inner { width: max-content; flex: none; transform-origin: top center; }
}
@media print {
  @page { size: A4 portrait; margin: 0; }
  html, body { background: #fff !important; }
  .no-print { display: none !important; }
  body > *:not(.doc-print-master) { display: none !important; }
  .doc-print-master { display: block !important; }
  .doc-sheet {
    position: static; margin: 0; box-shadow: none; border-radius: 0;
    width: 210mm; min-height: 296mm; padding: 0;
    /* v2.49.0 — flex in PRINT too: margin-top:auto on the footer band
       pins it to the sheet bottom (the page edge) like the reference */
    display: flex; flex-direction: column;
    page-break-after: avoid; break-inside: avoid; overflow: visible;
  }
  .doc-sheet-pad { padding: 0 11mm; }
}

/* ── shared sheet styles (v2.49.0 — BGL reference palette: Emerald/Teal
    + Deep Navy on white; #00897B banner, #00796B ink, #1A2340 waves) ── */
.doc-sheet {
  color: #1f2937;
  --brand: ${ACTION_TEAL};   /* tabs, table header, final row */
  --banner: ${BRAND_TEAL};   /* banner + footer band          */
  --dark:  ${DEEP_NAVY};     /* header/footer waves           */
  --line:  #c9d6d4;          /* light teal-gray borders       */
  --soft:  #f2f7f6;          /* soft fills                    */
  /* v2.54.0 — tints for the two remaining hardcoded brand areas. The
     defaults are the EXACT pre-v2.54.0 constants, so bgl/lian sheets
     (which never override them) render byte-identically; the Arya
     template overrides both through the inline template style. */
  --meta-soft: #eef6f4;      /* meta box label fill           */
  --strip-line: #d5e8e3;     /* words-strip hairline border   */
}

/* ── brand banner ── */
.doc-banner { position: relative; background: var(--banner); color: #fff; }
.doc-banner-inner {
  display: flex; align-items: center; gap: 12px;
  padding: 4.5mm 12mm 9.5mm; position: relative; z-index: 1;
}
.doc-banner-logo {
  background: #fff; border-radius: 10px; padding: 6px 10px;
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0,0,0,.18);
}
/* v2.53.0 — the all-white lockup sits directly on the banner (reference
   composition): no plate, no padding, no shadow — and bigger, because the
   white marks carry the whole brand block (measured from the round-78
   reference: ≈37mm × 21.7mm ≈ 17.6% of the A4 width). */
.doc-banner-logo.doc-banner-logo-white { background: transparent; padding: 0; box-shadow: none; border-radius: 0; }
.doc-banner-logo-white .doc-banner-logo-img { width: 34mm; max-height: 20.5mm; }
.doc-banner-logo-img { width: 27mm; height: auto; max-height: 14mm; object-fit: contain; display: block; }
.doc-banner-org { flex: 1; text-align: right; min-width: 0; }
.doc-banner-name { font-size: 16.5px; font-weight: 800; margin: 0; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,.22); }
.doc-banner-tagline { font-size: 10px; font-weight: 600; color: rgba(255,255,255,.88); margin: 2px 0 0; }
/* v2.55.0 — templates with a LIGHT logo zone (yasteb's white sweep)
   print the Persian org name/tagline in dark ink instead of white
   (white would vanish over the light zone). Attribute-scoped: never
   fires for bgl/lian/aria (zero regression). */
.doc-sheet[data-name-dark='1'] .doc-banner-name { color: var(--banner-name-ink); text-shadow: none; }
.doc-sheet[data-name-dark='1'] .doc-banner-tagline { color: var(--banner-name-ink); opacity: .82; }
/* v2.54.0 — brand slogan at the banner's LEFT edge (Arya reference:
   white Persian line + smaller English line over the blue sweep).
   RTL flex-row places this last child at the left; it sits in the
   banner's short-left zone above the wave, so it never collides with
   the right-side logo/name block. Rendered ONLY for templates that
   define a slogan (bgl/lian print nothing — zero regression). */
.doc-banner-slogan { flex-shrink: 0; text-align: center; padding-left: 2mm; z-index: 1; }
.doc-banner-slogan-fa {
  font-size: 12px; font-weight: 800; color: #fff; margin: 0;
  text-shadow: 0 1px 2px rgba(0,0,0,.28); line-height: 1.6;
}
.doc-banner-slogan-en {
  font-size: 7.6px; font-weight: 600; color: rgba(255,255,255,.92); margin: 1px 0 0;
  letter-spacing: .4px; text-shadow: 0 1px 1px rgba(0,0,0,.25); line-height: 1.5;
  white-space: nowrap;
}
.doc-banner-wave { display: block; width: 100%; height: 9.5mm; margin-top: 1.5mm; }

/* ── meta row: title block right / meta box LEFT (user round 56) ── */
.doc-meta-row {
  display: flex; align-items: center; gap: 10px;
  padding: 3mm 12mm 0;
}
.doc-title-block { flex: 1; text-align: right; min-width: 0; }
.doc-main-title { font-size: 19px; font-weight: 800; margin: 0; color: #111827; }
.doc-main-sub { font-size: 9.5px; color: #4b5563; margin: 2px 0 0; }
.doc-status-chip {
  display: inline-block; margin-top: 3px; background: var(--brand); color: #fff;
  font-size: 8.5px; font-weight: 700; padding: 1px 10px; border-radius: 999px;
}
.doc-meta-box {
  border-collapse: collapse; flex-shrink: 0; background: #fff;
  border: 1.2px solid var(--brand); border-radius: 8px; overflow: hidden;
}
.doc-meta-box td { border: 0.6px solid var(--brand); padding: 3px 10px; font-size: 10px; }
.doc-meta-label { background: var(--meta-soft); color: var(--brand); font-weight: 700; white-space: nowrap; }
.doc-meta-value { font-weight: 700; color: #111827; min-width: 30mm; text-align: left; }

/* ── teal-tabbed party boxes (seller/buyer) ── */
.doc-party { position: relative; margin: 4mm 12mm 0; }
.doc-tab {
  position: absolute; top: -8px; right: 10px; z-index: 1;
  background: var(--brand); color: #fff; font-size: 9px; font-weight: 700;
  padding: 1.5px 11px; border-radius: 4px; line-height: 1.55;
}
.doc-party {
  border: 1px solid var(--brand); border-radius: 8px;
  padding: 10px 10px 6px; background: #fff;
}
.doc-party-grid { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 1px 10px; }
.doc-field { font-size: 9.5px; color: #374151; margin: 1px 0; }
.doc-field-label { color: var(--brand); font-weight: 700; }
.doc-field-value { color: #111827; font-weight: 600; }
.doc-field-strong .doc-field-value { font-weight: 800; font-size: 10.5px; }
/* v2.49.0 (task §9) — دو ردیف نشانی مستقل با Label جدا و تفکیک بصری:
   نشانی دفتر مرکزی و دقیقاً در ردیف پایین نشانی کارخانه */
.doc-party-addresses { margin-top: 3px; border-top: 1px solid var(--line); }
.doc-addr-row { display: flex; align-items: flex-start; gap: 8px; padding: 2.5px 0; }
.doc-addr-row + .doc-addr-row { border-top: 1px dashed var(--line); }
.doc-addr-label { color: var(--brand); font-weight: 700; font-size: 9.5px; white-space: nowrap; min-width: 23mm; flex-shrink: 0; }
.doc-addr-value { color: #111827; font-weight: 500; font-size: 9.5px; line-height: 1.85; }

/* ── items table: solid teal header (centered), white rows with subtle
    separators — v2.49.0 (task §12: zebra dropped, rows stay white) ── */
.doc-table { width: 186mm; margin: 4mm 12mm 0; border-collapse: collapse; font-size: 10px; }
.doc-table thead th {
  background: var(--brand); color: #fff; font-weight: 700; padding: 6px 5px;
  border: 1px solid var(--brand); font-size: 9.5px; text-align: center;
}
.doc-table tbody td { border: 1px solid var(--line); padding: 4.5px 5px; vertical-align: middle; background: #fff; }
/* v2.55.0 — the Yas-Tab reference's AliceBlue zebra rows. Only even
   rows tint; attribute-scoped so bgl/lian/aria keep all-white rows
   (the exact v2.49.0 table). print-color-adjust inherits from
   .doc-sheet (exact) so the tint survives printing. */
.doc-sheet[data-zebra='1'] .doc-table tbody tr:nth-child(even) td { background: var(--zebra); }
.doc-pad-row td { height: 13px; }
.w-rownum { width: 8mm; text-align: center; }
.w-desc { text-align: right; }
.w-qty { width: 11mm; text-align: center; }
.w-unit { width: 12mm; text-align: center; }
.w-price { width: 24mm; text-align: left; }
.c-center { text-align: center; }
.c-rtl { text-align: right; }
.c-num { text-align: left; font-variant-numeric: tabular-nums; white-space: nowrap; }
.c-strong { font-weight: 700; }
.doc-item-name { font-weight: 600; }
.doc-item-note { color: #6b7280; font-size: 8.5px; }
.doc-item-code { color: #6b7280; font-size: 8.5px; margin-right: 4px; }

/* ── three-box bottom strip (teal tabs) ── */
.doc-bottom { display: flex; gap: 10px; margin: 4mm 12mm 0; align-items: stretch; }
.doc-box { position: relative; border: 1px solid var(--line); border-radius: 8px; padding: 12px 9px 7px; background: #fff; }
.doc-box-notes { flex: 1.35; }
.doc-box-sum { flex: 1.1; border-color: var(--brand); border-width: 1.2px; padding: 12px 0 0; overflow: hidden; }
.doc-box-bank { flex: 1.15; }
.doc-pay-row { display: flex; justify-content: space-between; gap: 6px; font-size: 9px; color: #374151; padding: 2px 0; }
.doc-pay-row > span:first-child { color: #6b7280; flex-shrink: 0; }
.doc-pay-val { font-weight: 600; }
.doc-pay-sep { border-top: 1px dashed #d4d4d8; margin: 4px 0; }
.doc-pay-empty { font-size: 8.8px; color: #6b7280; line-height: 1.8; margin-top: 3px; }
.doc-sum-row { display: flex; justify-content: space-between; padding: 3.5px 10px; font-size: 10px; border-bottom: 1px solid #e5e7eb; }
.doc-sum-final { background: var(--brand); color: #fff; font-weight: 800; font-size: 11px; border-bottom: none; }
.doc-sum-novat { color: #6b7280; font-style: italic; font-size: 9px; }
/* v2.49.0 (task §15) — نوار «مبلغ قابل پرداخت به حروف»: مستقل و متمایز */
.doc-words-strip {
  margin: 3.5mm 12mm 0; display: flex; align-items: flex-start; gap: 8px;
  background: var(--soft); border: 1px solid var(--strip-line); border-right: 3px solid var(--brand);
  border-radius: 6px; padding: 4px 10px;
}
.doc-words-label { color: var(--brand); font-weight: 700; font-size: 10px; white-space: nowrap; flex-shrink: 0; }
.doc-words-value { color: #111827; font-weight: 700; font-size: 10.5px; line-height: 1.8; }
.doc-note-line { font-size: 8.8px; color: #4b5563; margin: 2px 0 0; }
.doc-terms-list { margin: 3px 0 0; padding-right: 14px; font-size: 8.5px; color: #4b5563; line-height: 1.8; }

/* ── signatures: subtle bordered boxes + dashed signature baseline (§17) ── */
.doc-sign { display: flex; gap: 10px; margin: 4.5mm 12mm 0; }
.doc-sign-cell {
  flex: 1; border: 1px solid var(--line); border-radius: 8px;
  min-height: 17.5mm; position: relative; background: #fff;
  display: flex; flex-direction: column; align-items: center; padding-top: 4px;
}
.doc-sign-label { font-size: 9px; font-weight: 700; color: var(--brand); }
.doc-sign-line { position: absolute; bottom: 3.5mm; right: 9mm; left: 9mm; border-top: 1px dashed var(--line); }

/* ── v2.52.0 — Lian gradient divider (between signatures and the footer
    band): slim 3.5mm rounded bar, colors inline from the template
    (bgl renders no divider at all — JSX guard on tpl.divider). ── */
.doc-divider-bar {
  height: 3.5mm; margin: 4mm 12mm 0; border-radius: 999px;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}

/* ── teal footer band with the deep-navy wave + contact icons ── */
.doc-footer-band {
  position: relative; margin-top: auto; background: var(--banner); color: #fff;
  min-height: 14mm; padding: 3.5mm 12mm 8.5mm;
}
/* v2.55.0 — a ribbon template (yasteb) renders the reference's TALLER
   footer proportion: the contact line rides high, the amber ribbon
   sweeps below it, the wave stays pinned to the bottom edge. */
.doc-footer-band.doc-footer-band-ribbon { min-height: 19mm; padding: 3mm 12mm 4.5mm; }
.doc-footer-ribbon {
  position: absolute; inset: 0; width: 100%; height: 100%;
  z-index: 0; pointer-events: none; display: block;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
/* v2.55.0 — the Yas-Tab footer tagline at the band's right end (navy
   ink over the light zone — mirrors the reference composition). */
.doc-footer-slogan {
  position: absolute; right: 12mm; bottom: 1.2mm; z-index: 1;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0;
  pointer-events: none;
}
.doc-footer-slogan-fa { font-size: 7.2px; font-weight: 700; color: var(--brand); line-height: 1.5; }
.doc-footer-slogan-en {
  font-size: 6.8px; font-weight: 700; color: var(--brand); opacity: .92;
  letter-spacing: .3px; white-space: nowrap; line-height: 1.5;
}
.doc-footer-contact {
  position: relative; z-index: 1; display: flex; align-items: center; justify-content: center;
  gap: 12px; font-size: 9px; flex-wrap: wrap;
}
.doc-footer-item { font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
.doc-footer-item svg { flex-shrink: 0; opacity: .92; }
.doc-footer-sep { opacity: .55; }
.doc-footer-wave { position: absolute; bottom: 0; left: 0; width: 100%; height: 8.5mm; }

.doc-official-strip {
  border: 1px solid var(--brand); border-radius: 6px; background: var(--soft);
  color: #374151; font-size: 8.6px; font-weight: 600; text-align: center;
  padding: 4px 8px; margin: 4mm 12mm 0; line-height: 1.7;
}
.doc-vat-table { margin: 4mm 12mm 0; font-size: 9px; }
.doc-official-footer { display: flex; gap: 8px; margin: 4mm 12mm 0; }
.doc-serial {
  flex: 1; border: 1px solid #9ca3af; border-radius: 6px; padding: 4px 8px;
  font-size: 8.6px; color: #374151; display: flex; justify-content: space-between; align-items: center;
}
.doc-serial-no { font-weight: 800; letter-spacing: 1px; }

@media print {
  .doc-banner, .doc-banner-wave path, .doc-banner-slogan,
  .doc-tab, .doc-sum-final,
  .doc-footer-band, .doc-footer-wave path, .doc-footer-ribbon path,
  .doc-words-strip, .doc-meta-label, .doc-status-chip, .doc-official-strip,
  .doc-table thead th, .doc-sheet[data-zebra='1'] .doc-table tbody td {
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc-sheet { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`
let cssInjected = false;
function InjectPrintCss() {
  useEffect(() => {
    if (cssInjected) return;
    const style = document.createElement('style');
    style.id = 'doc-print-css';
    style.textContent = PRINT_CSS;
    document.head.appendChild(style);
    cssInjected = true;
    return () => { /* keep injected across dialogs */ };
  }, []);
  return null;
}

// ── dialog wrapper ─────────────────────────────────────────
// v2.40.0 — FULL-SCREEN viewer. Root cause of the «صفحهٔ باریک» report:
// the DialogContent base shipped `sm:max-w-lg`, which (a) tailwind-merge
// never removes next to an unscoped custom max-w and (b) is emitted later
// in the CSS sheet — so this dialog rendered 512px wide on every desktop
// while the A4 sheet inside is 794px. The base default is gone (see
// ui/dialog.tsx) and this dialog now spans the viewport (minus a 1rem
// inset), with the preview sheet auto-scaled so the WHOLE page is visible
// («تمام صفحه») plus manual zoom controls. Print output is unchanged —
// the body-level print master renders the sheet at natural size.
export default function DocumentPrintDialog({ open, onOpenChange, doc }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: PrintDocData | null;
}) {
  const [mode, setMode] = useState<InvoiceMode>('unofficial');
  const [company, setCompany] = useState<CompanyInfo>({
    name: 'سامانه فروش',
    companyName: 'هلدینگ بهبود گستر',
    website: '', address: '', phone: '', economicCode: '',
  });
  // v2.40.0 — viewer zoom state + live measurements
  const [zoom, setZoom] = useState<ZoomState>(ZOOM_FIT);
  // natural sheet size in CSS px; A4 default so the very first frame is
  // already close (the real measurement lands one commit later)
  const [sheetSize, setSheetSize] = useState({ w: 794, h: 1123 });
  const [viewSize, setViewSize] = useState({ w: 0, h: 0 });
  const sheetRoRef = useRef<ResizeObserver | null>(null);
  const viewRoRef = useRef<ResizeObserver | null>(null);

  // v2.40.0 — measurement via CALLBACK REFS, not [open]-dep effects: the
  // Radix portal mounts the dialog DOM on its own schedule, so an effect
  // keyed on `open` can run before the elements exist (empirically: the
  // observer never attached and fit stayed clamped at ZOOM_MIN). A callback
  // ref fires exactly when React binds/unbinds the node — portal-proof.
  const bindSheetEl = useCallback((el: HTMLDivElement | null) => {
    sheetRoRef.current?.disconnect();
    sheetRoRef.current = null;
    if (!el) return;
    // offsetWidth/offsetHeight and the ResizeObserver contentRect are
    // LAYOUT values — the scale() transform never feeds back into them,
    // so there is no observe loop.
    const measure = () => setSheetSize({ w: el.offsetWidth, h: el.offsetHeight });
    queueMicrotask(measure);
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    sheetRoRef.current = ro;
  }, []);

  const bindScrollEl = useCallback((el: HTMLDivElement | null) => {
    viewRoRef.current?.disconnect();
    viewRoRef.current = null;
    if (!el) return;
    const upd = () => setViewSize({ w: el.clientWidth, h: el.clientHeight });
    queueMicrotask(upd);
    const ro = new ResizeObserver(() => upd());
    ro.observe(el);
    viewRoRef.current = ro;
  }, []);

  useEffect(() => {
    if (!open) return;
    (async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get' }),
        });
        const data = await res.json();
        if (res.ok && data.settings) {
          setCompany({
            name: data.settings['app.name'] || 'سامانه فروش',
            companyName: data.settings['app.company'] || 'هلدینگ بهبود گستر',
            website: data.settings['app.website'] || '',
            address: data.settings['app.address'] || '',
            phone: data.settings['app.phone'] || '',
            economicCode: data.settings['app.economic_code'] || '',
          });
        }
      } catch { /* defaults */ }
    })();
  }, [open]);

  // Every freshly opened document starts fitted to the page.
  useEffect(() => {
    if (open) queueMicrotask(() => setZoom(ZOOM_FIT));
  }, [open, doc?.documentNumber]);

  if (!doc) return null;

  // 48px = the .doc-print-root padding (24px each side) kept as breathing
  // room around the fitted sheet.
  const fitScale = computeFitScale({ w: viewSize.w - 48, h: viewSize.h - 48 }, sheetSize);
  const scale = zoom === ZOOM_FIT ? fitScale : zoom;
  const manualBase = zoom === ZOOM_FIT ? fitScale : zoom;
  const edges = zoomAtEdge(manualBase);
  const bumpZoom = (dir: 1 | -1) => setZoom(stepZoom(manualBase, dir));
  const zoomLabel = zoom === ZOOM_FIT ? 'تمام صفحه' : `٪${toPersianNum(Math.round(zoom * 100))}`;

  return (
    <>
      <InjectPrintCss />
      {/* v2.31.9 — PRINT MASTER: the sheet rendered via a portal DIRECTLY
          under <body>, outside the Radix dialog tree. The previous
          visibility-trick + position:absolute-inside-the-dialog combination
          produced a BLANK page in real print output (the dialog's fixed +
          translated chrome trapped the sheet off the page box — verified
          empirically with Chromium's print-media PDF). The master is hidden
          on screen (@media screen .doc-print-master { display:none }) and
          isolated on print via display-based rules; the dialog keeps its
          own non-printing preview copy below. It stays UNSCALED — the zoom
          below only affects the on-screen preview, never the print output. */}
      {createPortal(
        <div className="doc-print-master">
          <DocumentSheet doc={doc} company={company} mode={mode} />
        </div>,
        document.body,
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0"
          dir="rtl"
        >
          <div className="no-print flex items-center justify-between px-4 py-2.5 bg-white border-b border-gray-100 flex-wrap gap-2">
            <DialogTitle className="text-sm font-bold text-gray-800">
              پیش‌نمایش چاپ — {TYPE_TITLES[doc.documentType] || 'سند'} {doc.documentNumber}
            </DialogTitle>
            <div className="flex items-center gap-2 flex-wrap">
              {/* official / unofficial mode switch */}
              <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
                <button
                  onClick={() => setMode('unofficial')}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition-all ${mode === 'unofficial' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
                  title="فاکتور داخلی — بدون الزامات مالیاتی"
                >
                  غیررسمی
                </button>
                <button
                  onClick={() => setMode('official')}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-bold transition-all ${mode === 'official' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
                  title="صورتحساب رسمی مطابق مادهٔ ۱۶۹ — با شماره سریال، جدول مالیات و امضای الزامی"
                >
                  رسمی (ماده ۱۶۹)
                </button>
              </div>
              {/* v2.40.0 — zoom controls (preview only; print unaffected) */}
              <div className="flex items-center rounded-lg border border-gray-200 bg-gray-50" role="group" aria-label="بزرگ‌نمایی پیش‌نمایش">
                <button
                  onClick={() => bumpZoom(-1)}
                  disabled={edges.min}
                  className="h-8 w-8 flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="کوچک‌نمایی"
                  aria-label="کوچک‌نمایی"
                >
                  <ZoomOut size={13} />
                </button>
                <span className="min-w-[62px] text-center text-[11px] font-bold text-gray-700 select-none" dir="rtl">
                  {zoomLabel}
                </span>
                <button
                  onClick={() => bumpZoom(1)}
                  disabled={edges.max}
                  className="h-8 w-8 flex items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="بزرگ‌نمایی"
                  aria-label="بزرگ‌نمایی"
                >
                  <ZoomIn size={13} />
                </button>
                <button
                  onClick={() => setZoom(ZOOM_FIT)}
                  className={`h-8 w-8 flex items-center justify-center rounded-md transition-colors ${zoom === ZOOM_FIT ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                  title="نمایش تمام صفحهٔ سند (متناسب با صفحه)"
                  aria-label="نمایش تمام صفحهٔ سند"
                >
                  <Maximize2 size={13} />
                </button>
              </div>
              <button onClick={() => window.print()}
                className="h-8 px-3 rounded-lg bg-gray-900 hover:bg-gray-800 text-white text-xs font-bold flex items-center gap-1.5 transition-colors">
                <Printer size={13} /> چاپ / ذخیرهٔ PDF
              </button>
              <button onClick={() => onOpenChange(false)}
                className="h-8 px-3 rounded-lg border border-gray-200 text-gray-600 text-xs font-medium flex items-center gap-1.5 hover:bg-gray-50 transition-colors">
                <X size={13} /> بستن
              </button>
            </div>
          </div>
          {/* v2.40.0 — full-height scroll area; the sheet sits on a
              transform-scaled stage sized to scale×natural, so scrollbars
              track the VISUAL size, not the unscaled layout box. Only the
              stage lives here — the hint moved to a fixed footer below so
              a fitted page never needs a scrollbar. */}
          <div ref={bindScrollEl} className="doc-print-root no-print min-h-0 flex-1 overflow-auto bg-gray-200">
            <div
              className="doc-zoom-stage"
              style={{ width: sheetSize.w * scale, height: sheetSize.h * scale }}
            >
              <div
                ref={bindSheetEl}
                className="doc-zoom-inner"
                style={{ transform: `scale(${scale})` }}
              >
                {/* preview copy — display:none on print (the body-level
                    .doc-print-master above is the print source) */}
                <DocumentSheet doc={doc} company={company} mode={mode} />
              </div>
            </div>
          </div>
          <p className="no-print flex items-center justify-center gap-1.5 flex-wrap border-t border-gray-100 bg-white px-4 py-2 text-center text-[11px] text-gray-500">
            <Download size={12} /> برای PDF، در پنجرهٔ چاپ مقصد «Save as PDF» را انتخاب کنید — خروجی تک‌صفحهٔ عمودی A4
            {mode === 'official'
              ? ' · حالت رسمی: شماره سریال + جدول مالیات + امضای الزامی (مادهٔ ۱۶۹)'
              : ' · حالت غیررسمی: سند داخلی بدون الزامات مالیاتی'}
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
