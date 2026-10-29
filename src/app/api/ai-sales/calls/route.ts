import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, type AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { isAiEnabledForCompany, getAiSettings } from '@/lib/ai/settings';
import { processRecording, retryRecording, parseManualTranscript } from '@/lib/ai/engine/pipeline';
import { hasAiPermission, aiDenied, resolveAiCompanyScope, aiAudit } from '@/lib/ai/api-helpers';
// v2.58.11 (audit P1-1): the CENTRAL access policy — list fragment +
// single-row gates + the center gate replace the company-only checks.
import { assertAiCenterAccess, canAccessAiRecording, aiRecordingWhere } from '@/lib/ai/access-policy';

// ════════════════════════════════════════════════════════════
// AI SALES — CALLS API (v2.27.0)
// POST actions: list | get | create-manual | delete | retry |
//               transcript | analyze
// Audio upload lives in calls/upload (multipart); audio streaming
// lives in calls/audio (GET).
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

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create-manual') return await handleCreateManual(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'retry') return await handleRetry(body, user);
    if (action === 'transcript') return await handleTranscript(body, user);
    if (action === 'analyze') return await handleAnalyze(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-calls', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── LIST ────────────────────────────────────────────────────
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, status, centerId, page = 1, pageSize = 20, search } = body as {
    companySlug?: string; status?: string; centerId?: string; page?: number; pageSize?: number; search?: string;
  };
  const scope = await resolveAiCompanyScope(user, companySlug);
  if ('error' in scope) return scope.error;

  const where: Record<string, unknown> = {};
  if (scope.companyIds) where.companyId = { in: scope.companyIds };
  if (status) where.status = status;
  if (centerId) where.centerId = centerId;
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { center: { name: { contains: search } } },
    ];
  }
  // v2.58.11 (P1-1): the territory/BU/ownership fragment — composed under
  // AND so the caller's search OR stays intact. An out-of-territory
  // recording or a centerless colleague recording no longer lists for a
  // restricted expert (unrestricted users keep their view).
  where.AND = [...((where.AND as Array<Record<string, unknown>>) ?? []), aiRecordingWhere(user)];

  const take = Math.min(100, Math.max(1, Number(pageSize)));
  const skip = (Math.max(1, Number(page)) - 1) * take;

  const [items, total] = await Promise.all([
    db.aiCallRecording.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      select: {
        id: true, status: true, direction: true, source: true, title: true,
        durationSec: true, retryCount: true, failReason: true, createdAt: true,
        companyId: true, consent: true,
        center: { select: { id: true, name: true } },
        contact: { select: { id: true, title: true, person: true } },
        rep: { select: { id: true, displayName: true } },
        transcript: { select: { id: true, wordCount: true, confidence: true } },
        analyses: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, intent: true, temperature: true, conversionScore: true, summary: true, confidence: true, needsReview: true } },
      },
    }),
    db.aiCallRecording.count({ where }),
  ]);

  return NextResponse.json({ items, total, page: Number(page), pageSize: take });
}

// ── GET (full detail incl. analysis + coach) ────────────────
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  const recording = await db.aiCallRecording.findUnique({
    where: { id },
    include: {
      center: { select: { id: true, name: true, phone: true } },
      contact: { select: { id: true, title: true, person: true, phone: true } },
      rep: { select: { id: true, displayName: true } },
      transcript: { select: { id: true } },
      analyses: { orderBy: { createdAt: 'desc' }, take: 1 },
      coachInsights: { take: 1, orderBy: { createdAt: 'desc' } },
    },
  });
  if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  // v2.58.11 (P1-1): the central gate — company + BU + territory (+ ownership
  // for centerless rows); a miss reads as "not found" (no existence leak).
  if (!(await canAccessAiRecording(user, recording))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  const { transcript, ...rest } = recording;
  const nextActions = await db.aiNextAction.findMany({
    where: { recordingId: id },
    select: { id: true, type: true, title: true, priority: true, dueAt: true, reason: true, confidence: true, status: true },
  });
  return NextResponse.json({
    recording: { ...rest, hasAudio: !!rest.audioFileId },
    hasTranscript: !!transcript,
    analysis: recording.analyses[0] || null,
    coach: recording.coachInsights[0] || null,
    nextActions,
  });
}

// ── TRANSCRIPT (sensitive — permission + audit) ─────────────
async function handleTranscript(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  if (!hasAiPermission(user, 'ai_transcript_read')) {
    return aiDenied('خواندن متن مکالمه نیازمند دسترسی خاص است.');
  }
  const recording = await db.aiCallRecording.findUnique({
    where: { id },
    select: { id: true, companyId: true, centerId: true, userId: true, createdById: true },
  });
  if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  if (!(await canAccessAiRecording(user, recording))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }

  await aiAudit('AI_TRANSCRIPT_READ', `recording=${id}`, 'خواندن متن مکالمه', user.id);

  const transcript = await db.aiCallTranscript.findUnique({ where: { recordingId: id } });
  return NextResponse.json({ transcript });
}

// ── CREATE MANUAL (paste transcript, no audio) ──────────────
async function handleCreateManual(body: Record<string, unknown>, user: AuthUser) {
  const { centerId, contactId, transcriptText, direction, title, consent } = body as {
    centerId?: string; contactId?: string; transcriptText?: string; direction?: string;
    title?: string; consent?: string;
  };
  if (!centerId || !transcriptText?.trim()) {
    return NextResponse.json({ error: 'مرکز و متن مکالمه الزامی است.' }, { status: 400 });
  }
  if (transcriptText.length > 60000) {
    return NextResponse.json({ error: 'متن مکالمه بیش از حد طولانی است (حداکثر ۶۰ هزار کاراکتر).' }, { status: 400 });
  }
  const center = await assertAiCenterAccess(user, centerId);
  if (!(await isAiEnabledForCompany(center.companyId))) {
    return aiDenied('ماژول هوش مصنوعی برای این شرکت غیرفعال است.');
  }
  if (contactId) {
    const contact = await db.centerContact.findUnique({ where: { id: contactId }, select: { centerId: true } });
    if (!contact || contact.centerId !== centerId) {
      return NextResponse.json({ error: 'شخص تماس به این مرکز تعلق ندارد.' }, { status: 400 });
    }
  }

  const { segments } = parseManualTranscript(transcriptText.trim());
  const recording = await db.aiCallRecording.create({
    data: {
      companyId: center.companyId,
      centerId,
      contactId: contactId || null,
      userId: user.id,
      direction: direction === 'inbound' ? 'inbound' : 'outbound',
      source: 'manual-transcript',
      status: 'queued',
      language: 'fa',
      consent: ['granted', 'denied', 'not-required'].includes(consent || '') ? (consent as string) : 'unknown',
      title: (title || '').slice(0, 200),
      durationSec: Math.min(4 * 3600, Math.round(transcriptText.split(/\s+/).length / 2.5)),
      createdById: user.id,
    },
  });
  await db.aiCallTranscript.create({
    data: {
      recordingId: recording.id,
      sttProvider: 'manual',
      language: 'fa',
      fullText: transcriptText.trim(),
      segments: JSON.stringify(segments),
      confidence: 1,
      wordCount: transcriptText.split(/\s+/).filter(Boolean).length,
    },
  });
  await aiAudit('AI_RECORDING_CREATED', `recording=${recording.id}`, 'ثبت دستی متن مکالمه', user.id);

  const settings = await getAiSettings();
  if (settings.autoAnalyze) {
    after(async () => { await processRecording(recording.id); });
  }

  return NextResponse.json({ message: 'مکالمه ثبت شد و در صف تحلیل قرار گرفت.', recording }, { status: 201 });
}

// ── ANALYZE (re-run / kick off) ─────────────────────────────
async function handleAnalyze(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  const recording = await db.aiCallRecording.findUnique({
    where: { id },
    select: { id: true, companyId: true, centerId: true, userId: true, createdById: true, status: true },
  });
  if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  if (!(await canAccessAiRecording(user, recording))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  if (recording.status === 'transcribing' || recording.status === 'analyzing') {
    return NextResponse.json({ error: 'این تماس در حال پردازش است.' }, { status: 409 });
  }
  await db.aiCallRecording.update({ where: { id }, data: { status: 'queued', failReason: '' } });
  after(async () => { await processRecording(id); });
  return NextResponse.json({ message: 'تحلیل آغاز شد.' });
}

// ── RETRY ───────────────────────────────────────────────────
async function handleRetry(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  const recording = await db.aiCallRecording.findUnique({
    where: { id },
    select: { id: true, companyId: true, centerId: true, userId: true, createdById: true },
  });
  if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  if (!(await canAccessAiRecording(user, recording))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  const ok = await retryRecording(id);
  if (!ok) return NextResponse.json({ error: 'این تماس قابل تلاش مجدد نیست (سقف تلاش پر شده یا در حال پردازش است).' }, { status: 409 });
  after(async () => { await processRecording(id); });
  return NextResponse.json({ message: 'تلاش مجدد آغاز شد.' });
}

// ── DELETE (audio + transcript + analysis cascade) ──────────
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const { id, deleteAudio } = body as { id?: string; deleteAudio?: boolean };
  if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });
  const recording = await db.aiCallRecording.findUnique({
    where: { id },
    select: { id: true, companyId: true, centerId: true, userId: true, createdById: true, audioFileId: true },
  });
  if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  if (!(await canAccessAiRecording(user, recording))) {
    return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
  }
  if (getCanonicalRole(user.role) !== 'admin' && recording.createdById !== user.id) {
    return aiDenied('حذف تماس فقط توسط ایجادکننده یا مدیر سیستم ممکن است.');
  }

  if (deleteAudio && recording.audioFileId) {
    const file = await db.file.findUnique({ where: { id: recording.audioFileId } });
    if (file) {
      const { resolveStoredPath } = await import('@/lib/storage');
      const fs = await import('fs');
      const p = resolveStoredPath(file.storedName);
      if (p) fs.unlink(p, () => undefined);
      await db.file.delete({ where: { id: file.id } }).catch(() => undefined);
    }
  }
  await db.aiCallRecording.delete({ where: { id } });
  await aiAudit('AI_RECORDING_DELETED', `recording=${id}`, `حذف تماس${deleteAudio ? ' + صوت' : ''}`, user.id);
  return NextResponse.json({ message: 'تماس حذف شد.' });
}
