# گزارش تست — BGL AI Sales Intelligence (v2.27.0)

## خلاصهٔ گیت‌های کیفیت — همه سبز

| گیت | نتیجه |
|-----|-------|
| TypeScript (`tsc --noEmit`) | **۰ خطا** |
| ESLint | **۰ خطا / ۰ هشدار** |
| Vitest | **۱۰۳/۱۰۳** (۷۴ رگرسیون + ۲۹ AI جدید) |
| Production Build | **PASS** |
| Browser UI رگرسیون (v2600) | **۴۶/۴۶** |
| Browser AI جدید (v2700) | **۳۸/۳۸** |
| API Smoke Sweep | **۴۵/۴۵** |
| CAS Verify | ۷/۷ |
| Dark-Leak Probe (۱۷ ماژول) | **۰ نشت** |
| Overflow Hunter @۳۲۰px | clean |
| E2E Pipeline با LLM واقعی | **PASS کامل** |

## تست‌های واحد جدید (۲۹)

### tests/ai-followup-date.test.ts — پارسر تاریخ نسبی فارسی (۹)
- امروز/فردا/پس‌فردا (+ZWNJ) ✓
- N روز بعد با رقم فارسی/عربی/ASCII ✓
- هفته/دو هفته/N هفته ✓
- ماه بعد/اول ماه بعد/سر ماه/نیم‌ماه ✓
- روزهای هفته → وقوع بعدی (شنبه بعد از پنجشنبه = +۲ روز؛ دوشنبه = +۴) ✓
- تاریخ صریح جلالی (۱۵ اسفند → 2027-03-06) ✓
- متن بدون تاریخ → null (هرگز حدس نمی‌زند) ✓
- اولویت اسکن findFollowupDateInTexts ✓

### tests/ai-extraction.test.ts — اعتبارسنجی خروجی LLM (۸)
- Schema کامل + clamp بازهٔ عددی (۱۸۰→۱۰۰) ✓
- فیلدهای غایب → default (دادهٔ جزئی بهتر از هیچ) ✓
- نرمال‌سازی enum های خلاقانه LLM (PURCHASE→other؛ «بالا»→high) ✓
- تاریخ: فقط ISO میلادی معتبر؛ جلالی/هرزه → null ✓
- کوچینگ + clamp نمره‌ها ✓
- extractJsonObject: plain/fence/چته/براکت در رشته/هرزه ✓

### tests/ai-risk.test.ts — موتور ریسک + RBAC (۱۲)
- مشتری سالم → ریسک ۰ بدون سیگنال ✓
- R1 cap (۵ اعتراض → ۲۵) ✓
- R2+R3 stacking ✓
- R6 فقط وقتی بعد از پیش‌فاکتور تماسی نبوده ✓
- R4/R5/R7/R8 + سقف ۱۰۰ ✓
- توصیهٔ فوری ≥۶۰ + جملهٔ انسانی برای هر سیگنال ✓
- RBAC: admin همه؛ standard عملیاتی؛ finance/production هیچ ✓

## تست مرورگر AI (browser-ai-v2700.ts — ۳۸ چک)

A1 منوی گروه AI در sidebar ✓ | A2 لیست+دکمه‌ها+pill+امتیاز ✓ |
A3 دیالوگ ۶ تب + ring + labels گوینده ✓ | A4 دکمه‌های تأیید/اجرا + دلیل ✓ |
A5 کوچینگ + تب تیم ✓ | A6 داشبورد+Supervisor+KPI+رتبه ✓ | A7 تنظیمات کامل ✓ |
A8 ماتریس دسترسی expert (۴ فرزند؛ playbook/settings مخفی؛ دیپ‌لینک fallback) ✓ |
A9 دارک بدون نشت روشن ✓ | A10 کارت Pre-Call Brief در تماس‌ها ✓

## E2E واقعی (LLM واقعی — نه Mock)

اسکریپت: `scripts/ai-e2e-test.sh` + `test:ai`
1. Login ادمین ✓ 2. Settings GET ✓ 3. ساخت مرکز واقعی از API ✓
4. ثبت متن مکالمه واقعی (اعتراض قیمت/رقیب/چک/شنبه) ✓
5. Pipeline پس‌زمینه: analyzing→completed در ~۵۵-۸۵ ثانیه ✓
6. تحلیل: intent=negotiation, temperature=cold/warm, conversionScore=40,
   confidence=0.90, ۳ اعتراض, ۱ تصمیم‌گیرنده ✓
7. کوچینگ: qualityScore=35-45 ✓ 8. NBA با تاریخ درست ✓
9. Brief: enoughData=true + ۶ اعتراض باز + توصیه ✓
10. RBAC: 401 بدون احراز ✓
11. ایزوله‌سازی: aria→۰ تماس؛ ادمین→همه ✓
12. داشبورد/مصرف: تحلیل‌شده=۲, میانگین کیفیت, توکن ✓

## باگ‌های واقعی شکارشده در سیکل (۹ مورد)
1. zod v4: intent/temperature بدون default → reject undefined
2. LLM واقعی: objections رشته، products/decisionMakers فیلد null
3. تاریخ LLM: سال غلط (2024/2025) → پارسر قطعی + sanity bound
4. پارسر فارسی: ۴ باگ ترتیب تطبیق (زیررشته‌ها)
5. RBAC: replace-all اشتباه به finance/production
6. پروسهٔ یتیم سرور (pkill الگوی غلط)
7. Rate-limit 429 در تست (page.goto×۱۰) → ناوبری client-side
8. نشت دارک آواتار غیرفعال (latent)
9. Scope ادمین بدون slug → 400

## باقی‌مانده‌ها (Known Limitations)
- Diarization زمان‌محور سطح-enterprise (الان: LLM از محتوا)
- Telephony واقعی (اینترفیس آماده)
- Google Calendar/Meet و Email واقعی (نیازمند OAuth/SMTP)
- تست بار سنگین STT با فایل‌های ۲۵MB (فرمت‌های کوچک تست شد)
