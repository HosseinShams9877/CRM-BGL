# راهنمای Provider های هوش مصنوعی

## معماری — بدون Vendor Lock-in

تمام موتورها فقط با اینترفیس‌ها صحبت می‌کنند. افزودن Provider = پیاده‌سازی
اینترفیس + ثبت در Registry؛ هیچ موتوری تغییر نمی‌کند.

```
src/lib/ai/providers/llm.ts   → LLMProvider  (complete)
src/lib/ai/providers/stt.ts   → STTProvider  (transcribe)
src/lib/ai/connection-test.ts → تست اتصال (دکمهٔ «تست اتصال» در تنظیمات)
```

## دسترسی از ایران (ملاحظات تحریم)

سرویس‌های زیر از سرورهای ایران **در دسترس نیستند** و نباید پیکربندی شوند:

| سرویس | وضعیت از ایران |
|---|---|
| Claude / Anthropic | مسدود (تحریم) |
| OpenAI | مسدود (تحریم) |
| Google Gemini | مسدود (تحریم) |
| zai / GLM | در دسترس |
| OpenAI-سازگارِ خودمیزبان (Ollama / vLLM / LM Studio) | در دسترس — بدون وابستگی خارجی |

نکتهٔ مهم: **هیچ جزئی از BGL CRM به Claude وابسته نیست** (اسکن کد: صفر ارجاع).
معماری Provider-محور از ابتدا برای استقلال از یک فروشنده طراحی شده است.

### گزینهٔ پیشنهادی برای استقرار داخل ایران: مدل محلی

استقرار خودمیزبان هم تحریم‌ناپذیر است (هیچ درخواستی از مرز خارج نمی‌شود) و هم
دادهٔ مکالمات مشتریان را روی سرور خودتان نگه می‌دارد — برای CRM فروش، مزیت
حریم خصوصی واقعی است. راه‌اندازی با Ollama:

```bash
# ۱) نصب Ollama (ollama.com) و سپس دانلود مدل با پشتیبانی فارسی:
ollama pull qwen2.5:14b        # یا هر مدل دیگر
ollama serve                    # معمولاً خودکار بالا می‌آید

# ۲) در CRM: تنظیمات سیستم → یکپارچه‌سازی → پل هوش مصنوعی
#    آدرس سرویس: http://localhost:11434/v1/chat/completions
#    کلید API:   خالی بگذارید (سرویس محلی کلید نمی‌خواهد)
#    مدل:        qwen2.5:14b   ← باید با نام مدل دانلودشده یکسان باشد

# ۳) دکمهٔ «تست اتصال» را بزنید — در چند ثانیه پاسخ می‌گیرید
```

مسیرهای دقیق Chat Completions سرویس‌های رایج:

| سرویس | آدرس |
|---|---|
| Ollama | `http://localhost:11434/v1/chat/completions` |
| vLLM | `http://<host>:8000/v1/chat/completions` |
| LM Studio | `http://localhost:1234/v1/chat/completions` |

> **حفاظت SSRF (v2.58.3):** تمام درخواست‌های خروجی پل هوش مصنوعی
> (چت / LLM / تبدیل صدا به متن / تست اتصال) پیش از اتصال اعتبارسنجی
> می‌شوند — Loopback، محدوده‌های RFC1918، Metadata ابری (169.254.169.254)
> و Link-local نسخهٔ ۶ (fe80::/10) رد می‌شوند؛ پاسخ‌های DNS ترکیبی
> عمومی+خصوصی کل دامنه را رد می‌کند؛ اتصال به IP تأییدشده «مقید» است
> (DNS rebinding ممکن نیست)؛ Redirect هرگز دنبال نمی‌شود و یک مهلت
> واحد، DNS تا پایان بدنهٔ پاسخ را پوشش می‌دهد.
>
> اگر سرویس شما روی **همین سرور** اجرا می‌شود (نصب Local با
> Ollama/vLLM)، در فایل `.env` این تنظیم صریح را اضافه کنید و سرور را
> ری‌استارت کنید:
>
> ```env
> AI_ALLOW_LOCAL_ENDPOINTS=true
> ```
>
> این استثنا فقط Loopback و RFC1919/۱۹۱۸ را برای همین سرور مجاز
> می‌کند؛ **مقاصد Link-local و Metadata هرگز** — حتی با این تنظیم —
> مجاز نیستند. پیش‌فرض خاموش است.

آدرس باید **مسیر کامل** `/v1/chat/completions` باشد؛ آدرس ریشه (مثلاً
`http://localhost:11434/v1`) با خطای ۴۰۴ پاسخ می‌دهد — دکمهٔ «تست اتصال»
این مورد را با پیام راهنما اعلام می‌کند.

## Provider های موجود

### ۱. LLM — zai (پیش‌فرض، فعال بدون تنظیم)
- z-ai-web-dev-sdk؛ فارسی؛ در محیط توسعهٔ این پروژه بدون پیکربندی کار می‌کند
- استقرار روی سرور خودتان: فایل پیکربندی SDK را بسازید —
  `~/.z-ai-config` (یا ریشهٔ پروژه) با ساختار:
  ```json
  { "baseUrl": "https://api.z.ai/api/paas/v4", "apiKey": "<کلید شما>" }
  ```
- انتخاب از: تنظیمات هوش مصنوعی → موتور تحلیل (LLM) → «داخلی»

### ۲. LLM — OpenAI-سازگار
هر endpoint سازگار با Chat Completions (سرویس محلی Ollama/vLLM/LM Studio یا
هر سرویس ابری در دسترس):
1. **تنظیمات سیستم → یکپارچه‌سازی → پل هوش مصنوعی**: آدرس سرویس (مسیر
   کامل)، کلید (برای سرویس محلی خالی)، مدل
2. **دکمهٔ «تست اتصال»** را بزنید — اتصال، مدل و زمان پاسخ را راستی‌آزمایی
   می‌کند (سقف ۱۰ ثانیه؛ سرویس تحریم‌شده یا قطع را صادقانه اعلام می‌کند)
3. تنظیمات هوش مصنوعی → LLM → «OpenAI-سازگار»
- Security: URL اعتبارسنجی می‌شود؛ کلید فقط سمت سرور خوانده می‌شود (هرگز
  به فرم بازگردانده نمی‌شود)؛ فقط ادمین
- رفتار ذخیرهٔ کلید: فیلد خالی یعنی «کلید قبلی حفظ شود»؛ دکمهٔ
  «حذف کلید ذخیره‌شده» برای پاک‌کردن

### ۳. STT — zai (پیش‌فرض)
تبدیل صوت به متن فارسی؛ بهینه برای گفتگوی فروش.

### ۴. STT — none
غیرفعال: فقط ثبت متن دستی (تحلیل همچنان کامل کار می‌کند).

### ۵. STT — Whisper خودمیزبان (الگوی توسعه)
برای استقلال کامل از تحریم، سرویس faster-whisper/whisper.cpp را روی سرور
خودتان بالا بیاورید و Provider زیر را پیاده کنید (الگوی آماده):

```typescript
// src/lib/ai/providers/stt.ts
class WhisperSttProvider implements STTProvider {
  readonly id = 'whisper';
  async transcribe(audio: Buffer, mime: string, lang: string): Promise<SttResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'call.webm');
    form.append('model', 'whisper-1'); form.append('language', 'fa');
    const res = await fetch(process.env.WHISPER_URL!, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.WHISPER_KEY!}` }, body: form,
    });
    if (!res.ok) throw new Error(`Whisper ${res.status}`);
    const data = await res.json() as { text: string };
    return { text: data.text, provider: 'whisper', confidence: 0.9 };
  }
}
// در Registry ثبت کنید و یک گزینه به تنظیمات اضافه کنید.
```

## افزودن Provider جدید (نمونه: Whisper API)

```typescript
// src/lib/ai/providers/stt.ts
// همان الگوی بالا — پیاده‌سازی STTProvider + ثبت در Registry
```

## Telephony (VoIP/SIP/PBX) — فعال از v2.28.0

ورودی تماس: وب‌هوک امضاشده (HMAC) از Asterisk/3CX/Simotel + آپلود فایل +
متن دستی. راهنمای کامل قرارداد و فعال‌سازی: `AI_CALL_CENTER_INTEGRATION.md`.
