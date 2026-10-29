import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { hasAiPermission, aiDenied, aiAudit } from '@/lib/ai/api-helpers';
// v2.58.11 (audit P1-1): the central AI Sales access policy replaces the
// company-only canAccessRecording gate.
import { canAccessAiRecording } from '@/lib/ai/access-policy';
import {
  verifyStoredFileChecksum,
  streamStoredFile,
  storedFileSize,
  assertDownloadable,
} from '@/lib/file-lifecycle';
import { ApiError } from '@/lib/api-error';

// ════════════════════════════════════════════════════════════
// AI SALES — CALL AUDIO STREAMING (v2.27.0)
// GET ?id=<recordingId> — permission-gated + checksum-verified +
// audit-logged. Audio access is as sensitive as transcripts.
// ════════════════════════════════════════════════════════════

export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_transcript_read')) {
      return aiDenied('دسترسی به فایل صوتی مکالمه نیازمند دسترسی خاص است.');
    }

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'شناسه تماس الزامی است.' }, { status: 400 });

    const recording = await db.aiCallRecording.findUnique({
      where: { id },
      select: { id: true, companyId: true, centerId: true, userId: true, createdById: true, audioFileId: true },
    });
    if (!recording) return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
    // v2.58.11 (P1-1): the central gate — audio is as sensitive as the
    // transcript; territory/BU/ownership answer with 404 (no leak).
    if (!(await canAccessAiRecording(user, recording))) {
      return NextResponse.json({ error: 'تماس یافت نشد.' }, { status: 404 });
    }
    if (!recording.audioFileId) {
      return NextResponse.json({ error: 'برای این تماس فایل صوتی ثبت نشده است.' }, { status: 404 });
    }

    const file = await db.file.findUnique({ where: { id: recording.audioFileId } });
    if (!file) return NextResponse.json({ error: 'فایل صوتی یافت نشد.' }, { status: 404 });

    // v2.58.3 (finding 9) — PENDING audio is never downloadable, and the
    // checksum is verified ASYNC + chunked (bounded memory — the full
    // readFileSync is gone from the request path); the body is STREAMED
    // and the stream closes itself on error/mismatch.
    try {
      assertDownloadable(file.status);
      await verifyStoredFileChecksum(file.storedName, file.checksum);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      logApiError('ai-sales-audio', 'audio verification failed:', file.storedName);
      return NextResponse.json({ error: 'خطای داخلی سرور' }, { status: 500 });
    }

    await aiAudit('AI_AUDIO_READ', `recording=${id}`, 'پخش فایل صوتی مکالمه', user.id);

    try {
      return new NextResponse(streamStoredFile(file.storedName), {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'audio/mpeg',
          'Content-Length': String(storedFileSize(file.storedName)),
          'Content-Disposition': `inline; filename="call-${id}.${file.storedName.split('.').pop()}"`,
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      return NextResponse.json({ error: 'خطای داخلی سرور' }, { status: 500 });
    }
  } catch {
    return NextResponse.json({ error: 'خطای داخلی سرور' }, { status: 500 });
  }
}
