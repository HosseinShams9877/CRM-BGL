import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, canAccessCompany, type AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { resolveTerritoryScope, centerInTerritory } from '@/lib/territory-scope';

const UNAUTHORIZED = NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

/**
 * v2.35.0 — shared tenant gate for a followup's company: isolated companies
 * (یاس طب) answer to their assigned users only; group admins are walled
 * out, non-admins keep the assignment check.
 */
async function followupCompanyDenied(user: AuthUser, companyId: string): Promise<boolean> {
  const comp = await db.company.findUnique({
    where: { id: companyId },
    select: { slug: true, isIsolated: true },
  });
  if (comp?.isIsolated) {
    return !(getCanonicalRole(user.role) !== 'admin' && user.companyIds.includes(comp.slug));
  }
  if (getCanonicalRole(user.role) === 'admin') return false;
  return !comp || !canAccessCompany(user, comp.slug);
}

/**
 * v2.58.3 (round 88, finding 1) — SALES TERRITORY gate for a follow-up's
 * notes. The company gate above stays primary; this adds the geographic
 * scope: a scoped expert may only read/write the notes of a follow-up
 * whose CENTER is inside their territory. Center-less follow-ups are not
 * readable/writable by scoped users through the direct-id path (the list
 * already hides them — the direct path must agree). 404 — no existence leak.
 */
async function followupTerritoryDenied(user: AuthUser, followup: { centerId: string | null }): Promise<boolean> {
  const territory = resolveTerritoryScope(user);
  if (!territory) return false;
  if (!followup.centerId) return true;
  const center = await db.center.findUnique({
    where: { id: followup.centerId },
    select: { province: true },
  });
  if (!center) return true;
  return !centerInTerritory({ id: followup.centerId, province: center.province }, territory);
}

/**
 * GET — list notes of a followup (v2.19.0).
 * The UI previously showed a placeholder card ("load notes from the API")
 * because this endpoint did not exist. Same tenant gate as POST.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) return UNAUTHORIZED;

    const { id } = await params;

    const followup = await db.periodicFollowup.findUnique({ where: { id } });
    if (!followup) {
      return NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 });
    }

    // Tenant isolation: only users with access to the followup's company may read notes
    if (await followupCompanyDenied(user, followup.companyId)) {
      return NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 });
    }
    // v2.58.3 — sales-territory gate (404 — no existence leak)
    if (await followupTerritoryDenied(user, followup)) {
      return NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 });
    }

    const notes = await db.followupNote.findMany({
      where: { followupId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return NextResponse.json({ notes });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getCurrentUser();
    if (!user) return UNAUTHORIZED;

    const { id } = await params;
    const body = await req.json();
    const { text } = body;

    if (!text || !text.trim()) {
      return NextResponse.json({ error: 'متن یادداشت الزامی است' }, { status: 400 });
    }

    const followup = await db.periodicFollowup.findUnique({ where: { id } });
    if (!followup) {
      return NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 });
    }

    // Tenant isolation: only users with access to the followup's company may add notes
    if (await followupCompanyDenied(user, followup.companyId)) {
      return NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 });
    }
    // v2.58.3 — sales-territory gate (404 — no existence leak)
    if (await followupTerritoryDenied(user, followup)) {
      return NextResponse.json({ error: 'پیگیری یافت نشد' }, { status: 404 });
    }

    const note = await db.followupNote.create({
      data: {
        followupId: id,
        text: text.trim(),
      },
    });

    return NextResponse.json({ success: true, note });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
