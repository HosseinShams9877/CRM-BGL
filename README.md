# سامانهٔ مدیریت جامع فروش — BGL CRM

سامانهٔ مدیریت ارتباط با مشتری و فروش گروه بهبود گستر؛ ساخته‌شده با Next.js / TypeScript / Prisma / SQLite،
با احراز هویت مبتنی بر نشست، ایزوله‌سازی چند-شرکتی (multi-tenant)، رابط کاربری کامل فارسی و تقویم جلالی.

> مستندات تغییرات هر نسخه: [CHANGELOG.md](./CHANGELOG.md) · راهنمای کامل نصب برای ویندوز/macOS/لینوکس: [INSTALL.md](./INSTALL.md) · اجرای لوکال روی ویندوز: [WINDOWS.md](./WINDOWS.md) · استقرار تولیدی روی هاست/دامنه/سرور: [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## معماری در یک نگاه

| لایه | فناوری / فایل‌ها |
|------|------------------|
| رابط کاربری | Next.js App Router + React + Tailwind (RTL، فارسی، تقویم جلالی `src/lib/jalali.ts`) |
| API | ۵۰ مسیر `/api/*` با الگوی `{ action, ...payload }` (POST) و GET های کوئری‌رشته‌ای |
| دسترسی‌ها | ماتریس مجوز شغلی `src/lib/access-config.ts` + منو `src/lib/menu-catalog.ts` |
| داده | Prisma + SQLite (`prisma/schema.prisma`، ۳۰+ مدل، ۶۶ ایندکس) |
| احراز هویت | نشست سرور-ساید با انقضای ۱۲ ساعت (`src/lib/auth.ts`) + PBKDF2 (سازگار با bcrypt legacy) |
| امنیت | CSRF همان-مبدأ + Rate-limit سه‌سطحی + اعتبارسنجی Zod + لاگر ساختاریافته (Middleware `src/middleware.ts`) |
| فایل | ذخیرهٔ واقعی روی دیسک با checksum SHA-256 (`src/lib/storage.ts`) |
| تست | Vitest — ۶۹۶ تست واحد (از جمله ۱۴ تست مالی یکپارچگی روی SQLite واقعی) + ۴ باتری runtime: `scripts/verify-{api,browser,install,restore}.mjs` |

## راه‌اندازی سریع

> راهنمای کامل و گام‌به‌گام (شامل ویندوز و رفع اشکال): **[INSTALL.md](./INSTALL.md)**

```bash
npm ci                       # نصب دقیق مطابق package-lock.json
# کپی .env.example → .env و تنظیم BGL_HMAC_SECRET
#   ویندوز CMD:      copy .env.example .env
#   ویندوز PowerShell: Copy-Item .env.example .env
#   macOS / لینوکس:   cp .env.example .env
npm run db:push               # ساخت/همگام‌سازی دیتابیس
npm run db:seed               # دادهٔ اولیه (رمز مدیر یک‌بار چاپ می‌شود)
npm run dev                   # http://localhost:3000
```

راه میان‌رو: ویندوز `setup.bat` · macOS/لینوکس `bash setup.sh`

## اسکریپت‌ها

| دستور | کار |
|-------|-----|
| `npm run dev` | سرور توسعه روی پورت ۳۰۰۰ |
| `npm run build` | build تولیدی (خروجی standalone + کپی کراس‌پلتفرم static/public از طریق `scripts/postbuild.mjs`) |
| `npm start` | اجرای خروجی production (`.next/standalone/server.js`) |
| `npm run clean` | پاک‌سازی کامل آرتیفکت‌های build (`.next/`) — بدون وابستگی به `rm`، روی ویندوز هم کار می‌کند |
| `npm run lint` | ESLint کل پروژه (۰ خطا) |
| `npm test` | ۶۹۶ تست واحد (Vitest) |
| `npm run db:push` / `db:generate` | همگام‌سازی schema با Prisma |
| `npm run db:seed` | دادهٔ اولیه (شرکت‌ها + مدیر؛ رمز تصادفی یک‌بار چاپ می‌شود) |

## متغیرهای محیطی

| متغیر | توضیح |
|-------|-------|
| `DATABASE_URL` | مسیر فایل SQLite (پیش‌فرض `file:./dev.db`) |
| `BGL_HMAC_SECRET` | کلید HMAC برای throttle ورود — **در production الزامی** |
| `COOKIE_SECURE` | ارسال کوکی فقط روی HTTPS (پیش‌فرض: در production فعال) |
| `SEED_ADMIN_PASSWORD` | رمز اولیهٔ مدیر هنگام seed (اختیاری) |

## استقرار و بهداشت build (P2-4)

پوشهٔ `.next/` صرفاً خروجی build است و **هرگز** باید از این قواعد پیروی کند:

- **git**: در `.gitignore` است — هیچ‌گاه commit نمی‌شود.
- **بکاپ/آرشیو**: بکاپ نگیرید؛ با یک `npm run build` نو ساخته می‌شود.
- **انتشار**: فقط خروجی `.next/standalone/` را منتقل کنید (بسیار کوچکتر از کل `.next`)
  و با `node .next/standalone/server.js` اجرا کنید — اسکریپت `build` به‌صورت خودکار
  `static` و `public` را داخل standalone کپی می‌کند.
- **پاکسازی**: `npm run clean` پوشهٔ `.next` را کامل حذف می‌کند (شامل کش توسعه و build).
- پس از هر بازیابی یا جابجایی فایل دیتابیس، حتماً `npm run db:push` اجرا کنید
  (درس استقراری ثبت‌شده در v2.10.0).

## راستی‌آزمایی (پیش از انتشار)

```bash
npm run lint            # باید: ۰ خطا
npx tsc --noEmit        # باید: ۰ خطا
npm test                # باید: ۶۹۶/۶۹۶
npm run test:conn       # محیط/DB/مهاجرت/سلامت (سرور روشن)
npm run test:api        # مالی + ماتریس دسترسی (سرور روشن)
npm run test:restore    # چرخهٔ کامل پشتیبان/بازیابی (محیط ایزوله)
npm run build           # باید: موفق (کراس‌پلتفرم — ویندوز/macOS/لینوکس)
npx tsx scripts/verify-v2140-runtime.ts  # باتری کامل v2.14.0
```

## ساختار پوشه‌ها

```
prisma/            اسکیمای دیتابیس + seed
scripts/           باتری‌های راستی‌آزمایی runtime
src/app/api/       ۵۰ مسیر API (همه محافظت‌شده)
src/components/    ۲۹ کامپوننت کسب‌وکار + primitives در ui/
src/hooks/         لایهٔ API مشترک (use-api) و هوک‌های UI
src/lib/           auth، access، jalali، storage، logger، rate-limit، validators
storage/uploads/   فایل‌های آپلودی واقعی (هرگز commit نمی‌شود)
```
