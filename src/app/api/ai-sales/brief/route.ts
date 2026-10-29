import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
// v2.58.11 (audit P1-1): the central AI Sales access policy replaces the
// company-only centerInCompanyScope gate.
import { assertAiCenterAccess } from '@/lib/ai/access-policy';
import { buildPreCallBrief } from '@/lib/ai/engine/brief';
import { hasAiPermission, aiDenied } from '@/lib/ai/api-helpers';

// ════════════════════════════════════════════════════════════
// AI SALES — PRE-CALL BRIEF API (v2.27.0)
// POST { centerId, contactId? } → grounded pre-call brief.
// Every field comes from real CRM rows (see engine/brief.ts).
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_calls_read')) {
      return aiDenied('شما دسترسی به ماژول هوش مصنوعی فروش را ندارید.');
    }

    const body = await req.json().catch(() => ({}));
    const { centerId, contactId } = body as { centerId?: string; contactId?: string };
    if (!centerId) return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });

    // v2.58.11 (P1-1): company + BU + territory + active company — one
    // fail-closed gate (404, no existence leak).
    await assertAiCenterAccess(user, centerId);

    const brief = await buildPreCallBrief(centerId, contactId || null);
    if (!brief) return NextResponse.json({ error: 'مرکز یافت نشد.' }, { status: 404 });
    return NextResponse.json({ brief });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-brief', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
