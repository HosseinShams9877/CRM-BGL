// ════════════════════════════════════════════════════════════
// SMS PROVIDER — v2.43.0 pure request builders / response parsers
//
// Iranian SMS providers, built as PURE functions so every branch
// is unit-testable without touching the network:
//   kavenegar   — REST: GET https://api.kavenegar.com/v1/{API-KEY}/sms/send.json
//   melipayamak — REST: POST https://rest.payamak-panel.com/api/SendSMS/SendSMS
//                 (username + password, NOT a bearer key)
//   sms_ir      — REST: POST https://api.sms.ir/v1/send/bulk (x-api-key header)
//
// The caller (API route) owns fetch, timeouts, logging and
// rate/daily limits — this module only maps data.
// ════════════════════════════════════════════════════════════

export type SmsProviderId = 'kavenegar' | 'melipayamak' | 'sms_ir';

export const SMS_PROVIDERS: ReadonlyArray<{ id: SmsProviderId; label: string; needsUserPass: boolean }> = [
  { id: 'kavenegar', label: 'کاوه‌نگار (Kavenegar)', needsUserPass: false },
  { id: 'melipayamak', label: 'ملی‌پیامک (Melipayamak)', needsUserPass: true },
  { id: 'sms_ir', label: 'پیامک‌رسان (SMS.ir)', needsUserPass: false },
];

export function isSmsProviderId(v: unknown): v is SmsProviderId {
  return v === 'kavenegar' || v === 'melipayamak' || v === 'sms_ir';
}

// ── Phone normalization ─────────────────────────────────────
// Accepts the shapes users actually paste (09…, +989…, 00989…,
// bare 9…) and canonicalizes to the 11-digit 09xxxxxxxxx form
// every provider expects in its `to`/`receptor` field.
const DIGITS_RE = /^[0-9]+$/;

export function normalizeIranMobile(raw: string): string | null {
  const s = String(raw ?? '').replace(/[\s\-()]/g, '');
  if (!s) return null;
  let d = s;
  if (d.startsWith('+98')) d = '0' + d.slice(3);
  else if (d.startsWith('0098')) d = '0' + d.slice(4);
  else if (d.startsWith('98') && d.length === 12) d = '0' + d.slice(2);
  else if (d.startsWith('9') && d.length === 10) d = '0' + d;
  if (d.length !== 11 || !DIGITS_RE.test(d)) return null;
  if (!d.startsWith('09')) return null;
  // second digit block must be a mobile prefix (90-99 ranges)
  const prefix = Number(d.slice(1, 3));
  if (prefix < 90 || prefix > 99) return null;
  return d;
}

// ── Message body rules ──────────────────────────────────────
// Providers reject empty and oversized bodies; our own cap is a
// single concatenated SMS (2 segments worth) to keep costs sane.
export const SMS_MAX_CHARS = 459;
export const SMS_MIN_CHARS = 1;

export function validateSmsText(text: string): { ok: true } | { ok: false; error: string } {
  const t = String(text ?? '').trim();
  if (t.length < SMS_MIN_CHARS) return { ok: false, error: 'متن پیامک خالی است' };
  if (t.length > SMS_MAX_CHARS) return { ok: false, error: `متن پیامک باید حداکثر ${SMS_MAX_CHARS} نویسه باشد` };
  return { ok: true };
}

// ── Request builders ────────────────────────────────────────
export interface SmsProviderConfig {
  apiKey: string;          // kavenegar + sms_ir
  username?: string;       // melipayamak
  password?: string;       // melipayamak
  sender: string;          // line number (e.g. 10004346)
}

export interface SmsHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** undefined for GET — query string already carries the payload */
  body?: string;
}

export function buildSmsRequest(
  provider: SmsProviderId,
  cfg: SmsProviderConfig,
  to: string,
  text: string,
): SmsHttpRequest | { error: string } {
  if (!normalizeIranMobile(to)) return { error: 'شمارهٔ موبایل معتبر نیست' };
  const v = validateSmsText(text);
  if (!v.ok) return { error: v.error };
  if (!cfg.sender.trim()) return { error: 'شمارهٔ فرستنده تنظیم نشده است' };

  if (provider === 'kavenegar') {
    if (!cfg.apiKey.trim()) return { error: 'کلید API کاوه‌نگار تنظیم نشده است' };
    const qs = new URLSearchParams({ receptor: to, sender: cfg.sender.trim(), message: text });
    return {
      url: `https://api.kavenegar.com/v1/${encodeURIComponent(cfg.apiKey.trim())}/sms/send.json?${qs.toString()}`,
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
  }

  if (provider === 'melipayamak') {
    if (!cfg.username?.trim() || !cfg.password?.trim()) return { error: 'نام کاربری و رمز ملی‌پیامک تنظیم نشده است' };
    return {
      url: 'https://rest.payamak-panel.com/api/SendSMS/SendSMS',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: cfg.username.trim(), password: cfg.password.trim(), to, from: cfg.sender.trim(), text }),
    };
  }

  // sms_ir — bulk send to a single receptor
  if (!cfg.apiKey.trim()) return { error: 'کلید API پیامک‌رسان تنظیم نشده است' };
  return {
    url: 'https://api.sms.ir/v1/send/bulk',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey.trim(), Accept: 'application/json' },
    body: JSON.stringify({ lineNumber: cfg.sender.trim(), messageText: text, mobiles: [to] }),
  };
}

// ── Response parsers ────────────────────────────────────────
export interface SmsSendResult {
  ok: boolean;
  messageId?: string;
  /** Persian, user-facing — never a raw provider dump */
  error?: string;
}

export function parseSmsResponse(provider: SmsProviderId, httpStatus: number, bodyText: string): SmsSendResult {
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // non-JSON body (proxy page, HTML error) — parsers fall through to
    // the generic «پاسخ نامعتبر» branches below via the null default
  }

  if (provider === 'kavenegar') {
    // 200 with { return: { status: 200... } } OR error bodies; HTTP non-200 = auth/quota
    if (httpStatus === 200 && json) {
      const ret = json.return as Record<string, unknown> | undefined;
      const status = typeof ret?.status === 'number' ? ret.status : undefined;
      if (status === 200) {
        const entries = json.entries as Array<Record<string, unknown>> | undefined;
        const mid = entries && entries.length > 0 && typeof entries[0].messageid === 'number'
          ? String(entries[0].messageid) : undefined;
        return { ok: true, messageId: mid };
      }
      return { ok: false, error: `کاوه‌نگار خطا داد (کد ${status ?? 'نامشخص'})` };
    }
    if (httpStatus === 401 || httpStatus === 403) return { ok: false, error: 'کلید API کاوه‌نگار نامعتبر است' };
    return { ok: false, error: `کاوه‌نگار پاسخ ${httpStatus} داد` };
  }

  if (provider === 'melipayamak') {
    // Body: { Value: 'نویسه‌های عددی', RetStatus: 1, StrRetStatus: 'Ok' }
    // RetStatus 1 = accepted; Value = provider message id
    if (json && typeof json.RetStatus === 'number') {
      if (json.RetStatus === 1) {
        const val = typeof json.Value === 'string' ? json.Value : undefined;
        return { ok: true, messageId: val };
      }
      return { ok: false, error: `ملی‌پیامک خطا داد (${json.StrRetStatus ?? json.RetStatus})` };
    }
    return { ok: false, error: 'ملی‌پیامک پاسخ نامعتبر داد' };
  }

  // sms_ir — { status: 1, messageId (number), message: 'موفق' }
  if (json && typeof json.status === 'number') {
    if (json.status === 1) {
      const mid = typeof json.messageId === 'number' ? String(json.messageId) : undefined;
      return { ok: true, messageId: mid };
    }
    return { ok: false, error: `پیامک‌رسان خطا داد (کد ${json.status})` };
  }
  if (httpStatus === 401) return { ok: false, error: 'کلید API پیامک‌رسان نامعتبر است' };
  return { ok: false, error: `پیامک‌رسان پاسخ ${httpStatus} داد` };
}

// ── Templates ───────────────────────────────────────────────
// Fixed wording so admins can audit what their users send; the
// dialog pre-fills these and the user can still edit before send.
export function buildCollectionReminderSms(params: {
  centerName: string;
  invoiceNumber: string;
  amountRial: number;
  overdueDays: number;
  companyName: string;
}): string {
  const amount = params.amountRial.toLocaleString('fa-IR');
  const overdue = params.overdueDays > 0 ? `${params.overdueDays.toLocaleString('fa-IR')} روز از سررسید گذشته است` : 'سررسید فاکتور رسیده است';
  return `${params.centerName} گرامی؛\nفاکتور ${params.invoiceNumber} به مبلغ ${amount} ریال — ${overdue}. لطفاً جهت تسویه با ${params.companyName} هماهنگ فرمایید.`;
}

export function buildFollowupReminderSms(params: {
  centerName: string;
  personName?: string | null;
  companyName: string;
}): string {
  const greet = params.personName ? `${params.personName} عزیز، ` : `${params.centerName} گرامی؛ `;
  return `${greet}یادآوری پیگیری دوره‌ای از سوی ${params.companyName}. لطفاً در صورت نیاز به هماهنگی تماس بگیرید.`;
}

export function buildTestSms(companyName: string): string {
  return `پیامک آزمایشی از سامانهٔ CRM ${companyName} — تنظیمات ارسال با موفقیت کار می‌کند.`;
}
