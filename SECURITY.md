# گزارش امنیت — دور ۷۲ (v2.47.0)

این سند پاسخ مهندسی‌شده به ممیزی امنیتی v2.45/v2.46 است: هر یافته،
تصمیم اتخاذشده (رفع / رفع با انحراف مستند / پذیرش مستند با دلیل) و
ارجاع به کد/تست مربوط.

## ۱. موارد رفع‌شده (Fix)

| # | یافتهٔ ممیزی | رفع | شاهد |
|---|---|---|---|
| 1 | بستهٔ ZIP دارای `.env` با `SESSION_SECRET` (متغیر مرده) و `DATABASE_URL="file:./prisma/dev.db"` | بسته‌بندی r72 دیگر `.env` ارسال نمی‌کند (setup.bat از `.env.example` می‌سازد)؛ `SESSION_SECRET` حذف شد | `scripts/r72-package.sh` |
| 2 | `start.mjs` مسیر `prisma/prisma/dev.db` می‌ساخت | نرمال‌سازی واحد: هر شکل نسبی (`./dev.db`، `./prisma/dev.db`) به `<root>/prisma/dev.db` می‌رسد | `scripts/start.mjs` + تست دستی مصادیق |
| 3 | نتیجهٔ عملی باگ ۲: `prisma db push` در بستهٔ ≤2.46 دیتابیس دومی مخفی می‌ساخت و دادهٔ ارسالی دور زده می‌شد | باگ ۲ رفع شد + `scripts/setup-db-heal.mjs` دادهٔ زندهٔ کاربر نسخه‌های قدیم را به مسیر درست ارتقا می‌دهد | setup.bat گام ۴ |
| 4 | نبود HMAC فقط `console.warn` بود | `start.mjs` در production بدون `BGL_HMAC_SECRET` با پیام فارسی fail-fast می‌شود (NODE_ENV نامشخص = production، منطق سرور standalone) | `scripts/start.mjs` |
| 5 | setup.bat پیام «HMAC already set» خلاف واقع | `scripts/setup-env.mjs`: مقدار پر → دست‌نخورده؛ خالی → پر می‌شود؛ خط غایب → append می‌شود | setup.bat گام ۱ |
| 6 | رمزهای ثابت معتبر admin/yasteb در مستندات و ۲۱ فایل repo | رمزها از repo با env (`BGL_QA_*`) پاک شدند؛ بسته‌بندی r72 رمز هر دو حساب را در DB بسته به مقدار تصادفی چرخش می‌دهد + `FIRST-LOGIN.txt` | sweep r72 + `r72-package.sh` |
| 7 | PBKDF2 فقط ۱۰هزار تکرار؛ bcrypt legacy بدون ارتقا | PBKDF2-SHA512 با ۲۱۰٬۰۰۰ تکرار + فرمت نسخه‌دار `pbkdf2$iter$salt$hash`؛ verify فرمت قدیمی/ bcrypt را می‌پذیرد؛ لاگین موفق → rehash شفاف + AuditEvent | `src/lib/auth.ts` + `tests/password-hash.test.ts` |
| 8 | `timingSafeEqual` بدون گارد طول | گارد طول + صفر در هر دو شاخه (قبلاً نصفه بود) | `verifyPassword` |
| 9 | `cookie maxAge=43200` ثابت در ۳ نقطه | maxAge کوکی = طول مؤثر نشست (تنظیم ادمین) | `src/app/api/auth/route.ts` |
| 10 | `lastSeenAt` در هر request نوشته می‌شد | throttle ۶۰ ثانیه‌ای (~۹۹٪ کاهش write) | `src/lib/auth.ts` |
| 11 | XFF بدون trusted proxy → باکت‌های ناامن برای brute-force | `TRUSTED_PROXY` سه‌حالته: خاموش → XFF نادیده؛ روشن → آخرین hop (نمای پروکسی خود ما) | `src/lib/rate-limit.ts` + تست |
| 12 | هیچ Security Header در next.config | CSP/XFO/nosniff/Referrer/Permissions/HSTS روی همهٔ مسیرها | `next.config.ts` |
| 13 | قلمرو فروش fail-open | fail-closed: تخصیص ناقص/JSON خراب/mode ناشناخته → دسترسی صفر + هشدار یک‌بارهٔ ممیزی `TERRITORY_CONFIG_INVALID` | `src/lib/territory-scope.ts` + ۷۷ خط تست |
| 14 | webhook تلفنی: `findFirst→create` (race) | `@@unique([provider, externalId])` در اسکیم + بازندهٔ race با P2002 خودش را duplicate اعلام و فایلش را پاک می‌کند | `prisma/schema.prisma` + `telephony-ingest.ts` |
| 15 | فایل صوت قبل از DB نوشته می‌شد بدون cleanup | هر شکست DB → `safeUnlink` (قرارداد «فایل روی دیسک ⇔ ردیف در DB») | `telephony-ingest.ts` |
| 16 | consent در pipeline چک نمی‌شد | `consent=denied` → پردازش ممنوع و fail recording («unknown» مجاز — ریسک باقی‌ماندهٔ PBX، مستند) | `pipeline.ts` گام صفر |
| 17 | `retentionUntil` بدون job حذفی | sweep واقعی (ردیف+فایل+بایت‌های دیسک، حداکثر ۲۰۰ در اجرا) در ingest (ساعتی)، ذخیرهٔ تنظیمات و `npm run ai:retention` | `src/lib/ai/retention-sweep.ts` + تست |
| 18 | `assignTo` بدون اعتبارسنجی | مقصد باید موجود/فعال/در دسترسِ همان شرکت باشد (شرکت مستقل: ادمین مجاز نیست) | `ai-sales/actions/route.ts` |
| 19 | حذف/ویرایش پلی‌بوک فقط با id (IDOR) | گیت scope شرکت روی هر دو (save + delete) | `ai-sales/playbook/route.ts` |
| 20 | backup فقط JSON ناقص ۲۰۰۰ ردیف بدون restore | snapshot واقعی `VACUUM INTO` + quick_check روی خود snapshot + manifest با sha256 + چرخش ۱۴تایی + `scripts/restore-backup.mjs` (checksum+integrity+بکاپ پیش از بازگردانی) | `src/lib/backup-snapshot.ts` + تست |
| 21 | تست‌ها روی dev.db واقعی اجرا می‌شدند | vitest روی کپی ایزولهٔ checkpoint شده (`prisma/test.db`) + `NODE_ENV=test` | `tests/setup.ts` |
| 22 | `noImplicitAny:false` | فعال — کل کد تایپ‌ساخت | `tsconfig.json` |
| 23 | `reactStrictMode:false` | فعال (double-render توسعه برای کشتن باگ‌های effect) | `next.config.ts` |
| 24 | دو lockfile (npm + bun) | bun.lock حذف شد؛ npm واحد | repo |
| 25 | `prisma/migrations` نبود؛ فقط db push | migration پایه `0_init` + `migrate deploy` در setup؛ dev.db به‌عنوان applied علامت خورد | `prisma/migrations/` |
| 26 | npm audit: ۹ (۵ High — sharp و…) | sharp 0.35.4 + prisma 6.19.3 + overrideهای js-yaml 4.3.2 / prismjs 1.30.0 / deepmerge-ts 8.0.2 → **۰ آسیب‌پذیری** (npm audit --omit=dev) | package.json/lock |
| 27 | `AiCallRecording` فقط index روی (provider,externalId) | قید یکتا (ردیف ۱۴) — همین‌جا تکرار برای وضوح | `schema.prisma` |

## ۲. موارد با انحراف مستند (Deviation با دلیل)

### Float به‌جای Decimal/BigInt در ستون‌های مبلغ
**تصمیم**: نگه‌داشتن Float با **قید ریالِ صحیح در مرز نوشتن**.
**دلیل**: Rial واحد کسری ندارد؛ اعداد صحیح تا 2^53 در float64 و REAL
دقیقاً ذخیره می‌شوند؛ در این پشته (SQLite + JSON API + ۴۰+ مصرف‌کنندهٔ
UI با محاسبات عددی) ستون Decimal هر پاسخ API را به string تبدیل و کل
UI را می‌شکند — رگرسیون بدتر از ریسک نظری. تمام ورودی‌های مبلغ
(`paymentCreateSchema`، اقلام سند، قیمت محصول، قیمت همکار) `.int()` شدند؛
`sumRial` جمع صحیح می‌دهد. مسیر آینده (اگر روزی کسری لازم شد): ارجاع
productId در سریال‌ها + مهاجرت Decimal هم‌زمان با بازنویسی UI.

### Product.code و HesabfaProductLink.productCode سراسری‌یکتا (نه شرکت‌محور)
**تصمیم**: حفظ یکتایی سراسری.
**دلیل**: `code` در این سیستم شناسهٔ جهانی کالا (SKU) است — سریال‌های
existing (`inventorySerials.productCode`)، پروندهٔ خدمات پس از فروش،
قیمت همکاران و لینک حسابفا همگی با کد خالص join می‌کنند؛ شرکت‌محورکردن
آن‌ها « ambiguity » در همهٔ این joinها ایجاد می‌کند و نیازمند مهاجرت
سریال‌ها به productId است (پروژهٔ جداگانه). ریسک فعلی صرفاً
availability است (شرکت مستقل نمی‌تواند کد تکراری کاتالوگ گروه بزند —
پاسخ ۴۰۹ فارسی)، نه نشت داده؛ چون visibility کاتالوگ با companyId
ایزوله است.

## ۳. موارد پذیرفته‌شده با تحلیل ریسک (Risk-Accepted)

### finance_write برای نقش standard
این مجوز یعنی «اجازهٔ ثبت سند/پرداختِ خودِ کارشناس»، نه دسترسی مالی
کراس‌کاربر. کنترل‌های مضاعف:
- تأیید/رد سند نیاز به `finance_write` **و** `view_other_sales_documents`
  دارد (فقط ادمین/مالی — v2.27.2)
- کارتابل مالی/فاکتورها علاوه بر مجوز، scope شرکت (+ قلمرو فروش از v2.36) می‌گیرد (v2.11.1)
- cancel/move-stage فقط روی سند خود کاربر (checkOwnership + territory)
حذف این مجوز گردش تأیید/ارسال/کاریز (r65-r70) را برای همهٔ کارشناسان
می‌شکند؛ شکاف باقی‌مانده UI-level نیست (لیست استاندارد creator-scoped است).

### jobTitle صرفاً محدودکنندهٔ منو
سمت کاربر لایهٔ UI/ناوبری است؛ اعمال سطح route بر عهدهٔ role/permission
است. مسیر آینده: پاک‌سازی منو با سمت مکمل، نه گیت امنیتی.

### سند همکار استان در قلمرو (docTerritoryOr)
طراحی v2.41: کارشناسِ استان، اسناد مراکز استان خود را می‌بیند حتی اگر
همکار ثبت کرده باشد (شرکت یک تیم است؛ قلمرو «حوزهٔ کاری» است نه «مالکیت
سند»'). با fail-closed جدید، حالت خراب فقط به دادهٔ خودش محدود می‌شود.

### consent=unknown در pipeline
وب‌هوک PBXهای فعلی فیلد رضایت نمی‌فرستند؛ مسدودکردن unknown کل
مرکز تماس را خاموش می‌کند. denied مسدود است (سخت‌گیرانه‌ترین حالتِ
قابل اجرا)؛ unknown با ریسک مستند مجاز تا زمانی که PBXها consent
بفرستند.

## ۴. قراردادهای جدید محیط

| متغیر | نقش |
|---|---|
| `BGL_HMAC_SECRET` | همان قبل — حالا در production اجباری (fail-fast) |
| `TRUSTED_PROXY` | `true` فقط وقتی پشت reverse-proxy خودتان هستید (برای شمارش صحیح IP در rate-limit) |
| `BGL_BACKUP_DIR` | مسیر snapshotها (پیش‌فرض `backups/`) |
| `BGL_QA_ADMIN_PASSWORD` / `BGL_QA_YASTEB_PASSWORD` | رمزهای تست E2E — repo دیگر هیچ رمز ثابتی ندارد |

## ۵. تست‌ها

- `tests/password-hash.test.ts` — ۱۶ تست (فرمت v2، legacy v1/bcrypt،
  hashهای خراب/خصمانه، ماتریس needsRehash، کف OWASP)
- `tests/backup-snapshot.test.ts` — ۸ تست (نام‌گذاری، چرخش، snapshot
  واقعی با checksum، قرارداد manifest)
- `tests/ai-retention-sweep.test.ts` — ۲ تست DB (حذف انقضایافته+فایل،
  no-op)
- `tests/rate-limit.test.ts` — بازنویسی clientIpOf (۳ حالت XFF با/بدون TRUSTED_PROXY)
- `tests/territory-scope.test.ts` — حالتهای fail-closed
- بقیه: مجموع ≥ ۵۹۰ تست؛ `npm run test` روی DB ایزوله اجرا می‌شود.
