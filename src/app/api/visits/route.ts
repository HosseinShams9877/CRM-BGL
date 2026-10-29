import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/db';
import { getCurrentUser, type AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { ApiError } from '@/lib/api-error';
import {
  getAllowedCompanyIds, allowedCenterIds, COMPANY_ACCESS_DENIED,
} from '@/lib/company-scope';
import { territoryVisibleCenterIds } from '@/lib/territory-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

// ════════════════════════════════════════════════════════
//  Types
// ════════════════════════════════════════════════════════

interface Visit {
  id: string;
  centerId: string;
  centerName: string;
  date: string;
  time: string;
  purpose: string;
  result: string;
  nextAction: string;
  assignedTo: string;
  assignedToName: string;
  status: 'planned' | 'done' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

// ════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function getVisitsData(): Promise<Visit[]> {
  const meta = await db.meta.findUnique({ where: { key: 'visits_data' } });
  if (!meta?.value) return [];
  let parsed: unknown;
  let ok = true;
  try {
    parsed = JSON.parse(meta.value);
  } catch {
    ok = false;
  }
  // v2.58.7 (stage 5): a corrupt blob must NEVER degrade to `[]` — not on
  // mutations (already fail-closed since v2.58.4) and not on READS either:
  // serving an empty list made the corruption INVISIBLE (the user thinks
  // the visits are gone, keeps working, and the next valid mutation is the
  // one that finally overwrites the blob). Reads now fail with the same
  // controlled Persian error + REQUEST ID (the client surfaces it; an
  // admin repairs the row from backup). Reads still never write.
  if (!ok || !Array.isArray(parsed)) {
    logVisitsCorruption(
      ok ? 'read path — blob is valid JSON but not an array' : 'read path — blob is unparseable JSON',
    );
    throw new ApiError(409, VISITS_CORRUPT_MSG);
  }
  return parsed as Visit[];
}

/** v2.58.4 (issue 3) — one loud, correlatable log line per corruption
 *  event: a short REQUEST ID lets support match a client report to the
 *  exact server log entry (same convention as lib/api-error). */
function logVisitsCorruption(context: string): void {
  const reqId = `req-${crypto.randomBytes(6).toString('hex')}`;
  logApiError('visits', `VISITS_BLOB_CORRUPT [${reqId}] — mutation ABORTED, original value PRESERVED (${context})`);
}

// ── Concurrent-safe mutations (v2.15.0 — sixth-round audit, item 5) ──
// All visits live in ONE Meta row as a JSON blob, and the handlers used a
// naive read → push → write sequence. Two simultaneous registrations both
// read the same array and the second write silently erased the first visit
// (both requests still reported success). Mutations now run through an
// optimistic-concurrency loop: the write only lands when the row is still
// the exact version we read (guarded on updatedAt AND value); otherwise the
// whole read-modify-write is retried from scratch.
//
// v2.58.4 (user issue 3) — DATA-DESTRUCTION GUARD: a corrupt (unparseable
// or non-array) blob used to fall through as `[]` and the mutation then
// WROTE `[]` back — one "successful" update destroyed every visit in the
// system. Now the mutation ABORTS with a controlled Persian error, the
// ORIGINAL value is preserved byte-identically (repairable from backup),
// and the event is logged with a REQUEST ID. Zero-deletion guarantee.

const VISITS_KEY = 'visits_data';
const VISITS_CONFLICT_MSG = 'تغییرات هم‌زمان روی بازدیدها اعمال نشد؛ لطفاً دوباره تلاش کنید.';
// v2.58.4 (issue 3) → v2.58.7 (stage 5): controlled failure for a corrupt
// blob — the status is now 409 (CONFLICT: the stored state is unusable for
// this request; the user's mandatory test matrix) and the SAME message is
// shared by the read path. The original value is NEVER overwritten.
const VISITS_CORRUPT_MSG =
  'داده‌های بازدیدهای سیستم قابل خوانده شدن نیست. برای جلوگیری از از دست رفتن اطلاعات، عملیات انجام نشد و دادهٔ فعلی دست‌نخورده باقی ماند — لطفاً با پشتیبانی تماس بگیرید.';

type MutateResult =
  | { ok: true; visits: Visit[] }
  | { ok: false; response: NextResponse };

async function mutateVisits(
  mutate: (visits: Visit[]) => Promise<MutateResult> | MutateResult,
  maxAttempts = 6,
): Promise<{ visits: Visit[] } | { response: NextResponse }> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const current = await db.meta.findUnique({ where: { key: VISITS_KEY } });
    let base: Visit[] = [];
    if (current?.value) {
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(current.value);
      } catch {
        ok = false;
      }
      // v2.58.4 (issue 3) — FAIL-CLOSED: corrupt (unparseable OR non-array)
      // ⇒ the mutation ABORTS. The old `base = []` fall-through wrote the
      // empty array back over the (only copy of the) data — an
      // unrecoverable destruction on a routine edit.
      if (!ok || !Array.isArray(parsed)) {
        logVisitsCorruption(
          ok ? 'blob is valid JSON but not an array' : 'blob is unparseable JSON',
        );
        // v2.58.7 (stage 5): 409 CONFLICT — the user's mandatory test
        // matrix for a corrupt visit + update. Data still byte-preserved.
        return {
          response: NextResponse.json({ error: VISITS_CORRUPT_MSG }, { status: 409 }),
        };
      }
      base = parsed as Visit[];
    }

    const result = await mutate(base);
    if (!result.ok) return { response: result.response };

    const serialized = JSON.stringify(result.visits);
    if (current) {
      // Guarded write — only succeeds when the row hasn't changed since read.
      const guard = await db.meta.updateMany({
        where: { key: VISITS_KEY, updatedAt: current.updatedAt, value: current.value },
        data: { value: serialized },
      });
      if (guard.count === 1) return { visits: result.visits };
    } else {
      try {
        await db.meta.create({ data: { key: VISITS_KEY, value: serialized } });
        return { visits: result.visits };
      } catch {
        // Lost the create race — fall through to retry.
      }
    }

    // Conflict — brief backoff, then re-read and re-apply.
    await new Promise((r) => setTimeout(r, 20 * attempt));
  }
  return {
    response: NextResponse.json({ error: VISITS_CONFLICT_MSG }, { status: 409 }),
  };
}

// ════════════════════════════════════════════════════════
//  Main POST handler
// ════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    // Auth (central — includes sliding 12h session expiry)
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'stats') return await handleStats(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('visits', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — get all visits with optional filters
// ════════════════════════════════════════════════════════

async function handleList(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const { status, assignedTo, centerId } = body as {
    status?: string;
    assignedTo?: string;
    centerId?: string;
  };

  let visits = await getVisitsData();

  // v2.12.0: tenant isolation — non-admins only see visits whose center
  // belongs to one of their companies. Previously this route returned the
  // entire visits blob (all companies) to every authenticated user.
  const scopeCenterIds = await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user)));
  if (scopeCenterIds !== null) {
    const allowed = new Set(scopeCenterIds);
    visits = visits.filter((v) => allowed.has(v.centerId));
  }

  // v2.34.8 — center dossier (پرونده مرکز): filter a single center's visits.
  // Applied AFTER the tenant scope so a cross-company centerId yields an
  // empty list, never another tenant's rows.
  if (centerId && typeof centerId === 'string') {
    visits = visits.filter((v) => v.centerId === centerId);
  }

  if (status) {
    visits = visits.filter((v) => v.status === status);
  }
  if (assignedTo) {
    visits = visits.filter((v) => v.assignedTo === assignedTo);
  }

  // Sort newest first
  visits.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // v2.21.0 — enrich each visit with its center's province/city. The visits
  // blob only stores centerId; the frontend adapter previously mapped
  // `territory` to a hardcoded '', so the «منطقه‌ها» KPI and the region
  // filter on the visits page could never show real data. Region now means
  // the center's province (falling back to its city).
  const centerIds = [...new Set(visits.map((v) => v.centerId).filter((id): id is string => !!id))];
  const centers = centerIds.length
    ? await db.center.findMany({
        where: { id: { in: centerIds } },
        select: { id: true, city: true, province: true },
      })
    : [];
  const centerGeo = new Map(centers.map((c) => [c.id, c]));
  const enriched = visits.map((v) => {
    const geo = centerGeo.get(v.centerId);
    return { ...v, city: geo?.city || '', province: geo?.province || '' };
  });

  return NextResponse.json({ visits: enriched });
}

// ════════════════════════════════════════════════════════
//  CREATE — add a new visit
// ════════════════════════════════════════════════════════

async function handleCreate(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const {
    centerId,
    centerName,
    date,
    time,
    purpose,
    result,
    nextAction,
    assignedTo,
    assignedToName,
    status,
  } = body as {
    centerId?: string;
    centerName?: string;
    date?: string;
    time?: string;
    purpose?: string;
    result?: string;
    nextAction?: string;
    assignedTo?: string;
    assignedToName?: string;
    status?: string;
  };

  if (!centerId) {
    return NextResponse.json({ error: 'شناسه مرکز الزامی است' }, { status: 400 });
  }
  if (!date) {
    return NextResponse.json({ error: 'تاریخ الزامی است' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — a visit may only be registered against a
  // center belonging to one of the user's companies (admins unrestricted).
  const createScopeCenterIds = await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user)));
  if (createScopeCenterIds !== null && !createScopeCenterIds.includes(centerId)) {
    return NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 });
  }

  const validStatuses: Visit['status'][] = ['planned', 'done', 'cancelled'];
  const now = new Date().toISOString();

  const newVisit: Visit = {
    id: generateId(),
    centerId: centerId!,
    centerName: centerName || '',
    date: date!,
    time: time || '',
    purpose: purpose || '',
    result: result || '',
    nextAction: nextAction || '',
    assignedTo: assignedTo || user.id,
    assignedToName: assignedToName || user.displayName,
    status: validStatuses.includes(status as Visit['status']) ? (status as Visit['status']) : 'planned',
    createdAt: now,
    updatedAt: now,
  };

  const outcome = await mutateVisits((current) => ({ ok: true, visits: [...current, newVisit] }));
  if ('response' in outcome) return outcome.response;

  return NextResponse.json({ message: 'بازدید با موفقیت ایجاد شد', visit: newVisit }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE — update a visit by id
// ════════════════════════════════════════════════════════

async function handleUpdate(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const { id, ...fields } = body as {
    id?: string;
    centerId?: string;
    centerName?: string;
    date?: string;
    time?: string;
    purpose?: string;
    result?: string;
    nextAction?: string;
    assignedTo?: string;
    assignedToName?: string;
    status?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه بازدید الزامی است' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — 404 (no existence leak) when the visit's
  // center is outside the user's company scope.
  const updateScopeCenterIds = await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user)));

  const validStatuses: Visit['status'][] = ['planned', 'done', 'cancelled'];
  const now = new Date().toISOString();

  // v2.15.0: update runs through the optimistic-concurrency loop.
  const outcome = await mutateVisits(async (visits) => {
    const index = visits.findIndex((v) => v.id === id);
    if (index === -1) {
      return { ok: false, response: NextResponse.json({ error: 'بازدید یافت نشد' }, { status: 404 }) };
    }

    if (updateScopeCenterIds !== null) {
      if (!updateScopeCenterIds.includes(visits[index].centerId)) {
        return { ok: false, response: NextResponse.json({ error: 'بازدید یافت نشد' }, { status: 404 }) };
      }
      // moving the visit to an out-of-scope center is equally forbidden
      if (fields.centerId !== undefined && !updateScopeCenterIds.includes(fields.centerId)) {
        return { ok: false, response: NextResponse.json({ error: COMPANY_ACCESS_DENIED }, { status: 403 }) };
      }
    }

    // Validate status if provided
    if (fields.status && !validStatuses.includes(fields.status as Visit['status'])) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: 'وضعیت نامعتبر است. مقادیر مجاز: planned, done, cancelled' },
          { status: 400 },
        ),
      };
    }

    const updated: Visit = {
      ...visits[index],
      ...fields,
      id: visits[index].id,
      createdAt: visits[index].createdAt,
      updatedAt: now,
    } as Visit;

    if (fields.status) {
      updated.status = fields.status as Visit['status'];
    }

    // Update assignedToName if assignedTo changed and assignedToName not provided
    if (fields.assignedTo && !fields.assignedToName) {
      const targetUser = await db.user.findUnique({ where: { id: fields.assignedTo } });
      if (targetUser) {
        updated.assignedToName = targetUser.displayName;
      }
    }

    const next = [...visits];
    next[index] = updated;
    return { ok: true, visits: next };
  });
  if ('response' in outcome) return outcome.response;

  const updatedVisit = outcome.visits.find((v) => v.id === id);
  return NextResponse.json({ message: 'بازدید با موفقیت به‌روزرسانی شد', visit: updatedVisit });
}

// ════════════════════════════════════════════════════════
//  DELETE — remove a visit by id
// ════════════════════════════════════════════════════════

async function handleDelete(
  body: Record<string, unknown>,
  user: AuthUser,
) {
  const { id } = body as { id?: string };

  if (!id) {
    return NextResponse.json({ error: 'شناسه بازدید الزامی است' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — 404 when the visit's center is outside the
  // user's company scope.
  const deleteScopeCenterIds = await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user)));

  // v2.15.0: delete runs through the optimistic-concurrency loop.
  const outcome = await mutateVisits((visits) => {
    const index = visits.findIndex((v) => v.id === id);
    if (index === -1) {
      return { ok: false, response: NextResponse.json({ error: 'بازدید یافت نشد' }, { status: 404 }) };
    }
    if (deleteScopeCenterIds !== null && !deleteScopeCenterIds.includes(visits[index].centerId)) {
      return { ok: false, response: NextResponse.json({ error: 'بازدید یافت نشد' }, { status: 404 }) };
    }
    return { ok: true, visits: visits.filter((_, i) => i !== index) };
  });
  if ('response' in outcome) return outcome.response;

  return NextResponse.json({ message: 'بازدید با موفقیت حذف شد' });
}

// ════════════════════════════════════════════════════════
//  STATS — count visits by status
// ════════════════════════════════════════════════════════

async function handleStats(
  _body: Record<string, unknown>,
  user: AuthUser,
) {
  let visits = await getVisitsData();

  // v2.12.0: tenant isolation — stats are computed over the user's company
  // scope only (previously over every company's visits).
  const statsScopeCenterIds = await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user)));
  if (statsScopeCenterIds !== null) {
    const allowed = new Set(statsScopeCenterIds);
    visits = visits.filter((v) => allowed.has(v.centerId));
  }

  const stats = {
    total: visits.length,
    planned: visits.filter((v) => v.status === 'planned').length,
    done: visits.filter((v) => v.status === 'done').length,
    cancelled: visits.filter((v) => v.status === 'cancelled').length,
  };

  return NextResponse.json({ stats });
}
