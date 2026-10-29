import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

// ══════════════════════════════════════════════════════════
// PIPELINE — v2.34.6 per-user sales-pipeline customization
// Each user (typically a sales expert) owns a PERSONAL pipeline:
// custom stage titles, order, and visibility. Stored as JSON in
// Meta under `pipeline.<userId>`; never shared across users.
//
// A stage config maps 1:1 onto a SYSTEM stage key — the document
// placement logic (stageOf) is untouched, only presentation
// (title/order/visibility) is personalized.
//
// GET              → { stages: UserStage[] | null }   (null = defaults)
// POST save        → validate + persist own config
// POST reset       → back to system defaults (deletes the key)
// ══════════════════════════════════════════════════════════

const SYSTEM_STAGE_KEYS = [
  'presentation', 'negotiation', 'proforma', 'proforma-followup',
  'invoice', 'dispatch', 'procurement', 'cancelled',
] as const;
type SystemStageKey = (typeof SYSTEM_STAGE_KEYS)[number];

export interface UserStage {
  key: SystemStageKey;
  title: string;
  visible: boolean;
}

const META_PREFIX = 'pipeline.';

function metaKey(userId: string): string {
  return META_PREFIX + userId;
}

function validateStages(raw: unknown): { ok: true; stages: UserStage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'فهرست مراحل خالی است' };
  if (raw.length > SYSTEM_STAGE_KEYS.length) return { ok: false, error: `حداکثر ${SYSTEM_STAGE_KEYS.length} مرحله مجاز است` };
  const seen = new Set<string>();
  const out: UserStage[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { ok: false, error: 'ساختار مرحله نامعتبر است' };
    const { key, title, visible } = item as Record<string, unknown>;
    if (typeof key !== 'string' || !(SYSTEM_STAGE_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `کلید مرحلهٔ ناشناخته: ${String(key)}` };
    }
    if (seen.has(key)) return { ok: false, error: `مرحلهٔ تکراری: ${key}` };
    seen.add(key);
    const t = typeof title === 'string' ? title.trim() : '';
    if (!t || t.length > 60) return { ok: false, error: 'عنوان هر مرحله باید ۱ تا ۶۰ نویسه باشد' };
    out.push({ key: key as SystemStageKey, title: t, visible: visible !== false });
  }
  return { ok: true, stages: out };
}

export async function GET() {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
    const row = await db.meta.findUnique({ where: { key: metaKey(user.id) } });
    const stages: UserStage[] | null = row ? JSON.parse(row.value) : null;
    return NextResponse.json({ stages });
  } catch (e: unknown) {
    return NextResponse.json({ error: apiErrorMessage(e, 'خطای سرور') }, { status: apiErrorStatus(e) });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
    const body = await req.json();
    const { action } = body;

    if (action === 'save') {
      const verdict = validateStages(body.stages);
      if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 400 });
      await db.meta.upsert({
        where: { key: metaKey(user.id) },
        update: { value: JSON.stringify(verdict.stages) },
        create: { key: metaKey(user.id), value: JSON.stringify(verdict.stages) },
      });
      return NextResponse.json({ success: true, stages: verdict.stages });
    }

    if (action === 'reset') {
      await db.meta.deleteMany({ where: { key: metaKey(user.id) } });
      return NextResponse.json({ success: true, stages: null });
    }

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ error: apiErrorMessage(e, 'خطای سرور') }, { status: apiErrorStatus(e) });
  }
}
