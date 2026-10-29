// ════════════════════════════════════════════════════════════
//  BUSINESS MODEL — shared pure helpers & label maps for the
//  per-company business-model customization (v2.6.0).
//  Used by API routes (after-sales, partner-pricing, centers)
//  and UI components (labels/badges). No React, no DB.
// ════════════════════════════════════════════════════════════

// ── نوع مشتری: سازمانی / نهایی (BGL + همه) ──
export const CUSTOMER_TYPE_LABELS: Record<string, string> = {
  organization: 'سازمانی',
  end_user: 'مشتری نهایی',
};

// ── سگمنت B2B (بازرگانی): دولتی / خصوصی / همکار ──
export const SEGMENT_LABELS: Record<string, string> = {
  government: 'دولتی',
  private: 'خصوصی',
  partner: 'همکار / نماینده',
};

// ── خوش‌حسابی ──
export const PAYMENT_BEHAVIOR_LABELS: Record<string, string> = {
  good_payer: 'خوش‌حساب',
  bad_payer: 'بدحساب',
  unknown: 'نامشخص',
};

// ── خدمات پس از فروش ──
export const TICKET_TYPE_LABELS: Record<string, string> = {
  repair: 'تعمیر',
  maintenance: 'سرویس دوره‌ای',
  installation: 'نصب و راه‌اندازی',
  training: 'آموزش',
  replacement: 'تعویض',
};

export const TICKET_STATUS_LABELS: Record<string, string> = {
  open: 'باز',
  in_progress: 'در حال انجام',
  waiting_parts: 'در انتظار قطعه',
  resolved: 'حل شده',
  closed: 'بسته شده',
  rejected: 'رد شده',
};

export const TICKET_PRIORITY_LABELS: Record<string, string> = {
  low: 'کم',
  normal: 'معمولی',
  high: 'زیاد',
  critical: 'بحرانی',
};

export const WARRANTY_STATUS_LABELS: Record<string, string> = {
  in_warranty: 'در گارانتی',
  out_of_warranty: 'خارج از گارانتی',
  unknown: 'نامشخص',
};

// ── باشگاه مشتریان ──
export const LOYALTY_REASON_LABELS: Record<string, string> = {
  purchase: 'خرید',
  redeem: 'استفاده از امتیاز',
  manual: 'دستی',
  referral: 'معرفی مشتری',
  adjustment: 'اصلاح',
  good_payer_bonus: 'پاداش خوش‌حسابی',
};

// ════════════════════════════════════════════════════════════
//  WARRANTY — گارانتی سریال‌محور
//  گارانتی = تاریخ فروش سریال + ماه‌های گارانتی محصول
// ════════════════════════════════════════════════════════════
export function computeWarranty(
  soldAt: Date | string | null,
  warrantyMonths: number,
): { warrantyUntil: Date | null; warrantyStatus: 'in_warranty' | 'out_of_warranty' | 'unknown'; daysLeft: number | null } {
  if (!soldAt) return { warrantyUntil: null, warrantyStatus: 'unknown', daysLeft: null };
  const base = typeof soldAt === 'string' ? new Date(soldAt) : soldAt;
  const until = new Date(base.getTime());
  until.setMonth(until.getMonth() + (warrantyMonths > 0 ? warrantyMonths : 12));
  const now = Date.now();
  const daysLeft = Math.ceil((until.getTime() - now) / 86400000);
  return {
    warrantyUntil: until,
    warrantyStatus: until.getTime() >= now ? 'in_warranty' : 'out_of_warranty',
    daysLeft,
  };
}

// ════════════════════════════════════════════════════════════
//  TIERED PARTNER PRICING — قیمت پلکانی همکاران
//  بهترین پلکان = بزرگ‌ترین minQty که کمتر یا مساوی تعداد باشد
// ════════════════════════════════════════════════════════════
export interface PriceTier {
  minQty: number;
  price: number;
  commissionPercent?: number;
  discountPercent?: number;
  active?: boolean;
}

export function resolveTier<T extends PriceTier>(tiers: T[], qty: number): T | null {
  const eligible = tiers.filter((t) => (t.active === undefined || t.active) && t.minQty <= qty && t.minQty > 0);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, t) => (t.minQty > best.minQty ? t : best));
}

/** درصد تخفیف مؤثر پلکان نسبت به قیمت عمومی */
export function tierDiscountPercent(partnerPrice: number, publicPrice: number): number {
  if (!publicPrice || publicPrice <= 0) return 0;
  return Math.max(0, Math.round((1 - partnerPrice / publicPrice) * 100));
}
