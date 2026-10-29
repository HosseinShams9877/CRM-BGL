# معماری BGL AI Sales Intelligence
### هوش مصنوعی فروش و تحلیل مکالمات — v2.27.0

## ۱. نمای کلی

ماژول AI Sales Intelligence روی زیرساخت موجود CRM (Next.js 16 App Router، Prisma 6/SQLite، Session Auth، RBAC دو‌لایه، Company Isolation) ساخته شده — **بدون بازنویسی هیچ بخش سالم**. همهٔ اقدامات AI از مسیرهای موجود (Activity، AuditEvent، File، Meta) عبور می‌کنند؛ هیچ سیستم موازی وجود ندارد.

```
┌─────────────────────────────────────────────────────────────┐
│ UI: گروه منوی «هوش مصنوعی فروش» (۶ صفحه) + کارت Pre-Call     │
│     ai-dashboard · ai-calls · ai-actions · ai-coaching ·     │
│     ai-playbook · ai-settings + pre-call-brief-card          │
├─────────────────────────────────────────────────────────────┤
│ API Layer (POST + action — همان convention پروژه):           │
│ /api/ai-sales/{calls, calls/upload, calls/audio, actions,    │
│  brief, dashboard, coaching, memory, playbook, settings,     │
│  usage}  ← گارد: ai_* permission + company scope + audit     │
├─────────────────────────────────────────────────────────────┤
│ Engine Layer (src/lib/ai/engine/):                           │
│  pipeline  → زنجیرهٔ وضعیت + هماهنگی STT/LLM/نوشتن          │
│  nba       → Next Best Action + سیاست تأیید + اجرا→Activity  │
│  memory    → حافظهٔ ساختاریافته (ادغام LLM + fallback قطعی)   │
│  brief     → Pre-Call Brief مبتنی بر دادهٔ واقعی              │
│  risk      → ۸ قانون R1-R8 (بدون LLM → صفر Hallucination)    │
│  stats     → تجمیع داشبورد مدیریتی                            │
├─────────────────────────────────────────────────────────────┤
│ Provider Abstraction (src/lib/ai/providers/):                │
│  LLMProvider: zai (پیش‌فرض) │ openai_compat (ai_bridge)      │
│  STTProvider: zai (پیش‌فرض) │ none                            │
│  TelephonyProvider: اینترفیس (ingestion فعلاً upload/manual)  │
├─────────────────────────────────────────────────────────────┤
│ Data Layer: ۸ مدل Prisma با پیشوند Ai* — همه Company-Scoped  │
│  AiCallRecording · AiCallTranscript · AiCallAnalysis ·       │
│  AiNextAction · AiCustomerMemory · AiCoachInsight ·          │
│  AiUsageLog · AiPlaybook                                     │
└─────────────────────────────────────────────────────────────┘
```

## ۲. Pipeline پردازش تماس

```
upload (multipart) ─┐
manual transcript ──┤→ AiCallRecording(status=queued)
                    │      │ after() ← هرگز Request UI را بلاک نمی‌کند
                    ▼      ▼
                 [transcribing] فایل صوت از دیسک (SHA-256 verify)
                    │  STTProvider.transcribe() → AiCallTranscript
                    ▼
                 [analyzing] buildAnalysisPrompt (حقن واژگان پزشکی
                    │  + قرنطینهٔ injection) → LLMProvider.complete()
                    │  → extractJsonObject → zod (clamp/null-tolerant)
                    │  → AiCallAnalysis (+segments گوینده روی transcript)
                    │  ⚠ خطا → ۱ retry خودکار → fail با دلیل انسانی
                    ▼
                 createNextActionsFromAnalysis (سیاست suggest/
                    │  confirm/auto؛ auto≥۰.۷۵ → اجرای فوری)
                    ▼
                 upsertMemoryFromAnalysis (ادغام حافظه؛ خطا → fallback قطعی)
                    ▼
                 coachCall (اگر coach_enabled و rep مشخص)
                    ▼
                 [completed] ── خطاها: [failed] + failReason + retry دستی
```

## ۳. مدل داده (همه additive — `prisma db push`)

| مدل | نقش | کلیدها |
|-----|-----|--------|
| AiCallRecording | تماس + زنجیرهٔ وضعیت | companyId, centerId?, contactId?, userId?, audioFileId?, status, retryCount, consent, retentionUntil |
| AiCallTranscript | متن + segments گوینده | recordingId (1:1), sttProvider, fullText, segments JSON |
| AiCallAnalysis | استخراج ساختاریافته | recordingId, intent, temperature, conversionScore, scoreReasons, objections, decisionMakers, confidence, needsReview |
| AiNextAction | NBA با چرخهٔ تأیید | companyId, centerId?, type(۱۴), status(۵), dueAt, reason, confidence, executedActivityId |
| AiCustomerMemory | حافظهٔ ساختاریافته | centerId+contactId, preferences, insights |
| AiCoachInsight | ارزیابی ۱۳ معیاره | userId, recordingId, qualityScore, scores |
| AiUsageLog | کنترل هزینه | companyId, feature, tokens, audioSeconds, cost |
| AiPlaybook | پلی‌بوک فروش | companyId, category(۷), source(manual/winning-mined) |

## ۴. RBAC

هفت مجوز `ai_*` به `RolePermissions` موجود اضافه شد (نه سیستم مجوز جدید):

| مجوز | admin | standard | finance | production |
|------|:-----:|:--------:|:-------:|:----------:|
| ai_calls_read | ✓ | ✓ (شرکت خود) | ✗ | ✗ |
| ai_transcript_read | ✓ | ✓ (شرکت خود) | ✗ | ✗ |
| ai_coaching_read | ✓ | ✓ | ✗ | ✗ |
| ai_manager_dashboard | ✓ | ✗ | ✗ | ✗ |
| ai_playbook_manage | ✓ | ✗ | ✗ | ✗ |
| ai_settings_manage | ✓ | ✗ | ✗ | ✗ |
| ai_usage_view | ✓ | ✗ | ✗ | ✗ |

منو: گروه `ai-intelligence` برای sales_expert فقط ۴ فرزند عملیاتی را می‌بیند (playbook/settings حذف می‌شوند)؛ دیپ‌لینک به تب مخفی هم fallback می‌خورد.

## ۵. Explainability و Confidence

- هر ConversionScore آرایهٔ `scoreReasons` دارد ({factor, impact:±۱, detail})
- هر NBA فیلد `reason` + `confidence` دارد؛ در UI رندر می‌شوند
- Confidence < ۰.۵۵ → `needsReview=true` → بج «نیازمند بازبینی»
- موتور ریسک ۱۰۰٪ قاعده‌محور است — هر سیگنال کد (R1-R8) + امتیاز + جملهٔ فارسی دارد

## ۶. تنظیمات و Feature Flags

همه در Meta (الگوی موجود) با کش ۶۰ ثانیه‌ای:
`ai_sales.enabled` · `ai_sales.enabled.<companyId>` (per-company) · `ai_sales.llm_provider` · `ai_sales.stt_provider` · `ai_sales.approval_mode` (+override شرکت) · `ai_sales.auto_analyze` · `ai_sales.coach_enabled` · `ai_sales.max_audio_mb` · `ai_sales.retention_days` · `ai_sales.monthly_cost_limit_rial` · `ai_sales.domain_vocabulary`

## ۷. نقاط اتصال به ماژول‌های موجود

| ماژول موجود | اتصال |
|-------------|-------|
| Activities | اجرای NBA = ایجاد Activity واقعی (همان shape هسته) |
| Calendar | فعالیت اجراشده با activityDate ظاهر می‌شود |
| AuditEvent | همهٔ رویدادهای AI_* (تأیید/اجرا/حذف/خواندن transcript/صوت/تنظیمات) |
| File | صوت با category='ai-call-audio' + checksum |
| Centers/Contacts | پیوند همهٔ موجودیت‌های AI + کارت Brief در تماس‌ها |
| ai-bridge | Provider «OpenAI-سازگار» از همان تنظیمات ادمین |
| CONTACT_PROFILE_NOTE | ورودی زمینهٔ تحلیل (رگ خواب) |

## ۸. محدودیت‌های شناخته‌شده

- Diarization دقیق زمان‌محور در سطح Azure/Google نیست — تفکیک گوینده توسط LLM از محتوا انجام می‌شود (بهتر از هوریستیک، دقیق‌تر از هردو نیست)
- Telephony واقعی (SIP/PBX) اینترفیس دارد؛ ingestion فعلاً آپلود/دستی است
- Google Calendar/Meet و ارسال ایمیل واقعی مستلزم OAuth/SMTP credentials است — عمداً Fake ساخته نشد
- SQLite تک‌پروسه: پردازش پس‌زمینه با after() در همان Node انجام می‌شود (برای استقرار چندپروسه‌ای، صف Redis/MongoDB قابل افزودن بدون تغییر موتورهاست)
