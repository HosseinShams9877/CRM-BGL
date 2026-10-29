import { db } from '@/lib/db';
import { isSmsProviderId, type SmsProviderId } from './provider';

// ════════════════════════════════════════════════════════════
// SMS SETTINGS — v2.43.0 (Meta key-value store, ai/settings
// pattern: ~60s read cache, safe defaults, admin-managed via
// /api/sms actions get-settings/set-settings).
//
// Key map (all optional — SMS stays DISABLED until configured):
//   sms.enabled      'true' | 'false'   (default false)
//   sms.provider     'kavenegar' | 'melipayamak' | 'sms_ir'
//   sms.api_key      secret — NEVER returned to the client (masked,
//                    read directly from Meta by the send path only)
//   sms.username     melipayamak username (provider-specific)
//   sms.password     melipayamak password — same secret rule
//   sms.sender       sender line number (e.g. 10004346)
//   sms.daily_limit  per-company daily send cap (default 200)
//   sms.signature    optional signature appended to templates
// ════════════════════════════════════════════════════════════

export interface SmsSettings {
  enabled: boolean;
  provider: SmsProviderId;
  apiKey: string;
  username: string;
  password: string;
  sender: string;
  dailyLimit: number;
  signature: string;
}

export const SMS_SETTINGS_KEYS = [
  'sms.enabled', 'sms.provider', 'sms.api_key', 'sms.username',
  'sms.password', 'sms.sender', 'sms.daily_limit', 'sms.signature',
] as const;

const DEFAULTS: SmsSettings = {
  enabled: false,
  provider: 'kavenegar',
  apiKey: '',
  username: '',
  password: '',
  sender: '',
  dailyLimit: 200,
  signature: '',
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; value: SmsSettings } | null = null;

export function invalidateSmsSettingsCache(): void {
  cache = null;
}

export async function getSmsSettings(): Promise<SmsSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const rows = await db.meta.findMany({ where: { key: { in: [...SMS_SETTINGS_KEYS] } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const value: SmsSettings = {
    enabled: (map.get('sms.enabled') ?? '') === 'true',
    provider: isSmsProviderId(map.get('sms.provider')) ? (map.get('sms.provider') as SmsProviderId) : DEFAULTS.provider,
    apiKey: map.get('sms.api_key') ?? '',
    username: map.get('sms.username') ?? '',
    password: map.get('sms.password') ?? '',
    sender: map.get('sms.sender') ?? '',
    dailyLimit: Math.max(1, Math.min(5000, Number(map.get('sms.daily_limit')) || DEFAULTS.dailyLimit)),
    signature: map.get('sms.signature') ?? '',
  };
  cache = { at: Date.now(), value };
  return value;
}

export interface SaveSmsSettingsInput {
  enabled?: boolean;
  provider?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  sender?: string;
  dailyLimit?: number;
  signature?: string;
}

export interface SaveSmsSettingsResult {
  ok: boolean;
  error?: string;
  /** how many Meta rows were upserted */
  written: number;
}

export async function saveSmsSettings(input: SaveSmsSettingsInput): Promise<SaveSmsSettingsResult> {
  const writes: Array<{ key: string; value: string }> = [];

  if (typeof input.enabled === 'boolean') {
    writes.push({ key: 'sms.enabled', value: input.enabled ? 'true' : 'false' });
  }
  if (typeof input.provider === 'string') {
    if (!isSmsProviderId(input.provider)) return { ok: false, error: 'سرویس پیامک ناشناخته است', written: 0 };
    writes.push({ key: 'sms.provider', value: input.provider });
    // switching away from melipayamak clears its credential block; secrets
    // of the other shape are left untouched (re-switch keeps them).
    if (input.provider !== 'melipayamak') {
      writes.push({ key: 'sms.username', value: '' });
      writes.push({ key: 'sms.password', value: '' });
    }
  }
  // Secrets: empty string = KEEP the stored value (the form never echoes
  // them back); a non-empty value replaces it.
  if (typeof input.apiKey === 'string' && input.apiKey.trim() !== '') {
    writes.push({ key: 'sms.api_key', value: input.apiKey.trim() });
  }
  if (typeof input.username === 'string' && input.username.trim() !== '') {
    writes.push({ key: 'sms.username', value: input.username.trim() });
  }
  if (typeof input.password === 'string' && input.password.trim() !== '') {
    writes.push({ key: 'sms.password', value: input.password.trim() });
  }
  if (typeof input.sender === 'string') {
    const s = input.sender.replace(/[\s-]/g, '');
    if (s !== '' && !/^\+?[0-9]{6,15}$/.test(s)) {
      return { ok: false, error: 'شمارهٔ فرستنده باید ۶ تا ۱۵ رقم باشد', written: 0 };
    }
    writes.push({ key: 'sms.sender', value: s });
  }
  if (typeof input.dailyLimit === 'number') {
    if (!Number.isFinite(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 5000) {
      return { ok: false, error: 'سقف روزانه باید بین ۱ تا ۵۰۰۰ باشد', written: 0 };
    }
    writes.push({ key: 'sms.daily_limit', value: String(Math.round(input.dailyLimit)) });
  }
  if (typeof input.signature === 'string') {
    if (input.signature.length > 60) return { ok: false, error: 'امضا حداکثر ۶۰ نویسه است', written: 0 };
    writes.push({ key: 'sms.signature', value: input.signature.trim() });
  }

  // enabling requires a minimally complete config — fail CLOSED, not at
  // first send time (the admin would discover it after the user lost work).
  // Secrets never echo back to the form, so "keep" semantics matter here:
  // a stored key + empty input field must still count as configured.
  const current = await getSmsSettings();
  const next: SmsSettings = {
    ...current,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
    provider: isSmsProviderId(input.provider) ? input.provider : current.provider,
    apiKey: input.apiKey?.trim() || current.apiKey,
    username: input.username?.trim() || current.username,
    password: input.password?.trim() || current.password,
    sender: typeof input.sender === 'string' ? input.sender.replace(/[\s-]/g, '') : current.sender,
    dailyLimit: typeof input.dailyLimit === 'number' ? input.dailyLimit : current.dailyLimit,
    signature: typeof input.signature === 'string' ? input.signature.trim() : current.signature,
  };
  if (input.provider && input.provider !== 'melipayamak') {
    next.username = '';
    next.password = '';
  }
  if (next.enabled) {
    const missing: string[] = [];
    if (!next.sender) missing.push('شمارهٔ فرستنده');
    if (next.provider === 'melipayamak') {
      if (!next.username || !next.password) missing.push('نام کاربری/رمز ملی‌پیامک');
    } else if (!next.apiKey) {
      missing.push('کلید API');
    }
    if (missing.length > 0) {
      return { ok: false, error: `برای فعال‌سازی، ${missing.join('، ')} الزامی است`, written: 0 };
    }
  }

  for (const w of writes) {
    await db.meta.upsert({ where: { key: w.key }, create: w, update: { value: w.value } });
  }
  invalidateSmsSettingsCache();
  return { ok: true, written: writes.length };
}
