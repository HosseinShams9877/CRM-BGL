# گزارش ممیزی و آمادگی Production — BGL CRM نسخهٔ ۲٫۵۸٫۷
**دور ۹۴ — Production Readiness Review & Hardening** (سپردن تشخیص: تیم پنج‌نقشی معمار ارشد نرم‌افزار / مهندس امنیت کاربرد / سرپرست بک‌اند / مهندس دیتابیس / سرپرست اتوماسیون QA)

---

## ۱. روش ممیزی

ممیزی مستقلِ سطح-اکشن روی **کد واقعی** (نه worklog، نه comment، نه وجود helper): هر مسیر حساس API در حسابداری، فروش، انبار، پیگیری، فعالیت‌ها، هوش مصنوعی، فایل، پیامک و خدمات پس از فروش با پنج سنجه بررسی شد — (A) احراز هویت، (B) مجوز نقش، (C) حوزهٔ شرکت، (D) حوزهٔ قلمرو، (E) مالکیت منبع. برای هر یافتهٔ gap، رفتار روی کد قبل از اصلاح شخصاً بازتولید/ردیابی شد (خط‌به-خط با شماره خط)، سپس با «تست رگرسیون روی رفتار جدید → اصلاح → همان تست سبز» بسته شد. **قواعد محافظ**: بدون مهاجرت مخرب، DB عملیاتی هرگز لمس نشد (همهٔ تست‌ها و گیت‌ها روی fixture/کپی آزمایشی)، تست سالم حذف/skip نشد، secret نمایش داده نشد.

## ۲. جدول یافته‌ها (۱۲ مورد — همه CONFIRMED و بسته‌شده)

| # | یافته | شدت | وضعیت | اصلاح (مسیر واقعی) | شاهد رگرسیون |
|---|---|---|---|---|---|
| G1 | فروش سریع (quick-sale) بدون گارد قلمرو — صدور فاکتور تأییدشده + پرداخت + امتیاز + ارسال خودکار برای مرکز خارج از حوزهٔ کارشناس scope-دار | CRITICAL | CONFIRMED→FIXED | sales-documents/route.ts — هر دو مسیر مشتری (centerId + موبایل) با `assertTerritoryAccess` (404 بدون افشا) | tests/sales-docs-territory-hardening.test.ts (۸ تست؛ شمارش صفر نوشتار مالی) |
| G2 | قیمت همکار (PartnerPrice) گروه-سراسری قابل جهش توسط «هر» فروشنده استاندارد (gite product_create‖finance_write هر دو true)؛ resolve مرکز فقط BU — نشت نام/کمیسیون بین‌شرکتی | CRITICAL | CONFIRMED→FIXED | partner-pricing/route.ts — جهش‌ها از `assertPermission(accounting_cartable)` (مالی/مدیر)؛ resolve scope شرکت | tests/partner-pricing-security.test.ts (۸) |
| G3 | واحد تولید: update-status/list-inbox بدون فیلتر شرکت — نوشتن بازتر از خواندن | HIGH | CONFIRMED→FIXED | production/route.ts — fragment اختیاری شرکت در هر دو (صف مشترک null دست‌نخورده) | tests/production-scope.test.ts (۴) |
| A4 | update/submit-approval/cancel سند + انتقال مرکز بدون قلمرو (مسیرهای خود-سند) | HIGH | CONFIRMED→FIXED | sales-documents/route.ts — territory در findDocOrThrow×۳ + گارد مرکز جدید | همان فایل تست (۵) |
| A5 | label/issue-label-serials ارسال بدون قلمرو — نوشتن (backfill dispatch + سریال کارتن) | MEDIUM | CONFIRMED→FIXED | shipments/route.ts — fragment قلمرو در loadLabelDocOrThrow (شکل درونی سازگار SalesDocument) | tests/shipments-label-territory.test.ts (۳) |
| A6 | هر سه مسیر ویس فعالیت بدون قلمرو (ایجاد/تبدیل/پخش) | MEDIUM | CONFIRMED→FIXED | activities/voice/route.ts — activityTerritoryWhere + گارد مرکز | tests/voice-route-hardening.test.ts (۷) |
| A7 | تغییر رمز «خود» از مسیر users بدون رمز فعلی (نشست ربوده = قفل دائمی مالک) | MEDIUM | CONFIRMED→FIXED | users/route.ts — currentPassword اجباری برای self (400/403)؛ ریست مدیر دست‌نخورده | tests/users-self-password.test.ts (۴) |
| A8 | chat پل AI بدون مجوز + پیام بی‌کران (خرج کلید سازمانی توسط نقش‌های بدون ai_*) | MEDIUM | CONFIRMED→FIXED | ai-bridge/route.ts — گیت ai_calls_read + سقف ۸٬۰۰۰ نویسه + سقف system_prompt | tests/ai-bridge-chat-hardening.test.ts (۶) |
| S1 | کل انتگراسیون حسابفا با fetch خام (بدون گارد SSRF؛ redirect دنبال می‌شود؛ credential در body به مقصد مهاجم) | HIGH | CONFIRMED→FIXED | hesabfa-client.ts — safeOutboundFetch (DNS pin + بدون redirect + blocklist + deadline/size)؛ نگاشت خطا: timeout/network = retryable، رد گارد = غیر-retryable | tests/hesabfa-ssrf-hardening.test.ts (۱۶ — رد ۱۰ هدف خصوصی قبل از اتصال) + tests/hesabfa-readonly.test.ts (۱۵) |
| S2 | connection-set حسابفا هر baseUrlی را ذخیره می‌کرد (بدون پارس/پروتکل) | HIGH | CONFIRMED→FIXED | hesabfa/route.ts — اعتبارسنجی URL در ذخیره (همان بهداشت پل AI) | همان فایل تست |
| V1 | مسیر «خواندن» بازدیدها خرابی JSON را به [] خاموش تبدیل می‌کرد (نقاب فساد تا اولین بازنویسی)؛ جهش 500 بود نه 409 | MEDIUM | CONFIRMED→FIXED | visits/route.ts — قرارداد 409 برای جهش (ماتریس الزامی) و کنترل‌شده برای خواندن؛ هرگز [] خاموش | tests/visits-integrity.test.ts (۱۰ — به‌روزشده بدون تضعیف) |
| F1 | مسیر ویس: نوشتن فایل نهایی قبل از ردیف‌های DB بدون rollback — پنجرهٔ فایل orphan | HIGH | CONFIRMED→FIXED | activities/voice/route.ts — storeFileLifecycle + جبران (شکست activity-create = حذف فایل)؛ پخش استریم؛ MIME واقعی صوت | tests/voice-route-hardening.test.ts (تریگر واقعی SQLite → صفر residue) |
| F4 | MIME فقط ادعایی (بدون magic bytes) | MEDIUM | CONFIRMED→FIXED | storage.ts — sniffContentMime/verifyUploadContent/verifyAudioContent؛ سیم‌کشی files/calls-upload/voice | tests/file-mime-sniff.test.ts (۱۴) |
| F5 | فایل فیزیکی بی‌ردیف هرگز جمع نمی‌شد (فقط شمارش) | LOW | CONFIRMED→FIXED | file-lifecycle.ts — sweepOrphanFinalFiles (مهلت ۱h، گارد شکل، .part/ردیف دست‌نخورده) + CLI --prune-orphans | tests/orphan-file-prune.test.ts (۳) |
| F3 | جاروی pending با path.join خام (فرار نام مسموم از پوشهٔ storage) | LOW | CONFIRMED→FIXED | file-lifecycle.ts — resolveStoredPath سخت‌گیرانه در sweep | tests/file-lifecycle.test.ts (موجود) + prune |
| D1 | ServiceTicket.cost آخرین پول بدون invariant ریال-صحیح (safeFloat کسر می‌پذیرفت) | LOW | CONFIRMED→FIXED | after-sales/route.ts — parseIntRial در update/resolve (400 قبل از نوشتن) | رگرسیون after-sales موجود + قرارداد |
| D2 | AiCustomerMemory بدون unique (contactId نال) + دو مسیر findFirst→create — نسل دو-ردیفی در هم‌زمانی | MEDIUM | CONFIRMED→FIXED (کد) | memory-dedupe.ts — reconcile درون-تراکنشی keep-latest در موتور (fencedTx) و مسیر دستی ($transaction) | tests/memory-dedupe.test.ts (۴) |
| I2 | هیچ ثبت/مشاهده‌پذیری الگوهای تزریق پرامپت | MEDIUM | CONFIRMED→FIXED | ai/prompt-injection.ts — ۸ الگوی EN/FA، سیاست فقط-ثبت، رویداد امنیتی با pattern-id+hash (بدون متن خام) در chat/save-prompt/system_prompt | ai-bridge-chat-hardening (۳ تست مخصوص) |

**مسیرهای راستی‌آزمایی‌شده و سالم (بدون تغییر لازم)**: accounting-cartable (ماتریس مالکیت درون-تراکنش)، billing، orders، inventory، products، centers، followups، activities، pipeline، after-sales، loyalty، ai-sales×۹ (گیت‌های hasAiPermission + scope + IDOR)، users/impersonation/sessions، settings، backup، files، sms، mail، notes، hesabfa خواندنی‌ها، audit، stats، reports، dashboard، companies، webhooks. ماتریس الزامی مرحلهٔ ۲ کاربر روی cartable واقعی pin شد (۹ تست).

## ۳. لایهٔ سیاست دسترسی مرکزی (الزام مرحلهٔ ۱)

`src/lib/access-policy/` — مرجع واحد پنج گارد با نام‌های خواسته‌شده: **assertPermission / assertCompanyAccess / assertTerritoryAccess / assertResourceOwnership** (+ assertCenterAccess ترکیبی). همه ApiError پرتاب می‌کنند (پاکت خطای فارسی کنترل‌شدهٔ موجود). مسیرهای اصلاح‌شدهٔ این دور مستقیماً از آن مصرف می‌کنند؛ primitiveهای company-scope/territory-scope در جای خود باقی‌اند و لایهٔ مرکزی آن‌ها را ترکیب می‌کند. رگرسیون: tests/access-policy.test.ts (۱۷ تست).

## ۴. دیتابیس

- **مهاجرت جدید: هیچ** (۱۷ مهاجرت دست‌نخورده؛ db:deploy روی کپی آزمایشی = «No pending migrations»). rollback پرسش نمی‌شود چون schema تغییر نکرد.
- **Float و پول**: ۲۴ ستون Float پولی ممیزی شد — core (فاکتور/پرداخت/قیمت) با invariant «ریال صحیح در مرز نوشتن» (money.ts + اعتبارسنجی مسیرها؛ این دور آخرین استثنا ServiceTicket.cost هم بسته شد). ذخیره‌سازی Float عمدی و مستند است (ریال کسر ندارد؛ اعداد صحیح < 2⁵³ در float64/دقیق). **طرح مهاجرت پیشنهادی (بدون اجرا)**: انتقال ستون‌های پولی core به INTEGER affinity بدون تبدیل داده (مقادیر همین حالا صحیح‌اند) — ۱۱ جدول؛ قابل rollback با بازگرداندن نوع؛ مستند در بایگانی. کش‌های Hesabfa و AiUsageLog (مشتق/فقط‌خواندن) Float می‌مانند.
- **AiCustomerMemory unique**: طرح مهاجرت (dedupe keep-latest + ایندکس یکتای جزئی WHERE contactId IS NOT NULL) مستند شد؛ **بدون اجرا** («بدون تست تغییر نده») — ریسک دادهٔ زنده + محدودیت NULL در SQLite. عوضش reconcile درون-تراکنشی در کد، هر دو مسیر نوشتن.
- **Cascadeهای خطرناک بالقوه** (Center→CenterAccount Cascade، SalesDocument→financeRecords Cascade، IssuedInvoice→payments Cascade): فقط در صورت حذف فیزیکی والد فعال می‌شوند — امروز هیچ مسیر API حذف والد ندارد (archive/void/cancel). گزارش داده شد؛ توصیه: Restrict در مهاجرت آتی.
- ۲ ردیف فایل بدون محتوا و ۸ سند حسابی بدون حساب مرکزی: **فقط گزارش** (قاعدهٔ کاربر: بدون اطلاعات معتبر، حذف/اصلاح حدسی ممنوع).

## ۵. کارایی (مرحلهٔ ۸ — گزارش)

اصلاح‌شده: حذف کوئری مردهٔ stats.ts (اسلات ۸ Promiseall دورانداخته — یک findMany بی‌کران در هر view داشبورد)؛ پخش ویس استریمی؛ پایان readFileSync در مسیر پخش. **گزارش باقی‌مانده (خارج از scope، اولویت‌بندی‌شده)**: ۱) گزارش‌های تجمیعی بدون صفحه‌بندی/پنجرهٔ تاریخ پیش‌فرض (reports/route.ts اکشن‌های متعدد) ۲) N+1 سینک حسابفا (upsert سطری در درخواست HTTP) ۳) blob واحد بازدیدها (Meta) ۴) اسکن description contains در sales-metrics. هیچ‌کدام data-loss یا امنیتی نیستند؛ برای نسخهٔ بعدی.

## ۶. گیت‌های انتشار (خروجی واقعی، محیط: Linux sandbox، Node 24، SQLite)

| گیت | نتیجه | خروجی |
|---|---|---|
| `npm ci` | ✅ PASS | exit 0 |
| `npm run db:generate` | ✅ PASS | exit 0 |
| `npm run db:deploy` (روی کپی آزمایشی dev.db) | ✅ PASS | 17 migrations، no pending |
| `npm test` | ✅ PASS | **۱۱۰۵/۱۱۰۵ آزمون، ۹۰ فایل** (۰۰ خطای شبکه واقعی — فقط stub شبکه/ذخیره‌سازی) |
| `npx tsc --noEmit` | ✅ PASS | 0 خطا |
| `npm run lint` | ✅ PASS | ۰ خطا / ۰ هشدار |
| `npm run build` | ✅ PASS | exit 0 (+postbuild static) |
| `npm run test:api` | ✅ PASS | 38/38 (سرور production روی کپی آزمایشی، پورت ۳۱۰۰) |
| `npm run test:e2e` | ✅ PASS | 11/11 (صفر خطای کنسول؛ RTL) |
| `npm run test:restore` | ✅ PASS | 17/17 (رفت‌وبرگشت واقعی؛ بستهٔ دستکاری‌شده رد) |
| `npm run test:conn` | ✅ PASS | 12/12 (integrity/FK/مهاجرت/health/origin-less 403/login 401) |

- DB عملیاتی `prisma/dev.db` در کل دور **لمس نشد** (mtime و hash ثابت؛ git clean). گیت‌های runtime روی `/tmp` کپی آزمایشی اجرا شدند و پاک شدند.
- **NOT RUN (صادقانه)**: ویندوز واقعی (setup.bat/EBUSY) — معادل لینوکسی اجرا شد؛ بارگذاری واقعی زیر load تولیدی.

## ۷. فایل‌های تغییرکرده (۳۵ فایل کد/تست + ۶ هویت نسخه)

- **جدید (۵)**: `src/lib/access-policy/index.ts`، `src/lib/ai/prompt-injection.ts`، `src/lib/ai/memory-dedupe.ts`، + ۱۳ فایل تست جدید (فهرست در §۲).
- **ویرایش مسیرها (۱۵)**: sales-documents، partner-pricing، production، shipments، activities/voice، users، ai-bridge، ai-sales/calls/upload، ai-sales/memory، files، hesabfa، visits، after-sales، + lib: hesabfa-client، storage، file-lifecycle، ai/engine/memory، ai/engine/stats، scripts/files-health.
- **هویت نسخه**: package.json، package-lock، sidebar، WINDOWS.md، setup.bat، setup.sh. **مهاجرت: صفر**.

## ۸. تغییرات قراردادی هنگام ارتقا (v2.58.6 → v2.58.7) — بدون نیاز به اقدام دادهٔ

۱) جهش‌های قیمت همکار → فقط مالی/مدیر (خطای 403 برای فروشنده) ۲) تغییر رمز خود از مسیر users → رمز فعلی لازم (UI از قبل از /api/auth می‌فرستد؛ بدون تغییر کامپوننت) ۳) بازدید خراب در «لیست» → خطای 409 کنترل‌شده به‌جای لیست خالی ۴) بارگذاری با محتوای ناهم‌خوان با ادعای MIME → 400 ۵) chat پل AI برای نقش‌های بدون ai_calls_read → 403 ۶) PRAGMA/کلید: هیچ. **Rollback**: برگرداندن کد نسخهٔ قبلی کافی است (بدون مهاجرت).

## ۹. مسائل باقی‌مانده

۱) آیتم‌های کارایی §۵ (غیر امنیتی) ۲) طرح‌های مهاجرت مستندشده (INTEGER affinity پول core؛ unique حافظهٔ مشتری + Restrict روی cascadeهای مالی) — تصمیم انتشار جداگانه ۳) ۸ سند حسابی بدون حساب مرکزی و ۲ ردیف فایل بدون محتوا (فقط گزارش، مطابق قاعده) ۴) NOT RUN ویندوز ۵)abbai کیفیت: هم‌زمانی کامل SQLite از serialization درست می‌آید؛ بار سنگین تولیدی روی ویندوز تست نشده.

## ۱۰. امتیاز و حکم آمادگی

- **امتیاز امنیتی: ۹٫۱ / ۱۰** — کسر: بار تولیدی/ویندوز تست‌نشده (۰٫۴)، بدهی کارایی گزارشی (۰٫۳)، نبود unique در سطح DB برای حافظهٔ مشتری (۰٫۲) — هر سه مستند و برنامه‌ریزی‌شده، هیچ‌کدام مسیر سوءاستفادهٔ عملی باز نمی‌گذارند.
- **شروط الزami کاربر**: مجوزدهی کامل (۵ سنجه × همهٔ مسیرهای حساس — این دور ۱۲ gap بسته شد) ✅ · ریسک از دست رفتن داده ندارد (مسیرهای مخرب حذف نداریم؛ cascadeها dormant؛ بازدید fail-closed؛ فایل lifecycle+جبران) ✅ · تست‌های امنیتی سبز (۱۱۰۵/۱۱۰۵) ✅ · مهاجرت قابل rollback (مهاجرتی نیست) ✅ · secret در release نیست (چرخش رمز بسته، .env خارج از بسته) ✅.
- **حکم: پروژه Production Ready است** — با دو توصیهٔ عملیاتی: (الف) `npm run files:health -- --sweep` را در Task Scheduler/cron بگذارید (بازیابی pending + orphan)؛ (ب) لاگ‌های رویداد AI_PROMPT_INJECTION_SUSPECTED را ماهانه بازبینی کنید.
