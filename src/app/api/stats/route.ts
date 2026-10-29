import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { assertCanAccessCompanySlug, nonIsolatedCompanyIds } from '@/lib/company-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { computeFollowupStatus } from '@/lib/followup-status';
import { lastMonthKeys, jalaliMonthKey, jalaliMonthLabel } from '@/lib/trend';

const UNAUTHORIZED = NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return UNAUTHORIZED;

  const { searchParams } = new URL(req.url);
  const company = searchParams.get('company') || 'holding';

  try {
    // v2.25.0 — REAL monthly invoiced-sales trend for the holding
    // dashboard (admin-only group view). The dashboard previously
    // rendered a hardcoded EMPTY placeholder array. Source of truth:
    // approved invoice documents (quick-sale, direct, and proforma-
    // derived), bucketed by Jalali month on the direct companyId column.
    if (searchParams.get('trend')) {
      if (getCanonicalRole(user.role) !== 'admin') {
        return NextResponse.json({ error: 'نمای هلدینگ فقط برای مدیر سیستم در دسترس است.' }, { status: 403 });
      }
      const months = Math.max(1, Math.min(Number(searchParams.get('months')) || 7, 24));
      const keys = lastMonthKeys(months);
      // Generous Gregorian lower bound so the oldest Jalali month is fully
      // covered (31-day Jalali months + year-boundary slack).
      const lowerBound = new Date(Date.now() - (months * 31 + 93) * 86400000);
      // v2.35.0 — isolated companies (یاس طب) never join the group trend:
      // their docs resolve to no slug bucket and are skipped below.
      const comps = await db.company.findMany({
        where: { isIsolated: false },
        select: { id: true, slug: true },
      });
      const slugById = new Map(comps.map((c) => [c.id, c.slug]));

      const docs = await db.salesDocument.findMany({
        where: {
          documentType: 'invoice',
          status: 'approved',
          issuedAt: { gte: lowerBound },
        },
        select: { finalAmount: true, companyId: true, issuedAt: true, createdAt: true },
      });

      // slug → (monthKey → amount)
      const perCompany = new Map<string, Map<string, number>>();
      for (const doc of docs) {
        const slug = doc.companyId ? slugById.get(doc.companyId) : undefined;
        if (!slug || slug === 'holding') continue; // company-neutral rows don't split the chart
        const key = jalaliMonthKey(doc.issuedAt || doc.createdAt);
        let buckets = perCompany.get(slug);
        if (!buckets) { buckets = new Map(); perCompany.set(slug, buckets); }
        buckets.set(key, (buckets.get(key) || 0) + doc.finalAmount);
      }

      const series = keys.map((key) => {
        const bySlug: Record<string, number> = {};
        let total = 0;
        for (const [slug, buckets] of perCompany) {
          const v = buckets.get(key) || 0;
          bySlug[slug] = v;
          total += v;
        }
        return { key, label: jalaliMonthLabel(key), total, companies: bySlug };
      });

      return NextResponse.json({ months: series });
    }

    // Tenant isolation gates
    if (company === 'holding' && getCanonicalRole(user.role) !== 'admin') {
      return NextResponse.json({ error: 'نمای هلدینگ فقط برای مدیر سیستم در دسترس است.' }, { status: 403 });
    }
    if (company !== 'holding') {
      // v2.35.0 — shared company gate (isolated companies: assigned users
      // only, admins are walled out; unknown slug → 404).
      try {
        await assertCanAccessCompanySlug(user, company);
      } catch (e: unknown) {
        const status = (e as { status?: number })?.status === 404 ? 404 : 403;
        return NextResponse.json({ error: 'شما به این شرکت دسترسی ندارید.' }, { status });
      }
    }

    if (company === 'holding') {
      // Admin group-wide view (non-admins are blocked above).
      // v2.35.0 — the aggregate counts ONLY non-isolated companies; یاس طب
      // numbers never merge into the holding view.
      const groupIds = await nonIsolatedCompanyIds();
      const totalSales = await db.salesReport.aggregate({ _sum: { totalSales: true }, where: { companyId: { in: groupIds } } });
      const totalCenters = await db.center.count({ where: { isArchived: false, companyId: { in: groupIds } } });
      const openProformas = await db.salesDocument.count({
        where: { documentType: 'proforma', status: { in: ['draft', 'pending_approval'] }, companyId: { in: groupIds } },
      });
      // v2.15.0 (audit #6): active follow-ups are counted from the due status
      // DERIVED from nextFollowupDate — the stored column could keep a
      // long-overdue follow-up filed as 'upcoming'.
      const activeFollowupRows = await db.periodicFollowup.findMany({
        where: { isActive: true, companyId: { in: groupIds } },
        select: { status: true, nextFollowupDate: true, daysOverdue: true },
      });
      const activeFollowups = activeFollowupRows.filter(
        (r) => computeFollowupStatus(r).status !== 'done',
      ).length;

      return NextResponse.json(buildStats(totalSales._sum.totalSales || 0, totalCenters, openProformas, activeFollowups, 'کل فروش (ریال)', 'کل مراکز فعال'));
    }

    const comp = await db.company.findUnique({ where: { slug: company } });
    if (!comp) return NextResponse.json({ error: 'شرکت یافت نشد' }, { status: 404 });

    // Scope every metric to this company (previously proformas leaked across companies)
    const centerIds = await db.center.findMany({
      where: { companyId: comp.id },
      select: { id: true },
    });

    const totalSales = await db.salesReport.aggregate({
      _sum: { totalSales: true },
      where: { companyId: comp.id },
    });
    const totalCenters = await db.center.count({ where: { companyId: comp.id, isArchived: false } });
    const openProformas = await db.salesDocument.count({
      where: {
        documentType: 'proforma',
        status: { in: ['draft', 'pending_approval'] },
        centerId: { in: centerIds.map((c) => c.id) },
      },
    });
    const activeFollowupRows = await db.periodicFollowup.findMany({
      where: { companyId: comp.id, isActive: true },
      select: { status: true, nextFollowupDate: true, daysOverdue: true },
    });
    const activeFollowups = activeFollowupRows.filter(
      (r) => computeFollowupStatus(r).status !== 'done',
    ).length;

    const labels: Record<string, { centers: string; sales: string }> = {
      bazargani: { centers: 'مشتریان فعال', sales: 'کل فروش (ریال)' },
      aria: { centers: 'مراکز فعال', sales: 'کل فروش (ریال)' },
      bgl: { centers: 'مشتریان B2B فعال', sales: 'کل فروش (ریال)' },
      yasteb: { centers: 'مشتریان فعال', sales: 'کل فروش (ریال)' },
    };
    const lbl = labels[company] || { centers: 'مراکز فعال', sales: 'کل فروش (ریال)' };

    return NextResponse.json(buildStats(totalSales._sum.totalSales || 0, totalCenters, openProformas, activeFollowups, lbl.sales, lbl.centers));
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

function buildStats(salesAmount: number, centersCount: number, proformasCount: number, followupsCount: number, salesLabel: string, centersLabel: string) {
  // P2-1 (v2.9.0): the eight *Change / *Progress placeholders that were
  // always hardcoded to 0 are removed. No consumer ever read them — the
  // dashboards render their own trend indicators from real data.
  return {
    salesAmount,
    salesLabel,
    salesIcon: 'trending-up',
    centersCount,
    centersLabel,
    centersIcon: 'building-2',
    proformasCount,
    proformasLabel: 'پیش‌فاکتورهای باز',
    proformasIcon: 'file-text',
    followupsCount,
    followupsLabel: 'پیگیری‌های فعال',
    followupsIcon: 'phone',
  };
}
