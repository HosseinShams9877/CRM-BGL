import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds,
  ownerScopedCenterWhere, NON_COMPANY_SLUGS, assigneeInScope,
} from '@/lib/company-scope';
import { activityTerritoryWhere, resolveTerritoryScope } from '@/lib/territory-scope';
// v2.58.7 — the central policy layer (stage 1): the territory dimension
// for the center guard, imported from the one authoritative module.
import { assertTerritoryAccess } from '@/lib/access-policy';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import {
  checkVoicePolicy, voiceMimeExtension, voiceMimeBase, voiceOriginalName, MAX_VOICE_BYTES,
} from '@/lib/activity-voice';
import { sanitizeActivityProducts } from '@/lib/activity-products';
import { generateStoredName, resolveStoredPath, verifyAudioContent } from '@/lib/storage';
// v2.58.7 (F1/F2): the voice route now rides the SAME crash-safe file
// lifecycle (temp → pending row → atomic rename → commit) and the SAME
// streaming download path as every other file.
import {
  storeFileLifecycle, deleteFileLifecycle,
  verifyStoredFileChecksum, streamStoredFile, storedFileSize, assertDownloadable,
  type StoredFile,
} from '@/lib/file-lifecycle';
import { getSTTProvider } from '@/lib/ai/providers/stt';
import { getAiSettings } from '@/lib/ai/settings';
import { recordAiUsage } from '@/lib/ai/usage';
import fs from 'fs';

// ════════════════════════════════════════════════════════════
// ACTIVITY VOICE NOTE API (v2.34.7 — «ویس» in quick activity)
//
//  POST multipart  → create an activity WITH a recorded voice note,
//                    optionally transcribing it right away. The audio is
//                    stored through the same checksummed pipeline as all
//                    other files; the Activity row links to the File row
//                    via voiceNoteFileId.
//  POST JSON
//    {action:'transcribe', id} → transcribe a saved voice note LATER and
//                    persist the text on Activity.voiceTranscript (the
//                    user's «بعدش تکس بشه» flow).
//  GET ?id=<activityId> → stream the voice note for in-app playback
//                    (tenant-scoped + checksum-verified, like call audio).
//
// Transcription rides on the existing STT provider abstraction and obeys
// the admin switches: ai_sales.enabled and ai_sales.stt_provider. When
// transcription is disabled the voice note still records, attaches and
// plays — only the text step returns a clear Persian message.
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const contentType = req.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      return await handleVoiceCreate(req, user);
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };
    if (action === 'transcribe') return await handleTranscribe(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('activities-voice', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── Shared: is transcription available per admin settings? ──
async function transcriptionAvailable(): Promise<{ ok: boolean; reason?: string }> {
  const settings = await getAiSettings();
  if (!settings.enabled) {
    return { ok: false, reason: 'ماژول هوش مصنوعی غیرفعال است — ویس ذخیره می‌شود ولی تبدیل به متن انجام نمی‌شود.' };
  }
  if (settings.sttProvider === 'none') {
    return { ok: false, reason: 'سرویس تبدیل صدا به متن از طرف مدیر سیستم غیرفعال شده است.' };
  }
  return { ok: true };
}

// ── Shared: run STT on stored bytes, best-effort usage logging ──
async function transcribeBytes(
  audio: Buffer,
  mimeType: string,
  companyId: string | null,
  userId: string,
): Promise<{ text: string; error?: string }> {
  const provider = (await getAiSettings()).sttProvider;
  try {
    const result = await getSTTProvider(provider).transcribe(audio, mimeType, 'fa');
    if (companyId) {
      await recordAiUsage({
        companyId, userId, feature: 'stt', provider: result.provider, model: 'asr',
        audioSeconds: Math.round(audio.length / 16000), status: 'success',
      });
    }
    return { text: result.text };
  } catch (e) {
    if (companyId) {
      await recordAiUsage({
        companyId, userId, feature: 'stt', provider, model: 'asr',
        audioSeconds: Math.round(audio.length / 16000), status: 'failed',
      });
    }
    return { text: '', error: e instanceof Error ? e.message : 'تبدیل صدا به متن ناموفق بود.' };
  }
}

// ── Shared: resolve a company id for usage logging ──
async function resolveCompanyId(centerId: string | null, user: AuthUser): Promise<string | null> {
  if (centerId) {
    const center = await db.center.findUnique({ where: { id: centerId }, select: { companyId: true } });
    if (center) return center.companyId;
  }
  const slugs = user.companyIds.filter((s) => !NON_COMPANY_SLUGS.has(s));
  if (slugs.length === 0) return null;
  const company = await db.company.findFirst({ where: { slug: { in: slugs } }, select: { id: true } });
  return company?.id ?? null;
}

// ── Shared: validate assignee is a colleague (same company set) ──
// v2.58.0 — promoted to lib/company-scope (assigneeInScope) so the
// plain activities route enforces the same rule; see its header there.

// ════════════════════════════════════════════════════════
//  CREATE WITH VOICE (multipart)
// ════════════════════════════════════════════════════════
async function handleVoiceCreate(req: NextRequest, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد فعالیت را ندارید.' }, { status: 403 });
  }

  const declaredLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_BYTES + 64 * 1024) {
    return NextResponse.json({ error: 'حجم ویس نباید از ۱۰ مگابایت بیشتر باشد.' }, { status: 400 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'درخواست نامعتبر است — حجم ویس نباید از ۱۰ مگابایت بیشتر باشد.' }, { status: 400 });
  }

  const blob = form.get('audio');
  if (!blob || typeof blob === 'string') {
    return NextResponse.json({ error: 'فایل صوتی در درخواست یافت نشد.' }, { status: 400 });
  }
  const audioFile = blob as File;

  const title = String(form.get('title') || '').trim();
  const description = String(form.get('description') || '').trim();
  const activityDate = String(form.get('activityDate') || '').trim();
  const activityTime = String(form.get('activityTime') || '').trim();
  const centerId = String(form.get('centerId') || '').trim() || null;
  const assignedTo = String(form.get('assignedTo') || '').trim() || null;
  const isPhoneCall = String(form.get('isPhoneCall') || '') === 'true';
  const isOnsiteVisit = String(form.get('isOnsiteVisit') || '') === 'true';
  const isUnansweredCall = String(form.get('isUnansweredCall') || '') === 'true';
  const wantTranscript = String(form.get('transcribe') || '') === 'true';
  // v2.34.9 — optional product tags, JSON-encoded [{id,name}] (the plain
  // create action receives the same shape as an array value).
  const products = sanitizeActivityProducts(form.get('products'));

  if (!title) {
    return NextResponse.json({ error: 'عنوان و موضوع فعالیت الزامی است.' }, { status: 400 });
  }
  const parsedDate = new Date(activityDate);
  if (!activityDate || isNaN(parsedDate.getTime())) {
    return NextResponse.json({ error: 'تاریخ فعالیت نامعتبر است.' }, { status: 400 });
  }

  // Voice policy: audio-only MIME, hard size cap.
  const mimeType = audioFile.type || 'audio/webm';
  const policy = checkVoicePolicy(mimeType, audioFile.size);
  if (!policy.ok) {
    return NextResponse.json({ error: policy.reason }, { status: 400 });
  }
  const ext = voiceMimeExtension(mimeType)!;

  // v2.58.7 (stage 7): REAL content verification — a text/image payload
  // claiming audio is refused BEFORE the disk write and any STT spend.
  {
    const voiceBytes = Buffer.from(await audioFile.arrayBuffer());
    const voiceContentCheck = verifyAudioContent(voiceBytes);
    if (!voiceContentCheck.ok) {
      return NextResponse.json({ error: voiceContentCheck.reason }, { status: 400 });
    }
  }

  // Tenant guards (same rules as the plain create action). v2.34.9: unknown
  // center id is a clean 404 (was a raw FK-violation 500 for admins).
  // v2.58.7 (A6): the territory dimension was MISSING on every voice path
  // (the plain activities route composes activityTerritoryWhere / checks
  // centerInTerritory on create) — a scoped expert could attach a voice
  // note to an out-of-territory center. Same denial convention as the
  // plain route: 404 no-leak.
  if (centerId) {
    const center = await db.center.findUnique({ where: { id: centerId }, select: { companyId: true, province: true, id: true } });
    if (!center) {
      return NextResponse.json({ error: 'مرکز مشخص‌شده یافت نشد.' }, { status: 404 });
    }
    const allowed = await getAllowedCompanyIds(user);
    if (allowed !== null && !allowed.includes(center.companyId)) {
      return NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 });
    }
    try {
      assertTerritoryAccess(user, center);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: 'مرکز مشخص‌شده یافت نشد.' }, { status: e.status });
      }
      throw e;
    }
  }
  if (assignedTo && !(await assigneeInScope(assignedTo, user))) {
    return NextResponse.json({ error: 'کاربر انتخاب‌شده به‌عنوان مسئول در دسترس شما نیست.' }, { status: 403 });
  }

  // Persist audio through the crash-safe lifecycle (checksummed,
  // server-named), then the activity — with COMPENSATION: if the activity
  // row fails, the just-stored file is deleted again (v2.58.7, F1: the
  // old code wrote the FINAL path first and inserted rows after — a
  // DB failure in between left a physical orphan file that NO sweeper
  // ever collected).
  const bytes = Buffer.from(await audioFile.arrayBuffer());
  const dayIso = parsedDate.toISOString().slice(0, 10);
  const originalName = voiceOriginalName(dayIso, ext);
  const storedName = `${generateStoredName(originalName).split('.')[0]}.${ext}`;

  let stored: StoredFile;
  try {
    stored = await storeFileLifecycle({
      bytes,
      originalName,
      mimeType: voiceMimeBase(mimeType),
      storedName,
      centerId,
      category: 'activity-voice',
      createdById: user.id,
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  let activity;
  try {
    activity = await db.activity.create({
      data: {
        title,
        description,
        activityDate: parsedDate,
        activityTime,
        isPhoneCall,
        isOnsiteVisit,
        isUnansweredCall,
        centerId,
        assignedTo,
        createdById: user.id,
        businessUnitId: user.businessUnitId,
        voiceNoteFileId: stored.id,
        products,
      },
      include: {
        center: { select: { id: true, name: true } },
        assignedUser: { select: { id: true, displayName: true } },
        creator: { select: { id: true, displayName: true } },
      },
    });
  } catch (e: unknown) {
    // v2.58.7 (F1) COMPENSATION: the file was just stored, but the
    // activity row failed (constraint, crash-window, …) — remove the
    // stored file again so NO orphan (physical or DB) survives the
    // failed upload. deleteFileLifecycle is best-effort here: if the
    // compensation itself fails, the committed row stays REPORTABLE
    // (files-health) instead of silently leaking bytes.
    await deleteFileLifecycle(stored.id).catch(() => undefined);
    logApiError('activity-voice', 'activity create failed — stored voice compensated:', stored.storedName, e instanceof Error ? e.message : String(e));
    return NextResponse.json({ error: 'ثبت فعالیت صوتی با خطا مواجه شد — فایل ذخیره‌شده حذف شد.' }, { status: 500 });
  }

  // Optional immediate transcription — never fatal for the save itself.
  let transcript: string | null = null;
  let transcriptError: string | null = null;
  if (wantTranscript) {
    const availability = await transcriptionAvailable();
    if (!availability.ok) {
      transcriptError = availability.reason ?? null;
    } else {
      const companyId = await resolveCompanyId(centerId, user);
      const result = await transcribeBytes(bytes, mimeType, companyId, user.id);
      if (result.text) {
        transcript = result.text;
        await db.activity.update({
          where: { id: activity.id },
          data: { voiceTranscript: transcript },
        });
      } else {
        transcriptError = result.error ?? 'تبدیل صدا به متن ناموفق بود.';
      }
    }
  }

  return NextResponse.json({
    message: 'فعالیت صوتی ثبت شد.',
    activity: { ...activity, voiceTranscript: transcript ?? '' },
    voice: { fileId: stored.id, size: stored.size, mimeType: voiceMimeBase(mimeType) },
    transcript,
    transcriptError,
  }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  TRANSCRIBE LATER (JSON {action:'transcribe', id})
// ════════════════════════════════════════════════════════
async function handleTranscribe(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.calendar) {
    return NextResponse.json({ error: 'شما دسترسی فعالیت‌ها را ندارید.' }, { status: 403 });
  }
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه فعالیت الزامی است.' }, { status: 400 });

  const where: Record<string, unknown> = { id, businessUnitId: user.businessUnitId };
  Object.assign(where, await ownerScopedCenterWhere(user));
  // v2.58.7 (A6): territory parity with the plain activities route — a
  // scoped expert transcribes only their territory's (or own centerless)
  // activities.
  const trTerritory = activityTerritoryWhere(resolveTerritoryScope(user), user.id);
  if (trTerritory) {
    where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), trTerritory];
  }
  const activity = await db.activity.findFirst({
    where,
    select: { id: true, voiceNoteFileId: true, voiceTranscript: true, centerId: true },
  });
  if (!activity) return NextResponse.json({ error: 'فعالیت یافت نشد.' }, { status: 404 });
  if (!activity.voiceNoteFileId) {
    return NextResponse.json({ error: 'این فعالیت ویس ندارد.' }, { status: 400 });
  }

  // Idempotent: an existing transcript is returned as-is (no duplicate cost).
  if (activity.voiceTranscript.trim()) {
    return NextResponse.json({ transcript: activity.voiceTranscript, cached: true });
  }

  const availability = await transcriptionAvailable();
  if (!availability.ok) {
    return NextResponse.json({ error: availability.reason }, { status: 409 });
  }

  const file = await db.file.findUnique({ where: { id: activity.voiceNoteFileId } });
  if (!file) return NextResponse.json({ error: 'فایل صوتی یافت نشد.' }, { status: 404 });
  // v2.58.7 (F2): ASYNC chunked checksum verification before the STT step
  // (the STT call still needs the full bytes — but verification no longer
  // buffers the file twice in the request path).
  try {
    await verifyStoredFileChecksum(file.storedName, file.checksum);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  const storedPath = resolveStoredPath(file.storedName);
  if (!storedPath || !fs.existsSync(storedPath)) {
    logApiError('activities-voice', 'stored voice missing on disk:', file.storedName);
    return NextResponse.json({ error: 'فایل صوتی روی سرور یافت نشده است.' }, { status: 410 });
  }

  const bytes = fs.readFileSync(storedPath);
  const companyId = await resolveCompanyId(activity.centerId, user);
  const result = await transcribeBytes(bytes, file.mimeType, companyId, user.id);
  if (!result.text) {
    return NextResponse.json({ error: result.error || 'تبدیل صدا به متن ناموفق بود.' }, { status: 502 });
  }
  await db.activity.update({ where: { id: activity.id }, data: { voiceTranscript: result.text } });
  return NextResponse.json({ transcript: result.text, cached: false });
}

// ════════════════════════════════════════════════════════
//  STREAM VOICE (GET ?id=<activityId>)
// ════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }
    const perms = getRolePermissions(user.role);
    if (!perms.calendar) {
      return NextResponse.json({ error: 'شما دسترسی فعالیت‌ها را ندارید.' }, { status: 403 });
    }

    const id = req.nextUrl.searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'شناسه فعالیت الزامی است.' }, { status: 400 });

    const where: Record<string, unknown> = { id, businessUnitId: user.businessUnitId };
    Object.assign(where, await ownerScopedCenterWhere(user));
    // v2.58.7 (A6): territory parity with the plain activities route.
    const gtTerritory = activityTerritoryWhere(resolveTerritoryScope(user), user.id);
    if (gtTerritory) {
      where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), gtTerritory];
    }
    const activity = await db.activity.findFirst({
      where,
      select: { id: true, voiceNoteFileId: true },
    });
    if (!activity) return NextResponse.json({ error: 'فعالیت یافت نشد.' }, { status: 404 });
    if (!activity.voiceNoteFileId) {
      return NextResponse.json({ error: 'این فعالیت ویس ندارد.' }, { status: 404 });
    }

    const file = await db.file.findUnique({
      where: { id: activity.voiceNoteFileId },
      select: { id: true, storedName: true, mimeType: true, checksum: true, status: true },
    });
    if (!file) return NextResponse.json({ error: 'فایل صوتی یافت نشد.' }, { status: 404 });

    // v2.58.7 (F2): STREAMED playback — the old GET read the ENTIRE audio
    // into memory (readFileSync + whole-buffer SHA-256 + Uint8Array body).
    // Now: pending files are not downloadable, the checksum is verified in
    // 64-KiB async chunks, and the body is the shared stream helper (the
    // same contract as /api/files and the AI call audio route).
    try {
      assertDownloadable(file.status);
      await verifyStoredFileChecksum(file.storedName, file.checksum);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }

    const size = storedFileSize(file.storedName);
    return new NextResponse(streamStoredFile(file.storedName), {
      status: 200,
      headers: {
        'Content-Type': file.mimeType || 'audio/webm',
        'Content-Length': String(size),
        'Content-Disposition': `inline; filename="voice-${activity.id}.${file.storedName.split('.').pop()}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('activities-voice', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
