import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError, logApiInfo, logApiWarn } from '@/lib/logger';
import { rateLimit, clientIpOf } from '@/lib/rate-limit';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import {
  buildSmsRequest, normalizeIranMobile, parseSmsResponse, validateSmsText,
  buildTestSms, SMS_PROVIDERS,
} from '@/lib/sms/provider';
import { getSmsSettings, saveSmsSettings } from '@/lib/sms/settings';

// ════════════════════════════════════════════════════════════
// SMS API — v2.43.0
//
// POST actions:
//   send          — any authenticated user; validated phone/text,
//                   rate-limited (10/hour/IP), daily-capped per
//                   company, logged to SmsLog (sent OR failed)
//   get-settings  — admin; MASKED view (secrets never leave)
//   set-settings  — admin; strict validation, fail-closed enable
//   test          — admin; real send to a given phone, logged
//   history       — own company rows (admins: all companies)
// ════════════════════════════════════════════════════════════

const SEND_TIMEOUT_MS = 15_000;
const CONTEXT_TYPES = ['manual', 'collection', 'followup', 'test'] as const;
type ContextType = (typeof CONTEXT_TYPES)[number];

function isAdmin(user: AuthUser): boolean {
  return getCanonicalRole(user.role) === 'admin';
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'send') return await handleSend(body, user, req);
    if (action === 'get-settings') return await handleGetSettings(user);
    if (action === 'set-settings') return await handleSetSettings(body, user);
    if (action === 'test') return await handleTest(body, user, req);
    if (action === 'history') return await handleHistory(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('sms', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── SEND ────────────────────────────────────────────────────
async function handleSend(body: Record<string, unknown>, user: AuthUser, req: NextRequest) {
  const { to, text, contextType, centerName } = body as {
    to?: string; text?: string; contextType?: string; centerName?: string;
  };

  const ctx: ContextType =
    contextType && (CONTEXT_TYPES as readonly string[]).includes(contextType)
      ? (contextType as ContextType) : 'manual';

  if (typeof to !== 'string') return NextResponse.json({ error: 'شمارهٔ موبایل الزامی است' }, { status: 400 });
  const phone = normalizeIranMobile(to);
  if (!phone) return NextResponse.json({ error: 'شمارهٔ موبایل معتبر نیست (فرمت صحیح: 09xxxxxxxxx)' }, { status: 400 });
  if (typeof text !== 'string') return NextResponse.json({ error: 'متن پیامک الزامی است' }, { status: 400 });
  const v = validateSmsText(text);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });

  // anti-abuse: sliding-window per IP (10 sends/hour)
  // v2.47.0 — clientIpOf (anti-spoof): a rotating fake XFF used to mint
  // fresh sms-rate-limit buckets on demand.
  const ip = clientIpOf(req.headers);
  const rl = rateLimit(`sms:${ip}`, 10, 60 * 60 * 1000);
  if (!rl.ok) {
    return NextResponse.json(
      { error: `تعداد پیامک‌های ارسالی زیاد است — ${rl.retryAfterSec} ثانیه دیگر تلاش کنید` },
      { status: 429, headers: { 'Retry-After': String(Math.max(1, rl.retryAfterSec)) } },
    );
  }

  const settings = await getSmsSettings();
  if (!settings.enabled) {
    return NextResponse.json({ error: 'ارسال پیامک توسط مدیر سیستم فعال نشده است' }, { status: 403 });
  }

  // v2.43.0 — AuthUser carries company SLUGS; the SmsLog row needs the DB
  // companyId. Resolve the user's primary company once (indexed lookup).
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { companyId: true },
  });
  const companyId = dbUser?.companyId ?? null;

  // daily cap — per company (default 200)
  const dayStart = startOfToday();
  const sentToday = await db.smsLog.count({
    where: { companyId: companyId ?? undefined, createdAt: { gte: dayStart } },
  });
  if (sentToday >= settings.dailyLimit) {
    return NextResponse.json({ error: `سقف ارسال روزانهٔ شرکت (${settings.dailyLimit.toLocaleString('fa-IR')} پیامک) پر شده است` }, { status: 429 });
  }

  const finalText = settings.signature && !text.includes(settings.signature)
    ? `${text}\n${settings.signature}` : text;

  const req0 = buildSmsRequest(settings.provider, {
    apiKey: settings.apiKey,
    username: settings.username,
    password: settings.password,
    sender: settings.sender,
  }, phone, finalText);

  const logBase = {
    phone,
    text: finalText,
    provider: settings.provider,
    centerName: typeof centerName === 'string' ? centerName.slice(0, 120) : null,
    contextType: ctx,
    companyId,
    userId: user.id,
  };

  if ('error' in req0) {
    // config drifted (e.g. sender cleared after enable) — log honestly
    await db.smsLog.create({ data: { ...logBase, status: 'failed', error: req0.error } });
    return NextResponse.json({ error: req0.error }, { status: 400 });
  }

  let status = 'failed';
  let messageId: string | undefined;
  let error: string | undefined;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
    const res = await fetch(req0.url, {
      method: req0.method,
      headers: req0.headers,
      body: req0.body,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const bodyText = await res.text().catch(() => '');
    const parsed = parseSmsResponse(settings.provider, res.status, bodyText);
    status = parsed.ok ? 'sent' : 'failed';
    messageId = parsed.messageId;
    error = parsed.error;
    logApiInfo('sms send', { provider: settings.provider, ok: parsed.ok, http: res.status, ctx });
  } catch (e: unknown) {
    error = 'اتصال به سرویس پیامک برقرار نشد (شبکه/پروکسی)';
    logApiWarn('sms send network failure', { provider: settings.provider, msg: e instanceof Error ? e.message : '?' });
  }

  const row = await db.smsLog.create({
    data: { ...logBase, status, messageId: messageId ?? null, error: error ?? null },
  });

  if (status === 'failed') {
    return NextResponse.json({ error: error || 'ارسال پیامک ناموفق بود', logId: row.id }, { status: 502 });
  }
  return NextResponse.json({
    ok: true,
    logId: row.id,
    messageId: messageId ?? null,
    message: 'پیامک با موفقیت ارسال شد',
  });
}

// ── SETTINGS (admin, secrets masked) ────────────────────────
async function handleGetSettings(user: AuthUser) {
  if (!isAdmin(user)) return NextResponse.json({ error: 'تنظیمات پیامک فقط برای مدیر سیستم فعال است.' }, { status: 403 });
  const s = await getSmsSettings();
  const todayCount = await db.smsLog.count({ where: { createdAt: { gte: startOfToday() } } });
  return NextResponse.json({
    settings: {
      enabled: s.enabled,
      provider: s.provider,
      providerLabel: SMS_PROVIDERS.find((p) => p.id === s.provider)?.label ?? s.provider,
      sender: s.sender,
      dailyLimit: s.dailyLimit,
      signature: s.signature,
      // secrets: configured flags only, never the values
      apiKeyConfigured: s.apiKey.trim() !== '',
      usernameConfigured: s.username.trim() !== '',
      passwordConfigured: s.password.trim() !== '',
    },
    stats: { sentToday: todayCount },
    providers: SMS_PROVIDERS,
  });
}

async function handleSetSettings(body: Record<string, unknown>, user: AuthUser) {
  if (!isAdmin(user)) return NextResponse.json({ error: 'تنظیمات پیامک فقط برای مدیر سیستم فعال است.' }, { status: 403 });
  const { enabled, provider, apiKey, username, password, sender, dailyLimit, signature } = body as {
    enabled?: boolean; provider?: string; apiKey?: string; username?: string; password?: string;
    sender?: string; dailyLimit?: number; signature?: string;
  };
  const result = await saveSmsSettings({
    enabled: typeof enabled === 'boolean' ? enabled : undefined,
    provider: typeof provider === 'string' ? provider : undefined,
    apiKey: typeof apiKey === 'string' ? apiKey : undefined,
    username: typeof username === 'string' ? username : undefined,
    password: typeof password === 'string' ? password : undefined,
    sender: typeof sender === 'string' ? sender : undefined,
    dailyLimit: typeof dailyLimit === 'number' ? dailyLimit : undefined,
    signature: typeof signature === 'string' ? signature : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, written: result.written });
}

async function handleTest(body: Record<string, unknown>, user: AuthUser, req: NextRequest) {
  if (!isAdmin(user)) return NextResponse.json({ error: 'آزمایش پیامک فقط برای مدیر سیستم فعال است.' }, { status: 403 });
  const { to } = body as { to?: string };
  if (typeof to !== 'string' || !normalizeIranMobile(to)) {
    return NextResponse.json({ error: 'شمارهٔ موبایل معتبر نیست' }, { status: 400 });
  }
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: { companyId: true },
  });
  const company = dbUser?.companyId
    ? await db.company.findUnique({ where: { id: dbUser.companyId }, select: { name: true } })
    : null;
  const text = buildTestSms(company?.name ?? 'BGL');
  return await handleSend({ to, text, contextType: 'test' }, user, req);
}

// ── HISTORY ─────────────────────────────────────────────────
async function handleHistory(user: AuthUser) {
  // scope non-admins to their own company's sends (admins see all)
  let companyFilter: Record<string, unknown> | undefined;
  if (!isAdmin(user)) {
    const dbUser = await db.user.findUnique({ where: { id: user.id }, select: { companyId: true } });
    companyFilter = { companyId: dbUser?.companyId ?? null };
  }
  const rows = await db.smsLog.findMany({
    where: companyFilter,
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, phone: true, text: true, status: true, error: true,
      centerName: true, contextType: true, createdAt: true,
      provider: true, user: { select: { displayName: true } },
    },
  });
  return NextResponse.json({
    items: rows.map((r) => ({
      id: r.id,
      phone: r.phone,
      text: r.text,
      status: r.status,
      error: r.error,
      centerName: r.centerName,
      contextType: r.contextType,
      createdAt: r.createdAt,
      provider: r.provider,
      sender: r.user?.displayName ?? '—',
    })),
  });
}
