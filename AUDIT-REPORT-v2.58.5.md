# گزارش ممیزی مجدد — BGL CRM v2.58.5 (دور ۹۲)

> ورودی: ممیزی مستقل کاربر روی v2.58.4 با ۷ یافتهٔ باقی‌مانده (R1 تا R7).
> روش: هر یافته ابتدا روی کد واقعی بازتولید و با وضعیت CONFIRMED / NOT REPRODUCED ثبت شد؛ سپس چرخهٔ «تست شکست روی کد قبلی → اصلاح ریشه‌ای → همان تست سبز → بررسی مسیرهای مشابه → آزمون رگرسیون» اجرا شد. هیچ تست معنی‌داری حذف یا skip نشد؛ کنترل دسترسی، اعتبارسنجی، TypeScript و ESLint ضعیف نشدند.

## جدول یافته‌ها

| # | محور | وضعیت | ریشه | محل اصلاح | آزمون الزامی |
|---|------|--------|------|-----------|---------------|
| R1 | replay پرداخت بدون بررسی دسترسی جاری | CONFIRMED | مسیر idempotency پیش از گاردها return می‌کرد | `src/lib/cartable-payments.ts` + `src/lib/invoice-payments.ts` (گاردها به قبل از افشای نتیجه منتقل شد؛ سیاست وضعیت/مانده فقط برای پول تازه) | `tests/idempotent-replay-access.test.ts` (۶) |
| R2 | کلید تازه در هر submit فرم | CONFIRMED | `crypto.randomUUID()` داخل بدنهٔ submit | `src/lib/payment-idempotency.ts` (موتور مشترک) + `sales-collections.tsx` (فرم واقعی + ref والد) | `tests/payment-key-stability.test.ts` (۴؛ با handler و سرویس واقعی، فقط شبکه stub) |
| R3 | اقدام نیمه‌تمام AI در resume اجرا نمی‌شد | CONFIRMED | `continue` در مسیر resume | `src/lib/ai/engine/nba.ts` (تفکیک موجود/اجرا شده + عبور از مسیر idempotent اجرا) | `tests/nba-resume-autoexec.test.ts` (۵) |
| R4 | نوشتن‌های پردازش AI بدون مالکیت lease | CONFIRMED | failRecording بدون token (خطوط ۴۱۹/۴۲۶)؛ نوشتن‌های transcript/analysis/memory/NBA/coaching بدون fence؛ شکست coaching با coachingDone=true | `src/lib/ai/engine/lease.ts` (جدید؛ fencedTx گارد اتمیک) + `pipeline.ts` + `memory.ts` + `nba.ts` (تمدید lease، token اجباری در شکست، coach-only resume، کوچینگ idempotent) | `tests/ai-fenced-writes.test.ts` (۵) |
| R5 | نشت تایمر/منابع در safe-outbound | CONFIRMED | خواندن موفق بدون cleanup؛ dispose صریح دور زننده | `src/lib/safe-outbound.ts` (finish() مشترک idempotent روی همهٔ خروجی‌ها) | `tests/safe-outbound-cleanup.test.ts` (۷؛ با تایمر جعلی و transport آزمایشی) |
| R6 | db-heal: شمارش ردیف = سکوت نویسنده؛ env-fail با exit ۰ | CONFIRMED | fingerprint شش‌جدولی؛ main بدون exit غیرصفر | `scripts/setup-db-heal.mjs` (data_version + WAL mtime/size + شمارش؛ سه‌نقطه‌ای؛ rollback کامل پس از swap؛ exit ۱ در env-fail؛ تقدم resolver مشترک) | `tests/db-heal-writer-safety.test.ts` (۶) |
| R7 | CLI فقط .env می‌خواند؛ launcher هر دو | CONFIRMED | دو پیاده‌سازی جدا | `scripts/lib/resolve-env.mjs` (جدید؛ یک قراردار: env > .env.local > .env > default + نرمال‌سازی doubled-path) + `start.mjs` + `files-health.ts` + `setup-db-heal.mjs` | `tests/resolve-env.test.ts` (۷؛ شامل اجرای CLI واقعی از cwd دیگر با مسیر دارای فاصله + درخت بایت‌به‌بایت دست‌نخورده) |

## یافتهٔ جانبی (کشف خودراستی‌آزمایی)

Prisma هنگام require، خودش `.env` دایرکتوری کاری را در `process.env` بار می‌کند و تشخیص «منبع مؤثر DATABASE_URL» را آلوده می‌کرد. ریشه‌دار شد: snapshot محیط پیش از require (`initialEnv`) در setup-db-heal.mjs — با تست رگرسیون R6.5 (خروج غیرصفر کود در .env ناخواندنی).

## گیت‌های نهایی (اجرای واقعی؛ فرمان / محیط / exit / نتیجه)

| گیت | فرمان | exit | نتیجه |
|---|---|---|---|
| نصب وابستگی‌ها | `npm ci` | ۰ | PASS |
| تولید کلاینت Prisma | `npm run db:generate` | ۰ | PASS |
| مهاجرت‌ها (DB عملیاتی) | `DATABASE_URL=file:./dev.db npm run db:deploy` | ۰ | PASS — ۱۷ مهاجرت، بدون تغییر (این نسخه مهاجرت جدید ندارد) |
| تست کامل | `npm test` | ۰ | PASS — **۹۵۸/۹۵۸ در ۷۲ فایل** (قبلاً ۹۱۸/۶۵؛ ۴۰ تست جدید در ۷ فایل) |
| TypeScript | `npx tsc --noEmit` | ۰ | PASS |
| Lint | `npm run lint` | ۰ | PASS (۰ خطا، ۰ هشدار) |
| Build | `npm run build` | ۰ | PASS (standalone + postbuild) |
| API runtime | `npm run test:api` | ۰ | PASS — 38/38 (سرور زنده روی DB عملیاتی) |
| E2E مرورگر | `npm run test:e2e` | ۰ | PASS — 11/11 |
| بازیابی پشتیبان | `npm run test:restore` | ۰ | PASS — 17/17 |
| آمادگی نصب | `npm run test:conn` | ۰ | PASS — 12/12 |

## علت تغییر تعداد تست‌ها

۹۱۸ → ۹۵۸: ۴۰ آزمون جدید در ۷ فایل (هر یافتهٔ R1-R7 آزمون‌های الزامی خود را گرفت: R1=۶، R2=۴، R3=۵، R4=۵، R5=۷، R6=۶، R7=۷). هیچ تستی حذف یا skip نشد.

## ممیزی مجدد مسیر مصرف‌کننده (پس از سبز شدن)

- فرم واقعی کلید پایدار می‌فرستد؟ بله — `sales-collections.tsx` کلید را از `submitIdempotentPayment` می‌گیرد (بدون تولید داخل submit)؛ تست R2.B همان مسیر موتور را با handler واقعی billing می‌راند و verify-browser (11/11) فرم زنده را تأیید می‌کند.
- replay واقعی کنترل دسترسی دارد؟ بله — تست R1.1/R1.2 با تغییر زندهٔ companyIds/قلمرو/مالکیت در DB واقعی.
- worker قدیمی واقعاً از تمام نوشتن‌ها منع می‌شود؟ بله — R4.1 برای هر نوع اثر (state/analysis/action/insight/failure) جداگانه LeaseLostError می‌گیرد.
- CLI واقعاً تنظیمات برنامه را مصرف می‌کند؟ بله — R7.2/R7.3: همان resolver در start.mjs و files-health؛ توافق مسیر مطلق یکسان.

## محدودیت‌های باقی‌مانده / BLOCKED

- **BLOCKED (محیطی)**: اجرای setup.bat روی ویندوز واقعی (cmd) و قفل فایل EBUSY ویندوز — در محیط لینوکسی این پروژه قابل اجرا نیست. معادل لینوکسی همهٔ مسیرها (heal، rollback، exit codes) با فرزند واقعی تست شده است.
- اجرای مستقیم `tsx scripts/files-health.ts` از پوشهٔ بیرونی نیازمند `--tsconfig` است (محدودیت کشف tsconfig در tsx)؛ از طریق `npm run files:health` (که cwd را روی ریشه می‌گذارد) بدون محدودیت است.
- ۲ رکورد فایل فاقد محتوا و ۸ فاکتور بدون حساب مرکز (میراثی) — طبق قواعد کاربر فقط گزارش شده‌اند، بدون ترمیم حدسی؛ پاک‌سازی اختیاری: `npm run files:health -- --prune`.
- قید محیط sandbox: متغیر `DATABASE_URL` تزریقی shell — در همهٔ گیت‌ها با مقدار صریح کنار زده شد (رفتار کد صحیح؛ علت محیط).
