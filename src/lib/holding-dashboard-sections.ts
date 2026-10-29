// ════════════════════════════════════════════════════════════
// HOLDING DASHBOARD SECTIONS — v2.50.0 pure catalog + validation
//
// Round 75: «دسترسی مدیر هلدینگ باید داشبورد قوی از بحث انواع گزارشات
// داشته باشد» — the holding dashboard is assembled from TAB sections
// (overview / sales / finance / pipeline / staff / ops). Each user owns
// a PERSONAL layout (visibility + order) stored as JSON in Meta under
// `holding_dashboard.<userId>` — the exact ownership pattern of the
// v2.43.0 expert widgets (`dashboard.<userId>`) and the v2.34.6
// per-user pipeline stages.
//
// Pure by design: no fetch, no DB, no React — fully testable.
// ════════════════════════════════════════════════════════════

export const HOLDING_TAB_KEYS = [
  'overview', 'sales', 'finance', 'pipeline', 'staff', 'ops',
] as const;
export type HoldingTabKey = (typeof HOLDING_TAB_KEYS)[number];

export interface HoldingTabMeta {
  key: HoldingTabKey;
  title: string;
  desc: string;
}

export const HOLDING_TAB_CATALOG: ReadonlyArray<HoldingTabMeta> = [
  { key: 'overview', title: 'نمای کلی گروه', desc: 'شاخص‌های کلیدی، روند فروش ماهانه، سهم شرکت‌ها و هشدارها' },
  { key: 'sales', title: 'گزارش فروش', desc: 'روند ماهانه به تفکیک شرکت و برترین مراکز خرید' },
  { key: 'finance', title: 'مالی و مطالبات', desc: 'طلب باز، وصولی، چک‌های در جریان و روند وصول' },
  { key: 'pipeline', title: 'کاریز فروش', desc: 'قیف مراحل، ارزش لوله و نرخ برد' },
  { key: 'staff', title: 'عملکرد کارکنان', desc: 'رتبه‌بندی کارشناسان بر اساس فروش و نرخ برد' },
  { key: 'ops', title: 'تولید و ارسال', desc: 'سفارشات تولید، وضعیت ارسال بار و شرکت‌های حمل' },
];

export interface HoldingTab {
  key: HoldingTabKey;
  visible: boolean;
}

export function holdingTabTitle(key: string): string {
  return HOLDING_TAB_CATALOG.find((t) => t.key === key)?.title ?? key;
}

// ── Validation (save path) ──────────────────────────────────
export function validateHoldingTabs(raw: unknown): { ok: true; tabs: HoldingTab[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'فهرست بخش‌ها خالی است' };
  if (raw.length > HOLDING_TAB_KEYS.length) return { ok: false, error: `حداکثر ${HOLDING_TAB_KEYS.length} بخش مجاز است` };
  const seen = new Set<string>();
  const out: HoldingTab[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'ساختار بخش نامعتبر است' };
    const { key, visible } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !(HOLDING_TAB_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `کلید بخش ناشناخته: ${String(key)}` };
    }
    if (seen.has(key)) return { ok: false, error: `بخش تکراری: ${holdingTabTitle(key)}` };
    seen.add(key);
    out.push({ key: key as HoldingTabKey, visible: visible !== false });
  }
  if (out.every((t) => !t.visible)) {
    return { ok: false, error: 'حداقل یک بخش باید نمایان باشد' };
  }
  return { ok: true, tabs: out };
}

// ── Default layout (no saved config) ────────────────────────
export function defaultHoldingTabs(): HoldingTab[] {
  return HOLDING_TAB_KEYS.map((key) => ({ key, visible: true }));
}

// ── Resolution (render path) ────────────────────────────────
/** Saved layout wins, but stays FORWARD-COMPATIBLE: keys added after the
 * layout was saved appear (visible) at the END in catalog order, and stale
 * keys are dropped instead of crashing the dashboard. */
export function resolveHoldingTabs(saved: HoldingTab[] | null): HoldingTab[] {
  if (!saved || saved.length === 0) return defaultHoldingTabs();
  const known = saved.filter((t) => (HOLDING_TAB_KEYS as readonly string[]).includes(t.key));
  const present = new Set(known.map((t) => t.key));
  const appended = HOLDING_TAB_KEYS.filter((k) => !present.has(k)).map((key) => ({ key, visible: true }));
  const resolved = [...known, ...appended];
  return resolved.some((t) => t.visible) ? resolved : defaultHoldingTabs();
}

/** Ordered list of VISIBLE tab keys for the renderer. */
export function visibleHoldingTabKeys(saved: HoldingTab[] | null): HoldingTabKey[] {
  return resolveHoldingTabs(saved).filter((t) => t.visible).map((t) => t.key);
}
