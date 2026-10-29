import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { parseBody, filesListSchema, filesDeleteSchema } from '@/lib/validators';
import { logApiError } from '@/lib/logger';
import { getAllowedCompanyIds } from '@/lib/company-scope';
import { centerInTerritory, centerTerritoryWhere, resolveTerritoryScope } from '@/lib/territory-scope';
import {
  checkUploadPolicy,
  verifyUploadContent,
  MAX_FILE_SIZE,
} from '@/lib/storage';
import {
  storeFileLifecycle,
  verifyStoredFileChecksum,
  streamStoredFile,
  storedFileSize,
  assertDownloadable,
  deleteFileLifecycle,
} from '@/lib/file-lifecycle';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';

/**
 * Files API — REAL storage (P1-2 remediation, v2.9.0).
 *
 * Previously this module only persisted metadata and silently discarded the
 * bytes (the old code literally said "simulate"). Now:
 *  - POST multipart/form-data → real upload to disk + SHA-256 checksum
 *  - POST JSON {action:'list'}     → tenant-scoped listing
 *  - POST JSON {action:'delete'}   → disk + DB removal
 *  - GET  ?id=<fileId>             → streams the stored bytes, checksum-verified
 *
 * All actions require the upload_files permission and are tenant-scoped:
 * company users only reach files attached to centers of their own companies.
 */

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const contentType = req.headers.get('content-type') || '';

    // ── Real upload: multipart/form-data ──
    if (contentType.includes('multipart/form-data')) {
      return await handleMultipartUpload(req, user);
    }

    // ── Metadata actions: JSON body ──
    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'list') return await handleList(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'upload') {
      // The old JSON "upload" path stored metadata without any bytes.
      return NextResponse.json(
        { error: 'بارگذاری فایل فقط از طریق فرم multipart انجام می‌شود.' },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('files', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  UPLOAD — multipart, real bytes → disk + DB
// ════════════════════════════════════════════════════════
async function handleMultipartUpload(req: NextRequest, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.upload_files) {
    return NextResponse.json({ error: 'شما دسترسی بارگذاری فایل را ندارید.' }, { status: 403 });
  }

  // Fast rejection on Content-Length (browsers always send it for multipart):
  // Next.js truncates oversized bodies before the route runs, which would
  // corrupt multipart parsing. Checking the header first gives a clean 400.
  const declaredLength = Number(req.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FILE_SIZE + 64 * 1024) {
    return NextResponse.json(
      { error: 'حجم فایل نباید از ۱۰ مگابایت بیشتر باشد.' },
      { status: 400 },
    );
  }

  // Chunked clients (no Content-Length) may still exceed the platform cap;
  // a truncated multipart stream throws here — translate to a clean 400.
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: 'درخواست نامعتبر است — حجم فایل نباید از ۱۰ مگابایت بیشتر باشد.' },
      { status: 400 },
    );
  }
  const blob = form.get('file');
  if (!blob || typeof blob === 'string') {
    return NextResponse.json({ error: 'فایلی در درخواست یافت نشد.' }, { status: 400 });
  }
  const file = blob as File;

  const originalName = (form.get('originalName') as string) || file.name || '';
  const mimeType = (form.get('mimeType') as string) || file.type || 'application/octet-stream';
  const centerIdRaw = (form.get('centerId') as string) || '';
  const category = ((form.get('category') as string) || '').trim().slice(0, 64) || null;

  // Policy gate (size / extension / MIME) — Persian 400s.
  const size = file.size;
  const policy = checkUploadPolicy(mimeType, size, originalName || file.name);
  if (!policy.ok) {
    return NextResponse.json({ error: policy.reason }, { status: 400 });
  }

  // v2.58.7 (stage 7): REAL content verification — magic-byte sniffing
  // against the claim. A mislabeled upload (HTML claiming image/png) never
  // reaches the disk; unknown-but-clean binaries pass (conservative).
  const policyBytes = Buffer.from(await file.arrayBuffer());
  const contentCheck = verifyUploadContent(mimeType, policyBytes);
  if (!contentCheck.ok) {
    return NextResponse.json({ error: contentCheck.reason }, { status: 400 });
  }

  // Tenant guard: a centerId must belong to one of the user's companies.
  const centerId = centerIdRaw.trim() || null;
  if (centerId) {
    const allowed = await canAccessCenter(user, centerId);
    if (!allowed) {
      return NextResponse.json({ error: 'شما به این مرکز دسترسی ندارید.' }, { status: 403 });
    }
  }

  // v2.58.3 (round 88, finding 9) — the LIFECYCLE store: temp .part
  // write → pending row → atomic rename → committed. A crash between
  // the DB registration and the file move is identifiable and
  // recoverable (sweepStalePendingFiles); an ERROR rolls back both
  // sides; nothing half-finished survives.
  const bytes = policyBytes;
  try {
    const stored = await storeFileLifecycle({
      bytes,
      originalName: originalName || file.name,
      mimeType: mimeType || 'application/octet-stream',
      centerId,
      category,
      createdById: user.id,
    });
    return NextResponse.json(
      { message: 'فایل با موفقیت ذخیره شد.', file: stored },
      { status: 201 },
    );
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
}

// ════════════════════════════════════════════════════════
//  LIST — tenant-scoped
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const parsed = parseBody(filesListSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const perms = getRolePermissions(user.role);
  if (!perms.upload_files) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده فایل‌ها را ندارید.' }, { status: 403 });
  }

  const where: Record<string, unknown> = {};
  if (parsed.data.centerId) where.centerId = parsed.data.centerId;
  if (parsed.data.category) where.category = parsed.data.category;

  // v2.58.1 (audit F4-الف/ج): list scope = centers of the user's allowed
  // companies (admins: the NON-ISOLATED group — an independent company's
  // files never appear in a group admin's list) AND the user's sales
  // territory, PLUS the user's own centerless uploads (explicit ownership
  // policy — a centerless upload must not escape its creator's access).
  const visible = await visibleCenterIds(user);
  if (parsed.data.centerId && !visible.includes(parsed.data.centerId)) {
    return NextResponse.json({ files: [] });
  }
  where.OR = [
    { centerId: { in: visible } },
    getCanonicalRole(user.role) === 'admin'
      ? { centerId: null }
      : { AND: [{ centerId: null }, { createdById: user.id }] },
  ];

  const files = await db.file.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });

  return NextResponse.json({ files });
}

// ════════════════════════════════════════════════════════
//  DELETE — disk + DB
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const parsed = parseBody(filesDeleteSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const perms = getRolePermissions(user.role);
  if (!perms.upload_files) {
    return NextResponse.json({ error: 'شما دسترسی حذف فایل را ندارید.' }, { status: 403 });
  }

  const existing = await db.file.findUnique({
    where: { id: parsed.data.id },
    select: { id: true, storedName: true, centerId: true, createdById: true },
  });
  if (!existing) {
    return NextResponse.json({ error: 'فایل یافت نشد.' }, { status: 404 });
  }
  // v2.58.1 (audit F4-الف/ج): scope check (company + territory + isolated
  // companies for admins) — 403, no data leak.
  if (!(await canAccessFile(user, existing))) {
    return NextResponse.json({ error: 'شما به این فایل دسترسی ندارید.' }, { status: 403 });
  }
  // v2.58.1 (audit F4-ب): OWNERSHIP — the upload permission is not the
  // delete permission. Non-admins delete only files THEY uploaded;
  // an out-of-scope file AND a colleague's file are both refused.
  if (getCanonicalRole(user.role) !== 'admin' && existing.createdById !== user.id) {
    return NextResponse.json(
      { error: 'شما فقط می‌توانید فایل‌های بارگذاری‌شدهٔ خودتان را حذف کنید.' },
      { status: 403 },
    );
  }

  // v2.58.4 (external audit F06) — the recoverable delete: the row is
  // marked 'deleting', the bytes are settled, and ONLY THEN the row goes.
  // An unlink failure (EACCES/EBUSY) keeps the row TRACKABLE and returns
  // an honest 500 — the old removeQuietly() swallowed the failure and
  // dropped the row, leaving untracked bytes with a 200 «حذف شد».
  try {
    await deleteFileLifecycle(parsed.data.id);
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ message: 'فایل با موفقیت حذف شد.' });
}

// ════════════════════════════════════════════════════════
//  GET — download stored bytes (checksum-verified)
// ════════════════════════════════════════════════════════
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }
    const perms = getRolePermissions(user.role);
    if (!perms.upload_files) {
      return NextResponse.json({ error: 'شما دسترسی دانلود فایل را ندارید.' }, { status: 403 });
    }

    const id = req.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'شناسه فایل الزامی است.' }, { status: 400 });
    }

    const file = await db.file.findUnique({
      where: { id },
      select: { id: true, originalName: true, storedName: true, mimeType: true, checksum: true, centerId: true, createdById: true, status: true },
    });
    if (!file) {
      return NextResponse.json({ error: 'فایل یافت نشد.' }, { status: 404 });
    }
    if (!(await canAccessFile(user, file))) {
      return NextResponse.json({ error: 'شما به این فایل دسترسی ندارید.' }, { status: 403 });
    }

    // v2.58.3 (finding 9) — PENDING files are never downloadable (their
    // bytes are not durable yet).
    try {
      assertDownloadable(file.status);
      // v2.58.3 (finding 9) — ASYNC chunked checksum verification with
      // bounded memory (64 KiB chunks via stream — the readFileSync loop
      // is gone from the request path), then a STREAMED response body.
      await verifyStoredFileChecksum(file.storedName, file.checksum);
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }

    // RFC 5987 filename* so Persian names survive; ASCII fallback included.
    const asciiFallback = file.originalName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const encodedName = encodeURIComponent(file.originalName);
    const size = storedFileSize(file.storedName);

    try {
      return new NextResponse(streamStoredFile(file.storedName), {
        status: 200,
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Length': String(size),
          'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedName}`,
          'X-Content-SHA256': file.checksum || '',
          'Cache-Control': 'private, no-store',
        },
      });
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      throw e;
    }
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('files', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  Tenant guards
// ════════════════════════════════════════════════════════
// v2.58.1 (audit F4-الف/ب/ج) — the old guards checked the COMPANY only
// (and let `role === 'admin'` bypass everything). Three gaps closed:
//   الف) TERRITORY — a scoped expert now only reaches files attached to
//        centers INSIDE their sales territory (the centers API has
//        applied this since v2.36; files never did).
//   ب) OWNERSHIP on delete — `upload_files` alone no longer suffices to
//        delete a file: non-admins may delete ONLY files they uploaded
//        (and that are still inside their scope).
//   ج) ISOLATED COMPANIES — admins resolve to the NON-ISOLATED group
//        scope (getAllowedCompanyIds, v2.35.0) instead of an
//        unconditional bypass, so an independent company's (یاس‌طب) files
//        stay walled off from group admins here like every other route.
//
// Files WITHOUT a center now have an explicit ownership policy: the
// UPLOADER keeps read/download/delete access (previously a centerless
// upload instantly escaped its creator's own access — admin-only);
// admins see all centerless files.
async function canAccessCenter(user: AuthUser, centerId: string): Promise<boolean> {
  const center = await db.center.findUnique({
    where: { id: centerId },
    select: { companyId: true, province: true },
  });
  if (!center) return false;
  // company scope — admins resolve to the non-isolated group list (ج)
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null) return true; // unreachable (v2.35.0) — kept for safety
  if (!allowed.includes(center.companyId)) return false;
  // territory scope (الف) — null for admin/finance/production
  const t = resolveTerritoryScope(user);
  if (t && !centerInTerritory({ id: centerId, province: center.province }, t)) return false;
  return true;
}

async function canAccessFile(
  user: AuthUser,
  file: { centerId: string | null; createdById: string | null },
): Promise<boolean> {
  if (file.centerId) return canAccessCenter(user, file.centerId);
  // Centerless files: uploader-owned; admins see them all.
  return getCanonicalRole(user.role) === 'admin' || file.createdById === user.id;
}

/** IDs of centers whose files the user may see (company + territory). */
async function visibleCenterIds(user: AuthUser): Promise<string[]> {
  const allowed = await getAllowedCompanyIds(user);
  if (allowed === null) return []; // unreachable — fail-closed
  const t = resolveTerritoryScope(user);
  const rows = await db.center.findMany({
    where: { companyId: { in: allowed }, ...centerTerritoryWhere(t) },
    select: { id: true },
  });
  return rows.map((c) => c.id);
}
// (v2.58.4, audit F06) removeQuietly() is GONE — deletion goes through
// deleteFileLifecycle(): an unlink failure is surfaced, logged, and the
// tracking row survives in 'deleting' until the bytes are settled.
