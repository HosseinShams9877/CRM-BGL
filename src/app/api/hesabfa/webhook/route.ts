import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { db } from '@/lib/db';
import { logApiError } from '@/lib/logger';

// ════════════════════════════════════════════════════════════
// HESABFA WEBHOOK (inbound, server-to-server) — v2.34.3
// The middleware has exempted this path since the legacy design
// and the admin UI lists HesabfaWebhookEvent rows — but no route
// ever existed to receive them (found by the round-50 audit).
//
// READ-ONLY integration posture: events are STORED for
// observability; syncing itself stays poll/trigger-based
// (staleness rule + sync-inventory action).
//
// Auth: Hesabfa lets you embed a secret in the webhook URL you
// register (?key=…). We accept it via query param or
// X-Hesabfa-Key header and compare in constant time against
// HESABFA_WEBHOOK_SECRET. Fail-closed: if the env is not set,
// every call is rejected — no unauthenticated writes, ever.
// ════════════════════════════════════════════════════════════

const MAX_PAYLOAD_BYTES = 16 * 1024;

function keyMatches(provided: string, secret: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  try {
    const secret = process.env.HESABFA_WEBHOOK_SECRET?.trim();
    if (!secret) {
      // fail-closed — the admin has not registered any webhook source
      return NextResponse.json({ error: 'webhook فعال نیست (HESABFA_WEBHOOK_SECRET تنظیم نشده است).' }, { status: 403 });
    }
    const provided = req.nextUrl.searchParams.get('key')?.trim() || req.headers.get('x-hesabfa-key')?.trim() || '';
    if (!provided || !keyMatches(provided, secret)) {
      return NextResponse.json({ error: 'کلید وب‌هوک نامعتبر است.' }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'بدنهٔ JSON نامعتبر است.' }, { status: 400 });
    }

    const raw = JSON.stringify(body);
    if (raw.length > MAX_PAYLOAD_BYTES) {
      return NextResponse.json({ error: 'بدنهٔ رویداد بیش از حد بزرگ است.' }, { status: 413 });
    }
    const record = body as Record<string, unknown>;
    const eventType = String(record.eventType ?? record.event ?? record.Event ?? 'unknown').slice(0, 100);

    await db.hesabfaWebhookEvent.create({
      data: {
        eventType,
        payload: raw.slice(0, MAX_PAYLOAD_BYTES),
        processed: false,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    logApiError('hesabfa-webhook', e instanceof Error ? e.message : 'unknown error');
    return NextResponse.json({ error: 'خطای داخلی سرور' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ error: 'متد مجاز نیست.' }, { status: 405 });
}
