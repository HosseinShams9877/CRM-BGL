// ════════════════════════════════════════════════════════════
// MENU CATALOG — single source of truth for sidebar structure
// of all companies. Data-only (no React) so it can be shared
// between the Sidebar component and the admin Access
// Customization panel without duplication.
// Icons are attached in sidebar.tsx via the ICONS map.
//
// v2.34.0 — روزمره‌محور (spec §10): the seven daily-work items
// lead EVERY company menu (exact user-specified order), then a
// labeled separator «سایر بخش‌ها» and the remaining modules in
// logical groups. The duplicate «کاریز فروش» parent is retired
// (normalizeNavKey maps legacy ?module=pipeline links to
// sales-system-stages).
// ════════════════════════════════════════════════════════════

export type CompanySlug = 'holding' | 'bazargani' | 'aria' | 'bgl' | 'yasteb';

export interface MenuNode {
  key: string;
  label: string;
  /** v2.34.0 — 'primary' items render above the «سایر بخش‌ها» separator. */
  group?: 'primary' | 'secondary';
  children?: { key: string; label: string }[];
}

export const COMPANY_SLUGS: CompanySlug[] = ['holding', 'bazargani', 'aria', 'bgl', 'yasteb'];

/** v2.35.0 — isolated companies (شرکت مستقل): fully independent tenants
 * outside the group aggregate. Never shown in group switchers/dashboards. */
export const ISOLATED_COMPANY_SLUGS: CompanySlug[] = ['yasteb'];

// v2.34.4 — group structure (round 51, user-confirmed legal names): three
// subsidiaries under هلدینگ بهبود گستر (BGL) — تولید دستگاه (بهبود گستر
// لیام ایرانیان — میم) / بازرگانی (بهبودگستر لیان ایرانیان — نون) /
// فروش دستگاه و تجهیزات کمک تنفسی (آریا مدیکال). The manufacturer's
// former label «بهبود گستر لیان» was a round-40 typo (missing م + ایرانیان)
// that collided with the trader's name; shortName BGL → تولید because BGL
// is the HOLDING's name, not the manufacturer's.
export const COMPANY_META: Record<CompanySlug, { name: string; shortName: string; businessModel: string }> = {
  holding: { name: 'بهبود گستر (هلدینگ)', shortName: 'هلدینگ', businessModel: 'هلدینگ مادر گروه' },
  bazargani: { name: 'بهبود گستر لیان ایرانیان', shortName: 'بازرگانی', businessModel: 'واحد بازرگانی گروه' },
  aria: { name: 'آریا مدیکال', shortName: 'آریا', businessModel: 'فروش دستگاه و تجهیزات کمک تنفسی' },
  bgl: { name: 'بهبود گستر لیام ایرانیان', shortName: 'تولید', businessModel: 'تولید دستگاه‌های خلوص‌سنج' },
  yasteb: { name: 'یاس طب', shortName: 'یاس طب', businessModel: 'تولید ست‌های ونتیلاتور (مستقل)' },
};

// ── v2.34.0 — the seven daily-work primary items (user-specified order) ──
// Identical for every company; visibility is still resolved per user by the
// access matrix (a key the user lacks is simply not rendered).
// v2.56.0 (r81) — the r75 oversight-only exception is REVERSED: the
// holding issues its own sales documents now (پیش‌فاکتور هلدینگ با قالب
// «ایندیگوی سلطنتی» — user round 81), so its primaries include
// 'quick-proforma' like every other company.
function primaryMenus(
  callsChildren: { key: string; label: string }[],
): MenuNode[] {
  const items: MenuNode[] = [
    { key: 'sales-expert', label: 'داشبورد من', group: 'primary' },
    { key: 'dashboard', label: 'داشبورد مدیریت', group: 'primary' },
    { key: 'quick-activity', label: 'ثبت سریع فعالیت‌ها', group: 'primary' },
    { key: 'quick-proforma', label: 'صدور سریع پیش‌فاکتور', group: 'primary' },
  ];
  items.push(
    { key: 'sales-system-stages', label: 'کاریز مراحل فروش', group: 'primary' },
    { key: 'followup', label: 'پیگیری دوره‌ای', group: 'primary' },
    { key: 'calls', label: 'تماس‌ها', group: 'primary', children: callsChildren },
  );
  return items;
}

const CALLS_FULL = [
  { key: 'calls-log', label: 'ثبت تماس' },
  { key: 'calls-history', label: 'تاریخچه تماس‌ها' },
  { key: 'calls-scheduled', label: 'تماس‌های برنامه‌ریزی شده' },
];
const CALLS_BASIC = [
  { key: 'calls-log', label: 'ثبت تماس' },
  { key: 'calls-history', label: 'تاریخچه تماس‌ها' },
];

const AI_GROUP: MenuNode = {
  key: 'ai-intelligence', label: 'هوش مصنوعی فروش', group: 'secondary', children: [
    { key: 'ai-dashboard', label: 'داشبورد هوش فروش' },
    { key: 'ai-calls', label: 'تماس‌های تحلیل‌شده' },
    { key: 'ai-actions', label: 'اقدامات پیشنهادی' },
    { key: 'ai-coaching', label: 'مربی هوشمند فروش' },
    { key: 'ai-playbook', label: 'پلی‌بوک فروش' },
    { key: 'ai-settings', label: 'تنظیمات هوش مصنوعی' },
  ],
};

const INVENTORY_GROUP: MenuNode = {
  key: 'inventory', label: 'انبارداری', group: 'secondary', children: [
    { key: 'inventory-stock', label: 'موجودی کالا' },
    { key: 'inventory-movements', label: 'حرکت کالا' },
    { key: 'inventory-hesabfa', label: 'موجودی حسابفا' },
  ],
};

const SETTINGS_GROUP: MenuNode = {
  key: 'settings', label: 'تنظیمات سیستم', group: 'secondary', children: [
    { key: 'settings-general', label: 'تنظیمات عمومی' },
    { key: 'settings-security', label: 'امنیت و دسترسی' },
    { key: 'settings-access', label: 'شخصی‌سازی دسترسی' },
    { key: 'settings-backup', label: 'پشتیبان‌گیری' },
    { key: 'settings-integrations', label: 'یکپارچه‌سازی' },
  ],
};

const SALES_DOCS_GROUP: MenuNode = {
  key: 'sales-system', label: 'اسناد فروش', group: 'secondary', children: [
    { key: 'sales-system-stages', label: 'کاریز مراحل فروش' },
    { key: 'sales-proformas', label: 'پیش‌فاکتورها' },
    { key: 'sales-invoices', label: 'فاکتورها' },
    { key: 'sales-returns', label: 'مرجوعی‌ها' },
  ],
};

export const COMPANY_MENUS: Record<CompanySlug, MenuNode[]> = {
  holding: [
    // v2.56.0 (round 81) — هلدینگ بهبود گستر issues its OWN sales documents
    // again: the user asked for the holding's proforma (upload
    // «bgl_transparent.png» — the colorful BGL lockup) and it now prints
    // with the dedicated 'holding' royal-indigo template. The r75
    // oversight-only restriction (primaries without «صدور سریع پیش‌فاکتور»,
    // secondaries without «اسناد فروش», API issuer gates) is fully
    // reversed — the reports dashboard stays the holding's landing view.
    ...primaryMenus(CALLS_FULL),
    SALES_DOCS_GROUP,
    // ── سایر بخش‌ها ──
    { key: 'centers', label: 'مراکز و مشتریان', group: 'secondary', children: [
      { key: 'centers-list', label: 'لیست مراکز' },
      { key: 'centers-contacts', label: 'اشخاص تماس' },
      { key: 'centers-map', label: 'نقشه مراکز' },
      { key: 'centers-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'products', label: 'محصولات', group: 'secondary', children: [
      { key: 'products-list', label: 'لیست محصولات' },
      { key: 'products-specs', label: 'مشخصات فنی' },
      { key: 'products-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'calendar', label: 'تقویم و برنامه‌ریزی', group: 'secondary' },
    { key: 'mailbox', label: 'مراسلات', group: 'secondary' },
    INVENTORY_GROUP,
    AI_GROUP,
    { key: 'reports', label: 'گزارشات و عملکرد', group: 'secondary', children: [
      // v2.51.0 (r76) — «مرکز گزارش حرفه‌ای»: professional company/expert
      // performance report with charts + branded A4 PDF export.
      { key: 'reports-center', label: 'مرکز گزارش حرفه‌ای' },
      { key: 'reports-sales', label: 'گزارش فروش' },
      { key: 'reports-staff', label: 'عملکرد کارکنان' },
      { key: 'reports-finance', label: 'تحلیل مالی' },
      { key: 'reports-compare', label: 'مقایسه شرکت‌ها' },
      { key: 'reports-pipeline', label: 'گزارش کاریز فروش' },
      { key: 'reports-shipments', label: 'گزارش ارسال بار' },
    ]},
    { key: 'users', label: 'مدیریت کاربران', group: 'secondary' },
    SETTINGS_GROUP,
  ],
  bazargani: [
    ...primaryMenus(CALLS_BASIC),
    SALES_DOCS_GROUP,
    { key: 'centers', label: 'مراکز و مشتریان', group: 'secondary', children: [
      { key: 'centers-list', label: 'لیست مراکز' },
      { key: 'centers-individuals', label: 'مشتریان نهایی' },
      { key: 'centers-contacts', label: 'اشخاص تماس' },
    ]},
    { key: 'products', label: 'محصولات', group: 'secondary', children: [
      { key: 'products-list', label: 'لیست محصولات' },
      { key: 'products-specs', label: 'مشخصات فنی' },
      { key: 'products-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'calendar', label: 'تقویم و برنامه‌ریزی', group: 'secondary' },
    { key: 'mailbox', label: 'مراسلات', group: 'secondary' },
    INVENTORY_GROUP,
    { key: 'collections', label: 'وصول مطالبات', group: 'secondary' },
    { key: 'partner-pricing', label: 'قیمت همکاران', group: 'secondary' },
    AI_GROUP,
    { key: 'reports', label: 'گزارشات', group: 'secondary', children: [
      { key: 'reports-center', label: 'مرکز گزارش حرفه‌ای' },
      { key: 'reports-sales', label: 'گزارش فروش' },
      { key: 'reports-pipeline', label: 'گزارش کاریز فروش' },
      { key: 'reports-staff', label: 'عملکرد کارکنان' },
      { key: 'reports-shipments', label: 'گزارش ارسال بار' },
    ]},
    SETTINGS_GROUP,
  ],
  aria: [
    ...primaryMenus(CALLS_BASIC),
    SALES_DOCS_GROUP,
    { key: 'centers', label: 'مراکز و مشتریان', group: 'secondary', children: [
      { key: 'centers-list', label: 'لیست مراکز' },
      { key: 'centers-individuals', label: 'مشتریان نهایی' },
      { key: 'centers-territory', label: 'منطقه‌بندی' },
      { key: 'centers-contacts', label: 'اشخاص تماس' },
    ]},
    { key: 'products', label: 'محصولات', group: 'secondary', children: [
      { key: 'products-list', label: 'لیست محصولات' },
      { key: 'products-specs', label: 'مشخصات فنی' },
      { key: 'products-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'calendar', label: 'تقویم و برنامه‌ریزی', group: 'secondary' },
    { key: 'mailbox', label: 'مراسلات', group: 'secondary' },
    INVENTORY_GROUP,
    { key: 'loyalty', label: 'باشگاه مشتریان', group: 'secondary' },
    { key: 'visits', label: 'تردد نمایندگان', group: 'secondary' },
    AI_GROUP,
    { key: 'reports', label: 'گزارشات', group: 'secondary', children: [
      { key: 'reports-center', label: 'مرکز گزارش حرفه‌ای' },
      { key: 'reports-sales', label: 'گزارش فروش' },
      { key: 'reports-pipeline', label: 'گزارش کاریز فروش' },
      { key: 'reports-shipments', label: 'گزارش ارسال بار' },
    ]},
    SETTINGS_GROUP,
  ],
  bgl: [
    ...primaryMenus(CALLS_BASIC),
    SALES_DOCS_GROUP,
    { key: 'centers', label: 'مشتریان', group: 'secondary', children: [
      { key: 'centers-list', label: 'لیست مشتریان' },
      { key: 'centers-individuals', label: 'مشتریان نهایی' },
      { key: 'centers-contracts', label: 'قراردادها' },
      { key: 'centers-contacts', label: 'اشخاص تماس' },
    ]},
    { key: 'products', label: 'محصولات', group: 'secondary', children: [
      { key: 'products-list', label: 'لیست محصولات' },
      { key: 'products-specs', label: 'مشخصات فنی' },
      { key: 'products-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'calendar', label: 'تقویم و برنامه‌ریزی', group: 'secondary' },
    { key: 'mailbox', label: 'مراسلات', group: 'secondary' },
    INVENTORY_GROUP,
    { key: 'loyalty', label: 'باشگاه مشتریان', group: 'secondary' },
    { key: 'aftersales', label: 'خدمات پس از فروش', group: 'secondary', children: [
      { key: 'aftersales-tickets', label: 'تیکت‌های خدمات' },
      { key: 'aftersales-warranty', label: 'استعلام گارانتی' },
    ]},
    { key: 'production', label: 'تولید و ارسال', group: 'secondary', children: [
      { key: 'production-orders', label: 'سفارشات تولید' },
      { key: 'production-ship', label: 'ارسال و بارنامه' },
    ]},
    AI_GROUP,
    { key: 'reports', label: 'گزارشات', group: 'secondary', children: [
      { key: 'reports-center', label: 'مرکز گزارش حرفه‌ای' },
      { key: 'reports-sales', label: 'گزارش فروش' },
      { key: 'reports-pipeline', label: 'گزارش کاریز فروش' },
      { key: 'reports-production', label: 'گزارش تولید' },
      { key: 'reports-shipments', label: 'گزارش ارسال بار' },
    ]},
    SETTINGS_GROUP,
  ],
  // v2.35.0 — یاس طب (شرکت مستقل): a manufacturer of ventilator sets with
  // the FULL production-oriented module set (same shape as bgl), but as an
  // isolated tenant: its data, catalog and warehouse live outside every
  // group view.
  yasteb: [
    ...primaryMenus(CALLS_BASIC),
    SALES_DOCS_GROUP,
    { key: 'centers', label: 'مشتریان', group: 'secondary', children: [
      { key: 'centers-list', label: 'لیست مشتریان' },
      { key: 'centers-individuals', label: 'مشتریان نهایی' },
      { key: 'centers-contracts', label: 'قراردادها' },
      { key: 'centers-contacts', label: 'اشخاص تماس' },
    ]},
    { key: 'products', label: 'محصولات', group: 'secondary', children: [
      { key: 'products-list', label: 'لیست محصولات' },
      { key: 'products-specs', label: 'مشخصات فنی' },
      { key: 'products-cats', label: 'دسته‌بندی' },
    ]},
    { key: 'calendar', label: 'تقویم و برنامه‌ریزی', group: 'secondary' },
    { key: 'mailbox', label: 'مراسلات', group: 'secondary' },
    INVENTORY_GROUP,
    { key: 'loyalty', label: 'باشگاه مشتریان', group: 'secondary' },
    { key: 'aftersales', label: 'خدمات پس از فروش', group: 'secondary', children: [
      { key: 'aftersales-tickets', label: 'تیکت‌های خدمات' },
      { key: 'aftersales-warranty', label: 'استعلام گارانتی' },
    ]},
    { key: 'production', label: 'تولید و ارسال', group: 'secondary', children: [
      { key: 'production-orders', label: 'سفارشات تولید' },
      { key: 'production-ship', label: 'ارسال و بارنامه' },
    ]},
    { key: 'reports', label: 'گزارشات', group: 'secondary', children: [
      { key: 'reports-center', label: 'مرکز گزارش حرفه‌ای' },
      { key: 'reports-sales', label: 'گزارش فروش' },
      { key: 'reports-pipeline', label: 'گزارش کاریز فروش' },
      { key: 'reports-production', label: 'گزارش تولید' },
      { key: 'reports-shipments', label: 'گزارش ارسال بار' },
    ]},
    SETTINGS_GROUP,
  ],
};

/**
 * v2.34.0 — normalize legacy/duplicate nav keys to their current home.
 * `pipeline` (retired duplicate of the stage-kanban) → `sales-system-stages`.
 */
export function normalizeNavKey(key: string): string {
  if (key === 'pipeline') return 'sales-system-stages';
  return key;
}

/** All menu keys of a company (parents + children) in display order. */
export function allMenuKeys(company: CompanySlug): string[] {
  const menus = COMPANY_MENUS[company] || [];
  const keys: string[] = [];
  for (const m of menus) {
    keys.push(m.key);
    if (m.children) for (const c of m.children) keys.push(c.key);
  }
  return keys;
}

/** Expand a list of parent keys into parents + all their child keys. */
export function expandParentKeys(company: CompanySlug, parentKeys: string[]): string[] {
  const menus = COMPANY_MENUS[company] || [];
  const out: string[] = [];
  for (const m of menus) {
    if (parentKeys.includes(m.key)) {
      out.push(m.key);
      if (m.children) for (const c of m.children) out.push(c.key);
    }
  }
  return out;
}
