'use client';

// ════════════════════════════════════════════════════════════
// REPORTS CENTER — v2.51.0 (round 76) — «مرکز گزارش حرفه‌ای»
//
// Professional performance report with two views (company sales
// performance + sales-expert performance), real aggregates from
// /api/reports action 'performance-center', attractive pure-SVG/CSS
// charts (RTL-safe, print-safe — no chart library: hidden containers
// cannot be measured and JS charts break print determinism), and a
// branded A4 PDF export (browser print-to-PDF, same vector/selectable
// Persian text approach as the v2.49 proforma).
//
// Contract: src/lib/performance-center.ts (single source, like
// staff-perf.ts — API and UI drift is a compile error).
// ════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Building2, Users, TrendingUp, ShoppingCart, Phone, MapPin, Target,
  RefreshCw, FileDown, Printer, X, Award, BarChart3, PieChart, LineChart,
  Crown, Medal, UserCheck, PhoneCall, Wallet, Percent, Layers, Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  type PerformanceReport, type CompanyPerfRow, type ExpertPerfRow, type TrendPoint,
  type PeriodMonths, PERIOD_MONTHS_OPTIONS, periodLabel, toPersianDigits,
} from '@/lib/performance-center';
import { toJalaliString, formatJalaliFull } from '@/lib/jalali';

// ── BGL brand palette (v2.49.0 proforma reference: Emerald/Teal + Deep Navy) ──
const BRAND_TEAL = '#00897B';
const BRAND_TEAL_DARK = '#00796B';
const BRAND_NAVY = '#1A2340';
const RANK_GOLD = '#D97706';
const RANK_SILVER = '#64748B';
const RANK_BRONZE = '#B45309';

// ==================== FORMATTING ====================
function fa(n: number | string): string {
  return toPersianDigits(n);
}

function withSeparators(n: number): string {
  return toPersianDigits(Math.round(n).toLocaleString('en-US'));
}

/** Compact Rial amount for chart labels (میلیارد/میلیون). */
function compact(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return fa((n / 1_000_000_000).toFixed(1)) + ' م.ریال';
  if (Math.abs(n) >= 1_000_000) return fa(Math.round(n / 1_000_000)) + ' م.ریال';
  if (Math.abs(n) >= 1_000) return fa(Math.round(n / 1_000)) + ' ه.ریال';
  return fa(n);
}

function initialsOf(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] || '') + (parts[1][0] || '');
}

function rankColor(rank: number): string {
  if (rank === 1) return RANK_GOLD;
  if (rank === 2) return RANK_SILVER;
  if (rank === 3) return RANK_BRONZE;
  return '#94a3b8';
}

// ==================== SCREEN CHART: GRADIENT BARS (company sales) ====================
function GradientBars({ companies }: { companies: CompanyPerfRow[] }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  const max = Math.max(...companies.map((c) => c.sales), 1);

  return (
    <div className="flex items-end justify-around gap-3 h-56 px-2" dir="rtl">
      {companies.map((c) => {
        const pct = mounted ? Math.max((c.sales / max) * 100, c.sales > 0 ? 6 : 2) : 0;
        return (
          <div key={c.companyId} className="flex-1 flex flex-col items-center gap-2 group">
            <span className="text-[11px] font-extrabold text-gray-800 tabular-nums">{compact(c.sales)}</span>
            <div
              className="w-full rounded-t-xl relative transition-all duration-700 ease-out"
              style={{
                height: `${pct}%`,
                background: `linear-gradient(180deg, ${c.color}, ${c.color}99)`,
                boxShadow: `0 4px 14px ${c.color}33`,
                minHeight: '6px',
              }}
            >
              <div className="absolute inset-x-0 top-0 h-1.5 rounded-t-xl" style={{ background: c.color }} />
              <div className="absolute -top-9 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-[11px] px-2.5 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none shadow-lg">
                <div className="font-bold">{c.name}</div>
                <div className="tabular-nums">{withSeparators(c.sales)} ریال</div>
                <div>{fa(c.orders)} سفارش · سهم {fa(c.share)}٪</div>
              </div>
            </div>
            <div className="w-full rounded-lg bg-gray-50 border border-gray-100 py-1.5 px-1 text-center">
              <p className="text-[11px] font-bold text-gray-700 truncate" title={c.name}>{c.name}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ==================== SCREEN CHART: 12-MONTH STACKED TREND ====================
function TrendBars({ trend, companies }: { trend: TrendPoint[]; companies: CompanyPerfRow[] }) {
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 80);
    return () => clearTimeout(t);
  }, []);
  const max = Math.max(...trend.map((t) => t.total), 1);
  const gridLines = [0.25, 0.5, 0.75, 1];
  const active = trend[hover ?? -1];

  return (
    <div dir="rtl">
      <div className="relative h-52 px-2">
        {/* y grid */}
        {gridLines.map((g) => (
          <div key={g} className="absolute inset-x-2 flex items-center gap-2 pointer-events-none" style={{ bottom: `${g * 100}%` }}>
            <span className="text-[10px] text-gray-300 tabular-nums w-14 text-left shrink-0">{compact(max * g)}</span>
            <div className="flex-1 border-t border-dashed border-gray-100" />
          </div>
        ))}
        {/* bars */}
        <div className="absolute inset-2 bottom-0 flex items-end justify-around gap-1.5">
          {trend.map((t, i) => (
            <div
              key={i}
              className="flex-1 h-full flex flex-col justify-end items-stretch cursor-pointer"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-full flex flex-col justify-end rounded-t-md overflow-hidden transition-all duration-700 ease-out"
                style={{ height: mounted ? `${Math.max((t.total / max) * 100, t.total > 0 ? 4 : 1.5)}%` : '0%' }}
              >
                {companies.map((c) => {
                  const v = t.byCompany[c.companyId] || 0;
                  if (v <= 0) return null;
                  return (
                    <div
                      key={c.companyId}
                      style={{ height: `${(v / Math.max(t.total, 1)) * 100}%`, background: `linear-gradient(180deg, ${c.color}, ${c.color}CC)` }}
                      title={`${c.name}: ${withSeparators(v)} ریال`}
                    />
                  );
                })}
                {t.total === 0 && <div className="h-full bg-gray-50" />}
              </div>
            </div>
          ))}
        </div>
        {/* hover highlight */}
        {hover !== null && (
          <div className="absolute inset-y-0 rounded-lg border-2 border-teal-500/30 bg-teal-50/40 pointer-events-none"
            style={{ right: `calc(${(hover / trend.length) * 100}% + 8px)`, width: `calc(${100 / trend.length}% - 6px)` }} />
        )}
      </div>
      {/* x labels */}
      <div className="flex justify-around gap-1.5 px-2 mt-1.5" dir="rtl">
        {trend.map((t, i) => (
          <span key={i} className={`flex-1 text-center text-[10px] truncate ${hover === i ? 'text-teal-700 font-extrabold' : 'text-gray-400'}`}>{t.label}</span>
        ))}
      </div>
      {/* legend + hover readout */}
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3 px-2">
        <div className="flex flex-wrap gap-3">
          {companies.map((c) => (
            <div key={c.companyId} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: c.color }} />
              <span className="text-[11px] text-gray-600">{c.name}</span>
            </div>
          ))}
        </div>
        {active && (
          <div className="text-[11px] text-gray-500 bg-gray-50 rounded-lg px-3 py-1.5 border border-gray-100">
            <span className="font-bold text-gray-800">{active.label}</span> — مجموع {compact(active.total)}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== SCREEN CHART: SHARE DONUT (SVG) ====================
function ShareDonut({ companies, centerLabel }: { companies: CompanyPerfRow[]; centerLabel: string }) {
  const total = companies.reduce((s, c) => s + c.sales, 0);
  const R = 15.915; // r for 100% circumference

  // offset = sum of PREVIOUS segments' percentages — computed purely from
  // the data (no mutable accumulator; react-hooks/immutability — the same
  // pattern as the legacy reports DonutChart).
  const segments = companies
    .filter((c) => c.sales > 0)
    .map((c) => ({ ...c, pct: total > 0 ? (c.sales / total) * 100 : 0 }))
    .map((c, i, arr) => ({ ...c, offset: arr.slice(0, i).reduce((s, prev) => s + prev.pct, 0) }));

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-44 h-44">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          <circle cx="18" cy="18" r={R} fill="none" stroke="#f1f5f9" strokeWidth="4.2" />
          {segments.map((s) => (
            <circle
              key={s.companyId}
              cx="18" cy="18" r={R}
              fill="none"
              stroke={s.color}
              strokeWidth="4.2"
              strokeDasharray={`${s.pct} ${100 - s.pct}`}
              strokeDashoffset={`${-s.offset}`}
              className="transition-all duration-700"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="text-[10px] text-gray-400">{centerLabel}</p>
          <p className="text-base font-black text-gray-900 tabular-nums">{compact(total)}</p>
          <p className="text-[10px] text-gray-400">{fa(companies.filter((c) => c.sales > 0).length)} شرکت فعال</p>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1.5 mt-4 max-w-xs">
        {segments.map((s) => (
          <div key={s.companyId} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
            <span className="text-[11px] text-gray-600">{s.name}</span>
            <span className="text-[11px] font-bold text-gray-900 tabular-nums">{fa(Math.round(s.pct))}٪</span>
          </div>
        ))}
        {segments.length === 0 && <p className="text-[11px] text-gray-400">فروش تأییدشده‌ای در این دوره ثبت نشده است</p>}
      </div>
    </div>
  );
}

// ==================== SCREEN CHART: EXPERT RANKING BARS ====================
function ExpertRanking({ experts, metric }: { experts: ExpertPerfRow[]; metric: 'sales' | 'calls' }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 60);
    return () => clearTimeout(t);
  }, []);
  const rows = experts.slice().sort((a, b) => (metric === 'sales' ? b.sales - a.sales : b.calls - a.calls)).slice(0, 10);
  const max = Math.max(...rows.map((r) => (metric === 'sales' ? r.sales : r.calls)), 1);

  if (rows.length === 0) {
    return <p className="text-xs text-gray-400 text-center py-10">کارشناسی در این دوره فعالیت ثبت‌شده ندارد</p>;
  }

  return (
    <div className="space-y-3">
      {rows.map((e, i) => {
        const val = metric === 'sales' ? e.sales : e.calls;
        const pct = mounted ? Math.max((val / max) * 100, val > 0 ? 9 : 3) : 0;
        const rc = rankColor(i + 1);
        return (
          <div key={e.userId} className="flex items-center gap-3 group">
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 font-black text-[13px]"
              style={{
                background: i < 3 ? `${rc}18` : '#f1f5f9',
                color: i < 3 ? rc : '#64748b',
                border: i < 3 ? `1.5px solid ${rc}55` : 'none',
              }}
            >
              {fa(i + 1)}
            </div>
            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white font-bold text-[13px]"
              style={{ background: `linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_NAVY})` }}>
              {initialsOf(e.userName)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <p className="text-xs font-bold text-gray-800 truncate" title={e.userName}>{e.userName}</p>
                <span className="text-[11px] font-black tabular-nums shrink-0" style={{ color: BRAND_TEAL_DARK }}>
                  {metric === 'sales' ? compact(val) : fa(val) + ' تماس'}
                </span>
              </div>
              <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700 ease-out"
                  style={{ width: `${pct}%`, background: i < 3 ? `linear-gradient(90deg, ${rc}, ${rc}AA)` : `linear-gradient(90deg, ${BRAND_TEAL}, ${BRAND_NAVY})` }}
                />
              </div>
              <p className="text-[10px] text-gray-400 mt-0.5 truncate">{e.role}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ══════════════════════════════════════════════════════════
//  PDF EXPORT — branded A4 print sheets
//  Same approach as the v2.49 proforma: browser print-to-PDF
//  (vector, selectable Persian text, Vazirmatn). The sheets are
//  rendered twice: inside the preview dialog (scaled) and in a
//  body-level print master (natural size, print-only).
// ══════════════════════════════════════════════════════════

const REPORT_PRINT_CSS = `
@media screen {
  .rc-print-master { display: none; }
  .rc-preview-stage .rc-sheet { box-shadow: 0 6px 24px rgba(0,0,0,.16); border-radius: 6px; margin-bottom: 18px; }
}
.rc-sheet {
  width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff;
  font-family: 'Vazirmatn', Tahoma, sans-serif; color: #1f2937;
  display: flex; flex-direction: column; direction: rtl;
  font-size: 10.5px; line-height: 1.7; position: relative; overflow: hidden;
}
.rc-sheet-screen { box-shadow: 0 6px 24px rgba(0,0,0,.16); border-radius: 6px; margin-bottom: 18px; }
.rc-band {
  background: linear-gradient(105deg, ${BRAND_TEAL} 0%, ${BRAND_TEAL_DARK} 55%, ${BRAND_NAVY} 100%);
  color: #fff; padding: 7mm 12mm 0; position: relative;
}
.rc-band-title { font-size: 17px; font-weight: 800; margin: 0; }
.rc-band-sub { font-size: 9.5px; opacity: .92; margin-top: 1mm; }
.rc-band-meta {
  display: flex; gap: 4mm; margin-top: 2.5mm; font-size: 8.6px; flex-wrap: wrap;
}
.rc-band-chip {
  background: rgba(255,255,255,.16); border: 1px solid rgba(255,255,255,.35);
  border-radius: 99px; padding: 0.6mm 3mm; display: inline-flex; gap: 1.5mm; align-items: center;
}
.rc-band-wave { display: block; width: 100%; height: 7mm; margin-top: 2.5mm; }
.rc-body { padding: 5mm 12mm 0; flex: 1; }
.rc-sec-title {
  font-size: 12px; font-weight: 800; color: ${BRAND_NAVY};
  display: flex; align-items: center; gap: 2mm; margin: 4mm 0 2.5mm;
}
.rc-sec-title::before {
  content: ''; width: 1.2mm; height: 4.5mm; border-radius: 1mm; background: ${BRAND_TEAL};
}
.rc-kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; }
.rc-kpi {
  border: 1px solid #d7e5e2; border-radius: 2.5mm; padding: 2.8mm 3.5mm;
  background: #f7fbfa; display: flex; align-items: center; gap: 2.5mm;
}
.rc-kpi-icon {
  width: 8mm; height: 8mm; border-radius: 2mm; flex: none;
  display: flex; align-items: center; justify-content: center; color: #fff;
}
.rc-kpi-label { font-size: 8.2px; color: #6b7280; margin: 0; }
.rc-kpi-value { font-size: 13.5px; font-weight: 800; color: ${BRAND_NAVY}; margin: 0; line-height: 1.35; }
.rc-chart-row { display: flex; gap: 5mm; align-items: flex-start; }
.rc-table { width: 100%; border-collapse: collapse; margin-top: 1.5mm; }
.rc-table th {
  background: ${BRAND_TEAL}; color: #fff; font-size: 8.8px; font-weight: 700;
  padding: 1.8mm 2mm; text-align: center; border: 1px solid ${BRAND_TEAL_DARK};
}
.rc-table td {
  border: 1px solid #cfe0dd; padding: 1.6mm 2mm; font-size: 9px; text-align: center;
}
.rc-table tr:nth-child(even) td { background: #f4f9f8; }
.rc-table .num { font-weight: 700; }
.rc-note { font-size: 8px; color: #6b7280; margin-top: 2mm; }
.rc-footer-band {
  margin-top: auto; background: ${BRAND_NAVY}; color: rgba(255,255,255,.92);
  display: flex; justify-content: space-between; align-items: center;
  padding: 2.8mm 12mm; font-size: 8.2px;
}
@media print {
  @page { size: A4 portrait; margin: 0; }
  html, body { background: #fff !important; }
  body > *:not(.rc-print-master) { display: none !important; }
  .rc-print-master { display: block !important; }
  .rc-sheet {
    box-shadow: none; border-radius: 0; margin: 0; page-break-after: always;
    break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .rc-sheet:last-child { page-break-after: auto; }
  .rc-band, .rc-kpi-icon, .rc-table th, .rc-footer-band {
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
}
`;

let reportCssInjected = false;
function InjectReportPrintCss() {
  useEffect(() => {
    if (reportCssInjected) return;
    const style = document.createElement('style');
    style.id = 'rc-print-css';
    style.textContent = REPORT_PRINT_CSS;
    document.head.appendChild(style);
    reportCssInjected = true;
  }, []);
  return null;
}

// ── print SVG: horizontal company bars (deterministic coordinates) ──
function PrintBarsSvg({ companies }: { companies: CompanyPerfRow[] }) {
  const rows = companies.length;
  if (rows === 0) return <p className="rc-note">شرکتی در محدوده گزارش نیست.</p>;
  const W = 660, rowH = 30, H = rows * rowH + 8;
  const max = Math.max(...companies.map((c) => c.sales), 1);
  const nameW = 130, valW = 120, barMax = W - nameW - valW - 24;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      <defs>
        {companies.map((c) => (
          <linearGradient key={c.companyId} id={`pg-${c.companyId}`} x1="1" y1="0" x2="0" y2="0">
            <stop offset="0%" stopColor={c.color} />
            <stop offset="100%" stopColor={c.color} stopOpacity="0.55" />
          </linearGradient>
        ))}
      </defs>
      {companies.map((c, i) => {
        const y = i * rowH + 4;
        const bw = Math.max((c.sales / max) * barMax, c.sales > 0 ? 6 : 2);
        return (
          <g key={c.companyId}>
            <text x={W - 4} y={y + 13} textAnchor="end" fontSize="11" fontWeight="700" fill="#1f2937">{c.name}</text>
            <rect x={W - nameW - 12 - bw} y={y + 1} width={bw} height="17" rx="4" fill={`url(#pg-${c.companyId})`} />
            <text x={W - nameW - 16 - bw} y={y + 14} textAnchor="end" fontSize="9.5" fontWeight="700" fill={BRAND_NAVY}>{compact(c.sales)}</text>
            <text x={4} y={y + 13.5} fontSize="8.4" fill="#6b7280" textAnchor="start">
              {fa(c.orders)} سفارش · {fa(c.centers)} مرکز · سهم {fa(c.share)}٪
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── print SVG: 12-month stacked trend ──
function PrintTrendSvg({ trend, companies }: { trend: TrendPoint[]; companies: CompanyPerfRow[] }) {
  const W = 660, H = 170, top = 18, bottom = 20;
  const max = Math.max(...trend.map((t) => t.total), 1);
  const colW = (W - 8) / trend.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block' }}>
      {[0.5, 1].map((g) => (
        <line key={g} x1="4" x2={W - 4} y1={top + (H - top - bottom) * (1 - g)} y2={top + (H - top - bottom) * (1 - g)} stroke="#e5e7eb" strokeDasharray="3 3" />
      ))}
      <text x={W - 4} y={top + (H - top - bottom) * (1 - 1) - 3} textAnchor="end" fontSize="8" fill="#9ca3af">{compact(max)}</text>
      <text x={W - 4} y={top + (H - top - bottom) * (1 - 0.5) - 3} textAnchor="end" fontSize="8" fill="#9ca3af">{compact(max / 2)}</text>
      {trend.map((t, i) => {
        const x = W - 4 - (i + 1) * colW + 2;
        const h = (t.total / max) * (H - top - bottom);
        let cy = H - bottom;
        return (
          <g key={i}>
            {companies.map((c) => {
              const v = t.byCompany[c.companyId] || 0;
              if (v <= 0) return null;
              const segH = (v / Math.max(t.total, 1)) * h;
              cy -= segH;
              return <rect key={c.companyId} x={x} y={cy} width={colW - 5} height={Math.max(segH, 1)} rx="1.5" fill={c.color} fillOpacity="0.92" />;
            })}
            {t.total === 0 && <rect x={x} y={H - bottom - 2} width={colW - 5} height="2" rx="1" fill="#e5e7eb" />}
            <text x={x + (colW - 5) / 2} y={H - 6} textAnchor="middle" fontSize="8" fill="#6b7280">{t.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── print donut (deterministic SVG, same math as ShareDonut) ──
function PrintDonutSvg({ companies }: { companies: CompanyPerfRow[] }) {
  const total = companies.reduce((s, c) => s + c.sales, 0);
  // offset = sum of PREVIOUS segments (no mutable accumulator — same
  // pattern as ShareDonut above).
  const segs = companies
    .filter((c) => c.sales > 0)
    .map((c) => ({ ...c, pct: total > 0 ? (c.sales / total) * 100 : 0 }))
    .map((c, i, arr) => ({ ...c, offset: arr.slice(0, i).reduce((s, prev) => s + prev.pct, 0) }));
  const R = 15.915;
  return (
    <svg viewBox="0 0 36 36" style={{ width: '44mm', height: '44mm', display: 'block', margin: '0 auto' }} className="-rotate-90">
      <circle cx="18" cy="18" r={R} fill="none" stroke="#f1f5f9" strokeWidth="4" />
      {segs.map((s) => (
        <circle key={s.companyId} cx="18" cy="18" r={R} fill="none" stroke={s.color} strokeWidth="4"
          strokeDasharray={`${s.pct} ${100 - s.pct}`} strokeDashoffset={`${-s.offset}`} />
      ))}
    </svg>
  );
}

// ── one A4 sheet ──
function SheetBand({ title, sub, chips }: { title: string; sub: string; chips: string[] }) {
  return (
    <div className="rc-band">
      <h1 className="rc-band-title">{title}</h1>
      <p className="rc-band-sub">{sub}</p>
      <div className="rc-band-meta">
        {chips.map((c, i) => <span key={i} className="rc-band-chip">{c}</span>)}
      </div>
      <svg className="rc-band-wave" viewBox="0 0 700 26" preserveAspectRatio="none">
        <path d="M0,14 C90,0 180,24 300,12 C420,0 520,22 700,8 L700,26 L0,26 Z" fill={BRAND_NAVY} opacity="0.55" />
        <path d="M0,20 C120,8 260,26 420,14 C540,6 640,20 700,12 L700,26 L0,26 Z" fill="#ffffff" opacity="0.14" />
      </svg>
    </div>
  );
}

function SheetFooter({ page, pages, stamp }: { page: number; pages: number; stamp: string }) {
  return (
    <div className="rc-footer-band">
      <span>سامانه مدیریت ارتباط با مشتری بهبود گستر — مرکز گزارش حرفه‌ای</span>
      <span>صفحه {fa(page)} از {fa(pages)}</span>
      <span>{stamp}</span>
    </div>
  );
}

function KpiCell({ label, value, bg }: { label: string; value: string; bg: string }) {
  return (
    <div className="rc-kpi">
      <div className="rc-kpi-icon" style={{ background: bg }}>
        <Sparkles size={13} />
      </div>
      <div>
        <p className="rc-kpi-label">{label}</p>
        <p className="rc-kpi-value">{value}</p>
      </div>
    </div>
  );
}

/** The A4 report content — rendered by BOTH the preview dialog and the print master. */
function ReportSheets({ report }: { report: PerformanceReport }) {
  const { kpis, companies, monthlyTrend, experts, period } = report;
  const stamp = `تولید گزارش: ${toJalaliString(report.generatedAt)} (${fa(new Date(report.generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))})`;
  const periodChips = [
    `دوره: ${period.label}`,
    `تاریخ: ${toJalaliString(new Date())}`,
  ];
  const totalSales = companies.reduce((s, c) => s + c.sales, 0);
  const topExpert = experts.length > 0 ? experts[0] : null;

  return (
    <>
      {/* ── Sheet 1: company performance ── */}
      <div className="rc-sheet">
        <SheetBand
          title="گزارش عملکرد فروش شرکت‌ها"
          sub="هلدینگ بهبود گستر — تحلیل فروش تأییدشده به تفکیک شرکت‌های زیرمجموعه"
          chips={periodChips}
        />
        <div className="rc-body">
          <h2 className="rc-sec-title">شاخص‌های کلیدی دوره ({period.label})</h2>
          <div className="rc-kpi-grid">
            <KpiCell label="فروش کل (ریال)" value={withSeparators(kpis.totalSales)} bg={BRAND_TEAL} />
            <KpiCell label="سفارشات تأییدشده" value={fa(kpis.totalOrders)} bg={BRAND_TEAL_DARK} />
            <KpiCell label="مراکز فعال" value={fa(kpis.activeCenters)} bg={BRAND_NAVY} />
            <KpiCell label="شرکت با فروش" value={`${fa(kpis.companiesWithSales)} از ${fa(companies.length)}`} bg="#0891b2" />
            <KpiCell label="میانگین ارزش سفارش (ریال)" value={withSeparators(kpis.avgDealSize)} bg="#7c3aed" />
            <KpiCell label="کارشناسان فعال" value={fa(kpis.expertCount)} bg="#d97706" />
          </div>

          <h2 className="rc-sec-title">فروش به تفکیک شرکت</h2>
          <div className="rc-chart-row">
            <div style={{ flex: 2.2 }}>
              <PrintBarsSvg companies={companies} />
            </div>
            <div style={{ flex: 1 }}>
              <PrintDonutSvg companies={companies} />
              <p className="rc-note" style={{ textAlign: 'center' }}>
                سهم از {compact(totalSales)} ریال فروش کل
              </p>
            </div>
          </div>

          <h2 className="rc-sec-title">روند فروش ۱۲ ماه اخیر (ماه شمسی)</h2>
          <PrintTrendSvg trend={monthlyTrend} companies={companies} />

          <h2 className="rc-sec-title">جدول رتبه‌بندی شرکت‌ها</h2>
          <table className="rc-table">
            <thead>
              <tr>
                <th style={{ width: '9%' }}>رتبه</th>
                <th>شرکت</th>
                <th style={{ width: '19%' }}>فروش (ریال)</th>
                <th style={{ width: '10%' }}>سفارش</th>
                <th style={{ width: '10%' }}>مراکز</th>
                <th style={{ width: '17%' }}>میانگین سفارش (ریال)</th>
                <th style={{ width: '9%' }}>سهم</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c, i) => (
                <tr key={c.companyId}>
                  <td className="num">{fa(i + 1)}</td>
                  <td style={{ fontWeight: 700 }}>{c.name}</td>
                  <td className="num">{withSeparators(c.sales)}</td>
                  <td className="num">{fa(c.orders)}</td>
                  <td className="num">{fa(c.centers)}</td>
                  <td className="num">{withSeparators(c.avgDeal)}</td>
                  <td className="num">{fa(c.share)}٪</td>
                </tr>
              ))}
              {companies.length === 0 && (
                <tr><td colSpan={7}>شرکتی در محدودهٔ گزارش شما نیست</td></tr>
              )}
            </tbody>
          </table>
          <p className="rc-note">
            مبنا: اسناد فروش تأییدشده (پیش‌فاکتور بدون فاکتور مشتق + فاکتور) در پنجرهٔ {period.label} — دامنهٔ داده‌ها مطابق دسترسی کاربر گزارش‌گیرنده.
          </p>
        </div>
        <SheetFooter page={1} pages={2} stamp={stamp} />
      </div>

      {/* ── Sheet 2: expert performance ── */}
      <div className="rc-sheet">
        <SheetBand
          title="گزارش عملکرد کارشناسان فروش"
          sub="تحلیل فروش، کاریز و فعالیت‌های عملیاتی کارشناسان"
          chips={periodChips}
        />
        <div className="rc-body">
          <h2 className="rc-sec-title">شاخص‌های کلیدی تیم فروش ({period.label})</h2>
          <div className="rc-kpi-grid">
            <KpiCell label="کارشناسان فعال" value={fa(kpis.expertCount)} bg={BRAND_TEAL} />
            <KpiCell label="فروش کل تیم (ریال)" value={withSeparators(kpis.totalSales)} bg={BRAND_NAVY} />
            <KpiCell label="میانگین نرخ برد" value={`${fa(kpis.avgWinRate)}٪`} bg="#059669" />
            <KpiCell label="تماس‌های انجام‌شده" value={fa(kpis.totalCalls)} bg="#0891b2" />
            <KpiCell label="بازدیدهای حضوری" value={fa(kpis.totalVisits)} bg="#7c3aed" />
            <KpiCell
              label="کارشناس برتر"
              value={topExpert ? topExpert.userName : '—'}
              bg={RANK_GOLD}
            />
          </div>

          <h2 className="rc-sec-title">جدول عملکرد کارشناسان (مرتب بر اساس فروش)</h2>
          <table className="rc-table">
            <thead>
              <tr>
                <th style={{ width: '8%' }}>رتبه</th>
                <th>کارشناس</th>
                <th style={{ width: '11%' }}>سمت</th>
                <th style={{ width: '15%' }}>فروش (ریال)</th>
                <th style={{ width: '8%' }}>سفارش</th>
                <th style={{ width: '8%' }}>کاریز</th>
                <th style={{ width: '9%' }}>نرخ برد</th>
                <th style={{ width: '14%' }}>میانگین سفارش</th>
                <th style={{ width: '8%' }}>تماس</th>
                <th style={{ width: '8%' }}>بازدید</th>
              </tr>
            </thead>
            <tbody>
              {experts.slice(0, 16).map((e, i) => (
                <tr key={e.userId}>
                  <td className="num" style={{ fontWeight: 800, color: rankColor(i + 1) }}>{fa(i + 1)}</td>
                  <td style={{ fontWeight: 700 }}>{e.userName}</td>
                  <td style={{ fontSize: 8 }}>{e.role}</td>
                  <td className="num">{withSeparators(e.sales)}</td>
                  <td className="num">{fa(e.orders)}</td>
                  <td className="num">{fa(e.pipeline)}</td>
                  <td className="num">{fa(e.winRate)}٪</td>
                  <td className="num">{compact(e.avgDealSize)}</td>
                  <td className="num">{fa(e.calls)}</td>
                  <td className="num">{fa(e.visits)}</td>
                </tr>
              ))}
              {experts.length === 0 && (
                <tr><td colSpan={10}>کارشناسی در این دوره فعالیت ثبت‌شده ندارد</td></tr>
              )}
            </tbody>
          </table>
          {experts.length > 16 && (
            <p className="rc-note">… و {fa(experts.length - 16)} کارشناس دیگر (نمایش ۱۶ رتبهٔ برتر در چاپ).</p>
          )}
          <p className="rc-note">
            نرخ برد = فاکتورهای صادرشده ÷ (فاکتور + اسناد باطل/ردشده)؛ تماس و بازدید فقط فعالیت‌های «انجام‌شده» را می‌شمارد.
          </p>
        </div>
        <SheetFooter page={2} pages={2} stamp={stamp} />
      </div>
    </>
  );
}

// ==================== PRINT PREVIEW DIALOG (screen) + PRINT MASTER ====================
function ReportsPrintPreview({ report, onClose }: { report: PerformanceReport; onClose: () => void }) {
  const [scale, setScale] = useState(0.72);

  return createPortal(
    <>
      <InjectReportPrintCss />
      {/* screen overlay */}
      <div className="fixed inset-0 z-[70] bg-gray-900/75 backdrop-blur-sm flex flex-col animate-fade-in" dir="rtl" data-testid="rc-print-preview">
        <div className="bg-white border-b border-gray-200 px-4 py-2.5 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: `linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_NAVY})` }}>
              <FileDown size={16} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-extrabold text-gray-900 truncate">پیش‌نمایش گزارش A4</p>
              <p className="text-[11px] text-gray-400 truncate">دو برگ A4 — خروجی PDF از طریق چاپ مرورگر (ذخیره به‌صورت PDF)</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden">
              <button className="w-8 h-8 hover:bg-gray-50 text-gray-600" onClick={() => setScale((s) => Math.max(0.4, Math.round((s - 0.08) * 100) / 100))} aria-label="کوچک‌نمایی">−</button>
              <span className="w-12 text-center text-[11px] font-bold text-gray-700 tabular-nums">{fa(Math.round(scale * 100))}٪</span>
              <button className="w-8 h-8 hover:bg-gray-50 text-gray-600" onClick={() => setScale((s) => Math.min(1.15, Math.round((s + 0.08) * 100) / 100))} aria-label="بزرگ‌نمایی">+</button>
            </div>
            <Button size="sm" className="h-9 gap-1.5 text-white" style={{ background: `linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_TEAL_DARK})` }} onClick={() => window.print()}>
              <Printer size={14} /> چاپ / ذخیره PDF
            </Button>
            <Button size="sm" variant="outline" className="h-9 gap-1.5" onClick={onClose}>
              <X size={14} /> بستن
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-gray-200/60 p-6">
          <div className="rc-preview-stage" style={{ transform: `scale(${scale})`, transformOrigin: 'top center', width: '210mm', margin: '0 auto' }}>
            <ReportSheets report={report} />
          </div>
        </div>
      </div>
      {/* print master — body-level, print-only */}
      <div className="rc-print-master">
        <ReportSheets report={report} />
      </div>
    </>,
    document.body,
  );
}

// ==================== SCREEN: STAT CARD ====================
function StatCard({ label, value, sub, icon, gradient }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; gradient: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 hover:shadow-md hover:-translate-y-0.5 transition-all group">
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl flex items-center justify-center text-white shrink-0 shadow-md group-hover:scale-105 transition-transform" style={{ background: gradient }}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-gray-400 truncate">{label}</p>
          <p className="text-lg font-black text-gray-900 tabular-nums truncate" title={value}>{value}</p>
          {sub && <p className="text-[10px] text-gray-400 truncate">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

// ==================== SCREEN: COMPANY TABLE ====================
function CompanyTable({ companies }: { companies: CompanyPerfRow[] }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-2 flex items-center justify-between">
        <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
          <Layers size={16} style={{ color: BRAND_TEAL }} /> رتبه‌بندی شرکت‌ها
        </h3>
        <span className="text-[11px] text-gray-400">مرتب‌سازی بر اساس فروش</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/80 text-[11px] text-gray-500">
              <th className="py-2.5 px-4 font-bold">رتبه</th>
              <th className="py-2.5 px-3 text-right font-bold">شرکت</th>
              <th className="py-2.5 px-3 font-bold">فروش (ریال)</th>
              <th className="py-2.5 px-3 font-bold">سفارش</th>
              <th className="py-2.5 px-3 font-bold">مراکز</th>
              <th className="py-2.5 px-3 font-bold">میانگین سفارش</th>
              <th className="py-2.5 px-4 font-bold">سهم از کل</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((c, i) => (
              <tr key={c.companyId} className="border-t border-gray-50 hover:bg-teal-50/30 transition-colors">
                <td className="py-3 px-4 text-center">
                  <span className="inline-flex w-7 h-7 rounded-lg items-center justify-center text-[12px] font-black"
                    style={{ background: i < 3 ? `${rankColor(i + 1)}18` : '#f1f5f9', color: i < 3 ? rankColor(i + 1) : '#64748b' }}>
                    {fa(i + 1)}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: c.color }} />
                    <span className="font-bold text-gray-800 text-xs">{c.name}</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-center font-black text-gray-900 tabular-nums text-xs">{withSeparators(c.sales)}</td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{fa(c.orders)}</td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{fa(c.centers)}</td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{compact(c.avgDeal)}</td>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden min-w-12">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(c.share, c.sales > 0 ? 4 : 0)}%`, background: `linear-gradient(90deg, ${c.color}, ${c.color}AA)` }} />
                    </div>
                    <span className="text-xs font-black tabular-nums text-gray-700 w-9">{fa(c.share)}٪</span>
                  </div>
                </td>
              </tr>
            ))}
            {companies.length === 0 && (
              <tr><td colSpan={7} className="py-10 text-center text-gray-400 text-xs">شرکتی در محدودهٔ دسترسی شما نیست</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==================== SCREEN: EXPERT TABLE ====================
type ExpertSort = 'sales' | 'orders' | 'calls' | 'winRate';

function ExpertTable({ experts }: { experts: ExpertPerfRow[] }) {
  const [sortBy, setSortBy] = useState<ExpertSort>('sales');
  const sorted = useMemo(() => {
    const rows = [...experts];
    rows.sort((a, b) => (b[sortBy] as number) - (a[sortBy] as number));
    return rows;
  }, [experts, sortBy]);

  const sortLabels: Record<ExpertSort, string> = {
    sales: 'فروش', orders: 'سفارش', calls: 'تماس', winRate: 'نرخ برد',
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      <div className="px-5 pt-4 pb-2 flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
          <UserCheck size={16} style={{ color: BRAND_TEAL }} /> جدول تفصیلی کارشناسان
        </h3>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-gray-400">مرتب‌سازی:</span>
          {(Object.keys(sortLabels) as ExpertSort[]).map((k) => (
            <button
              key={k}
              onClick={() => setSortBy(k)}
              className={`px-2.5 py-1 rounded-lg font-bold transition-colors ${sortBy === k ? 'text-white' : 'text-gray-500 hover:bg-gray-100'}`}
              style={sortBy === k ? { background: BRAND_TEAL } : undefined}
            >
              {sortLabels[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="rc-expert-table">
          <thead>
            <tr className="bg-gray-50/80 text-[11px] text-gray-500">
              <th className="py-2.5 px-4 font-bold">رتبه</th>
              <th className="py-2.5 px-3 text-right font-bold">کارشناس</th>
              <th className="py-2.5 px-3 font-bold">فروش (ریال)</th>
              <th className="py-2.5 px-3 font-bold">سفارش</th>
              <th className="py-2.5 px-3 font-bold">کاریز</th>
              <th className="py-2.5 px-3 font-bold">نرخ برد</th>
              <th className="py-2.5 px-3 font-bold">میانگین سفارش</th>
              <th className="py-2.5 px-3 font-bold">تماس</th>
              <th className="py-2.5 px-3 font-bold">بازدید</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((e, i) => (
              <tr key={e.userId} className="border-t border-gray-50 hover:bg-teal-50/30 transition-colors">
                <td className="py-3 px-4 text-center">
                  <span className="inline-flex w-7 h-7 rounded-lg items-center justify-center text-[12px] font-black"
                    style={{ background: i < 3 ? `${rankColor(i + 1)}18` : '#f1f5f9', color: i < 3 ? rankColor(i + 1) : '#64748b' }}>
                    {fa(i + 1)}
                  </span>
                </td>
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                      style={{ background: `linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_NAVY})` }}>
                      {initialsOf(e.userName)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-bold text-gray-800 truncate">{e.userName}</p>
                      <p className="text-[10px] text-gray-400 truncate">{e.role}</p>
                    </div>
                  </div>
                </td>
                <td className="py-3 px-3 text-center font-black text-gray-900 tabular-nums text-xs">{withSeparators(e.sales)}</td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{fa(e.orders)}</td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{fa(e.pipeline)}</td>
                <td className="py-3 px-3 text-center">
                  <div className="flex items-center justify-center gap-1.5">
                    <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${e.winRate}%`, background: e.winRate >= 50 ? '#059669' : '#d97706' }} />
                    </div>
                    <span className="text-xs font-bold tabular-nums text-gray-700">{fa(e.winRate)}٪</span>
                  </div>
                </td>
                <td className="py-3 px-3 text-center text-gray-700 tabular-nums text-xs font-bold">{compact(e.avgDealSize)}</td>
                <td className="py-3 px-3 text-center">
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-cyan-700 bg-cyan-50 rounded-lg px-2 py-0.5">
                    <Phone size={10} /> {fa(e.calls)}
                  </span>
                </td>
                <td className="py-3 px-3 text-center">
                  <span className="inline-flex items-center gap-1 text-xs font-bold text-violet-700 bg-violet-50 rounded-lg px-2 py-0.5">
                    <MapPin size={10} /> {fa(e.visits)}
                  </span>
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={9} className="py-10 text-center text-gray-400 text-xs">کارشناسی در این دوره فعالیت ثبت‌شده ندارد</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==================== MAIN ====================
export default function ReportsCenter() {
  const [months, setMonths] = useState<PeriodMonths>(null);
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'companies' | 'experts'>('companies');
  const [printOpen, setPrintOpen] = useState(false);
  const [rankMetric, setRankMetric] = useState<'sales' | 'calls'>('sales');
  const cache = useRef<Map<string, PerformanceReport>>(new Map());

  const load = useCallback(async (m: PeriodMonths, force = false) => {
    const key = String(m);
    if (!force && cache.current.has(key)) {
      setReport(cache.current.get(key)!);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'performance-center', months: m }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'خطا در دریافت گزارش عملکرد');
      cache.current.set(key, json);
      setReport(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت گزارش عملکرد');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(months);
  }, [months, load]);

  // Esc closes the print preview
  useEffect(() => {
    if (!printOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPrintOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [printOpen]);

  const { kpis, companies, monthlyTrend, experts } = report ?? {
    kpis: null, companies: [], monthlyTrend: [], experts: [],
  };

  return (
    <div className="space-y-5 animate-fade-in" dir="rtl" data-testid="reports-center">
      <InjectReportPrintCss />

      {/* ── hero header ── */}
      <div className="relative rounded-3xl overflow-hidden shadow-lg" style={{ background: `linear-gradient(115deg, ${BRAND_NAVY} 0%, ${BRAND_TEAL_DARK} 60%, ${BRAND_TEAL} 100%)` }}>
        <svg className="absolute inset-x-0 bottom-0 w-full h-20 pointer-events-none" viewBox="0 0 700 80" preserveAspectRatio="none">
          <path d="M0,40 C120,10 260,70 420,36 C540,12 640,52 700,30 L700,80 L0,80 Z" fill="#ffffff" opacity="0.08" />
          <path d="M0,58 C140,30 300,76 480,48 C580,32 660,60 700,44 L700,80 L0,80 Z" fill="#ffffff" opacity="0.10" />
        </svg>
        <div className="relative p-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5 mb-1.5">
              <div className="w-10 h-10 rounded-2xl bg-white/15 border border-white/25 flex items-center justify-center text-white backdrop-blur">
                <Award size={20} />
              </div>
              <h1 className="text-xl font-black text-white">مرکز گزارش حرفه‌ای</h1>
            </div>
            <p className="text-[13px] text-white/85">گزارش عملکرد فروش شرکت‌ها و کارشناسان — با خروجی PDF برند BGL</p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <span className="text-[11px] text-white/80 bg-white/10 border border-white/20 rounded-full px-3 py-1">{formatJalaliFull(new Date())}</span>
              {report && (
                <span className="text-[11px] text-white/80 bg-white/10 border border-white/20 rounded-full px-3 py-1">
                  آخرین داده: {toJalaliString(report.generatedAt)}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-2" data-testid="rc-period-chips">
              {PERIOD_MONTHS_OPTIONS.map((m) => (
                <button
                  key={String(m)}
                  onClick={() => setMonths(m)}
                  disabled={loading}
                  className={`text-[11px] font-bold rounded-xl px-3.5 py-2 transition-all border ${
                    months === m
                      ? 'bg-white text-gray-900 border-white shadow-md'
                      : 'bg-white/10 text-white/85 border-white/25 hover:bg-white/20'
                  } ${loading && months !== m ? 'opacity-50' : ''}`}
                >
                  {periodLabel(m)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                className="h-9 gap-1.5 bg-white/15 border border-white/30 text-white hover:bg-white/25 backdrop-blur"
                onClick={() => void load(months, true)}
                disabled={loading}
                aria-label="بازخوانی داده‌ها"
              >
                <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> بازخوانی
              </Button>
              <Button
                size="sm"
                className="h-9 gap-1.5 text-white shadow-md"
                style={{ background: '#fff', color: BRAND_NAVY }}
                onClick={() => setPrintOpen(true)}
                disabled={!report || loading}
                data-testid="rc-pdf-button"
              >
                <FileDown size={14} /> خروجی PDF
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── tabs ── */}
      <div className="flex items-center gap-2">
        <div className="bg-gray-100 rounded-2xl p-1 flex gap-1">
          <button
            onClick={() => setTab('companies')}
            className={`flex items-center gap-2 text-xs font-bold rounded-xl px-4 py-2.5 transition-all ${tab === 'companies' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            data-testid="rc-tab-companies"
          >
            <Building2 size={15} style={{ color: tab === 'companies' ? BRAND_TEAL : undefined }} /> عملکرد شرکت‌ها
          </button>
          <button
            onClick={() => setTab('experts')}
            className={`flex items-center gap-2 text-xs font-bold rounded-xl px-4 py-2.5 transition-all ${tab === 'experts' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
            data-testid="rc-tab-experts"
          >
            <Users size={15} style={{ color: tab === 'experts' ? BRAND_TEAL : undefined }} /> عملکرد کارشناسان فروش
          </button>
        </div>
        {report && (
          <span className="text-[11px] text-gray-400 bg-gray-50 border border-gray-100 rounded-full px-3 py-1.5">
            دورهٔ فعال: <b className="text-gray-700">{report.period.label}</b>
          </span>
        )}
      </div>

      {/* ── states ── */}
      {loading && !report && (
        <div className="bg-white rounded-2xl border border-gray-100 p-12 text-center">
          <div className="w-9 h-9 border-[3px] rounded-full mx-auto mb-3 animate-spin" style={{ borderColor: `${BRAND_TEAL}33`, borderTopColor: BRAND_TEAL }} />
          <p className="text-sm text-gray-400">در حال محاسبهٔ شاخص‌های عملکرد…</p>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-5 flex items-center justify-between gap-3">
          <p className="text-sm text-red-600">{error}</p>
          <Button size="sm" variant="outline" className="h-8 text-red-600 border-red-200 hover:bg-red-50" onClick={() => void load(months, true)}>تلاش دوباره</Button>
        </div>
      )}

      {/* ── content ── */}
      {report && kpis && (
        <>
          {tab === 'companies' ? (
            <div className="space-y-5" data-testid="rc-companies-view">
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3" data-testid="rc-kpis">
                <StatCard label="فروش کل" value={`${compact(kpis.totalSales)}`} sub={`${withSeparators(kpis.totalSales)} ریال`} icon={<Wallet size={19} />} gradient={`linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_TEAL_DARK})`} />
                <StatCard label="سفارشات تأییدشده" value={fa(kpis.totalOrders)} icon={<ShoppingCart size={19} />} gradient="linear-gradient(135deg, #0891b2, #0e7490)" />
                <StatCard label="مراکز فعال" value={fa(kpis.activeCenters)} icon={<Building2 size={19} />} gradient={`linear-gradient(135deg, ${BRAND_NAVY}, #2E3A66)`} />
                <StatCard label="شرکت با فروش" value={`${fa(kpis.companiesWithSales)} / ${fa(companies.length)}`} icon={<Layers size={19} />} gradient="linear-gradient(135deg, #7c3aed, #6d28d9)" />
                <StatCard label="میانگین ارزش سفارش" value={compact(kpis.avgDealSize)} icon={<TrendingUp size={19} />} gradient="linear-gradient(135deg, #d97706, #b45309)" />
                <StatCard label="کارشناسان فعال" value={fa(kpis.expertCount)} sub={`${fa(kpis.totalCalls)} تماس · ${fa(kpis.totalVisits)} بازدید`} icon={<Users size={19} />} gradient="linear-gradient(135deg, #059669, #047857)" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
                <div className="xl:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
                      <BarChart3 size={16} style={{ color: BRAND_TEAL }} /> فروش به تفکیک شرکت
                    </h3>
                    <span className="text-[11px] text-gray-400">مبالغ به ریال — اسناد تأییدشده</span>
                  </div>
                  {companies.length > 0 ? <GradientBars companies={companies} /> : <p className="text-xs text-gray-400 text-center py-12">شرکتی در محدودهٔ گزارش نیست</p>}
                </div>
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2 mb-4">
                    <PieChart size={16} style={{ color: BRAND_TEAL }} /> سهم شرکت‌ها از فروش
                  </h3>
                  <ShareDonut companies={companies} centerLabel="فروش کل" />
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
                    <LineChart size={16} style={{ color: BRAND_TEAL }} /> روند فروش ۱۲ ماه اخیر (ماه شمسی)
                  </h3>
                  <span className="text-[11px] text-gray-400">مستقل از فیلتر دوره — نمای بلندمدت</span>
                </div>
                <TrendBars trend={monthlyTrend} companies={companies} />
              </div>

              <CompanyTable companies={companies} />
            </div>
          ) : (
            <div className="space-y-5" data-testid="rc-experts-view">
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
                <StatCard label="کارشناسان فعال" value={fa(kpis.expertCount)} icon={<Users size={19} />} gradient={`linear-gradient(135deg, ${BRAND_TEAL}, ${BRAND_TEAL_DARK})`} />
                <StatCard label="فروش کل تیم" value={compact(kpis.totalSales)} sub={`${withSeparators(kpis.totalSales)} ریال`} icon={<Wallet size={19} />} gradient={`linear-gradient(135deg, ${BRAND_NAVY}, #2E3A66)`} />
                <StatCard label="میانگین نرخ برد" value={`${fa(kpis.avgWinRate)}٪`} icon={<Percent size={19} />} gradient="linear-gradient(135deg, #059669, #047857)" />
                <StatCard label="تماس‌های انجام‌شده" value={fa(kpis.totalCalls)} icon={<PhoneCall size={19} />} gradient="linear-gradient(135deg, #0891b2, #0e7490)" />
                <StatCard label="بازدیدهای حضوری" value={fa(kpis.totalVisits)} icon={<MapPin size={19} />} gradient="linear-gradient(135deg, #7c3aed, #6d28d9)" />
                <StatCard label="میانگین ارزش سفارش" value={compact(kpis.avgDealSize)} icon={<Target size={19} />} gradient="linear-gradient(135deg, #d97706, #b45309)" />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
                      <Crown size={16} style={{ color: RANK_GOLD }} /> رتبه‌بندی کارشناسان
                    </h3>
                    <div className="flex items-center rounded-xl bg-gray-100 p-0.5 text-[11px] font-bold">
                      <button onClick={() => setRankMetric('sales')} className={`px-3 py-1.5 rounded-lg transition-colors ${rankMetric === 'sales' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>فروش</button>
                      <button onClick={() => setRankMetric('calls')} className={`px-3 py-1.5 rounded-lg transition-colors ${rankMetric === 'calls' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500'}`}>تماس</button>
                    </div>
                  </div>
                  <ExpertRanking experts={experts} metric={rankMetric} />
                </div>
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
                  <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2 mb-4">
                    <Medal size={16} style={{ color: BRAND_TEAL }} /> سهم کارشناسان از تماس‌های تیم
                  </h3>
                  {experts.length > 0 ? (
                    <ShareDonut
                      companies={experts.slice(0, 6).map((e, i) => ({
                        companyId: e.userId,
                        name: e.userName,
                        slug: e.userId,
                        color: [BRAND_TEAL, '#0891b2', BRAND_NAVY, '#7c3aed', '#d97706', '#059669'][i] || '#94a3b8',
                        sales: e.calls, orders: 0, centers: 0, avgDeal: 0, share: 0,
                      }))}
                      centerLabel="تماس کل"
                    />
                  ) : (
                    <p className="text-xs text-gray-400 text-center py-12">کارشناسی در این دوره فعالیت ثبت‌شده ندارد</p>
                  )}
                </div>
              </div>

              <ExpertTable experts={experts} />
            </div>
          )}
        </>
      )}

      {/* ── PDF print preview ── */}
      {printOpen && report && (
        <ReportsPrintPreview report={report} onClose={() => setPrintOpen(false)} />
      )}
    </div>
  );
}
