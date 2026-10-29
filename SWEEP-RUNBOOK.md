# Runbook نگهداری فایل‌ها — زمان‌بندی، مانیتورینگ و بازگردانی

نسخهٔ ۲٫۵۸٫۱۰ — پاسخ به یافتهٔ P2 مرور نهایی: ابزارهای `files:sweep` و `files-health` وجود داشتند اما هیچ Job زمان‌بندی‌شده‌ای آن‌ها را اجرا نمی‌کرد.

## ۱. چه چیزی زمان‌بندی می‌شود؟

Job روزانه ساعت **۰۳:۳۰** (زمان محلی سیستم) این فرمان را اجرا می‌کند:

```
node scripts/sweep-cron.mjs --sweep
```

این runner یک-shot و بدون تعامل است (مناسب Task Scheduler / cron) و **همان CLI تعاملی** `scripts/files-health.ts` را از طریق tsx اجرا می‌کند — یعنی مسیر زمان‌بندی‌شده و مسیر اپراتور یکی است (همان گاردها، همان شمارنده‌ها، همان کدهای خروج).

- **حالت پیش‌فرض (بدون پرچم):** فقط گزارش — صفر حذف.
- **با `--sweep`:** علاوه بر گزارش، فایل‌های `.part` قدیمیِ به‌تعلیق‌درآمده (فراتر از پنجرهٔ مهلت) بازیابی می‌شوند — همان کد گاردشدهٔ CLI؛ هرگز `rm` خام نیست.
- **`--prune` هرگز از مسیر زمان‌بندی‌شده اجرا نمی‌شود** — حذف رکورد باید تأیید انسانی بگیرد (`npm run files:health -- --prune` به‌صورت تعاملی).

## ۲. ثبت Job

### ویندوز (پکیج local-win)

```
node scripts\register-sweep-task.mjs            ← فقط چاپ فرمان‌ها
node scripts\register-sweep-task.mjs --install  ← ثبت با schtasks (روزانهٔ ۰۳:۳۰)
node scripts\register-sweep-task.mjs --remove   ← حذف
```

معادل دستی (CMD با دسترسی مدیر):

```
schtasks /Create /TN "BGL-CRM File Sweep" /SC DAILY /ST 03:30 /TR "\"C:\Program Files\nodejs\node.exe\" \"D:\BGL-CRM\scripts\sweep-cron.mjs\" --sweep" /F
```

### لینوکس / macOS

```
node scripts/register-sweep-task.mjs --install   ← افزودن خط به crontab (با marker a# bgl-crm-sweep و جلوگیری از تکرار)
node scripts/register-sweep-task.mjs --remove
```

خط معادل برای systemd timer یا scheduler دلخواه:

```
30 3 * * * cd "<projectRoot>" && node scripts/sweep-cron.mjs --sweep >> logs/sweep-cron.log 2>&1
```

## ۳. مانیتورینگ

هر اجرا گزارش ماشین‌خوان را تازه می‌کند:

- **`logs/files-sweep-report.json`** — زمان اجرا، حالت، کد خروج و ۲۵ خط آخر خروجی. یک چک مانیتورینگ فقط به mtime این فایل و `exitCode` آن نیاز دارد.
- **`logs/sweep-cron.log`** — خروجی کامل اجراهای زمان‌بندی‌شده (append).
- کنسول خروجی Job نیز همین CLI است؛ log چرخشی برنامه (BGL_LOG_DIR) دست‌نخورده می‌ماند.

کدهای خروج:

| کد | معنی | اقدام |
|---|---|---|
| ۰ | سالم (یا پس از sweep سالم) | — |
| ۱ | رکورد committed بدون محتوای فیزیکی شناسایی شد (فقط گزارش — هیچ‌چیز حذف نشده) | `node scripts/accounting-disposition.mjs` را اجرا و تعیین تکلیف §۴ گزارش را با مدیر انجام دهید |
| ۲ | خطای عملیاتی (DB/ذخیره‌سازی ناخوانا) — **هیچ حذفی انجام نشده** (fail-closed) | لاگ را بررسی کنید؛ پس از رفع علت، Job خودش دوباره سالم می‌شود |

هشدار: exit 1 برایمان طبیعی است تا وقتی تعیین تکلیف نشده — گزارش صادقانه از دادهٔ واقعی است، نه خرابی Job.

## ۴. بازگردانی (rollback)

Job در حالت `--sweep` فقط **فایل‌های موقت `.part` قدیمی** را حذف می‌کند — نه رکورد DB و نه فایل‌های نهایی committed. با این حال:

1. **حذف Job:** `node scripts/register-sweep-task.mjs --remove` (یا `schtasks /Delete /TN "BGL-CRM File Sweep" /F`).
2. **اگر فایلی به‌اشتباه رفته باشد:** از آخرین بستهٔ پشتیبان کامل (backup route → `action=package`، شامل snapshot DB + پیوست‌های فایل با sha256) بازیابی کنید — `scripts/restore-backup.mjs` خودش pre-restore backup می‌گیرد و rollback خودکار دارد.
3. **سلامت عمومی:** `npm run files:health` (dry-run صددرصدی) و `node scripts/files-health.ts --prune` فقط با تأیید تعاملی برای حذف رکوردهای مردهٔ تأییدشده.

## ۵. پیش‌نیازها

- Node در PATH کاربر/سیستم (runner مسیر node خودش را از `process.execPath` می‌گیرد و در خط cron همین مسیر قطعی ثبت می‌شود).
- دسترسی خواندن/نوشتن به `prisma/dev.db` (یا `DATABASE_URL`) و پوشهٔ `storage/uploads` — همان چیزی که خود برنامه دارد.
- اجرای اولین بار را دستی تست کنید: `node scripts/sweep-cron.mjs --sweep` و بررسی `logs/files-sweep-report.json`.
