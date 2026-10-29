import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { db } from '@/lib/db';
import { logApiError } from '@/lib/logger';
import { getAiSettings } from '@/lib/ai/settings';
import { verifyHmac, parseTelephonyEvent, maxWebhookBodyBytes } from '@/lib/ai/providers/telephony';
import { ingestTelephonyCall } from '@/lib/ai/telephony-ingest';
import { processRecording } from '@/lib/ai/engine/pipeline';
import { rateLimit, clientIpOf, RATE_TIERS } from '@/lib/rate-limit';

// ════════════════════════════════════════════════════════════
// AI SALES — TELEPHONY WEBHOOK (v2.28.0)
//
// POST /api/ai-sales/telephony/webhook        — machine-to-machine
//
// The PBX (Asterisk / 3CX / Simotel / …) calls this endpoint when a
// recorded call finishes. There is NO session auth — the HMAC-SHA256
// signature over the raw request body IS the authentication:
//
//   x-signature-256: <hmac-sha256-hex(rawBody, secret)>
//   (x-hub-signature-256 / x-pbx-signature also accepted,
//    optional "sha256=" prefix, case-insensitive)
//
// Contract: AI_CALL_CENTER_INTEGRATION.md
//   • fast-ack — 202 within milliseconds; the analysis pipeline runs
//     in the background (`after()`), exactly like manual uploads
//   • idempotent — resend the same (provider, externalId) → 200
//     { duplicate: true }, no double ingestion
//   • honest errors — 400/401/413/422/429 with Persian messages the
//     PBX admin can act on; 404 when telephony is disabled (no
//     existence leak)
// ════════════════════════════════════════════════════════════

const SIGNATURE_HEADERS = ['x-signature-256', 'x-hub-signature-256', 'x-pbx-signature', 'x-webhook-signature'];

export async function POST(req: NextRequest) {
  try {
    // 1) rate limit (webhook tier — generous machine ceiling, 300/min)
    const ip = clientIpOf(req.headers);
    const rl = rateLimit(`telephony-webhook:${ip}`, RATE_TIERS.webhook.limit, RATE_TIERS.webhook.windowMs);
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.' },
        { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
      );
    }

    // 2) feature flag (cached ~60s — flag flips take effect within a minute)
    const settings = await getAiSettings();
    if (!settings.telephonyEnabled) {
      return NextResponse.json({ error: 'یافت نشد.' }, { status: 404 });
    }

    // 3) secret (direct Meta read — never cached, rotation takes effect
    //    immediately; the secret intentionally never enters AiSalesSettings
    //    so no settings GET response can leak it)
    const secretRow = await db.meta.findUnique({ where: { key: 'ai_sales.telephony_secret' } });
    const secret = secretRow?.value || '';
    if (secret.length < 16) {
      // enabled but not provisioned — indistinguishable from disabled
      return NextResponse.json({ error: 'یافت نشد.' }, { status: 404 });
    }

    // 4) body size guard BEFORE buffering (base64 ≈ 1.4× audio + slack)
    const bodyCap = maxWebhookBodyBytes(settings.maxAudioMb);
    const contentLength = Number(req.headers.get('content-length') || 0);
    if (contentLength > bodyCap) {
      return NextResponse.json(
        { error: `حجم درخواست بیش از حد مجاز است (حداکثر ${settings.maxAudioMb} مگابایت صوت).` },
        { status: 413 },
      );
    }
    const rawBody = await req.text();
    if (rawBody.length > bodyCap) {
      return NextResponse.json(
        { error: `حجم درخواست بیش از حد مجاز است (حداکثر ${settings.maxAudioMb} مگابایت صوت).` },
        { status: 413 },
      );
    }

    // 5) HMAC — the ONLY authentication for this endpoint
    const signature =
      SIGNATURE_HEADERS.map((h) => req.headers.get(h)).find((v) => v && v.trim()) || null;
    if (!verifyHmac(rawBody, signature, secret)) {
      // log (not audit) — keeps the audit trail for real business events
      logApiError('telephony-webhook', `signature rejected (ip=${ip})`);
      return NextResponse.json({ error: 'امضای درخواست نامعتبر یا غایب است.' }, { status: 401 });
    }

    // 6) payload contract
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'بدنهٔ درخواست JSON معتبر نیست.' }, { status: 400 });
    }
    const parsed = parseTelephonyEvent(payload, settings.maxAudioMb);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // 7) ingest (idempotent, never throws)
    const result = await ingestTelephonyCall(parsed.event);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    if (result.duplicate) {
      return NextResponse.json({ accepted: true, duplicate: true, recordingId: result.recordingId });
    }

    // 8) background pipeline — webhook must never wait for STT/LLM
    if (settings.autoAnalyze) {
      after(async () => { await processRecording(result.recordingId); });
    }

    return NextResponse.json(
      { accepted: true, duplicate: false, recordingId: result.recordingId },
      { status: 202 },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'خطای داخلی سرور';
    logApiError('telephony-webhook', msg);
    return NextResponse.json({ error: 'خطای داخلی سرور' }, { status: 500 });
  }
}

// Health probes get an explicit method error (no existence leak).
export async function GET() {
  return NextResponse.json({ error: 'متد مجاز نیست.' }, { status: 405 });
}
