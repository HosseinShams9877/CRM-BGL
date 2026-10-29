# گزارش ممیزی و اصلاح — BGL CRM v2.58.1 (دور ۸۶)

> روش: هر یافتهٔ ممیزی خارجی (v2.58.0) مستقلاً **بازتولید** شد؛ سپس اصلاح ریشه‌ای، سپس آزمون اختصاصی، سپس ممیزی مجدد مسیرهای موازی (§۱۲ کاربر). وضعیت‌ها: PASS = اثبات‌شده با اجرا · NOT RUN = محیط اجازه نداد.

## جدول یافته‌ها

| شناسه | شدت | علت ریشه‌ای | فایل و تابع | اصلاح | آزمون | نتیجه | محدودیت |
|---|---|---|---|---|---|---|---|
| F1 | بحرانی | `handleMarkPaid` وضعیت را بدون رسید/همگام‌سازی/بازمحاسبه فلیپ می‌کرد | `api/billing/route.ts` handleMarkPaid | تسویه از سرویس مشترک `registerInvoicePayment` (source=settlement) با رسید واقعی مانده + آینهٔ سند + recalc در یک تراکنش؛ no-op برای تسویه‌شده؛ ابطال پرداخت نمی‌پذیرد؛ UI: دکمهٔ «دریافت مانده و تسویه» | billing-payments.test.ts (۳ تست) + verify-api.mjs (۴ چک): receipts==paidAmount==حساب مرکز، بدون رسید تکراری | PASS | — |
| F2 | بحرانی | چک مانده بیرون تراکنش با paidAmount کهنه؛ دو پرداخت ۶۰+۶۰ روی ۱۰۰ هر دو موفق | api/billing/route.ts handleAddPayment + (ممیزی مجدد) accounting-cartable add-payment | بازخوانی فاکتور/سند/مانده **داخل تراکنش**؛ idempotency کلیددار با `UNIQUE(userId,idemKey)` (جدول v2590)؛ چک‌های advisory فقط برای درخواست بدون کلید؛ گارد in-tx در cartable | billing-payments.test.ts (رقابت واقعی SQLite) + verify-api.mjs: ۶۰+۶۰→یکی؛ ۴۰+۶۰→۱۰۰+paid؛ replay→یک رسید؛ کلید متفاوت→۴۰۹؛ rollback بدون اثر ناقص | PASS | — |
| F3 | بالا | totalAmount/totalPrice کلاینت بی‌راستی‌آزمایی؛ quantity=-2 پذیرفته می‌شد | api/billing/route.ts handleCreate | validator مشترک ردیف (مثبت/صحیح-ریال/سقف/طول/۵۰۰ ردیف) + محاسبهٔ سرورِ totalPrice ردیف و جمع کل + تطبیق اجباری جمع=کل؛ P2002 شمارهٔ تکراری→۴۰۰؛ تاریخ نامعتبر→۴۰۰ | verify-api.mjs (۴ چک) + validateInvoiceItems unit (۴ تست) | PASS | — |
| F4-الف | بالا | files API قلمرو فروش را بررسی نمی‌کرد | api/files/route.ts canAccessCenter/list | قلمرو (centerTerritoryWhere + centerInTerritory) در همهٔ نقطه‌ها | verify-api.mjs: آپلود خارج از قلمرو ۴۰۳؛ لیست scope-شده | PASS | — |
| F4-ب | بالا | upload_files برای حذف کافی بود؛ مالکیت کنترل نمی‌شد | api/files/route.ts handleDelete | حذف = فقط فایل‌های خود کاربر (یا admin) | verify-api.mjs: حذف فایل همکار → ۴۰۳ | PASS | — |
| F4-ج | بالا | `role==='admin'` bypass کامل (فایل‌های شرکت مستقل یاس‌طب برای مدیر گروه نمایان) | api/files/route.ts گاردها | مدیر = scope شرکت‌های غیرایزوله (getAllowedCompanyIds) | verify-api.mjs: لیست مدیر بدون فایل یاس‌طب؛ حذف→۴۰۳ | PASS | — |
| F4-د | بالا | `docTerritoryOr` = «سازندهٔ من OR مرکز در قلمرو» — استان، اسناد همکاران را می‌داد | lib/territory-scope.ts + sales-documents list/get | `docOwnershipTerritoryWhere` = «سازندهٔ من AND مرکز در قلمرو»؛ findDocOrThrow بدون بسط قلمرو؛ توازن لیست/جزئیات | territory-scope.test.ts (بازنویسی) + verify-api.mjs: سند همکارِ همان-قلمرو → ۴۰۴/غایز در لیست | PASS | — |
| F4-هـ | بالا | مسیر حسابداری مالکیت سند را مثل فروش اعمال نمی‌کرد | api/billing/route.ts | `checkInvoiceOwnership` (فاکتور خودم یا آینهٔ سند خودم) در list/get/add-payment/mark-paid؛ ۴۰۴ بدون نشت | verify-api.mjs: کارشناز دیگر پرداخت/تسویه فاکتور مالی نمی‌کند؛ لیست‌ها scope-شده | PASS | — |
| F5 | بالا | v2580 (۱۲:۰۰) قبل از v2570 (۲۳:۰۰ = سازندهٔ جدول) مرتب می‌شد → `no such index` در نصب خالی | prisma/migrations | انتقال دو دستور HesabfaContact به v2581 (خودتوان، بعد از v2570) | نصب خالی: ۱۱/۱۱ migrations · ارتقای کپی DB موجود: no-op + status پاک · DB زنده ارتقا یافت | PASS | — |
| F6 | متوسط | `npx` بدون `call` (کنترل منتقل می‌شود)، بدون set -e، seed با `update: profile` ویرایش‌ها را بازنویسی می‌کرد، engines 20.6 | setup.bat / setup.sh / prisma/seed.ts / package.json | `call` + `cd /d %~dp0` + seed fatal + Node≥20.9؛ set -e؛ seed create-only | بازبینی کد + اجرای seed روی DB زنده (بدون تغییر پروفایل شرکت‌ها) | PASS (لینوکسی) | **ویندوز واقعی: NOT RUN** — محیط لینوکسی؛ منطق `call`/errorlevel استاندارد cmd است |
| F7 | بالا | دکمهٔ پشتیبان به export ناقص (سقف ۲۰۰۰) وصل بود؛ manifest از DB زنده؛ Restore بدون فایل/اعتبارسنجی/بازگشت | sales-settings / api/backup / backup-snapshot.ts / restore-backup.mjs | بستهٔ کامل (DB+فایل+manifest از snapshot)؛ دکمهٔ عملیاتی؛ خروجی JSON با برچسب صادقانه؛ Restore با اعتبارسنجی sha256+شکل نام، پشتیبان pre-restore، staging+rollback، گزارSHA-نیاز محرمانه مستند | verify-restore.mjs **۱۷/۱۷** (بازیابی روی محیط خالی، تطبیق شمار/روابط/checksum، رد بستهٔ دستکاری‌شده و path-traversal) + مسیر API روی DB عملیاتی | PASS | — |
| F8 | متوسط | `microphone=()` تعارض با getUserMedia؛ stream در unmount باز می‌ماند | next.config.ts / quick-activity.tsx | `microphone=(self)`؛ توقف مستقیم رکوردر+tracks در cleanup؛ پیام‌های خطای متمایز | بازبینی کد + build (هدر در هر پاسخ)؛ آزمون ضبط مرورگری واقعی **NOT RUN** (محیط headless بدون میکروفن) | PASS (پیکربندی) / NOT RUN (ضبط زنده) |
| F9 | متوسط | اهداف تست به فایل‌های غایب اشاره می‌کردند؛ setup تست DB عملیاتی را checkpoint می‌کرد و workerها مسابقه می‌دادند؛ ۲ رکورد فایل بدون محتوا | package.json / tests/setup.ts / — | اهداف واقعی: verify-browser/api/install/restore (در ZIP)؛ globalSetup+per-worker DB؛ files-health.mjs | ۶۹۶/۶۹۶ vitest (۴۶ فایل) · verify-browser ۱۱/۱۱ · verify-api ۳۸/۳۸ · verify-install ۱۲/۱۲ · سلامت ۲ پیوست غایب گزارش شد (بدون حذف) | PASS | — |

## ممیزی مجدد (§۱۲ — پرسش‌های بستن چرخه)

- «آیا مسیر دیگری همان قانون را دور می‌زند؟» — نوشتن پرداخت فقط از سرویس مشترک + مسیرهای گاردشدهٔ sales-documents/cartable (cartable در همین دور گارد in-tx گرفت). نوشتن رکورد فایل در مسیرهای voice/ai-calls از همان قواعد scope+مالکیت فایل‌ها خوانده می‌شود.
- «آیا کنترل فقط بیرون تراکنش است؟» — خیر؛ بازخوانی و چک مانده داخل تراکنش‌اند (آزمون رقابت واقعی).
- «آیا retry عملیات مالی را تکرار می‌کند؟» — هیچ retry ای در مسیر مالی وجود ندارد (تک‌شلی + idempotency در سطح DB).
- «آیا گزارش‌ها با منابع مالی سازگارند؟» — گزارش وصول از همان ردیف‌های IssuedInvoicePayment و recalc مرکز تغذیه می‌شود؛ سازگاری paidAmount==Σرسید==حساب مرکز در تست‌ها اثبات شد.
- «آیا محدودیت UI با درخواست مستقیم قابل دورزدن است؟» — ماتریس دسترسی verify-api همه قواعد را از API مستقیم آزمود و رد شد.
- «آیا نصب تازه، ارتقا و Restore هر سه کار می‌کنند؟» — بله؛ هر سه اجرا و سبز (نصب خالی ۱۱/۱۱، ارتقا no-op سالم، Restore ۱۷/۱۷).
- «آیا شکست عملیات پیام موفقیت تولید می‌کند؟» — setup fail-fast شد؛ بستهٔ پشتیبان نامعتبر «ساخته شد» نمی‌گوید؛ Restore شکست‌خورده rollback می‌کند.

## باقی‌مانده‌ها و ریسک‌ها (صادقانه)

1. **۲ رکورد فایل بدون محتوای فیزیکی** در دیتابیس شما (ویس‌های آزمونی 2026-08-30، مرکز C1217): گزارش شد، حذف نشد. پاک‌سازی اختیاری: `node scripts/files-health.mjs --prune`.
2. **۸ فاکتور بدون حساب مشتری** (میراث دادهٔ قبل از v2.13): قابل مشاهده/تسویه نیستند چون centerless → فقط admin با پیام شرکت. ترمیم دادهٔ اختیاری است (تعیین حساب مرکز برای آن‌ها).
3. **آزمون ویندوز واقعی** (setup.bat روی cmd واقعی) و **ضبط میکروفن زنده**: NOT RUN در این محیط.
4. **پول Float** (به‌جای Decimal/BigInt): سیاست پروژه integer-Rial با اعتبارسنجی مرزی است (SECURITY.md) — تغییر نوع ستون‌ها مهاجرت بزرگ می‌خواهد و در این محدوده انجام نشد.
5. محدودیت ۴۲۹ محیط sandbox در تست‌های پشت‌سرهم (پنجرهٔ ۶۰ ثانیه‌ای) — محدودیت محیط، نه اپ.
