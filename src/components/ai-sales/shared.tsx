'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — Shared UI helpers (v2.27.0)
// Persian numbers, Jalali dates, score visuals, states.
// ════════════════════════════════════════════════════════════

import React from 'react';
import { toJalaliString } from '@/lib/jalali';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AI_RECORDING_STATUS_LABEL, AI_TEMPERATURE_LABEL, AI_TEMPERATURE_COLOR,
  AI_INTENT_LABEL, AI_ACTION_TYPE_LABEL, AI_ACTION_STATUS_LABEL,
  AI_OBJECTION_TYPE_LABEL, type AiRecordingStatus, type AiIntent,
} from '@/lib/ai/types';

export function toPersianNum(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

export function faDate(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  return toJalaliString(iso);
}

export function faDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${toJalaliString(d)} — ${toPersianNum(`${hh}:${mm}`)}`;
}

export function faPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return `${toPersianNum(n)}٪`;
}

/** Small JSON-array parser that never throws. */
export function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject<T extends Record<string, unknown>>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// ── Visual atoms ────────────────────────────────────────────

export function StatusPill({ status }: { status: AiRecordingStatus }) {
  const map: Record<AiRecordingStatus, string> = {
    uploaded: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
    queued: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
    transcribing: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    analyzing: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    completed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    failed: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  };
  const busy = status === 'transcribing' || status === 'analyzing' || status === 'queued';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status]}`}>
      {busy && <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {AI_RECORDING_STATUS_LABEL[status]}
    </span>
  );
}

export function TemperatureBadge({ temperature }: { temperature: string | null | undefined }) {
  if (!temperature || !(temperature in AI_TEMPERATURE_LABEL)) return <span className="text-xs text-slate-400">—</span>;
  const color = AI_TEMPERATURE_COLOR[temperature as keyof typeof AI_TEMPERATURE_LABEL];
  return (
    <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: `${color}18`, color }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      {AI_TEMPERATURE_LABEL[temperature as keyof typeof AI_TEMPERATURE_LABEL]}
    </span>
  );
}

export function IntentBadge({ intent }: { intent: string | null | undefined }) {
  if (!intent || !(intent in AI_INTENT_LABEL)) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300">
      {AI_INTENT_LABEL[intent as AiIntent]}
    </span>
  );
}

export function ActionStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    suggested: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    approved: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300',
    executed: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    completed: 'bg-emerald-200 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
    dismissed: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  };
  const label = (AI_ACTION_STATUS_LABEL as Record<string, string>)[status] || status;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${map[status] || map.dismissed}`}>{label}</span>;
}

export function ActionTypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded-full bg-cyan-100 px-2 py-0.5 text-[11px] font-medium text-cyan-800 dark:bg-cyan-950 dark:text-cyan-300">
      {(AI_ACTION_TYPE_LABEL as Record<string, string>)[type] || type}
    </span>
  );
}

export function ObjectionTypeBadge({ type }: { type: string }) {
  return (
    <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-800 dark:bg-orange-950 dark:text-orange-300">
      {(AI_OBJECTION_TYPE_LABEL as Record<string, string>)[type] || type}
    </span>
  );
}

/** Circular score 0-100 with Persian digits. */
export function ScoreRing({ score, size = 56, label }: { score: number | null | undefined; size?: number; label?: string }) {
  if (score === null || score === undefined) return <div className="text-xs text-slate-400">—</div>;
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const color = clamped >= 70 ? '#059669' : clamped >= 40 ? '#d97706' : '#dc2626';
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center gap-1" title={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`امتیاز ${clamped} از ۱۰۰`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={5} className="stroke-slate-200 dark:stroke-slate-700" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={5} stroke={color}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c - (clamped / 100) * c}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fontSize={size * 0.28} fontWeight={700} fill="currentColor" className="text-slate-700 dark:text-slate-200">
          {toPersianNum(clamped)}
        </text>
      </svg>
      {label && <span className="text-[11px] text-slate-500 dark:text-slate-400">{label}</span>}
    </div>
  );
}

export function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, confidence)) * 100);
  const color = pct >= 75 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-500' : 'bg-rose-500';
  return (
    <div className="flex items-center gap-2" title={`اطمینان: ${pct}٪`}>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[11px] text-slate-500 dark:text-slate-400">{toPersianNum(pct)}٪</span>
    </div>
  );
}

// ── States ──────────────────────────────────────────────────

export function AiSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="در حال بارگذاری">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function AiEmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/60 px-6 py-14 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <div className="text-slate-400 dark:text-slate-500" aria-hidden="true">🧠</div>
      <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200">{title}</h3>
      <p className="max-w-md text-xs leading-6 text-slate-500 dark:text-slate-400">{description}</p>
      {action}
    </div>
  );
}

export function AiErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-300" role="alert">
      <span className="font-semibold">خطا: </span>{message}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mr-3 rounded-md border border-rose-300 px-2 py-0.5 font-semibold hover:bg-rose-100 dark:border-rose-800 dark:hover:bg-rose-900">
          تلاش مجدد
        </button>
      )}
    </div>
  );
}

// ── API helper ──────────────────────────────────────────────

export async function aiApi(path: string, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function aiApiJson<T>(path: string, body: Record<string, unknown> = {}): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await aiApi(path, body);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: (data as { error?: string }).error || `خطای ${res.status}` };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: 'خطای ارتباط با سرور' };
  }
}

/** Center option loader (id + name) for the upload/manual dialogs. */
export interface CenterOption { id: string; name: string; contacts: { id: string; title: string; person: string | null }[] }

export async function loadCenters(): Promise<CenterOption[]> {
  const res = await fetch('/api/centers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'list', page: 1, pageSize: 300, includeArchived: false }),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  // /api/centers returns { success, data } — never `items`.
  const items = (data.data || data.items || []) as { id: string; name: string; extraContacts?: CenterOption['contacts'] }[];
  return items.map((c) => ({ id: c.id, name: c.name, contacts: (c.extraContacts || []).map((x) => ({ id: x.id, title: x.title, person: x.person })) }));
}
