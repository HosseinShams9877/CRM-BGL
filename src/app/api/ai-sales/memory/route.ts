import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hasAiPermission, aiDenied, aiAudit } from '@/lib/ai/api-helpers';
// v2.58.11 (audit P1-1): the central AI Sales access policy replaces the
// company-only centerInCompanyScope gate — company + business unit +
// territory + active company in ONE fail-closed query.
import { assertAiCenterAccess } from '@/lib/ai/access-policy';
import { reconcileCustomerMemoryDuplicates } from '@/lib/ai/memory-dedupe';
import { safeParseJsonCell } from '@/lib/ai/engine/memory';

// ════════════════════════════════════════════════════════════
// AI SALES — CUSTOMER AI MEMORY API (v2.27.0)
// POST actions: get | update
// Structured memory per center (+optional contact). Manual edits
// are merged alongside AI consolidation and audited.
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_calls_read')) {
      return aiDenied('شما دسترسی به ماژول هوش مصنوعی فروش را ندارید.');
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'get') return await handleGet(body, user);
    if (action === 'update') return await handleUpdate(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-memory', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleGet(body: Record<string, unknown>, user: AuthUserT) {
  const { centerId, contactId } = body as { centerId?: string; contactId?: string };
  if (!centerId) return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  // v2.58.11 (P1-1): company + BU + territory + active company — 404 on
  // any miss (no existence leak); the auditor's out-of-province probe.
  await assertAiCenterAccess(user, centerId);
  const memory = await db.aiCustomerMemory.findFirst({
    where: { centerId, contactId: contactId || null },
  });
  return NextResponse.json({ memory });
}

async function handleUpdate(body: Record<string, unknown>, user: AuthUserT) {
  const { centerId, contactId, summary, preferences, insights } = body as {
    centerId?: string; contactId?: string; summary?: string; preferences?: Record<string, unknown>; insights?: Record<string, unknown>;
  };
  if (!centerId) return NextResponse.json({ error: 'شناسه مرکز الزامی است.' }, { status: 400 });
  // v2.58.11 (P1-1): the central policy gate (returns the center with its
  // companyId — the old code re-read the center AFTER a company-only check)
  const center = await assertAiCenterAccess(user, centerId);

  // v2.58.7 (D2): the manual write is now a transaction with an IN-TX
  // re-check + duplicate reconcile — the old findFirst→update-or-create
  // raced exactly like the engine path (two writers for one center both
  // created; reads then flipped nondeterministically between rows).
  // After this, exactly ONE row per (center, contact) survives every
  // write path, keep-latest.
  // v2.58.11 (audit medium): the EXISTING cells are parsed with the
  // pipeline's safe parser — a corrupt blob degraded to {} instead of
  // a raw JSON.parse SyntaxError → 500.
  await db.$transaction(async (tx) => {
    const existing = await tx.aiCustomerMemory.findFirst({ where: { centerId, contactId: contactId || null } });
    const data = {
      summary: (summary || existing?.summary || '').slice(0, 4000),
      preferences: JSON.stringify(preferences || safeParseJsonCell(existing?.preferences, 'manual-update:preferences')),
      insights: JSON.stringify(insights || safeParseJsonCell(existing?.insights, 'manual-update:insights')),
      source: 'manual' as const,
      updatedById: user.id,
    };
    if (existing) {
      await tx.aiCustomerMemory.update({ where: { id: existing.id }, data });
    } else {
      await tx.aiCustomerMemory.create({
        data: { companyId: center.companyId, centerId, contactId: contactId || null, ...data },
      });
    }
    await reconcileCustomerMemoryDuplicates(tx, centerId, contactId || null);
  });
  await aiAudit('AI_MEMORY_UPDATED', `center=${centerId}`, 'ویرایش دستی حافظه مشتری', user.id);
  return NextResponse.json({ message: 'حافظه مشتری به‌روزرسانی شد.' });
}

type AuthUserT = import('@/lib/auth').AuthUser;
