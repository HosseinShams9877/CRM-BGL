import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import {
  getAllowedCompanyIds, centerCompanyWhere, centerInCompanyScope,
} from '@/lib/company-scope';
import { proformaNumbersWithDerivedInvoice, countsAsPurchase } from '@/lib/sales-metrics';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import { resolveTerritoryScope, centerTerritoryWhere, centerInTerritory } from '@/lib/territory-scope';

// ═══ v2.58.3 (round 88, finding 1) — SALES TERRITORY on the loyalty club.
// A scoped expert sees/manages only the points of their territory's
// centers. centerTerritoryWhere is the canonical Center-model fragment
// (provinces mode filters via the center relation; centers mode via id).
// Admin / finance / production / country-mode: unaffected.

// ════════════════════════════════════════════════════════════════
//  LOYALTY API — باشگاه مشتریان
//  تراکنش‌های امتیاز، امتیازدهی/کسر دستی، گزارش مشتریان برتر
//  امتیاز مثبت = کسب | منفی = استفاده
// ════════════════════════════════════════════════════════════════

const POINTS_REASONS = ['purchase', 'redeem', 'manual', 'referral', 'adjustment', 'good_payer_bonus'];

function safePoints(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.max(-1000000, Math.min(1000000, n));
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list-transactions') return await handleListTransactions(body, user);
    if (action === 'add-points') return await handleAddPoints(body, user);
    if (action === 'top-customers') return await handleTopCustomers(body, user);
    if (action === 'stats') return await handleStats(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('loyalty', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── 1. LIST TRANSACTIONS — دفتر امتیازها (همه یا یک مشتری) ──
async function handleListTransactions(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده باشگاه مشتریان را ندارید.' }, { status: 403 });
  }

  const { centerId, limit = 50 } = body as { centerId?: string; limit?: number };
  const take = Math.max(1, Math.min(Number(limit) || 50, 200));

  // v2.12.0: tenant isolation — transactions are scoped to the user's
  // companies (the previous businessUnitId filter is unit-wide and isolates
  // nothing: every user is in the same unit).
  const allowed = await getAllowedCompanyIds(user);

  const where: Record<string, unknown> = {};
  if (centerId) {
    // Verify the center belongs to the user's company scope
    const center = await db.center.findFirst({
      where: { id: centerId },
      select: { id: true, province: true },
    });
    if (!center || !(await centerInCompanyScope(centerId, allowed))) {
      return NextResponse.json({ error: 'مشتری یافت نشد.' }, { status: 404 });
    }
    // v2.58.3 — the requested center must ALSO sit inside the expert's
    // sales territory (404 — no existence leak).
    if (!centerInTerritory(center, resolveTerritoryScope(user))) {
      return NextResponse.json({ error: 'مشتری یافت نشد.' }, { status: 404 });
    }
    where.centerId = centerId;
  } else {
    where.center = centerCompanyWhere(allowed);
    // v2.58.3 — territory narrows the whole ledger: the Center-model
    // fragment must ride the center RELATION (nested), composed with
    // the company fragment via AND.
    const tFragment = centerTerritoryWhere(resolveTerritoryScope(user));
    if (tFragment) {
      where.AND = [
        ...(Array.isArray(where.AND) ? (where.AND as unknown[]) : []),
        { center: tFragment as unknown as Record<string, unknown> },
      ];
    }
  }

  const transactions = await db.loyaltyTransaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      center: { select: { id: true, name: true, customerType: true } },
    },
  });

  return NextResponse.json({ success: true, data: transactions });
}

// ── 2. ADD POINTS — امتیازدهی دستی (مثبت) یا کسر (منفی) ──
async function handleAddPoints(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.edit_centers && !perms.finance_write) {
    return NextResponse.json({ error: 'شما دسترسی مدیریت امتیازها را ندارید.' }, { status: 403 });
  }

  const { centerId, points, reason, note, documentNumber } = body as {
    centerId?: string;
    points?: number;
    reason?: string;
    note?: string;
    documentNumber?: string;
  };

  if (!centerId) {
    return NextResponse.json({ error: 'شناسه مشتری الزامی است.' }, { status: 400 });
  }
  const p = safePoints(points);
  if (p === 0) {
    return NextResponse.json({ error: 'امتیاز باید عددی غیرصفر باشد.' }, { status: 400 });
  }

  // v2.12.0: tenant isolation — center must be in the user's company scope
  // v2.21.0: the scope fragment is resolved once here and re-applied to the
  // LIVE re-read inside the transaction below.
  const scopeWhere = centerCompanyWhere(await getAllowedCompanyIds(user)) ?? {};
  const center = await db.center.findFirst({
    where: { id: centerId, ...scopeWhere },
    select: { id: true, name: true, loyaltyPoints: true, province: true },
  });
  if (!center) {
    return NextResponse.json({ error: 'مشتری یافت نشد.' }, { status: 404 });
  }
  // v2.58.3 — manual points only for centers inside the expert's sales
  // territory (fail-closed write).
  if (!centerInTerritory(center, resolveTerritoryScope(user))) {
    return NextResponse.json({ error: 'مشتری یافت نشد.' }, { status: 404 });
  }

  const reasonValue = typeof reason === 'string' && POINTS_REASONS.includes(reason) ? reason : 'manual';

  // v2.21.0 — the balance check and the write used to happen in two steps
  // (read outside, write an ABSOLUTE value inside a batch transaction), so
  // two concurrent redeems both read the same balance, both passed the
  // negative check and both overwrote each other: a customer could redeem
  // the same points twice and end up NEGATIVE. The row is now re-read LIVE
  // inside the transaction (SQLite serialises writers) — exactly one
  // concurrent writer wins; latecomers get the CURRENT balance in the error.
  const result = await db.$transaction(async (tx) => {
    const live = await tx.center.findFirst({
      where: { id: centerId, ...scopeWhere },
      select: { id: true, loyaltyPoints: true },
    });
    if (!live) throw new ApiError(404, 'مشتری یافت نشد.');

    const newBalance = live.loyaltyPoints + p;
    if (newBalance < 0) {
      throw new ApiError(
        400,
        `امتیاز فعلی مشتری ${live.loyaltyPoints} است؛ کسر ${Math.abs(p)} ممکن نیست.`,
      );
    }

    const transaction = await tx.loyaltyTransaction.create({
      data: {
        centerId,
        points: p,
        reason: reasonValue,
        note: note?.trim() || '',
        documentNumber: documentNumber?.trim() || null,
        createdById: user.id,
        createdByName: user.displayName,
      },
    });
    await tx.center.update({
      where: { id: centerId },
      data: { loyaltyPoints: newBalance, updatedBy: user.id },
    });
    return { transaction, newBalance };
  });

  return NextResponse.json({
    success: true,
    message: p > 0 ? `${p} امتیاز به مشتری اضافه شد.` : `${Math.abs(p)} امتیاز کسر شد.`,
    data: result,
  });
}

// ── 3. TOP CUSTOMERS — گزارش مشتریان برتر باشگاه ──
// بیشترین خرید ریالی، بیشترین تناوب خرید، آخرین خرید (تازگی)، امتیاز
async function handleTopCustomers(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_reports && !perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده گزارشات را ندارید.' }, { status: 403 });
  }

  const { year, limit = 50 } = body as { year?: number; limit?: number };
  const take = Math.max(1, Math.min(Number(limit) || 50, 200));

  // v2.12.0: tenant isolation — the whole report is scoped to the user's
  // companies (documents via their center, profiles via companyId).
  const topAllowed = await getAllowedCompanyIds(user);

  const docWhere: Record<string, unknown> = {
    status: 'approved',
    documentType: { in: ['proforma', 'invoice'] },
    centerId: { not: null },
    ...(topAllowed !== null ? { center: centerCompanyWhere(topAllowed) } : {}),
  };
  // v2.58.3 — the whole report is additionally narrowed to the expert's
  // sales territory (composed with the company fragment above).
  const topTerritory = centerTerritoryWhere(resolveTerritoryScope(user));
  if (topTerritory) {
    docWhere.AND = [
      ...(Array.isArray(docWhere.AND) ? (docWhere.AND as unknown[]) : []),
      topTerritory as unknown as Record<string, unknown>,
    ];
  }
  if (year) {
    docWhere.issuedAt = {
      gte: new Date(`${year}-01-01`),
      lte: new Date(`${year}-12-31T23:59:59`),
    };
  }

  // Aggregate purchases per center (amount + frequency + recency)
  const documents = await db.salesDocument.findMany({
    where: docWhere,
    select: {
      centerId: true, documentType: true, documentNumber: true,
      finalAmount: true, issuedAt: true, createdAt: true,
    },
  });

  // v2.14.0 — purchase double-count guard: an approved proforma whose
  // invoice has been derived must not be counted again on top of the
  // derived invoice (the same purchase would sum twice).
  const proformasWithInvoice = await proformaNumbersWithDerivedInvoice();

  const agg = new Map<string, { totalAmount: number; count: number; lastPurchase: Date | null }>();
  for (const d of documents) {
    if (!d.centerId) continue;
    if (!countsAsPurchase(d, proformasWithInvoice)) continue;
    const entry = agg.get(d.centerId) || { totalAmount: 0, count: 0, lastPurchase: null };
    entry.totalAmount += d.finalAmount || 0;
    entry.count += 1;
    const dt = d.issuedAt || d.createdAt;
    if (dt && (!entry.lastPurchase || dt > entry.lastPurchase)) entry.lastPurchase = dt;
    agg.set(d.centerId, entry);
  }

  // Load center profiles (points, payment behavior, type, segment)
  const centers = await db.center.findMany({
    where: {
      isArchived: false,
      // v2.12.0: tenant isolation
      ...(centerCompanyWhere(topAllowed) ?? {}),
      // v2.58.3 — same territory narrowing as the purchase aggregation
      ...(centerTerritoryWhere(resolveTerritoryScope(user)) ?? {}),
    },
    select: {
      id: true, name: true, province: true, city: true, mobile: true,
      customerType: true, segment: true, loyaltyPoints: true,
      paymentBehavior: true, creditScore: true, createdAt: true,
    },
  });

  const now = Date.now();
  const rows = centers.map((c) => {
    const a = agg.get(c.id) || { totalAmount: 0, count: 0, lastPurchase: null };
    const daysSince = a.lastPurchase ? Math.floor((now - a.lastPurchase.getTime()) / 86400000) : null;
    // امتیاز وفاداری ترکیبی = امتیاز باشگاه + سهم خرید و تناوب (فقط برای رتبه‌بندی)
    const loyaltyIndex = c.loyaltyPoints + Math.round(a.totalAmount / 1000000) + a.count * 5;
    return {
      centerId: c.id,
      name: c.name,
      province: c.province || '',
      city: c.city || '',
      mobile: c.mobile || '',
      customerType: c.customerType,
      segment: c.segment,
      loyaltyPoints: c.loyaltyPoints,
      paymentBehavior: c.paymentBehavior,
      creditScore: c.creditScore,
      totalAmount: Math.round(a.totalAmount),
      purchaseCount: a.count,
      lastPurchase: a.lastPurchase,
      daysSinceLastPurchase: daysSince,
      loyaltyIndex,
      // متوسط هر خرید
      avgPurchase: a.count > 0 ? Math.round(a.totalAmount / a.count) : 0,
    };
  });

  // نماهای گزارش: بیشترین خرید / بیشترین تناوب / وفادارترین
  const byAmount = [...rows].filter((r) => r.totalAmount > 0).sort((a, b) => b.totalAmount - a.totalAmount).slice(0, take);
  const byFrequency = [...rows].filter((r) => r.purchaseCount > 0).sort((a, b) => b.purchaseCount - a.purchaseCount).slice(0, take);
  const byLoyalty = [...rows].sort((a, b) => b.loyaltyIndex - a.loyaltyIndex).slice(0, take);

  // خوش‌حساب‌ها و بدحساب‌ها
  const goodPayers = rows.filter((r) => r.paymentBehavior === 'good_payer');
  const badPayers = rows.filter((r) => r.paymentBehavior === 'bad_payer');

  return NextResponse.json({
    success: true,
    data: {
      byAmount,
      byFrequency,
      byLoyalty,
      goodPayers: goodPayers.slice(0, take),
      badPayers: badPayers.slice(0, take),
      summary: {
        totalCustomers: rows.length,
        activeBuyers: rows.filter((r) => r.purchaseCount > 0).length,
        totalPoints: rows.reduce((s, r) => s + r.loyaltyPoints, 0),
        goodPayers: goodPayers.length,
        badPayers: badPayers.length,
        individuals: rows.filter((r) => r.customerType === 'end_user').length,
        organizations: rows.filter((r) => r.customerType === 'organization').length,
      },
    },
  });
}

// ── 4. STATS ──
async function handleStats(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده باشگاه مشتریان را ندارید.' }, { status: 403 });
  }

  const buId = user.businessUnitId;
  // v2.12.0: tenant isolation — all aggregates scoped to the user's companies
  const statsAllowed = await getAllowedCompanyIds(user);
  const centerScope = centerCompanyWhere(statsAllowed);
  // v2.58.3 — stats honor the sales territory (same fragment as the ledger)
  const statsTerritory = centerTerritoryWhere(resolveTerritoryScope(user));
  const scopedCenter = centerScope && statsTerritory
    ? { AND: [centerScope, statsTerritory as unknown as Record<string, unknown>] }
    : centerScope ?? (statsTerritory as unknown as Record<string, unknown> | undefined);
  const [totalPointsIssued, totalPointsRedeemed, memberCount, transactionCount] = await Promise.all([
    db.loyaltyTransaction.aggregate({
      where: { ...(scopedCenter ? { center: scopedCenter } : { center: { businessUnitId: buId } }), points: { gt: 0 } },
      _sum: { points: true },
    }),
    db.loyaltyTransaction.aggregate({
      where: { ...(scopedCenter ? { center: scopedCenter } : { center: { businessUnitId: buId } }), points: { lt: 0 } },
      _sum: { points: true },
    }),
    db.center.count({
      where: { isArchived: false, loyaltyPoints: { gt: 0 }, ...(scopedCenter ?? {}) },
    }),
    db.loyaltyTransaction.count({
      where: scopedCenter ? { center: scopedCenter } : { center: { businessUnitId: buId } },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: {
      totalPointsIssued: totalPointsIssued._sum.points || 0,
      totalPointsRedeemed: Math.abs(totalPointsRedeemed._sum.points || 0),
      memberCount,
      transactionCount,
    },
  });
}
