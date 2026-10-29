import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, canAccessCompany } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { resolveTerritoryScope, centerInTerritory } from '@/lib/territory-scope';

const UNAUTHORIZED = NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

/** Load a followup and verify the requesting user may act on its company. Returns an error response or null. */
async function authorizeFollowupAccess(followupId: string) {
  const user = await getCurrentUser();
  if (!user) return { user: null, followup: null, error: UNAUTHORIZED };

  const followup = await db.periodicFollowup.findUnique({ where: { id: followupId } });
  if (!followup) {
    return { user, followup: null, error: NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 }) };
  }

  const comp = await db.company.findUnique({
    where: { id: followup.companyId },
    select: { slug: true, isIsolated: true },
  });
  // v2.35.0 — isolated-company follow-ups (یاس طب): assigned users only;
  // group admins are walled out like everyone else.
  if (comp?.isIsolated) {
    const assigned = getCanonicalRole(user.role) !== 'admin' && user.companyIds.includes(comp.slug);
    if (!assigned) {
      return { user, followup: null, error: NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 }) };
    }
  } else if (getCanonicalRole(user.role) !== 'admin') {
    if (!comp || !canAccessCompany(user, comp.slug)) {
      return { user, followup: null, error: NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 }) };
    }
  }

  // v2.58.3 (round 88, finding 1) — SALES TERRITORY: a scoped expert may
  // only act on (register a result for) a follow-up whose CENTER sits
  // inside their sales territory. A follow-up without a center is not
  // actionable for a scoped user (the list already excludes those rows —
  // the direct-id path must agree, otherwise the id would bypass the
  // geographic scope). 404 — no existence leak.
  const territory = resolveTerritoryScope(user);
  if (territory) {
    if (!followup.centerId) {
      return { user, followup: null, error: NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 }) };
    }
    const center = await db.center.findUnique({
      where: { id: followup.centerId },
      select: { province: true },
    });
    if (!center || !centerInTerritory({ id: followup.centerId, province: center.province }, territory)) {
      return { user, followup: null, error: NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 }) };
    }
  }

  return { user, followup, error: null };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { user, error } = await authorizeFollowupAccess(id);
    if (error) return error;
    if (!user) return UNAUTHORIZED;

    const body = await req.json();
    const { method, result, note } = body;

    if (!method) {
      return NextResponse.json({ error: 'روش پیگیری الزامی است' }, { status: 400 });
    }

    const followup = await db.periodicFollowup.findUnique({ where: { id } });
    if (!followup) {
      return NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 });
    }

    const today = new Date().toISOString().slice(0, 10);

    // Create history entry
    await db.followupHistory.create({
      data: {
        followupId: id,
        followupDate: today,
        method,
        result: result || null,
        note: note || null,
      },
    });

    // Calculate next date
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + followup.frequencyDays);

    await db.periodicFollowup.update({
      where: { id },
      data: {
        lastFollowupDate: today,
        nextFollowupDate: nextDate.toISOString().slice(0, 10),
        totalFollowups: { increment: 1 },
        daysOverdue: 0,
        status: 'upcoming',
      },
    });

    return NextResponse.json({ success: true });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
