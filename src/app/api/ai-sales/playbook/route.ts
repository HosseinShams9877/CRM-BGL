import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, type AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hasAiPermission, aiDenied, aiAudit } from '@/lib/ai/api-helpers';
import { getLLMProvider, extractJsonObject } from '@/lib/ai/providers/llm';
import { buildSupervisorBriefSystemPrompt } from '@/lib/ai/prompts';
import { getAiSettings } from '@/lib/ai/settings';
import { recordAiUsage } from '@/lib/ai/usage';

// ════════════════════════════════════════════════════════════
// AI SALES — PLAYBOOK API (v2.27.0)
// POST actions: list | save | delete | mine
// 'mine' = Winning Call Mining: aggregates objections handled +
// closing lines from calls that led to approved/converted docs,
// then proposes playbook entries (marked ai-suggested; admin
// publishes by saving them).
// ════════════════════════════════════════════════════════════

const CATEGORIES = ['opening', 'discovery', 'qualification', 'objection', 'pitch', 'closing', 'followup'];

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    // list is read-only; write actions need the manage permission.
    if (action === 'list') return await handleList(body, user);
    if (!hasAiPermission(user, 'ai_playbook_manage')) {
      return aiDenied('مدیریت پلی‌بوک فقط برای مدیر سیستم فعال است.');
    }
    if (action === 'save') return await handleSave(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'mine') return await handleMine(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-playbook', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, category } = body as { companySlug?: string; category?: string };
  if (!hasAiPermission(user, 'ai_calls_read')) {
    return aiDenied('شما دسترسی به پلی‌بوک را ندارید.');
  }
  const { resolveAiCompanyScope } = await import('@/lib/ai/api-helpers');
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;
  const where: Record<string, unknown> = { isActive: true };
  if (scope.companyIds) where.companyId = { in: scope.companyIds };
  if (category) where.category = category;
  const items = await db.aiPlaybook.findMany({
    where,
    orderBy: [{ category: 'asc' }, { createdAt: 'desc' }],
    take: 200,
    select: { id: true, category: true, title: true, content: true, tags: true, source: true, createdAt: true, isActive: true },
  });
  return NextResponse.json({ items });
}

async function handleSave(body: Record<string, unknown>, user: AuthUser) {
  const { id, companySlug, category, title, content, tags } = body as {
    id?: string; companySlug?: string; category?: string; title?: string; content?: string; tags?: string[];
  };
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'عنوان و محتوا الزامی است.' }, { status: 400 });
  }
  if (!CATEGORIES.includes(category || '')) {
    return NextResponse.json({ error: `دسته‌بندی نامعتبر است. مجاز: ${CATEGORIES.join(', ')}` }, { status: 400 });
  }
  const { resolveAiCompanyScope } = await import('@/lib/ai/api-helpers');
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;
  if (!scope.companyIds || scope.companyIds.length === 0) {
    return NextResponse.json({ error: 'شرکت مقصد را مشخص کنید.' }, { status: 400 });
  }
  const companyId = scope.companyIds[0];

  const data = {
    companyId, category: category as string,
    title: title.trim().slice(0, 300), content: content.trim().slice(0, 8000),
    tags: JSON.stringify((tags || []).map(String).slice(0, 10)),
  };
  if (id) {
    // v2.47.0 — IDOR guard: the bare-id update used to retarget ANY
    // playbook row (another company's entry included) to the caller's
    // company. The existing row must already be inside the caller's scope.
    const existing = await db.aiPlaybook.findUnique({ where: { id }, select: { companyId: true } });
    if (!existing) return NextResponse.json({ error: 'مورد یافت نشد.' }, { status: 404 });
    if (!scope.companyIds?.includes(existing.companyId)) {
      return aiDenied('دسترسی به این مورد پلی‌بوک ندارید.');
    }
    await db.aiPlaybook.update({ where: { id }, data: { ...data, isActive: true } });
    await aiAudit('AI_PLAYBOOK_UPDATED', `playbook=${id}`, data.title, user.id);
    return NextResponse.json({ message: 'مورد پلی‌بوک به‌روزرسانی شد.', id });
  }
  const created = await db.aiPlaybook.create({ data: { ...data, source: 'manual', createdById: user.id } });
  await aiAudit('AI_PLAYBOOK_CREATED', `playbook=${created.id}`, data.title, user.id);
  return NextResponse.json({ message: 'مورد پلی‌بوک ایجاد شد.', id: created.id }, { status: 201 });
}

async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه الزامی است.' }, { status: 400 });
  // v2.47.0 — IDOR guard: delete must verify BOTH the id AND that the
  // row's companyId is inside the caller's allowed scope — knowing an id
  // (e.g. a یاس طب playbook id in the hands of a group admin) used to be
  // enough to destroy another company's entry.
  const { resolveAiCompanyScope } = await import('@/lib/ai/api-helpers');
  const scope = await resolveAiCompanyScope(user, undefined);
  if ('error' in scope) return scope.error;
  const existing = await db.aiPlaybook.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!existing) return NextResponse.json({ error: 'مورد یافت نشد.' }, { status: 404 });
  if (scope.companyIds && !scope.companyIds.includes(existing.companyId)) {
    return aiDenied('دسترسی به این مورد پلی‌بوک ندارید.');
  }
  try {
    await db.aiPlaybook.delete({ where: { id } });
    await aiAudit('AI_PLAYBOOK_DELETED', `playbook=${id}`, 'حذف مورد پلی‌بوک', user.id);
    return NextResponse.json({ message: 'حذف شد.' });
  } catch {
    return NextResponse.json({ error: 'مورد یافت نشد.' }, { status: 404 });
  }
}

async function handleMine(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug } = body as { companySlug?: string };
  const { resolveAiCompanyScope } = await import('@/lib/ai/api-helpers');
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;
  if (!scope.companyIds || scope.companyIds.length === 0) {
    return NextResponse.json({ error: 'شرکت را مشخص کنید.' }, { status: 400 });
  }
  const companyId = scope.companyIds[0];

  // Winning calls = analyzed recordings of centers that have an approved
  // or issued document after the call date.
  const winning = await db.aiCallRecording.findMany({
    where: {
      companyId, status: 'completed',
      center: { salesDocuments: { some: { status: { in: ['approved', 'converted', 'issued'] } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { summary: true, objections: true, opportunities: true, commitments: true } },
      coachInsights: { take: 1, select: { strengths: true } },
    },
  });

  const facts = winning.map((w) => {
    const a = w.analyses[0];
    return {
      summary: a?.summary || '',
      objectionsHandled: (() => { try { return (JSON.parse(a?.objections || '[]') as { resolved?: boolean; type?: string; recommendedResponse?: string }[]).filter((o) => o.resolved).map((o) => `${o.type}: ${o.recommendedResponse || ''}`); } catch { return []; } })(),
      opportunities: (() => { try { return JSON.parse(a?.opportunities || '[]'); } catch { return []; } })(),
      strengths: (() => { try { return JSON.parse(w.coachInsights[0]?.strengths || '[]'); } catch { return []; } })(),
    };
  });

  if (facts.length === 0) {
    return NextResponse.json({ message: 'هنوز تماس برنده‌ای (تماس منتهی به فروش تأییدشده) برای استخراج وجود ندارد.', suggestions: [] });
  }

  const settings = await getAiSettings();
  const llm = getLLMProvider(settings.llmProvider);
  const completion = await llm.complete([
    { role: 'system', content: `${buildSupervisorBriefSystemPrompt()}\n\nتو همچنین الگوهای فروش برنده را از داده واقعی استخراج می‌کنی. خروجی JSON: {"suggestions":[{"category":"discovery|objection|closing|followup","title":"...","content":"..."}]}` },
    { role: 'user', content: `این داده‌های واقعی تماس‌های برنده است:\n${JSON.stringify(facts)}\nاز همین داده‌ها ۳ تا ۵ الگوی برنده استخراج کن و JSON بده.` },
  ], { maxTokens: 1500, temperature: 0.3 });
  await recordAiUsage({ companyId, userId: user.id, feature: 'playbook', provider: completion.provider, model: completion.model, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens });

  const parsed = extractJsonObject(completion.content);
  const suggestions = (parsed && Array.isArray((parsed as { suggestions?: unknown[] }).suggestions)
    ? (parsed as { suggestions: { category?: string; title?: string; content?: string }[] }).suggestions
    : []).filter((s) => s && s.title && s.content).slice(0, 5)
    .map((s) => ({
      category: CATEGORIES.includes(s.category || '') ? s.category : 'discovery',
      title: String(s.title).slice(0, 300),
      content: String(s.content).slice(0, 4000),
    }));

  await aiAudit('AI_PLAYBOOK_MINED', `company=${companyId}`, `${suggestions.length} suggestion(s)`, user.id);
  return NextResponse.json({ message: 'استخراج انجام شد؛ پیشنهادها را بازبینی و ذخیره کنید.', suggestions, winningCallsCount: facts.length });
}
