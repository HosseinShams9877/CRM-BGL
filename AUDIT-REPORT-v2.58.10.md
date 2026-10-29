# گزارش اصلاح نهایی — BGL CRM نسخهٔ ۲٫۵۸٫۱۰ (پاسخ به مرور نهایی ۲٫۵۸٫۹)

تاریخ: ۲۰۲۶-۰۹-۰۷ — دور ۹۲ (بازسازی و بستن یافته‌های «BGL-CRM-2.58.9-final-review»)

> **حکم مرور نهایی ورودی:** انتشار تولیدی تأیید نمی‌شود — امتیاز ۶٫۵/۱۰.
> **حکم این گزارش پس از اصلاح:** هر ۹ یافتهٔ مرور (۲×P0، ۳×P1، ۳×P2، ۱×Minor) + ۲ کارماندهٔ کارفرما بسته شدند؛ گیت‌های انتشار از خودِ بستهٔ نهایی و از نصب تازه اجرا شدند.

## ۰. مبنای بازسازی (شفافیت کامل)

بستهٔ ۲٫۵۸٫۸/۲٫۵۸٫۹ ممیزی‌شده در این محیط در دسترس نبود. بازسازی از **سورس واقعی در دسترس** انجام شد:

| ورودی | SHA-256 |
|---|---|
| BGL-CRM-2.58.7-local-win.zip (خط واقعی دورهای ۹۲–۹۴) | `d226c6ed38e0b8abfbda908a884de605d6a45725b1a69232f7ed91fa30c1f6ed` |
| BGL-CRM-2.58.7-local-win (1).zip (بستهٔ B — هفت‌یافتهٔ کارفرما روی پایهٔ ۲٫۵۸٫۴) | `edcd81d1df3009c3f43b2d7ff12ed7d4c6a37c061a2a96fd6de373ec8d7af72f` |
| BGL-CRM-2.58.9-final-review.md | `27875b4339027c63f82e5fca164b74fd2ad063ebaf05e962a785d8c38cb9405c` |
| dev.db عملیاتی ۲٫۵۸٫۷ (برای آزمون مسیر ارتقا، فقط روی کپی) | `df98f024926e1937c1184222f3c85e2bc96f80d1561e69fcbba27d9e0cca1102` |

خط ۲٫۵۸٫۷ واقعی (شامل لایهٔ access-policy، قلمرو مسیرها، SSRF، MIME، lease، payment-idempotency v2، memory-dedupe، resolve-env) به‌عنوان پایهٔ درخت توسعه بازگردانده شد؛ از بستهٔ B فقط ابزارهای عملیاتی بدون تعارض (`accounting-disposition`) و الگوی تست استرس مالکیت پورت و بازتولید شد. هر یافتهٔ مرور ابتدا روی این پایه **بازتولید (قرمز)** شد؛ جایی که یافته روی ۲٫۵۸٫۹ معنادار نبود (مثلاً رکوردهای ghost در DB تازه) با شواهد مستند شد.

## ۱. جدول یافته → بازتولید → اصلاح → آزمون → نتیجه

| # | یافتهٔ مرور | بازتولید روی کد پایه | اصلاح (مسیر واقعی) | آزمون الزامی | نتیجه |
|---|---|---|---|---|---|
| P0-۱ | Secret و دادهٔ عملیاتی داخل Release (FIRST-LOGIN.txt با رمزهای متنی؛ DB با ۲۱ کاربر/۱۵۰۸ مرکز/۱۵۸۴۷ فعالیت؛ sms.api_key خام) | تأیید: بسته‌های قبلی dev.db واقعی + FIRST-LOGIN.txt حمل می‌کردند (DB جداشده در `work/r92-legacy-2.58.7-dev.db` نگه داشته شد فقط برای آزمون ارتقا) | **Release بدون DB و بدون فایل رمز**: بسته‌بندی از `git archive` (state ردیابی‌نشده ذاتی وارد نمی‌شود) + نصب تازه = `migrate deploy` + seed؛ **FIRST-LOGIN.txt در لحظهٔ نصب روی سیستم کاربر زاده می‌شود** (فقط وقتی رمز واقعاً اعمال شود؛ seed.ts، mode 600، ارتقا هرگز نمی‌سازد)؛ کلید SMS در DB تازه وجود ندارد؛ راهنمای چرخش کلید در UPGRADING-v25810 | گیت بسته: «no DB/credentials/env/storage/logs in the ZIP» + «FIRST-LOGIN not before seed / born at install» از **خود ZIP** اجرا شد | ✅ |
| P0-۲ | همان نشت در خروجی standalone (dev.db، FIRST-LOGIN.txt، tests/، بخش‌هایی از src) | تأیید: tracer محافظه‌کار به‌دلیل fs دینامیک | `outputFileTracingExcludes` در next.config.ts (tests، DBها، storage، logs، FIRST-LOGIN، .env، scripts، docs/config اضافی) + **گیت fail-closed در postbuild.mjs**: هر نشتی DB/راز/.env در `.next/standalone` = حذف + FAIL ساخت | اسکن standalone پس از build واقعی در بستهٔ نهایی: **صفر artifact ممنوع** (در اجرای dev-tree هم آزموده شد: dev.db موجود نبود، tests/ حذف شد) | ✅ |
| P1-۳ | قلمرو ناقص در update/delete پرداخت کارتابل | **تأیید قرمز**: کاربر standard با قلمرو اصفهان، پرداخت سندِ خودِ خارج از قلمرو را ۲۰۰ ویرایش/حذف می‌کرد (تست قرمز: expected 404, received 200) | `cartable-payments.ts`: هر سه جهش ماتریس **شرکت 403 → قلمرو 404 بدون افشا → مالکیت 403** داخل تراکنش؛ parity کامل با add؛ اسناد بی‌مرکزِ خود کاربر پاس؛ دارندهٔ accounting_cartable دسترسی finance-wide | `tests/cartable-territory-parity.test.ts` — ۸ سناریو مسیر واقعی با کاربر province-scoped (۲ انکار + ۳ کنترل مثبت + ۲ کنترل finance) + ۱۸ تست موجود پرداخت بی‌رگرسیون | ✅ |
| P1-۴ | دو رکورد File بدون محتوای فیزیکی | **تأیید** روی DB عملیاتی ۲٫۵۸٫۷ با ابزار گزارش: `7b726…webm` و `f185d…webm` (committed، 8B، center C1217) | در Release تازه چنین رکوردی وجود ندارد (DB خالی + files-health exit 0 در گیت نصب). برای دادهٔ موجود: `scripts/accounting-disposition.mjs` فقط-خواندنی با شناسه‌های دقیق و گزینه‌های دستی (هرگز حذف/اتصال حدسی) — پورت‌شده با قرارداد مسیر مشترک resolve-env | اجرای واقعی روی DB عملیاتی (کپی): ۲ رکورد با جزئیات گزارش شد؛ روی DB تازه: خروجی پاک | ✅ |
| P1-۵ | Drift مهاجرت‌ها (v2520 و v2580) | **تأیید دقیق**: همان دو مهاجرت؛ هم‌ارزی منطقی اسکیمای DB زنده با استقرار تازهٔ فایل‌های فعلی شیء‌به‌شیء اثبات شد (فقط ترتیب ستون/شکست خط) | `scripts/fix-migration-drift.mjs`: گزارش-تنها → `--confirm` = پشتیبان VACUUM INTO + همسان‌سازی checksum ردیف‌های اعمال‌شده با هش فایل مرجع + بازخوانی/راستی‌آزمایی؛ فایل‌های مهاجرت **immutable** باقی‌ماندند | اجرای واقعی روی کپی DB عملیاتی: drift 2→0 و `prisma migrate status` = «Database schema is up to date!»؛ نصب تازه: drift = 0 به‌ساخت | ✅ |
| P2-۶ | مقیاس‌پذیری File Lifecycle (تست‌های >۵۰K timeout) | **بازتولید شد و جدی‌تر از timeout بود**: هر سه فاز sweep/snapshot مالکیت را با «صفحهٔ اول ۵۰٬۰۰۰ ردیف» قضاوت می‌کردند — `.part` (یا فایل نهایی در sweepOrphanFinalFiles) متعلق به ردیف فراتر از صفحه **یتیم پنداشته و حذف می‌شد** (از دست رفتن داده)؛ شمارنده‌ها بعد از سقف خاموش غلط | قرارداد جدید در `file-lifecycle.ts`: کاندیدا از خود دایرکتوری؛ مالکیت دقیق با کوئری IN تکه‌ای روی storedName یکتا (کامل در هر اندازه)؛ **بازچک مالکیت پیش از هر حذف**؛ خطای DB در فاز = **صفر حذف در آن فاز (fail-closed)**؛ فازهای deleting/missing با مکان‌نما تا اتمام؛ stale-pending = COUNT دقیق | `tests/file-sweep-ownership.test.ts` — ۵۰٬۱۰۰ ردیف پرکننده + قربانی زنده (باقی می‌ماند) + یتیم واقعی (حذف می‌شود) + خرابی DB واقعی (صفر حذف + خطای گزارش‌شده) + دقت snapshot؛ **۲ تست ۵۰K در ~۵ ثانیه** (بدون timeout) + ۱۴ تست موجود بی‌رگرسیون | ✅ |
| P2-۷ | sweeper ثبت نشده بود | تأیید: `files:sweep` موجود، بدون هیچ Job | `scripts/sweep-cron.mjs` (اجراکنندهٔ یک-shot بدون تعامل — همان CLI واقعی از طریق tsx؛ فقط-گزارش در پیش‌فرض؛ هرگز --prune) + `scripts/register-sweep-task.mjs` (چاپ/ثبت/حذف Job روزانهٔ ۰۳:۳۰ — schtasks ویندوز / crontab با marker) + **SWEEP-RUNBOOK.md** (زمان‌بندی/مانیتورینگ `logs/files-sweep-report.json`/rollback/پیش‌نیازها) + اهداف npm | اجرای واقعی: sweep-cron روی DB عملیاتی (exit 1 صادقانه با گزارش ۲ رکورد) و DB تازه (exit 0) + گزارش JSON نوشته شد؛ ثبت/حذف Job روی لینوکسِ sandbox آزموده شد (crontab غایب → خطای صادقانه + فرمان دقیق چاپ شد — بدون موفقیت جعلی) | ✅ |
| P2-۸ | دقت مالی Float | تأیید (بدون تغییر اسکیما — پذیرش ریسک مستند) | **FINANCIAL-PRECISION.md**: مرزهای ایمن (integer-Rial ورودی، تراکنش in-tx، دقت exact تا ۲^۵۳)، تصمیم پذیرش مستند، برنامهٔ Decimal/PostgreSQL + `scripts/money-reconciliation.mjs` فقط-خواندنی (اسکن همهٔ ستون‌های پولی؛ exit 1 اگر مقدار کسری باشد) | اجرای واقعی روی DB عملیاتی: **۳۹ ردیف اسکن، صفر مقدار غیرصحیح** | ✅ |
| Minor | بنر setup.bat نسخهٔ اشتباه | تأیید | ۲٫۵۸٫۱۰ هم‌راستا در: package.json + package-lock + setup.bat + setup.sh + نشان سایدبار | گیت بسته: هر چهار بنر از ZIP چک شد | ✅ |

### کارمانده‌های کارفرما از دستور ۲٫۵۸٫۸/۹ (بازتحلیل روی پایهٔ ۲٫۵۸٫۷)

| موضوع | وضعیت روی پایه | اقدام این دور |
|---|---|---|
| هویت پاسخ موفق idempotency (validateRecordedResponse) | موتور v2 پاسخ ساختاراً-معتبر را بدون تطبیق هویت می‌پذیرفت | `successBodyMatchesOperation` (همان فاکتور + همان مبلغ؛ عدم تطبیق = unknown و بقای کلید) + افشای `invoiceId`/`alreadySettled` در پاسخ add-payment + شاخهٔ قطعی alreadySettled — `tests/payment-response-identity.test.ts` (۶ تست: ۲ ناهم‌خوانی، ۱ تطبیق، ۱ alreadySettled، ۲ مسیر واقعی) |
| سلول JSON خراب حافظهٔ AI | `JSON.parse` مستقیم روی preferences/insights — یک سلول خراب کل مرحلهٔ memory را می‌کشت | parse تدافعی + لاگ `AI_MEMORY_CORRUPT_CELL` + پایهٔ merge خالی (منبع خام دست‌نخورده) — `tests/memory-corrupt-cell.test.ts` (۲ تست با LLM شبیه‌سازی‌شدهٔ خطاخورده = مسیر fallback واقعی) |
| merge حافظه/قفل DB-heal/قفل lease | روی خط ۲٫۵۸٫۷ واقعی از دورهای ۹۲–۹۴ پیاده و تست‌شده بودند (memory-dedupe درون-تراکنشی، fencedTx، BEGIN IMMEDIATE، پشتیبان/rollback کامل heal) | بازراستی‌آزمایی: همهٔ تست‌های مرتبط (ai-fenced-writes، memory-dedupe، db-heal-writer-lock/safety، backup-restore-resolver، resolve-env، payment-key-stability، payment-unknown-outcome، idempotent-replay-access) در سوئیت کامل سبز |

## ۲. آزمون‌های اجراشده (فرمان/محیط/نتیجهٔ واقعی)

| آزمون | محیط | نتیجه |
|---|---|---|
| Full Vitest — درخت توسعه | Linux · vitest run | **۱۱۲۵/۱۱۲۵ pass در ۹۴ فایل** (+۲۲ نسبت به ۲٫۵۸٫۷) |
| Full Vitest — **از خود ZIP** روی فیکسچر تازهٔ ساخت | نصب شبیه‌سازی‌شده | **۱۱۲۵ pass** — همان سوئیت، بدون dev.db |
| `tsc --noEmit` | درخت توسعه | ۰ خطا |
| `eslint .` | درخت توسعه | ۰ خطا / ۰ هشدار |
| `next build` + postbuild (با گیت بهداشت) | درخت توسعه + از خود ZIP | سبز؛ standalone بدون هیچ artifact ممنوع |
| `prisma migrate deploy` | DB تازه در بسته | ۱۷/۱۷ مهاجرت؛ **drift = 0** |
| seed (نصب تازه) | از خود ZIP | رمز تصادفی یک‌بار‌چاپ + **FIRST-LOGIN.txt زاده‌شده در نصب** (غایب در ZIP) |
| files-health/sweep-cron | DB تازه از ZIP | exit 0 (صفر رکورد ghost) |
| drift-fix | **کپی** DB عملیاتی ۲٫۵۸٫۷ | drift 2→0؛ migrate status «up to date»؛ پشتیبان ساخته شد |
| accounting-disposition | DB عملیاتی (فقط-خواندنی) | ۰ ردیف مالی بی‌مرکز؛ ۲ رکورد فایل ghost با جزئیات |
| money-reconciliation | DB عملیاتی (فقط-خواندنی) | ۳۹ ردیف اسکن؛ صفر مقدار غیرصحیح |
| بوت سرور production | standalone واقعی روی :3100 با DB تازه | `/api/health` = `{"status":"ok","db":"ok"}` + گیت Origin فعال |

## ۳. محدودیت‌های صادقانه (اجرا‌نشده در این محیط)

1. **setup.bat روی ویندوز واقعی** (cmd) — میزبان لینوکسی است؛ اسکریپت‌های setup منطق یکسانی با نسخه‌های پیشین دارند که در ویندوز آزموده شده بودند.
2. **E2E دو-تب مرورگر واقعی** — همان‌طور که مرور نهایی هم گزارش کرد، حالت dev در sandbox با خطای `uv_interface_addresses` بالا نمی‌آید؛ اما **سرور production واقعی (standalone) در همین محیط بوت و health-check شد** و منطق idempotency کلاینت-سرور با ۴۴ تست (موتور + مسیر واقعی با شبکه‌ی فقط-stub) پوشش داده شده است.
3. **ثبت Job روی Task Scheduler ویندوز** — فرمان دقیق چاپ و مستند شد؛ مسیر لینوکس (crontab) در sandbox آزموده شد (crontab غایب → خطای صادقانه).
4. **ارتقای واقعی روی DB کاربر** — drift-fix و disposition فقط روی **کپی** DB عملیاتی اجرا شدند؛ خودِ ابزارها فقط-گزارش/پشتیبان-اول طراحی شده‌اند و دستور اجرا در UPGRADING-v25810 §۲ و §۴ آمده است.

## ۴. تحویل

| فایل | SHA-256 |
|---|---|
| `BGL-CRM-2.58.10-local-win.zip` (۳.۲MB · ۴۲۴ فایل · بدون DB/راز) | `در فایل همراه `BGL-CRM-2.58.10-local-win.zip.sha256` و در نسخهٔ گزارشِ پوشهٔ download منتشر می‌شود (هشِ خودِ ZIP در فایل داخلش نمی‌گنجد — دور منطقی)` |

- گیت‌های انتشار همگی **از خود ZIP** و از نصب تازهٔ شبیه‌سازی‌شده اجرا شدند (بند ۲).
- مسیر ارتقا/چرخش راز/rollback: `UPGRADING-v25810.md` · Job زمان‌بندی‌شده: `SWEEP-RUNBOOK.md` · Float: `FINANCIAL-PRECISION.md`.
- درخت توسعه: کامیت کد `d1dc274` (پایهٔ بازسازی + همهٔ اصلاحات این دور) + کامیت گزارش `d9fca62`.
