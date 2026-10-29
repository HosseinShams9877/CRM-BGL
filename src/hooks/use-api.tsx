'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';

// ═══════════════════════════════════════════════════════════
// Shared API client layer for سامانه مدیریت جامع فروش.
// Every component talks to the backend through these helpers so
// auth, error handling and loading states stay consistent.
// ═══════════════════════════════════════════════════════════

export interface ApiError {
  message: string;
  status: number;
}

/** POST { action, ...payload } to the given API route. */
export async function apiCall<T = unknown>(
  route: string,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error((data as { error?: string }).error || 'خطای سرور'), {
      status: res.status,
    });
  }
  return data as T;
}

/** GET a query-string API route. */
export async function apiGet<T = unknown>(
  route: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  });
  const url = qs.toString() ? `${route}?${qs.toString()}` : route;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error((data as { error?: string }).error || 'خطای سرور'), {
      status: res.status,
    });
  }
  return data as T;
}

// ── Toast helpers (consistent feedback across the app) ──
/** Wrap any async action with loading toast + success/error feedback. */
export async function withToast(
  fn: () => Promise<unknown>,
  successMsg: string,
  errorMsg = 'خطا در انجام عملیات'
): Promise<boolean> {
  const id = toast.loading('در حال انجام عملیات...');
  try {
    await fn();
    toast.success(successMsg, { id });
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : errorMsg, { id });
    return false;
  }
}

// ── Skeleton loaders ──
export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div className={`bg-white rounded-xl border border-gray-100 p-4 ${className}`}>
      <div className="flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-gray-100 animate-pulse shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-gray-100 rounded-md animate-pulse w-2/5" />
          <div className="h-2.5 bg-gray-50 rounded-md animate-pulse w-3/5" />
        </div>
        <div className="h-3 bg-gray-100 rounded-md animate-pulse w-16" />
      </div>
    </div>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

type ListResponse<T> = {
  items?: T[];
  data?: T[];
  visits?: T[];
  total?: number;
  pagination?: { total?: number };
};

/**
 * v2.16.0 — walk EVERY page of an action-based list route.
 * The sales-documents/centers servers cap pageSize at 100; fetching a
 * single page silently hides documents 101+ (reported: a 150-document
 * tenant only ever saw 100 in the pipeline). Bounded at maxPages to keep
 * the worst-case payload sane.
 */
export async function listAllPages<T = unknown>(
  route: string,
  action: string,
  payload: Record<string, unknown> = {},
  maxPages = 20
): Promise<T[]> {
  const first = await apiCall<ListResponse<T> & { pagination?: { totalPages?: number } }>(
    route,
    action,
    { ...payload, page: 1, pageSize: 100 }
  );
  const all: T[] = first.items || first.data || first.visits || [];
  const totalPages = Math.min(first.pagination?.totalPages || 1, maxPages);
  for (let page = 2; page <= totalPages; page++) {
    const next = await apiCall<ListResponse<T>>(route, action, { ...payload, page, pageSize: 100 });
    const slice = next.items || next.data || next.visits || [];
    if (slice.length === 0) break;
    all.push(...slice);
  }
  return all;
}

/**
 * Fetch a list through an action-based POST route.
 * Returns { items, loading, error, refresh }.
 */
export function useApiList<T = unknown>(
  route: string | null,
  action: string,
  payload: Record<string, unknown> = {},
  deps: unknown[] = []
) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const payloadKey = JSON.stringify(payload);

  // v2.58.0 (audit 85-b): request-sequence guard — when payload/deps change
  // mid-flight, the older response can no longer overwrite the newer one
  // (last-writer-wins raced on quick tab/filter switches; sales-docs runs
  // three of these hooks live).
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    // Defer state updates past the first await: `load` is invoked from
    // effects (mount / deps change), and a synchronous setLoading here
    // would be a set-state-in-effect cascading render.
    await Promise.resolve();
    if (!route) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await apiCall<ListResponse<T>>(route, action, JSON.parse(payloadKey));
      if (seq !== seqRef.current) return; // stale response
      const list = res.items || res.data || res.visits || [];
      setItems(list);
      setTotal(res.total || res.pagination?.total || list.length);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : 'خطا در دریافت داده');
      setItems([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
     
  }, [route, action, payloadKey]);

  useEffect(() => {
    // Schedule on the microtask queue so every state update (including the
    // synchronous setLoading(true) at the top of `load`) happens
    // asynchronously — avoids cascading renders from the effect body.
    queueMicrotask(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { items, total, loading, error, refresh: load, setItems };
}

/**
 * v2.16.0 — like useApiList, but walks every page (see listAllPages)
 * so lists above the server's 100-record page cap are complete.
 */
export function useApiListAll<T = unknown>(
  route: string | null,
  action: string,
  payload: Record<string, unknown> = {},
  deps: unknown[] = [],
  maxPages = 20
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const payloadKey = JSON.stringify(payload);

  // v2.58.0 (audit 85-b): same stale-response guard as useApiList.
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    await Promise.resolve();
    if (!route) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const list = await listAllPages<T>(route, action, JSON.parse(payloadKey), maxPages);
      if (seq !== seqRef.current) return; // stale response
      setItems(list);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(e instanceof Error ? e.message : 'خطا در دریافت داده');
      setItems([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [route, action, payloadKey, maxPages]);

  useEffect(() => {
    queueMicrotask(load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, ...deps]);

  return { items, loading, error, refresh: load, setItems };
}

/** Small reusable spinner + error + empty wrapper for list views. */
export function ListState({
  loading,
  error,
  empty,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  onRetry?: () => void;
}) {
  if (loading) {
    return <SkeletonList count={4} />;
  }
  if (error) {
    return (
      <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
        <p className="text-sm text-red-600 mb-3">{error}</p>
        {onRetry && (
          <button onClick={onRetry} className="text-xs text-teal-700 hover:underline">
            تلاش مجدد
          </button>
        )}
      </div>
    );
  }
  if (empty) {
    return (
      <div className="bg-white rounded-xl border border-dashed border-gray-200 p-12 text-center">
        <div className="w-14 h-14 rounded-2xl bg-gray-50 flex items-center justify-center mx-auto mb-3">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="1.5">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <path d="M9 9h6v6H9z" />
          </svg>
        </div>
        <p className="text-sm font-bold text-gray-600 mb-1">داده‌ای برای نمایش وجود ندارد</p>
        <p className="text-xs text-gray-400 mb-4">با ثبت اولین رکورد، این بخش تکمیل می‌شود</p>
        {onRetry && (
          <button onClick={onRetry} className="text-xs text-teal-700 hover:underline font-medium">
            تلاش مجدد
          </button>
        )}
      </div>
    );
  }
  return null;
}
