import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, type AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { assertCanAccessCompanySlug, nonIsolatedCompanyIds } from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { computeFollowupStatus } from '@/lib/followup-status';
import { centerRelTerritoryWhere, centerInTerritory, resolveTerritoryScope } from '@/lib/territory-scope';

const UNAUTHORIZED = NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
const FORBIDDEN_COMPANY = NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status: 403 });

/** Resolve the company filter for a non-admin user: only their assigned companies. */
async function allowedCompanyIdsFor(user: AuthUser): Promise<string[]> {
  const comps = await db.company.findMany({
    where: { slug: { in: user.companyIds } },
    select: { id: true },
  });
  return comps.map((c) => c.id);
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return UNAUTHORIZED;

  const { searchParams } = new URL(req.url);
  const company = searchParams.get('company') || '';
  const status = searchParams.get('status') || '';
  const search = searchParams.get('search') || '';
  // v2.34.8 — center dossier (پرونده مرکز): restrict the list to one
  // center's followups. The tenant scope below still applies FIRST, so a
  // cross-company center id can only shrink the result set.
  const centerId = searchParams.get('centerId') || '';

  try {
    const where: Record<string, unknown> = { isActive: true };

    if (centerId) {
      where.centerId = centerId;
    }

    if (company && company !== 'holding') {
      // Explicit company requested — enforce tenant isolation.
      // v2.35.0 — shared gate: isolated companies resolve for their
      // assigned users only (admins are walled out of یاس طب).
      try {
        const comp = await assertCanAccessCompanySlug(user, company);
        where.companyId = comp.id;
      } catch (e: unknown) {
        return NextResponse.json(
          { error: (e as { message?: string })?.message || 'شما به این شرکت دسترسی ندارید.' },
          { status: (e as { status?: number })?.status || 403 },
        );
      }
    } else if (getCanonicalRole(user.role) !== 'admin') {
      // Non-admin without an explicit company: restrict to their companies only
      const ids = await allowedCompanyIdsFor(user);
      where.companyId = { in: ids };
    } else {
      // v2.35.0 — admin aggregate (holding) view: NON-isolated companies
      // only; isolated follow-ups never merge into the group feed.
      where.companyId = { in: await nonIsolatedCompanyIds() };
    }

    // Admin + 'holding' (or empty) → group-wide view, intentional

    // v2.41.0 (r57 port) — sales territory: a scoped expert's follow-up list only
    // covers their territory's centers (the center relation carries the
    // province; centers mode filters by the raw centerId column).
    const followupTerritory = resolveTerritoryScope(user);
    if (followupTerritory) {
      const fragment = centerRelTerritoryWhere(followupTerritory) as Record<string, unknown>;
      where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), fragment];
    }

    // v2.15.0: the status filter is applied AFTER the due status is
    // derived from nextFollowupDate — filtering in the DB would rely on the
    // stale stored column and miss follow-ups that have gone overdue.

    if (search) {
      where.OR = [
        { centerName: { contains: search } },
        { personName: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    const rows = await db.periodicFollowup.findMany({
      where,
      include: {
        history: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { history: true, notes: true } },
      },
      orderBy: { nextFollowupDate: 'asc' },
      // Hard cap to protect bandwidth on very large datasets
      take: 500,
    });

    // v2.15.0 (sixth-round audit, item 6): status/daysOverdue are DERIVED
    // from nextFollowupDate at read time. Previously the stored column was
    // returned as-is, so an overdue follow-up could linger as 'upcoming'
    // forever and never enter the overdue alert.
    const followups = rows.map((f) => {
      const derived = computeFollowupStatus(f);
      return { ...f, status: derived.status, daysOverdue: derived.daysOverdue };
    });

    const statusFilter = status && status !== 'all' ? status : null;
    const filtered = statusFilter
      ? followups.filter((f) => f.status === statusFilter)
      : followups;

    // Overdue first (most overdue on top), then by soonest next date.
    filtered.sort((a, b) => {
      if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return String(a.nextFollowupDate || '9999').localeCompare(String(b.nextFollowupDate || '9999'));
    });

    return NextResponse.json(filtered.slice(0, 500));
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return UNAUTHORIZED;

  try {
    const body = await req.json();
    const { companyId, centerId, centerName, city, personName, phone, frequency } = body;

    if (!companyId || !centerName || !personName || !frequency) {
      return NextResponse.json({ error: 'فیلدهای الزامی را تکمیل کنید' }, { status: 400 });
    }

    // Tenant isolation: the target company must belong to the user's scope.
    // v2.35.0 — shared slug gate (admins can never file follow-ups under an
    // isolated company; assigned یاس طب users can).
    const comp = await db.company.findUnique({ where: { id: companyId } });
    if (!comp) {
      return NextResponse.json({ error: 'شرکت یافت نشد' }, { status: 404 });
    }
    try {
      await assertCanAccessCompanySlug(user, comp.slug);
    } catch {
      return FORBIDDEN_COMPANY;
    }

    // v2.58.3 (round 88, finding 1) — CONSISTENCY: when a center is
    // attached, it must REALLY belong to the given company AND to the
    // caller's territory. Previously ANY center id from another company
    // was accepted and silently stored on the row (the list then leaked
    // that center's data inside a company-filtered feed).
    if (centerId) {
      const centerRow = await db.center.findUnique({
        where: { id: centerId },
        select: { companyId: true, province: true },
      });
      if (!centerRow || centerRow.companyId !== companyId) {
        return NextResponse.json(
          { error: 'مرکز انتخاب‌شده به این شرکت تعلق ندارد.' },
          { status: 400 },
        );
      }
      // v2.41.0 (r57 port) — territory isolation: a follow-up may only be
      // attached to a center inside the expert's sales territory
      // (fail-closed write).
      const createTerritory = resolveTerritoryScope(user);
      if (createTerritory && !centerInTerritory({ id: centerId, province: centerRow.province }, createTerritory)) {
        return NextResponse.json(
          { error: 'مرکز موردنظر در محدودهٔ فروش شما نیست.' },
          { status: 403 },
        );
      }
    }

    const freqDays: Record<string, number> = {
      weekly: 7,
      biweekly: 14,
      monthly: 30,
      bimonthly: 60,
    };
    const days = freqDays[frequency] || 30;
    const nextDate = new Date();
    nextDate.setDate(nextDate.getDate() + days);

    const followup = await db.periodicFollowup.create({
      data: {
        companyId,
        centerId: centerId || null,
        centerName,
        city: city || null,
        personName,
        phone: phone || null,
        frequency,
        frequencyDays: days,
        nextFollowupDate: nextDate.toISOString().slice(0, 10),
        status: 'upcoming',
      },
    });

    return NextResponse.json({ success: true, followup });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
