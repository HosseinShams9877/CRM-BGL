// ════════════════════════════════════════════════════════════
// DASHBOARD WIDGETS — v2.43.0 pure catalog + validation
//
// The expert dashboard is assembled from independent widget
// cards. Each user owns a PERSONAL layout (visibility + order)
// stored as JSON in Meta under `dashboard.<userId>` — the exact
// ownership pattern of the v2.34.6 per-user pipeline stages.
//
// Pure by design: no fetch, no DB, no React — fully testable.
// ════════════════════════════════════════════════════════════

export const WIDGET_KEYS = [
  'kpi', 'performance', 'pipeline', 'quick_actions',
  'collection', 'overdue_alerts', 'schedule', 'activities', 'top_centers',
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export interface WidgetMeta {
  key: WidgetKey;
  title: string;
  desc: string;
  /** full-width on the lg grid (kpi renders its own 4-card row) */
  fullSpan?: boolean;
}

export const WIDGET_CATALOG: ReadonlyArray<WidgetMeta> = [
  { key: 'kpi', title: 'شاخص‌های کلیدی', desc: 'چهار کارت فروش، پیگیری، برنامه و مراکز', fullSpan: true },
  { key: 'performance', title: 'عملکرد فروش', desc: 'تارگت در برابر فروش واقعی + نمودار ماهانه' },
  { key: 'pipeline', title: 'لولهٔ فروش', desc: 'قیف مراحل تبدیل مشتری' },
  { key: 'quick_actions', title: 'دسترسی سریع', desc: 'میان‌برهای ثبت سریع کارهای روزمره' },
  { key: 'collection', title: 'وصول مطالبات', desc: 'کل طلب باز، وصول‌شده و نسبت' },
  { key: 'overdue_alerts', title: 'هشدار سررسید', desc: 'فاکتورهای سررسیدگذشتهٔ فعال' },
  { key: 'schedule', title: 'برنامهٔ روزانه', desc: 'تایم‌لاین فعالیت‌های امروز' },
  { key: 'activities', title: 'فعالیت‌های اخیر', desc: 'آخرین اسناد و اقدامات شما' },
  { key: 'top_centers', title: 'برترین مراکز', desc: 'جدول مراکز کلیدی فروش' },
];

export interface UserWidget {
  key: WidgetKey;
  visible: boolean;
}

export function widgetTitle(key: string): string {
  return WIDGET_CATALOG.find((w) => w.key === key)?.title ?? key;
}

// ── Validation (save path) ──────────────────────────────────
export function validateWidgets(raw: unknown): { ok: true; widgets: UserWidget[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'فهرست ویجت‌ها خالی است' };
  if (raw.length > WIDGET_KEYS.length) return { ok: false, error: `حداکثر ${WIDGET_KEYS.length} ویجت مجاز است` };
  const seen = new Set<string>();
  const out: UserWidget[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'ساختار ویجت نامعتبر است' };
    const { key, visible } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !(WIDGET_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `کلید ویجت ناشناخته: ${String(key)}` };
    }
    if (seen.has(key)) return { ok: false, error: `ویجت تکراری: ${widgetTitle(key)}` };
    seen.add(key);
    out.push({ key: key as WidgetKey, visible: visible !== false });
  }
  if (out.every((w) => !w.visible)) {
    return { ok: false, error: 'حداقل یک ویجت باید نمایان باشد' };
  }
  return { ok: true, widgets: out };
}

// ── Default layout (no saved config) ────────────────────────
export function defaultWidgets(): UserWidget[] {
  return WIDGET_KEYS.map((key) => ({ key, visible: true }));
}

// ── Resolution (render path) ────────────────────────────────
/** Saved layout wins, but must stay FORWARD-COMPATIBLE: keys
 *  added after the layout was saved appear (visible) at the END
 *  in catalog order, and stale keys (removed from catalog) are
 *  dropped instead of crashing the dashboard. */
export function resolveWidgets(saved: UserWidget[] | null): UserWidget[] {
  if (!saved || saved.length === 0) return defaultWidgets();
  const known = saved.filter((w) => (WIDGET_KEYS as readonly string[]).includes(w.key));
  const present = new Set(known.map((w) => w.key));
  const appended = WIDGET_KEYS.filter((k) => !present.has(k)).map((key) => ({ key, visible: true }));
  const resolved = [...known, ...appended];
  return resolved.some((w) => w.visible) ? resolved : defaultWidgets();
}

/** Ordered list of VISIBLE widget keys for the renderer. */
export function visibleWidgetKeys(saved: UserWidget[] | null): WidgetKey[] {
  return resolveWidgets(saved).filter((w) => w.visible).map((w) => w.key);
}
