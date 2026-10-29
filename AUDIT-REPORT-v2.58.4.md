# گزارش ممیزی — BGL CRM v2.58.4

> ورودی: ممیزی مستقل کاربر روی v2.58.3 با ۹ محور یافتهٔ رگرسیون.
> روش: هر یافته ابتدا روی کد واقعی HEAD بازتولید و تأیید شد، سپس اصلاح ریشه‌ای + آزمون «اول قرمز، بعد سبز».
> بهبودهای سالم v2.58.3 (قلمرو، تراکنش پرداخت، SSRF پایه، Timeout، چرخهٔ عمر فایل) دست‌نخورده ماند.

## جدول یافته‌ها

| # | محور | وضعیت | محل اصلاح | آزمون الزامی |
|---|------|--------|-----------|---------------|
| ۱ | مالکیت پرداخت‌های کارتابل (finance_write تنها کافی نبود) | FIXED | `src/lib/cartable-payments.ts` + مهاجرت `v2614_payment_creator` | `tests/cartable-payment-ownership.test.ts` |
| ۲ | مجوز مدیریت پرامپت‌های سراسری AI | FIXED | `src/app/api/ai-bridge/route.ts` (دسترسی `ai_prompt_manage`، سقف ۲۰۰/۲۰٬۰۰۰ نویسه) | `tests/ai-prompt-permissions.test.ts` |
| ۳ | حفاظت دادهٔ بازدیدها در برابر JSON خراب | FIXED | `src/app/api/visits/route.ts` (لغو Mutation + حفظ بایت‌به‌بایت + `VISITS_BLOB_CORRUPT [reqId]`) | `tests/visits-integrity.test.ts` |
| ۴ | نرمال‌سازی نقش‌ها (legacy → canonical) | FIXED | `src/lib/roles.ts` + `src/lib/auth.ts` (~۲۵ فایل از `getCanonicalRole` عبور کردند) | `tests/role-canonical.test.ts` |
| ۵ | اعتبارسنجی نوع-اول فروش (quantity/unitPrice/discount/applyVat) | FIXED | `src/lib/sales-totals.ts` (`assertApplyVatBoolean` در create/quick-sale/update) | `tests/sales-strict-validation.test.ts` |
| ۶ | سیاست خطای نوع-محور (فقط ApiError به مشتری) | FIXED | `src/lib/api-error.ts` (heuristic زبان حذف شد؛ جزئیات فقط در لاگ سرور با reqId) | `tests/api-error.test.ts` |
| ۷ | SSRF کامل (IPv6/CIDR/mapped/rebinding/بدون Redirect) | VERIFIED | `src/lib/ssrf-guard.ts` + `src/lib/safe-outbound.ts` (از v2.58.3 سالم بود) | `tests/ssrf-guard.test.ts` (شامل `fe90::1` و `febf::1`) |
| ۸ | چرخهٔ عمر فایل (sweep + دانلود استریمی) | FIXED | `src/lib/file-lifecycle.ts` + `src/app/api/files/route.ts` + هدف npm `files:sweep` | `tests/file-lifecycle*.test.ts` |
| ۹ | مجموعهٔ تست رگرسیون | DONE | ۵ فایل تست جدید + به‌روزرسانی‌ها؛ Security / Data Integrity / Validation / Compatibility / Concurrency | ۹۱۸ آزمون در ۶۵ فایل |

## گیت‌های نهایی (اجرای واقعی روی HEAD)

- TypeScript: صفر خطا
- ESLint: صفر خطا / صفر هشدار
- Vitest: **۹۱۸/۹۱۸** در ۶۵ فایل
- `next build`: موفق

## قراردادهای آگاهانه (تغییر رفتار مستند)

- کارتابل کراس-شرکتی → `403 COMPANY_ACCESS_DENIED` (بازگردانی قرارداد v2.58.2؛ مسیر sales همچنان 404 می‌ماند)
- سلب مالکیت پرداخت → `403` (قرارداد files-route)
- انکار مجوز پرامپت → `403` برای کاربر غیرمجاز
- blob خراب بازدیدها → خواندن = نمای خالی؛ نوشتن = `500` کنترل‌شده (دادهٔ اصلی حفظ می‌شود)

## تغییرات قراردادی برای نصب‌های موجود (UPGRADING.md)

- مهاجرت `v2614_payment_creator` ستون nullable `createdById` به `SalesDocumentFinance` اضافه می‌کند — غیرمخرب؛ دادهٔ موجود تغییری نمی‌کند.
- نقش‌های میراثی (`administrator`، `financial`، `production_unit`) حالت کانونیک می‌گیرند؛ ردیف‌های DB دست‌نخورده می‌مانند.

## اجرا نشده (صادقانه)

- تست دستی مرورگر روی ویندوز واقعی (cmd/batch) — معادل اسکریپتی `verify-install` پوشش داده شده است.
- ضبط زندهٔ میکروفن در محیط headless (سیاست CSP `microphone=(self)` کد-سطح راست‌آزمایی شده).
