import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds, centerCompanyWhere,
  optionalCenterIdInWhere, allowedCenterIds, ownerScopedCenterWhere,
} from '@/lib/company-scope';
import { activityTerritoryWhere, centerTerritoryWhere, resolveTerritoryScope, territoryVisibleCenterIds } from '@/lib/territory-scope';
import { proformaNumbersWithDerivedInvoice, countsAsPurchase } from '@/lib/sales-metrics';
import { buildStaffPerfRow } from '@/lib/staff-perf';
// v2.51.0 (round 76) — «مرکز گزارش حرفه‌ای» shared contract (single
// source of truth for this handler AND the ReportsCenter UI).
import {
  PERIOD_MONTHS_OPTIONS, periodLabel, periodWindow, last12JalaliMonthBuckets,
  trendBucketIndex, buildExpertPerfRow,
  type PeriodMonths, type CompanyPerfRow, type ExpertPerfRow, type TrendPoint,
} from '@/lib/performance-center';
import { ISOLATED_COMPANY_SLUGS } from '@/lib/menu-catalog';
import { gregorianToJalali, jalaliMonthName, currentJalaliYear, jalaliYearWindow } from '@/lib/jalali';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

/** v2.36.0 — combined company + sales-territory scope for center-owned
 * rows in report queries: reports, dashboards and aggregates follow the
 * expert's assigned provinces, not the whole company. No-op for admins
 * and unassigned users (legacy behaviour preserved). */
function docCenterScope(user: AuthUser, allowed: string[] | null): Record<string, unknown> {
  const t = centerTerritoryWhere(resolveTerritoryScope(user));
  const company = centerCompanyWhere(allowed);
  if (!t && !company) return {};
  return { center: { ...company, ...t } };
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'sales-summary') return await handleSalesSummary(body, user);
    if (action === 'top-centers') return await handleTopCenters(body, user);
    if (action === 'activity-report') return await handleActivityReport(body, user);
    if (action === 'inventory-report') return await handleInventoryReport(body, user);
    // v2.18.0 (ninth-round audit) — real aggregates behind the previously
    // hardcoded report tabs.
    if (action === 'pipeline-summary') return await handlePipelineSummary(body, user);
    if (action === 'staff-performance') return await handleStaffPerformance(body, user);
    if (action === 'finance-summary') return await handleFinanceSummary(body, user);
    if (action === 'company-compare') return await handleCompanyCompare(body, user);
    if (action === 'production-summary') return await handleProductionSummary(body, user);
    // v2.19.0 (tenth-round audit) — dedicated shipment report
    if (action === 'shipment-summary') return await handleShipmentSummary(body, user);
    // v2.51.0 (round 76) — professional performance report: companies +
    // sales experts + 12-month Jalali trend + KPIs (PDF export backing).
    if (action === 'performance-center') return await handlePerformanceCenter(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('reports', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  SALES SUMMARY — monthly sales data for charts
// ════════════════════════════════════════════════════════
async function handleSalesSummary(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  // v2.15.0 (sixth-round audit, item 7): the report year is a JALALI year.
  // Previously the window was the Gregorian calendar year while the chart
  // labels were Jalali month names — January was rendered «فروردین» and the
  // month order followed the Gregorian calendar. The window now spans
  // Farvardin 1 → end of Esfand and each document is grouped by its REAL
  // Jalali month, so labels, grouping and ordering all agree.
  // v2.18.0 (ninth-round audit) — the on-screen period selector
  // (daily/weekly/monthly/yearly) used to be purely cosmetic. The sales
  // summary now accepts a `period`; the DEFAULT (no period / 'monthly')
  // keeps the exact v2.15.0 contract: current Jalali year grouped by real
  // Jalali month, Farvardin-first.
  const { year, period } = body as { year?: number; period?: string };

  // v2.12.0: tenant isolation — sales aggregates are scoped to the user's
  // companies (documents without a center are not attributable and are
  // admin-only, consistent with the accounting cartable semantics).
  const allowed = await getAllowedCompanyIds(user);

  if (period === 'daily' || period === 'weekly' || period === 'yearly') {
    return await handleSalesSummaryWindowed(period, user, allowed);
  }

  const targetYear = year || currentJalaliYear();
  const { start: yearStart, end: yearEnd } = jalaliYearWindow(targetYear);

  const salesDocuments = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      status: 'approved',
      ...docCenterScope(user, allowed),
      issuedAt: {
        gte: yearStart,
        lte: yearEnd,
      },
    },
    select: {
      issuedAt: true,
      finalAmount: true,
      documentType: true,
      documentNumber: true,
    },
  });

  // v2.14.0 — purchase double-count guard: skip approved proformas whose
  // invoice was derived (the derived invoice already carries the sale);
  // legacy proformas without a derived invoice still count.
  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  // Group by Jalali month (1 = Farvardin … 12 = Esfand), ordered Farvardin-first
  const monthlyData: Record<number, { month: string; total: number; invoices: number; returns: number }> = {};
  for (let jm = 1; jm <= 12; jm++) {
    monthlyData[jm] = { month: jalaliMonthName(jm), total: 0, invoices: 0, returns: 0 };
  }

  for (const doc of salesDocuments) {
    if (!doc.issuedAt) continue;
    const [jy, jm] = gregorianToJalali(
      doc.issuedAt.getUTCFullYear(),
      doc.issuedAt.getUTCMonth() + 1,
      doc.issuedAt.getUTCDate(),
    );
    if (jy !== targetYear || !monthlyData[jm]) continue;
    if (doc.documentType === 'return') {
      monthlyData[jm].returns += doc.finalAmount;
    } else if (countsAsPurchase(doc, proformasWithInvoice)) {
      monthlyData[jm].total += doc.finalAmount;
      monthlyData[jm].invoices += 1;
    }
  }

  const chartData = Object.values(monthlyData).map((d) => ({
    month: d.month,
    sales: Math.round(d.total),
    invoices: d.invoices,
    returns: Math.round(d.returns),
  }));

  const totalSales = chartData.reduce((sum, d) => sum + d.sales, 0);
  const totalReturns = chartData.reduce((sum, d) => sum + d.returns, 0);

  return NextResponse.json({
    year: targetYear,
    chartData,
    summary: { totalSales, totalReturns, netSales: totalSales - totalReturns },
  });
}

// ════════════════════════════════════════════════════════
//  TOP CENTERS — by sales amount
// ════════════════════════════════════════════════════════
async function handleTopCenters(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const { limit = 10, year } = body as { limit?: number; year?: number };
  // v2.15.0: Jalali year window (see handleSalesSummary) — «امسال» for a
  // Persian-calendar user means the current Jalali year.
  const targetYear = year || currentJalaliYear();
  const { start: yearStart, end: yearEnd } = jalaliYearWindow(targetYear);

  // v2.12.0: tenant isolation — top centers are restricted to the user's
  // companies.
  const topAllowed = await getAllowedCompanyIds(user);

  // v2.14.0 — purchase double-count guard: replaced the raw groupBy (which
  // counted an approved proforma AND its derived invoice as two purchases)
  // with an in-memory aggregation that skips proformas whose invoice was
  // derived. Legacy proformas without a derived invoice still count.
  const docs = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      status: 'approved',
      documentType: { in: ['proforma', 'invoice'] },
      centerId: { not: null },
      ...docCenterScope(user, topAllowed),
      issuedAt: {
        gte: yearStart,
        lte: yearEnd,
      },
    },
    select: { centerId: true, documentType: true, documentNumber: true, finalAmount: true },
  });

  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();
  const perCenter = new Map<string, { total: number; count: number }>();
  for (const d of docs) {
    if (!d.centerId) continue;
    if (!countsAsPurchase(d, proformasWithInvoice)) continue;
    const entry = perCenter.get(d.centerId) || { total: 0, count: 0 };
    entry.total += d.finalAmount || 0;
    entry.count += 1;
    perCenter.set(d.centerId, entry);
  }

  const topCenters = [...perCenter.entries()]
    .map(([centerId, v]) => ({ centerId, _sum: { finalAmount: v.total }, _count: { id: v.count } }))
    .sort((a, b) => b._sum.finalAmount - a._sum.finalAmount)
    .slice(0, Math.max(1, Number(limit) || 10));

  const centerIds = topCenters.map((c) => c.centerId).filter(Boolean) as string[];
  const centers = await db.center.findMany({
    where: { id: { in: centerIds } },
    select: { id: true, name: true, province: true },
  });

  const centerMap = Object.fromEntries(centers.map((c) => [c.id, c]));

  const chartData = topCenters.map((c) => {
    const cid = c.centerId ?? '';
    return {
      centerId: c.centerId,
      centerName: centerMap[cid]?.name || 'نامشخص',
      province: centerMap[cid]?.province || '',
      totalSales: Math.round(c._sum.finalAmount || 0),
      documentCount: c._count.id,
    };
  });

  return NextResponse.json({ year: targetYear, chartData });
}

// ════════════════════════════════════════════════════════
//  ACTIVITY REPORT — by user
// ════════════════════════════════════════════════════════
async function handleActivityReport(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const { dateFrom, dateTo } = body as { dateFrom?: string; dateTo?: string };

  const where: Record<string, unknown> = { businessUnitId: user.businessUnitId };

  // v2.31.2: owner-aware tenant isolation (round-30 leak fix) — center-less
  // activities of OTHER companies' users no longer inflate this report.
  Object.assign(where, await ownerScopedCenterWhere(user));

  // v2.36.0 — sales territory: the activity report follows the expert's
  // territory (their centers + their own center-less rows).
  const actTerritory = resolveTerritoryScope(user);
  if (actTerritory) {
    where.AND = [...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []), activityTerritoryWhere(actTerritory, user.id)];
  }

  if (dateFrom || dateTo) {
    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) dateFilter.gte = new Date(dateFrom);
    if (dateTo) dateFilter.lte = new Date(dateTo);
    where.activityDate = dateFilter;
  }

  const activities = await db.activity.findMany({
    where,
    select: {
      assignedTo: true,
      status: true,
      isPhoneCall: true,
      createdById: true,
    },
  });

  // Group by assigned user
  const userStats: Record<string, { userId: string; total: number; done: number; pending: number; cancelled: number; phoneCalls: number }> = {};

  for (const a of activities) {
    const key = a.assignedTo || a.createdById || 'unassigned';
    if (!userStats[key]) {
      userStats[key] = { userId: key, total: 0, done: 0, pending: 0, cancelled: 0, phoneCalls: 0 };
    }
    userStats[key].total += 1;
    if (a.status === 'done') userStats[key].done += 1;
    if (a.status === 'pending') userStats[key].pending += 1;
    if (a.status === 'cancelled') userStats[key].cancelled += 1;
    if (a.isPhoneCall) userStats[key].phoneCalls += 1;
  }

  const userIds = Object.keys(userStats).filter((k) => k !== 'unassigned');
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true },
  });

  const userMap = Object.fromEntries(users.map((u) => [u.id, u.displayName]));

  const chartData = Object.values(userStats).map((s) => ({
    ...s,
    userName: userMap[s.userId] || 'نامشخص',
  }));

  chartData.sort((a, b) => b.total - a.total);

  return NextResponse.json({ chartData });
}

// ════════════════════════════════════════════════════════
//  INVENTORY REPORT — stock levels
// ════════════════════════════════════════════════════════
async function handleInventoryReport(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  // v2.12.0: tenant isolation — stock report is scoped to the user's
  // companies: serials tied to another company's centers are excluded,
  // unassigned warehouse stock remains visible. (InventorySerial has no
  // `center` relation — filter by center-id set.)
  const invScope = optionalCenterIdInWhere(
    await territoryVisibleCenterIds(user, await allowedCenterIds(await getAllowedCompanyIds(user))),
  );

  // Stock status overview
  const statusCounts = await db.inventorySerial.groupBy({
    by: ['status'],
    ...(invScope ? { where: invScope } : {}),
    _count: { id: true },
  });

  const statusMap = Object.fromEntries(statusCounts.map((s) => [s.status, s._count.id]));

  // Stock by product code
  const productStock = await db.inventorySerial.groupBy({
    by: ['productCode'],
    where: { status: 'available', ...(invScope ?? {}) },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  const productCodes = productStock.filter((p) => p.productCode).map((p) => p.productCode!);
  const products = await db.product.findMany({
    where: { code: { in: productCodes } },
    select: { code: true, name: true, price: true },
  });

  const productMap = Object.fromEntries(products.map((p) => [p.code, p]));

  const chartData = productStock.map((p) => ({
    productCode: p.productCode || 'بدون کد',
    productName: productMap[p.productCode || '']?.name || '—',
    price: productMap[p.productCode || '']?.price || 0,
    availableCount: p._count.id,
  }));

  const summary = {
    available: statusMap['available'] || 0,
    sold: statusMap['sold'] || 0,
    returned: statusMap['returned'] || 0,
    defective: statusMap['defective'] || 0,
    total: Object.values(statusMap).reduce((a, b) => a + b, 0),
  };

  return NextResponse.json({ summary, chartData });
}

// ════════════════════════════════════════════════════════
//  SALES SUMMARY (WINDOWED) — daily / weekly / yearly periods
//  v2.18.0 — the period selector is now real. Buckets:
//   • daily   → last 30 days, one bucket per UTC day
//   • weekly  → last 12 weeks (weeks start Saturday, Iranian week)
//   • yearly  → last 5 Jalali years
//  Labels are Jalali. Same tenant scope + purchase-eligibility
//  rules as the default monthly summary.
// ════════════════════════════════════════════════════════
async function handleSalesSummaryWindowed(
  period: 'daily' | 'weekly' | 'yearly',
  user: AuthUser,
  allowed: string[] | null,
) {
  const now = new Date();
  const nowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  // Bucket boundaries (UTC millisecond timestamps).
  const buckets: Array<{ start: number; end: number; label: string }> = [];

  if (period === 'daily') {
    for (let i = 29; i >= 0; i--) {
      const start = nowUtc - i * 86400000;
      const d = new Date(start);
      const [, jm, jd] = gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      buckets.push({
        start,
        end: start + 86400000,
        label: `${jd} ${jalaliMonthName(jm).slice(0, 3)}`,
      });
    }
  } else if (period === 'weekly') {
    // Iranian weeks start Saturday: JS getDay() Sat=6 → offset 0.
    const dayOfWeek = now.getUTCDay();
    const weekOffset = (dayOfWeek + 1) % 7;
    const thisWeekStart = nowUtc - weekOffset * 86400000;
    for (let i = 11; i >= 0; i--) {
      const start = thisWeekStart - i * 7 * 86400000;
      const d = new Date(start);
      const [, jm, jd] = gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      buckets.push({
        start,
        end: start + 7 * 86400000,
        label: `هفته ${jm}/${jd}`,
      });
    }
  } else {
    // yearly — last 5 Jalali years, Farvardin 1 → Esfand end.
    const currentYear = currentJalaliYear(now);
    for (let y = currentYear - 4; y <= currentYear; y++) {
      const { start, end } = jalaliYearWindow(y);
      buckets.push({ start: start.getTime(), end: end.getTime(), label: String(y) });
    }
  }

  const firstStart = Math.min(...buckets.map((b) => b.start));
  const lastEnd = Math.max(...buckets.map((b) => b.end));

  const salesDocuments = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      status: 'approved',
      ...docCenterScope(user, allowed),
      issuedAt: {
        gte: new Date(firstStart),
        lte: new Date(lastEnd),
      },
    },
    select: { issuedAt: true, finalAmount: true, documentType: true, documentNumber: true },
  });

  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  const rows = buckets.map((b) => ({
    month: b.label,
    sales: 0,
    invoices: 0,
    returns: 0,
  }));
  // index each doc into its bucket by binary position (buckets are ordered)
  const bucketIndex = (t: number) => {
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (t >= buckets[i].start && t < buckets[i].end) return i;
    }
    return -1;
  };

  for (const doc of salesDocuments) {
    if (!doc.issuedAt) continue;
    const t = doc.issuedAt.getTime();
    const idx = bucketIndex(t);
    if (idx < 0) continue;
    if (doc.documentType === 'return') {
      rows[idx].returns += doc.finalAmount;
    } else if (countsAsPurchase(doc, proformasWithInvoice)) {
      rows[idx].sales += doc.finalAmount;
      rows[idx].invoices += 1;
    }
  }

  const chartData = rows.map((r) => ({
    month: r.month,
    sales: Math.round(r.sales),
    invoices: r.invoices,
    returns: Math.round(r.returns),
  }));

  const totalSales = chartData.reduce((s, d) => s + d.sales, 0);
  const totalReturns = chartData.reduce((s, d) => s + d.returns, 0);

  return NextResponse.json({
    period,
    chartData,
    summary: { totalSales, totalReturns, netSales: totalSales - totalReturns },
  });
}

// ════════════════════════════════════════════════════════
//  PIPELINE SUMMARY — real document-stage funnel
//  v2.18.0 — the pipeline report tab used to render hardcoded
//  numbers (33 opportunities / 48.5B / 71% win rate / 28 days).
// ════════════════════════════════════════════════════════
async function handlePipelineSummary(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);

  // Return documents are not funnel opportunities — excluded.
  const docs = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      documentType: { not: 'return' },
      ...docCenterScope(user, allowed),
    },
    select: { documentType: true, status: true, finalAmount: true, createdAt: true, issuedAt: true },
  });

  const stageDefs = [
    { key: 'lead', label: 'سرنخ / پیش‌نویس' },
    { key: 'review', label: 'در انتظار تأیید' },
    { key: 'proforma', label: 'پیش‌فاکتور تأییدشده' },
    { key: 'invoice', label: 'فاکتور (موفق)' },
    { key: 'cancelled', label: 'لغو / رد شده' },
  ] as const;
  const stages: Record<string, { key: string; label: string; count: number; amount: number }> = {};
  for (const s of stageDefs) stages[s.key] = { key: s.key, label: s.label, count: 0, amount: 0 };

  let wonCount = 0;
  let lostCount = 0;
  let pipelineValue = 0;
  const closeDurations: number[] = [];

  for (const d of docs) {
    if (d.status === 'draft') {
      stages.lead.count += 1;
      stages.lead.amount += d.finalAmount;
      pipelineValue += d.finalAmount;
    } else if (d.status === 'pending_approval') {
      stages.review.count += 1;
      stages.review.amount += d.finalAmount;
      pipelineValue += d.finalAmount;
    } else if (d.status === 'cancelled' || d.status === 'rejected') {
      stages.cancelled.count += 1;
      stages.cancelled.amount += d.finalAmount;
      lostCount += 1;
    } else if (d.status === 'approved') {
      if (d.documentType === 'invoice') {
        stages.invoice.count += 1;
        stages.invoice.amount += d.finalAmount;
        wonCount += 1;
        if (d.issuedAt) {
          const days = (d.issuedAt.getTime() - d.createdAt.getTime()) / 86400000;
          if (Number.isFinite(days) && days >= 0) closeDurations.push(days);
        }
      } else {
        stages.proforma.count += 1;
        stages.proforma.amount += d.finalAmount;
        pipelineValue += d.finalAmount;
      }
    }
  }

  const stageList = stageDefs.map((s) => ({
    ...stages[s.key],
    amount: Math.round(stages[s.key].amount),
  }));

  // Stage-to-stage conversion over the LIVE funnel (cancelled excluded).
  const funnel = stageList.filter((s) => s.key !== 'cancelled');
  const conversion: Array<{ label: string; value: number }> = [];
  for (let i = 0; i + 1 < funnel.length; i++) {
    const from = funnel[i];
    const to = funnel[i + 1];
    const value = from.count > 0 ? Math.round((to.count / from.count) * 100) : 0;
    conversion.push({ label: `${from.label} ← ${to.label}`, value: Math.min(100, value) });
  }

  const winRate = wonCount + lostCount > 0 ? Math.round((wonCount / (wonCount + lostCount)) * 100) : 0;
  const avgCloseDays = closeDurations.length > 0
    ? Math.round(closeDurations.reduce((a, b) => a + b, 0) / closeDurations.length)
    : 0;

  return NextResponse.json({
    stages: stageList,
    conversion,
    kpis: {
      totalOpportunities: docs.length,
      pipelineValue: Math.round(pipelineValue),
      wonCount,
      lostCount,
      winRate,
      avgCloseDays,
    },
  });
}

// ════════════════════════════════════════════════════════
//  STAFF PERFORMANCE — per-creator document statistics
//  v2.18.0 — the staff report tab used to render five fake
//  employees with invented sales/win rates.
// ════════════════════════════════════════════════════════
async function handleStaffPerformance(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);

  const docs = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      documentType: { in: ['proforma', 'invoice'] },
      ...docCenterScope(user, allowed),
    },
    select: { createdById: true, documentType: true, documentNumber: true, status: true, finalAmount: true, centerId: true },
  });

  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  interface StaffStat {
    sales: number;
    orders: number;
    centers: Set<string>;
    pipeline: number;
    won: number;
    lost: number;
  }
  const stats = new Map<string, StaffStat>();
  const statOf = (id: string): StaffStat => {
    let s = stats.get(id);
    if (!s) {
      s = { sales: 0, orders: 0, centers: new Set(), pipeline: 0, won: 0, lost: 0 };
      stats.set(id, s);
    }
    return s;
  };

  for (const d of docs) {
    const id = d.createdById || '';
    const s = statOf(id);
    if (d.status === 'approved') {
      if (countsAsPurchase(d, proformasWithInvoice)) {
        s.sales += d.finalAmount;
        s.orders += 1;
      }
      if (d.centerId) s.centers.add(d.centerId);
      if (d.documentType === 'invoice') s.won += 1;
      else s.pipeline += 1;
    } else if (d.status === 'draft' || d.status === 'pending_approval') {
      s.pipeline += 1;
    } else if (d.status === 'cancelled' || d.status === 'rejected') {
      s.lost += 1;
    }
  }

  const userIds = [...stats.keys()].filter(Boolean);
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, roleLabel: true, jobTitle: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const chartData = [...stats.entries()]
    .filter(([id]) => userMap.has(id))
    // v2.43.1 (r68) — mapping goes through the SHARED contract builder
    // (src/lib/staff-perf.ts): the API and the UI tab now derive from one
    // type, so the old `userName`/`name` field-name drift that crashed
    // the tab cannot structurally recur.
    .map(([id, s]) => {
      const u = userMap.get(id)!;
      return buildStaffPerfRow({
        userId: id,
        displayName: u.displayName,
        jobTitle: u.jobTitle,
        roleLabel: u.roleLabel,
        sales: s.sales,
        orders: s.orders,
        centers: s.centers.size,
        pipeline: s.pipeline,
        won: s.won,
        lost: s.lost,
      });
    })
    .sort((a, b) => b.sales - a.sales);

  return NextResponse.json({ chartData });
}

// ════════════════════════════════════════════════════════
//  FINANCE SUMMARY — receivables / collection / cheques
//  v2.18.0 — the finance report tab used to render invented
//  receivables (723.6M), an invented collection ratio (87%)
//  and an invented monthly trend.
// ════════════════════════════════════════════════════════
async function handleFinanceSummary(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);
  const now = Date.now();

  // ── Issued invoices (same tenant scope as /api/billing list) ──
  // v2.58.0 (audit 85-c): invoices without a customer account (hand invoices
  // where مرکز was never picked, ~50.79M rial in live data) used to be
  // EXCLUDED for company-scoped users — their billed/paid totals silently
  // vanished from the collection report. Same optional-center semantics as
  // everywhere else: company-neutral rows stay visible.
  const invoices = await db.issuedInvoice.findMany({
    where: {
      status: { not: 'void' },
      ...(allowed !== null
        ? {
            OR: [
              { centerAccount: { center: { companyId: { in: allowed } } } },
              { centerAccountId: null },
            ],
          }
        : {}),
    },
    select: {
      status: true,
      totalAmount: true,
      paidAmount: true,
      issuedAt: true,
      payments: { select: { amount: true, paymentDate: true } },
    },
  });

  let receivables = 0;
  let collected = 0;
  const collectDurations: number[] = [];
  const { start: yearStart, end: yearEnd } = jalaliYearWindow(currentJalaliYear());
  const monthlyCollected: Record<number, number> = {};
  for (let jm = 1; jm <= 12; jm++) monthlyCollected[jm] = 0;

  for (const inv of invoices) {
    receivables += Math.max(0, inv.totalAmount - inv.paidAmount);
    collected += inv.paidAmount;

    if (inv.status === 'paid' && inv.issuedAt) {
      const lastPay = inv.payments
        .filter((p) => p.paymentDate)
        .map((p) => p.paymentDate!.getTime())
        .sort((a, b) => b - a)[0];
      if (lastPay) {
        const days = (lastPay - inv.issuedAt.getTime()) / 86400000;
        if (Number.isFinite(days) && days >= 0) collectDurations.push(days);
      }
    }

    for (const p of inv.payments) {
      if (!p.paymentDate) continue;
      const t = p.paymentDate.getTime();
      if (t >= yearStart.getTime() && t <= yearEnd.getTime()) {
        const [, jm] = gregorianToJalali(
          p.paymentDate.getUTCFullYear(),
          p.paymentDate.getUTCMonth() + 1,
          p.paymentDate.getUTCDate(),
        );
        if (monthlyCollected[jm] !== undefined) monthlyCollected[jm] += p.amount;
      }
    }
  }

  // ── Cheques from real document finance records ──
  const chequeMethods = ['cheque', 'check', 'چک', 'چک بانکی'];
  const financeRecords = await db.salesDocumentFinance.findMany({
    where: {
      paymentMethod: { in: chequeMethods },
      salesDocument: {
        businessUnitId: user.businessUnitId,
        ...docCenterScope(user, allowed),
      },
    },
    select: { amount: true, paymentDate: true },
  });

  let pendingChecks = 0;
  let pendingChecksCount = 0;
  let clearedChecks = 0;
  for (const f of financeRecords) {
    if (f.paymentDate && f.paymentDate.getTime() > now) {
      pendingChecks += f.amount;
      pendingChecksCount += 1;
    } else {
      clearedChecks += f.amount;
    }
  }

  const ratio = collected + receivables > 0
    ? Math.round((collected / (collected + receivables)) * 100)
    : 0;
  const avgCollectionDays = collectDurations.length > 0
    ? Math.round(collectDurations.reduce((a, b) => a + b, 0) / collectDurations.length)
    : 0;

  const monthly: Array<{ month: string; collected: number }> = [];
  for (let jm = 1; jm <= 12; jm++) {
    monthly.push({ month: jalaliMonthName(jm), collected: Math.round(monthlyCollected[jm]) });
  }

  return NextResponse.json({
    kpis: {
      receivables: Math.round(receivables),
      collected: Math.round(collected),
      collectionRatio: ratio,
      avgCollectionDays,
      pendingChecks: Math.round(pendingChecks),
      pendingChecksCount,
      clearedChecks: Math.round(clearedChecks),
    },
    monthly,
  });
}

// ════════════════════════════════════════════════════════
//  COMPANY COMPARE — approved purchases per company
//  v2.18.0 — the compare tab used to render invented
//  per-company sales (BGL 15.6B, Bazargani 12B, ...).
//  Non-admin users only see their own companies.
// ════════════════════════════════════════════════════════
async function handleCompanyCompare(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);

  const docs = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      status: 'approved',
      documentType: { in: ['proforma', 'invoice'] },
      centerId: { not: null },
      ...docCenterScope(user, allowed),
    },
    select: { documentType: true, documentNumber: true, finalAmount: true, center: { select: { companyId: true } } },
  });

  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  const perCompany = new Map<string, { sales: number; orders: number; centers: Set<string> }>();
  for (const d of docs) {
    const companyId = d.center?.companyId;
    if (!companyId) continue;
    if (!countsAsPurchase(d, proformasWithInvoice)) continue;
    let entry = perCompany.get(companyId);
    if (!entry) {
      entry = { sales: 0, orders: 0, centers: new Set() };
      perCompany.set(companyId, entry);
    }
    entry.sales += d.finalAmount;
    entry.orders += 1;
    // centers: distinct companies with at least one purchase
    entry.centers.add(companyId);
  }

  // Distinct active centers per company (companies with any center).
  const companyRows = await db.company.findMany({
    select: { id: true, name: true, slug: true, color: true },
  });
  const centerCounts = await db.center.groupBy({
    by: ['companyId'],
    _count: { id: true },
  });
  const centerCountMap = new Map(centerCounts.map((c) => [c.companyId, c._count.id]));

  const chartData = companyRows
    .filter((c) => perCompany.has(c.id))
    .map((c) => {
      const e = perCompany.get(c.id)!;
      return {
        companyId: c.id,
        companyName: c.name,
        slug: c.slug,
        color: c.color,
        sales: Math.round(e.sales),
        orders: e.orders,
        centers: centerCountMap.get(c.id) || 0,
      };
    })
    .sort((a, b) => b.sales - a.sales);

  return NextResponse.json({ chartData });
}

// ════════════════════════════════════════════════════════
//  PRODUCTION SUMMARY — shipments + purchase requests
//  v2.18.0 — the BGL «گزارش تولید» menu item used to fall
//  through to the sales-report tab; this action backs the
//  new production report tab (also suggested at the end of
//  the v2.17.0 round).
// ════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
//  SHIPMENT SUMMARY — v2.19.0 (tenth-round audit)
//  Dedicated delivery/return aggregation over SalesShipment records:
//  KPIs, status breakdown, carrier performance, Jalali monthly trend,
//  and the recent shipments table. Tenant-scoped like every report.
// ════════════════════════════════════════════════════════
async function handleShipmentSummary(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);

  const shipments = await db.salesShipment.findMany({
    where: {
      salesDocument: {
        businessUnitId: user.businessUnitId,
        ...docCenterScope(user, allowed),
      },
    },
    select: {
      id: true, shipmentNumber: true, status: true, carrierName: true,
      dispatchedAt: true, deliveredAt: true, createdAt: true,
      salesDocument: {
        select: {
          documentNumber: true,
          center: { select: { name: true, city: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // ── KPIs + status breakdown ──
  const statusCounts: Record<string, number> = {};
  const carrierMap = new Map<string, { total: number; delivered: number; returned: number; active: number }>();
  const deliveryDurations: number[] = [];

  for (const s of shipments) {
    statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
    if (s.deliveredAt && s.dispatchedAt) {
      const days = (s.deliveredAt.getTime() - s.dispatchedAt.getTime()) / 86400000;
      if (Number.isFinite(days) && days >= 0) deliveryDurations.push(days);
    }
    const carrier = (s.carrierName || '').trim() || 'نامشخص';
    const row = carrierMap.get(carrier) || { total: 0, delivered: 0, returned: 0, active: 0 };
    row.total++;
    if (s.status === 'delivered') row.delivered++;
    if (s.status === 'returned') row.returned++;
    if (s.status === 'preparing' || s.status === 'ready' || s.status === 'in-transit') row.active++;
    carrierMap.set(carrier, row);
  }

  const activeStatuses = ['preparing', 'ready', 'in-transit'];
  const active = activeStatuses.reduce((s, k) => s + (statusCounts[k] || 0), 0);
  const delivered = statusCounts['delivered'] || 0;
  const returned = statusCounts['returned'] || 0;
  const total = shipments.length;
  const avgDeliveryDays = deliveryDurations.length > 0
    ? Math.round((deliveryDurations.reduce((a, b) => a + b, 0) / deliveryDurations.length) * 10) / 10
    : 0;
  const returnRate = total > 0 ? Math.round((returned / total) * 100) : 0;

  // ── Jalali monthly trend (last 12 months by dispatch month) ──
  const now = new Date();
  const [cy, cm] = gregorianToJalali(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
  const monthly: Array<{ label: string; year: number; month: number; dispatched: number; delivered: number; returned: number }> = [];
  for (let i = 11; i >= 0; i--) {
    let y = cy, m = cm - i;
    while (m <= 0) { m += 12; y--; }
    monthly.push({ label: jalaliMonthName(m), year: y, month: m, dispatched: 0, delivered: 0, returned: 0 });
  }
  const monthKey = (d: Date) => {
    const [jy, jm] = gregorianToJalali(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    return jy * 12 + (jm - 1);
  };
  for (const s of shipments) {
    const basis = s.dispatchedAt || s.createdAt;
    const idx = monthKey(basis) - ((cy - 1) * 12 + (cm - 1)) + 11;
    if (idx >= 0 && idx < 12) {
      monthly[idx].dispatched++;
      if (s.status === 'delivered' && s.deliveredAt) {
        const didx = monthKey(s.deliveredAt) - ((cy - 1) * 12 + (cm - 1)) + 11;
        if (didx >= 0 && didx < 12) monthly[didx].delivered++;
      }
      if (s.status === 'returned') monthly[idx].returned++;
    }
  }

  // ── carriers, sorted by volume ──
  const carriers = [...carrierMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  // ── recent shipments (newest 15) ──
  const recent = shipments.slice(0, 15).map((s) => ({
    id: s.id,
    shipmentNumber: s.shipmentNumber,
    status: s.status,
    carrierName: s.carrierName,
    documentNumber: s.salesDocument?.documentNumber || '',
    centerName: s.salesDocument?.center?.name || 'بدون مرکز',
    city: s.salesDocument?.center?.city || '',
    dispatchedAt: s.dispatchedAt?.toISOString() || null,
    deliveredAt: s.deliveredAt?.toISOString() || null,
    createdAt: s.createdAt.toISOString(),
  }));

  return NextResponse.json({
    kpis: { total, active, delivered, returned, avgDeliveryDays, returnRate },
    statusBreakdown: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
    monthly,
    carriers,
    recent,
  });
}

async function handleProductionSummary(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const allowed = await getAllowedCompanyIds(user);

  const shipments = await db.salesShipment.findMany({
    where: {
      salesDocument: {
        businessUnitId: user.businessUnitId,
        ...docCenterScope(user, allowed),
      },
    },
    select: { status: true, dispatchedAt: true, deliveredAt: true },
  });

  const shipmentCounts: Record<string, number> = {};
  const deliveryDurations: number[] = [];
  for (const s of shipments) {
    shipmentCounts[s.status] = (shipmentCounts[s.status] || 0) + 1;
    if (s.deliveredAt && s.dispatchedAt) {
      const days = (s.deliveredAt.getTime() - s.dispatchedAt.getTime()) / 86400000;
      if (Number.isFinite(days) && days >= 0) deliveryDurations.push(days);
    }
  }

  const orderGroups = await db.productionPurchaseRequest.groupBy({
    by: ['status'],
    _count: { id: true },
  });

  const activeStatuses = ['preparing', 'ready', 'in-transit'];
  const activeShipments = activeStatuses.reduce((s, k) => s + (shipmentCounts[k] || 0), 0);

  const avgDeliveryDays = deliveryDurations.length > 0
    ? Math.round(deliveryDurations.reduce((a, b) => a + b, 0) / deliveryDurations.length)
    : 0;

  return NextResponse.json({
    shipments: Object.entries(shipmentCounts).map(([status, count]) => ({ status, count })),
    shipmentKpis: {
      total: shipments.length,
      active: activeShipments,
      delivered: shipmentCounts['delivered'] || 0,
      returned: shipmentCounts['returned'] || 0,
      avgDeliveryDays,
    },
    orders: orderGroups.map((g) => ({ status: g.status, count: g._count.id })),
  });
}

// ══════════════════════════════════════════════════════════
//  PERFORMANCE CENTER — v2.51.0 (round 76)
//  «مرکز گزارش حرفه‌ای» — one aggregate powering BOTH screens of the
//  professional report UI (companies tab + experts tab) and its PDF
//  export. All numbers derive from the same purchase double-count
//  guard as every other report (countsAsPurchase); the 12-month
//  Jalali trend is ALWAYS unfiltered context (the period selector
//  only filters KPIs/tables), so the manager sees the long trend
//  regardless of the selected window.
// ══════════════════════════════════════════════════════════
async function handlePerformanceCenter(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  // ── period (rolling window; default all-time) ──
  const rawMonths: unknown = body.months ?? null;
  const months = (PERIOD_MONTHS_OPTIONS as readonly unknown[]).includes(rawMonths)
    ? (rawMonths as PeriodMonths)
    : null;
  const { from, to } = periodWindow(months);

  const allowed = await getAllowedCompanyIds(user);

  // ── sales documents (scoped, fetched unfiltered — window applied in
  // memory so the SAME rows feed the period KPIs AND the 12-month trend) ──
  const docs = await db.salesDocument.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      documentType: { in: ['proforma', 'invoice'] },
      ...docCenterScope(user, allowed),
    },
    select: {
      createdById: true, documentType: true, documentNumber: true, status: true,
      finalAmount: true, centerId: true, issuedAt: true, createdAt: true,
      center: { select: { companyId: true } },
    },
  });

  // approved stats live on issuedAt (set at approval); drafts/pending keep
  // their creation time — the window therefore never silently drops a
  // pipeline row that was created inside the period.
  const inWindow = (issuedAt: Date | null, createdAt: Date, status: string): boolean => {
    if (!from) return true;
    if (status === 'approved') return !!issuedAt && issuedAt >= from && issuedAt <= to;
    return createdAt >= from && createdAt <= to;
  };

  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  // ── per-company aggregation (windowed, approved purchases only) ──
  interface CompanyAgg { sales: number; orders: number; centers: Set<string>; }
  const perCompany = new Map<string, CompanyAgg>();
  // ── per-expert aggregation (windowed, same semantics as staff-perf) ──
  interface ExpertAgg {
    sales: number; orders: number; centers: Set<string>;
    pipeline: number; won: number; lost: number;
  }
  const perExpert = new Map<string, ExpertAgg>();
  const activeCenterIds = new Set<string>();

  for (const d of docs) {
    const companyId = d.center?.companyId;
    const isPurchase = d.status === 'approved' && countsAsPurchase(d, proformasWithInvoice);

    // window filter for the period aggregates
    if (inWindow(d.issuedAt, d.createdAt, d.status)) {
      if (isPurchase) {
        if (companyId) {
          let c = perCompany.get(companyId);
          if (!c) { c = { sales: 0, orders: 0, centers: new Set() }; perCompany.set(companyId, c); }
          c.sales += d.finalAmount;
          c.orders += 1;
          if (d.centerId) c.centers.add(d.centerId);
        }
        if (d.centerId) activeCenterIds.add(d.centerId);
      }
      const eid = d.createdById || '';
      if (eid) {
        let s = perExpert.get(eid);
        if (!s) { s = { sales: 0, orders: 0, centers: new Set(), pipeline: 0, won: 0, lost: 0 }; perExpert.set(eid, s); }
        if (isPurchase) {
          s.sales += d.finalAmount;
          s.orders += 1;
          if (d.centerId) s.centers.add(d.centerId);
        }
        if (d.status === 'approved') {
          if (d.documentType === 'invoice') s.won += 1;
          else s.pipeline += 1;
        } else if (d.status === 'draft' || d.status === 'pending_approval') {
          s.pipeline += 1;
        } else if (d.status === 'cancelled' || d.status === 'rejected') {
          s.lost += 1;
        }
      }
    }
  }

  // ── 12-month Jalali trend (UNFILTERED by period — long context) ──
  const buckets = last12JalaliMonthBuckets();
  const trend: TrendPoint[] = buckets.map((b) => ({ label: b.label, jy: b.jy, jm: b.jm, total: 0, byCompany: {} }));
  for (const d of docs) {
    if (d.status !== 'approved' || !d.issuedAt) continue;
    if (!countsAsPurchase(d, proformasWithInvoice)) continue;
    const idx = trendBucketIndex(buckets, d.issuedAt);
    if (idx < 0) continue;
    const companyId = d.center?.companyId;
    if (!companyId) continue;
    trend[idx].total += d.finalAmount;
    trend[idx].byCompany[companyId] = (trend[idx].byCompany[companyId] || 0) + d.finalAmount;
  }

  // ── activities (performed calls/visits, windowed, same scoping as the
  // activity report: business unit + owner-aware center scope + territory) ──
  const actWhere: Record<string, unknown> = {
    businessUnitId: user.businessUnitId,
    status: 'done',
  };
  Object.assign(actWhere, await ownerScopedCenterWhere(user));
  const actTerritory = resolveTerritoryScope(user);
  if (actTerritory) {
    actWhere.AND = [...(Array.isArray(actWhere.AND) ? (actWhere.AND as unknown[]) : []), activityTerritoryWhere(actTerritory, user.id)];
  }
  if (from) {
    actWhere.activityDate = { gte: from, lte: to };
  }
  const activities = await db.activity.findMany({
    where: actWhere,
    select: { assignedTo: true, createdById: true, isPhoneCall: true, isOnsiteVisit: true },
  });

  const actByUser = new Map<string, { calls: number; visits: number }>();
  for (const a of activities) {
    const uid = a.assignedTo || a.createdById || '';
    if (!uid) continue;
    let row = actByUser.get(uid);
    if (!row) { row = { calls: 0, visits: 0 }; actByUser.set(uid, row); }
    if (a.isPhoneCall) row.calls += 1;
    if (a.isOnsiteVisit) row.visits += 1;
  }

  // ── company rows (scope: user's companies minus the holding parent;
  // isolated companies appear only when explicitly inside the scope) ──
  const companyRows = await db.company.findMany({
    select: { id: true, name: true, slug: true, color: true },
  });
  const inScope = (slug: string): boolean => {
    if (allowed !== null) return allowed.includes(companyRows.find((c) => c.slug === slug)?.id || '');
    return slug !== 'holding' && !ISOLATED_COMPANY_SLUGS.includes(slug as never);
  };
  const companies: CompanyPerfRow[] = companyRows
    .filter((c) => {
      if (c.slug === 'holding') return false; // parent oversight entity — never a sales row
      return inScope(c.slug);
    })
    .map((c) => {
      const agg = perCompany.get(c.id) || { sales: 0, orders: 0, centers: new Set<string>() as Set<string> };
      return {
        companyId: c.id,
        name: c.name,
        slug: c.slug,
        color: c.color,
        sales: Math.round(agg.sales),
        orders: agg.orders,
        centers: agg.centers.size,
        avgDeal: agg.orders > 0 ? Math.round(agg.sales / agg.orders) : 0,
        share: 0,
      };
    })
    .sort((a, b) => b.sales - a.sales);

  const totalSales = companies.reduce((s, c) => s + c.sales, 0);
  const totalOrders = companies.reduce((s, c) => s + c.orders, 0);
  for (const c of companies) {
    c.share = totalSales > 0 ? Math.round((c.sales / totalSales) * 100) : 0;
  }

  // ── expert rows (union: creators of scoped docs + owners of scoped
  // activities, both inside the window) ──
  const expertIds = new Set<string>([...perExpert.keys(), ...actByUser.keys()]);
  const users = expertIds.size > 0
    ? await db.user.findMany({
        where: { id: { in: [...expertIds] } },
        select: { id: true, displayName: true, roleLabel: true, jobTitle: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const experts: ExpertPerfRow[] = [...expertIds]
    .filter((id) => userMap.has(id))
    .map((id) => {
      const u = userMap.get(id)!;
      const s = perExpert.get(id) || { sales: 0, orders: 0, centers: new Set<string>(), pipeline: 0, won: 0, lost: 0 };
      const a = actByUser.get(id) || { calls: 0, visits: 0 };
      return buildExpertPerfRow({
        userId: id,
        displayName: u.displayName,
        jobTitle: u.jobTitle,
        roleLabel: u.roleLabel,
        sales: s.sales,
        orders: s.orders,
        centers: s.centers.size,
        pipeline: s.pipeline,
        won: s.won,
        lost: s.lost,
      }, a.calls, a.visits);
    })
    .sort((a, b) => b.sales - a.sales || b.calls - a.calls);

  // ── KPIs ──
  const winRateRows = experts.filter((e) => {
    const s = perExpert.get(e.userId);
    return s && s.won + s.lost > 0;
  });
  const avgWinRate = winRateRows.length > 0
    ? Math.round(winRateRows.reduce((s, e) => s + e.winRate, 0) / winRateRows.length)
    : 0;
  const totalCalls = experts.reduce((s, e) => s + e.calls, 0);
  const totalVisits = experts.reduce((s, e) => s + e.visits, 0);

  return NextResponse.json({
    period: {
      months,
      label: periodLabel(months),
      fromISO: from ? from.toISOString() : null,
      toISO: to.toISOString(),
    },
    kpis: {
      totalSales: Math.round(totalSales),
      totalOrders,
      activeCenters: activeCenterIds.size,
      companiesWithSales: companies.filter((c) => c.sales > 0).length,
      expertCount: experts.length,
      avgWinRate,
      avgDealSize: totalOrders > 0 ? Math.round(totalSales / totalOrders) : 0,
      totalCalls,
      totalVisits,
    },
    companies,
    monthlyTrend: trend,
    experts,
    generatedAt: new Date().toISOString(),
  });
}
