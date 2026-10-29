import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { isAiEnabledForCompany } from '@/lib/ai/settings';
import { processRecording } from '@/lib/ai/engine/pipeline';
import { hasAiPermission, aiDenied, aiAudit } from '@/lib/ai/api-helpers';
// v2.58.11 (audit P1-1): the central AI Sales access policy replaces the
// company-only centerInCompanyScope gate.
import { assertAiCenterAccess } from '@/lib/ai/access-policy';
import {
  checkVoicePolicy, voiceMimeExtension, voiceMimeBase, MAX_VOICE_BYTES,
} from '@/lib/activity-voice';
import { generateStoredName, verifyAudioContent } from '@/lib/storage';
import { storeFileLifecycle } from '@/lib/file-lifecycle';

// ════════════════════════════════════════════════════════════
//  AI SALES — CALL AUDIO UPLOAD (multipart)
//  v2.58.0 (audit 85-a #3): the AI-calls dialog has posted to this
//  exact path since v2.27.0, but the route never existed — every
//  upload from the «بارگذاری فایل صوتی مکالمه» dialog 404'd. Mirrors
//  the voice-note discipline of /api/activities/voice (10 MB cap,
//  audio-only MIME policy, checksummed server-named storage) and the
//  telephony ingest contract «file on disk <=> row in DB».
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }
    if (!hasAiPermission(user, 'ai_calls_read')) {
      return aiDenied('شما دسترسی به ماژول هوش مصنوعی فروش را ندارید.');
    }

    const declaredLength = Number(req.headers.get('content-length') || '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_BYTES + 64 * 1024) {
      return NextResponse.json({ error: 'حجم فایل صوتی نباید از ۱۰ مگابایت بیشتر باشد.' }, { status: 400 });
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: 'درخواست نامعتبر است — حجم فایل صوتی نباید از ۱۰ مگابایت بیشتر باشد.' }, { status: 400 });
    }

    const blob = form.get('file');
    if (!blob || typeof blob === 'string') {
      return NextResponse.json({ error: 'فایل صوتی در درخواست یافت نشد.' }, { status: 400 });
    }
    const audioFile = blob as File;

    const centerId = String(form.get('centerId') || '').trim();
    const contactId = String(form.get('contactId') || '').trim() || null;
    const direction = String(form.get('direction') || 'outbound').trim();
    const consent = String(form.get('consent') || 'unknown').trim();
    const title = String(form.get('title') || '').trim().slice(0, 200);

    if (!centerId) {
      return NextResponse.json({ error: 'مرکز مشتری الزامی است.' }, { status: 400 });
    }

    // Voice policy: audio-only MIME, hard size cap.
    const mimeType = audioFile.type || 'audio/webm';
    const policy = checkVoicePolicy(mimeType, audioFile.size);
    if (!policy.ok) {
      return NextResponse.json({ error: policy.reason }, { status: 400 });
    }
    const ext = voiceMimeExtension(mimeType)!;

    // v2.58.7 (stage 7): REAL content verification — a text/image payload
    // claiming audio is refused BEFORE any STT spend or disk write.
    const audioBytes = Buffer.from(await audioFile.arrayBuffer());
    const audioContentCheck = verifyAudioContent(audioBytes);
    if (!audioContentCheck.ok) {
      return NextResponse.json({ error: audioContentCheck.reason }, { status: 400 });
    }

    // Tenant guards — v2.58.11 (P1-1): the CENTRAL policy gate (company +
    // BU + territory + active company; 404 fail-closed, no existence leak).
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

    // Persist audio first through the LIFECYCLE store (v2.58.3, finding 9):
    // temp .part → pending row → atomic rename → committed. A crash
    // between DB registration and the file move is identifiable and
    // recoverable; an ERROR rolls back both sides (the old
    // write-final-then-create-row order left orphans on a DB failure).
    const bytes = audioBytes;
    const originalName = `call-${new Date().toISOString().slice(0, 10)}.${ext}`;
    const storedName = `${generateStoredName(originalName).split('.')[0]}.${ext}`;

    let recording;
    try {
      const stored = await storeFileLifecycle({
        bytes,
        originalName: (audioFile.name || originalName).slice(0, 255),
        mimeType: voiceMimeBase(mimeType),
        storedName,
        centerId,
        category: 'ai-call-audio',
        createdById: user.id,
      });
      recording = await db.aiCallRecording.create({
        data: {
          companyId: center.companyId,
          centerId,
          contactId,
          userId: user.id,
          direction: direction === 'inbound' ? 'inbound' : 'outbound',
          source: 'manual-upload',
          status: 'queued',
          language: 'fa',
          consent: ['granted', 'denied', 'not-required'].includes(consent) ? consent : 'unknown',
          title,
          audioFileId: stored.id,
          createdById: user.id,
        },
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'ApiError') throw e;
      throw e;
    }

    await aiAudit(
      'AI_CALL_UPLOADED',
      `recording=${recording.id}`,
      `center=${centerId}; bytes=${bytes.length}; mime=${voiceMimeBase(mimeType)}; direction=${direction}`,
      user.id,
    );

    // Background pipeline (STT → analysis) — same after() discipline as
    // create-manual and the retry/transcript actions.
    after(async () => { await processRecording(recording.id); });

    return NextResponse.json(
      { message: 'فایل بارگذاری شد — پردازش در پس‌زمینه آغاز شد.', recording: { id: recording.id, status: 'queued' } },
      { status: 201 },
    );
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-calls-upload', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
