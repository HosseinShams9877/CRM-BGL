# تحلیل شکاف — BGL AI Sales Intelligence
### هوش مصنوعی فروش و تحلیل مکالمات — نسخه پایه v2.26.2 → v2.27.0

> این سند خروجی «مرحله صفر — تحلیل اجباری پروژه» است و پیش از هر کدنویسی تولید شده است.

---

## ۱. معماری کشف‌شده (زیرساخت موجود)

| لایه | وضعیت | جزئیات |
|------|--------|--------|
| Framework | ✅ | Next.js 16 (App Router) + React 19 + TypeScript strict |
| UI | ✅ | Tailwind 4 + shadcn/ui کامل + RTL + فونت Vazirmatn محلی + Dark Mode + next-themes |
| ORM / DB | ✅ | Prisma 6 + SQLite (WAL) — ۴۵ مدل موجود |
| Authentication | ✅ | Session cookie (`bgl_session`) + PBKDF2/bcrypt + انقضای سرورسرورِ سرِ لغزان + محدودسازی تلاش ورود (HMAC) |
| Authorization | ✅ | دو لایه: `User.role` (admin/finance/production/standard → ۲۳ پرچم `RolePermissions` برای API) + `User.jobTitle` (ماتریس منو در هر شرکت) |
| Multi-Tenant | ✅ | Company (holding/bazargani/aria/bgl) + BusinessUnit + `companyIds` کاربر + `canAccessCompany` + هلپرهای `company-scope.ts` |
| Copilot AI موجود | ⚠️ | `ai-bridge`: پل چت OpenAI-سازگار عمومی (تنظیمات ادمین + تاریخچه per-user + پرامپت‌ها). **چت عمومی است، نه موتور فروش** |
| ماژول تماس‌ها | ⚠️ | `sales-calls.tsx`: ثبت دستی تماس بر پایه `Activity.isPhoneCall` + تایمر نشست + «مدت مکالمه» داخل description. **بدون صوت، بدون متن، بدون تحلیل** |
| Activities | ✅ | CRUD کامل + تخصیص + وضعیت + دامنه شرکت |
| Calendar | ✅ | `sales-calendar.tsx` (تقویم جلالی روی Activity) |
| Pipeline | ✅ | `sales-pipeline.tsx` (مراحل فروش روی SalesDocument) |
| Contacts/Centers | ✅ | Center + CenterContact + ContactProfileNote (رگ خواب!) + tags + customFields |
| Sales Docs | ✅ | پیش‌فاکتور/فاکتور/مرجوعی + تأییدها + مالی + نسخه‌ها + لاگ |
| Notifications | ✅ | سامانه مراسلات داخلی (letter) + unreadCount در Topbar |
| Audit | ✅ | `AuditEvent` + `/api/audit` |
| File Storage | ⚠️ | ذخیره واقعی روی دیسک + SHA-256 + سقف ۱۰MB + allowlist MIME — **صوت در allowlist نیست** |
| Background Jobs | ⚠️ | الگوی `HesabfaJob` (status/payload/result) — صف کار وجود دارد اما عمومی نیست |
| Persian/Jalali | ✅ | `lib/jalali.ts` کامل + اعداد فارسی + Vazirmatn |
| Rate Limit | ✅ | 120 req/60s |
| Testing | ✅ | Vitest (۷۴ تست) + باتری مرورگر + api-sweep + `run-zero-bug.sh` (۷ گیت کیفیت) |
| LLM/STT داخلی | ✅ | `z-ai-web-dev-sdk` نصب است (chat + ASR فارسی) — **Provider پیش‌فرض واقعی و بدون هزینه اتصال** |

## ۲. قابلیت‌های قابل استفاده مجدد (Reuse — نه بازنویسی)

1. **ai-bridge** → به‌عنوان الگوی تنظیمات + Provider «OpenAI-سازگار» در معماری جدید (نه حذف؛ در کنار Provider پیش‌فرض zai)
2. **Activity** → مقصد تمام Auto-Activity ها (NBA اجرا شده = Activity واقعی؛ هیچ سیستم موازی ساخته نمی‌شود)
3. **AuditEvent** → ثبت تمام اقدامات AI با eventType های `ai_sales.*`
4. **File storage** → ذخیره فایل صوتی (با افزودن MIME های صوتی و سقف جداگانه)
5. **company-scope helpers** → ایزوله‌سازی تمام کوئری‌های AI
6. **Meta key-value** → Feature Flags و تنظیمات per-company
7. **HesabfaJob pattern** → الگوی Status Pipeline پردازش تماس
8. **Menu catalog + access matrix** → افزودن گروه منوی «هوش مصنوعی فروش»
9. **jalali.ts** → نمایش تاریخ‌ها + پارس تاریخ نسبی فارسی در موتور NBA
10. **ContactProfileNote (رگ خواب)** → منبع ورودی Structured Memory (ادغام، نه جایگزینی)
11. **run-zero-bug.sh** → گیت‌های کیفیت این ماژول هم داخل همان زنجیره

## ۳. شکاف‌ها (Gap) و تصمیم ساخت

| # | نیاز پرامپت | وضعیت | تصمیم |
|---|-------------|--------|--------|
| G1 | مدل‌های داده AI (CallRecording/Transcript/Analysis/...) | ❌ | مدل‌های جدید Prisma با پیشوند `Ai` + `companyId` روی همه |
| G2 | Ingestion تماس (آپلود صوت / دستی / آینده: VoIP) | ❌ | آپلود multipart واقعی + Adapter اینترفیس `TelephonyProvider` (پیاده‌سازی فعلی: manual-upload) |
| G3 | Speech-to-Text فارسی | ❌ | Provider `zai-asr` (فعال) + اینترفیس برای OpenAI/Whisper/Azure آینده |
| G4 | Speaker Identification | ❌ | جدا‌سازی دوگوینده با heuristic ساختاری + LLM (محدودیت ثبت‌شده) |
| G5 | تحلیل مکالمه (خلاصه/اینtente/اعتراض/دما/احتمال تبدیل) | ❌ | موتور LLM با JSON Schema + zod + Grounding |
| G6 | Next Best Action + Approval (Suggest/Confirm/Auto) | ❌ | مدل `AiNextAction` با چرخه وضعیت + Policy از تنظیمات |
| G7 | استخراج تاریخ Follow-up فارسی («پس‌فردا»، «شنبه») | ❌ | پارسر تاریخ نسبی فارسی (واحد تست‌پذیر) |
| G8 | Auto Activity / Calendar | ❌ | سرویس ایجاد Activity موجود را صدا می‌زند (بدون سیستم موازی) |
| G9 | Customer AI Memory ساختاریافته | ❌ | مدل `AiCustomerMemory` (JSON ساختاریافته، نه transcript خام) |
| G10 | Pre-Call Brief | ❌ | موتور `brief` — grounded روی تماس‌های قبلی + حافظه + اسناد |
| G11 | Sales Coach + Quality Score | ❌ | موتور `coach` با ۱۳ معیار + مدل `AiCoachInsight` |
| G12 | Risk Detection فرصت‌ها | ❌ | موتور قانون‌محور `risk` (بدون LLM → بدون Hallucination) |
| G13 | Manager Dashboard / Supervisor / Daily Brief | ❌ | API + UI داشبورد مدیریتی + خلاصه روزانه grounded |
| G14 | RBAC ریزدانه ai.* | ❌ | افزودن پرچم‌های `ai_*` به RolePermissions + گارد منو |
| G15 | Feature Flags per-company | ❌ | کلیدهای Meta `ai_sales.*` |
| G16 | Usage / Cost Tracking | ❌ | مدل `AiUsageLog` + سقف ماهانه |
| G17 | Playbook / Winning Mining | ❌ | مدل `AiPlaybook` + استخراج الگو از تماس‌های موفق (MVP) |
| G18 | Google Calendar/Meet + Email Automation | ❌ | اینترفیس Adapter + تنظیمات؛ **فعال‌سازی واقعی مستلزم OAuth/SMTP credentials است** → مستندسازی، بدون Fake |
| G19 | Telephony واقعی (SIP/PBX) | ❌ | اینترفیس Adapter؛ ingestion فعلاً upload/manual |
| G20 | Privacy (Retention/Consent/حذف) | ❌ | فیلد consent + Retention + حذف آبشاری صوت/متن |
| G21 | Prompt Injection Protection | ❌ | قرنطینه transcript به‌عنوان داده غیرقابل‌اعتماد + دستور صریح سیستم |
| G22 | صوت در Files | ❌ | افزودن MIME صوتی + سقف ۲۵MB (قابل تنظیم) |

## ۴. ریسک‌ها و ملاحظات

| ریسک | شدت | راهکار |
|------|------|--------|
| Hallucination در استخراج AI | بالا | Grounding سخت: فیلدهای بدون پشتوانه transcript → null؛ Confidence ذخیره؛ zod validation |
| Prompt Injection از طریق گفتار مشتری | بالا | قرنطینه ورودی + System prompt صریح + عدم اجرای دستورات داخل transcript |
| نشت Transcript بین شرکت‌ها | بالا | فیلتر `companyId` اجباری در همه کوئری‌ها + تست ایزوله‌سازی |
| کندی پردازش صوت در Request | متوسط | پردازش async با `after()` در Next 16 + Status Pipeline + UI وضعیت زنده |
| واترمارک هزینه AI | متوسط | AiUsageLog + سقف ماهانه + شمارنده توکن |
| کیفیت STT فارسیِ اصطلاحات پزشکی | متوسط | Domain Vocabulary در پرامپت (ventilator/BiPAP/CPAP/ICU...) |
| حجم دیتابیس SQLite با صوت | متوسط | صوت روی دیسک (نه DB) + Retention policy |
| Diarization دقیق گوینده | پایین | heuristic + محدودیت مستند |

## ۵. Migrationهای لازم

- **M1**: مدل‌های جدید (AiCallRecording, AiCallTranscript, AiCallAnalysis, AiNextAction, AiCustomerMemory, AiCoachInsight, AiUsageLog, AiPlaybook) — همه Additive، بدون تغییر مدل‌های موجود؛ Safe + Backward-Compatible (Prisma `db push` پس از validate).
- **M2**: افزودن پرچم‌های `ai_*` به RolePermissions — تغییر کد است نه DB.
- هیچ داده موجود حذف یا تغییر نمی‌یابد.

## ۶. APIهای جدید (طبق Convention فعلی: POST + action)

```
POST /api/ai-sales/calls        → list | get | create-manual | delete | retry | transcript
POST /api/ai-sales/calls/upload → multipart (فایل صوت + متادیتا)
GET  /api/ai-sales/calls/audio  → استریم صوت (گارد مجوز + audit)
POST /api/ai-sales/calls/analyze → اجرای Pipeline (async)
POST /api/ai-sales/actions      → list | approve | execute | dismiss | complete
POST /api/ai-sales/brief        → Pre-Call Brief مشتری
POST /api/ai-sales/coaching     → my | team | get
POST /api/ai-sales/dashboard    → KPIs + مقایسه کارشناسان
POST /api/ai-sales/supervisor   → Daily/Morning Brief
POST /api/ai-sales/memory       → get | update
POST /api/ai-sales/playbook     → list | save | delete | mine
POST /api/ai-sales/settings     → get | set (ادمین)
POST /api/ai-sales/usage        → آمار مصرف (ادمین)
```

## ۷. صفحات UI جدید (در منوی موجود، بدون بازطراحی)

- گروه منو `ai-intelligence` (هوش مصنوعی فروش) در هر ۴ شرکت:
  - `ai-dashboard` داشبورد هوش فروش (KPI + نمودار)
  - `ai-calls` تماس‌های تحلیل‌شده (لیست + دیالوگ جزئیات ۶ تب + پخش‌کننده صوت)
  - `ai-actions` اقدامات پیشنهادی (تأیید/اجرا/رد)
  - `ai-coaching` مربی هوشمند فروش
  - `ai-playbook` پلی‌بوک فروش (ادمین)
  - `ai-settings` تنظیمات هوش مصنوعی (ادمین)
- کارت «پیشنهاد AI برای تماس بعدی» در صفحه تماس‌ها (تب ثبت) پس از انتخاب مرکز

## ۸. تصمیم MVP (Core-First)

**در این نسخه کامل و واقعی ساخته می‌شود**: G1–G17, G20–G22 (به‌جز آنچه در سطر زیر است)
**به‌صورت آماده‌بستر (Adapter + تنظیمات + مستندات، بدون Fake)**: G18 (Google OAuth/SMTP) و G19 (Telephony Provider)

## ۹. گیت‌های کیفیت

این ماژول تابع همان زنجیره «باگ صفر» است: `typecheck → eslint → vitest → build → api-sweep` و تست‌های ایزوله‌سازی/RBAC جدید.
