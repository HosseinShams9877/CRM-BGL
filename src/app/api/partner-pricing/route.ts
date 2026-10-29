import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { resolveTier, tierDiscountPercent } from '@/lib/business-model';
import { logApiError } from '@/lib/logger';
import { assertConcurrencyToken } from '@/lib/concurrency';
import { parseIntRial } from '@/lib/money';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
// v2.58.7 — the central policy layer (stage 1) supplies BOTH the
// permission gate and the company scope this route previously lacked.
import { assertPermission, companyScopeOf } from '@/lib/access-policy';

// ════════════════════════════════════════════════════════════════
//  PARTNER PRICING API — لیست قیمت همکاران (بازرگانی B2B)
//  قیمت عمده/پلکانی به ازای هر محصول + درصد کمیسیون همکار
//  resolve: انتخاب بهترین پلکان برای (محصول، تعداد، مشتری همکار)
// ════════════════════════════════════════════════════════════════

function safeFloat(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'resolve') return await handleResolve(body, user);
    if (action === 'stats') return await handleStats(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('partner-pricing', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ── 1. LIST — همهٔ قواعد قیمت (گروه‌بندی بر اساس محصول در UI) ──
async function handleList(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده لیست قیمت همکاران را ندارید.' }, { status: 403 });
  }

  const rules = await db.partnerPrice.findMany({
    orderBy: [{ productCode: 'asc' }, { minQty: 'asc' }],
  });

  // اضافه‌کردن نام محصول برای نمایش
  const productCodes = [...new Set(rules.map((r) => r.productCode))];
  const products = await db.product.findMany({
    where: { code: { in: productCodes } },
    select: { code: true, name: true, price: true, unit: true },
  });
  const productMap = Object.fromEntries(products.map((p) => [p.code, p]));

  const data = rules.map((r) => ({
    ...r,
    productName: productMap[r.productCode]?.name || r.productCode,
    publicPrice: productMap[r.productCode]?.price || 0,
    unit: productMap[r.productCode]?.unit || 'عدد',
  }));

  return NextResponse.json({ success: true, data });
}

// ── 2. CREATE — ردیف قیمت جدید ──
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  // v2.58.7 (G2 — CRITICAL): the old gate `product_create || finance_write`
  // is held by EVERY standard salesperson, and PartnerPrice is a
  // GROUP-GLOBAL table (no companyId column) — any salesperson of company
  // A could rewrite/delete the tier prices every company B quote computes
  // from. Mutating the shared financial ladder is finance/admin work now
  // (accounting_cartable — finance + admin), enforced through the central
  // policy layer. The thrown ApiError maps to the route's 403 envelope.
  assertPermission(user, 'accounting_cartable', 'شما دسترسی تعریف قیمت همکار را ندارید.');

  const { productCode, minQty, price, discountPercent, commissionPercent, note } = body as {
    productCode?: string;
    minQty?: number;
    price?: number;
    discountPercent?: number;
    commissionPercent?: number;
    note?: string;
  };

  if (!productCode?.trim()) {
    return NextResponse.json({ error: 'کد محصول الزامی است.' }, { status: 400 });
  }

  const product = await db.product.findUnique({ where: { code: productCode.trim() } });
  if (!product) {
    return NextResponse.json({ error: 'محصول با این کد یافت نشد.' }, { status: 404 });
  }

  const minQtyValue = Math.max(1, Math.trunc(safeFloat(minQty, 1)));
  // v2.47.0 — integer-Rial invariant on the partner price too.
  const priceValue = Math.max(0, parseIntRial(price) ?? -1);
  if (priceValue < 0) {
    return NextResponse.json({ error: 'قیمت همکار باید عدد ریالیِ صحیح باشد.' }, { status: 400 });
  }

  // جلوگیری از پلکان تکراری (محصول + حداقل تعداد)
  const duplicate = await db.partnerPrice.findFirst({
    where: { productCode: productCode.trim(), minQty: minQtyValue },
  });
  if (duplicate) {
    return NextResponse.json(
      { error: `پلکانی با حداقل تعداد ${minQtyValue} برای این محصول از قبل ثبت شده است.` },
      { status: 409 },
    );
  }

  const rule = await db.partnerPrice.create({
    data: {
      productCode: productCode.trim(),
      minQty: minQtyValue,
      price: priceValue,
      discountPercent: Math.max(0, Math.min(100, safeFloat(discountPercent))),
      commissionPercent: Math.max(0, Math.min(100, safeFloat(commissionPercent))),
      note: note?.trim() || '',
    },
  });

  return NextResponse.json({ success: true, message: 'قیمت همکار ثبت شد.', data: rule }, { status: 201 });
}

// ── 3. UPDATE ──
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  // v2.58.7 (G2 — CRITICAL): same tightened gate as create (see above).
  assertPermission(user, 'accounting_cartable', 'شما دسترسی ویرایش قیمت همکار را ندارید.');

  const { id, price, minQty, discountPercent, commissionPercent, note, active, expectedVersion } = body as {
    id?: string;
    price?: number;
    minQty?: number;
    discountPercent?: number;
    commissionPercent?: number;
    note?: string;
    active?: boolean;
    expectedVersion?: number | string | null;
  };
  if (!id) return NextResponse.json({ error: 'شناسه قاعده الزامی است.' }, { status: 400 });

  const existing = await db.partnerPrice.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'قاعده قیمت یافت نشد.' }, { status: 404 });

  const updateData: Record<string, unknown> = { version: { increment: 1 } };
  if (price !== undefined) {
    const p = parseIntRial(price);
    if (p === null) return NextResponse.json({ error: 'قیمت همکار باید عدد ریالیِ صحیح باشد.' }, { status: 400 });
    updateData.price = Math.max(0, p);
  }
  if (minQty !== undefined) updateData.minQty = Math.max(1, Math.trunc(safeFloat(minQty, 1)));
  if (discountPercent !== undefined) updateData.discountPercent = Math.max(0, Math.min(100, safeFloat(discountPercent)));
  if (commissionPercent !== undefined) updateData.commissionPercent = Math.max(0, Math.min(100, safeFloat(commissionPercent)));
  if (note !== undefined) updateData.note = String(note).trim();
  if (active !== undefined) updateData.active = Boolean(active);

  // v2.23.0 — in-tx live re-read + concurrency token: a mismatch means
  // another user edited the rule meanwhile → 409, never a silent lost
  // update on money-adjacent data.
  // v2.25.0 — the token is the EXACT numeric CAS `version` (supersedes the
  // 1000ms updatedAt tolerance); a missing token answers 428.
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.partnerPrice.findUnique({
        where: { id },
        select: { id: true, updatedAt: true, version: true },
      });
      if (!live) throw new ApiError(404, 'قاعده قیمت یافت نشد.');

      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'قاعده قیمت',
        required: true,
      });

      return await tx.partnerPrice.update({ where: { id }, data: updateData });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }
  return NextResponse.json({ success: true, message: 'قیمت همکار به‌روزرسانی شد.', data: updated });
}

// ── 4. DELETE ──
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  // v2.58.7 (G2 — CRITICAL): same tightened gate as create (see above).
  assertPermission(user, 'accounting_cartable', 'شما دسترسی حذف قیمت همکار را ندارید.');

  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه قاعده الزامی است.' }, { status: 400 });

  const existing = await db.partnerPrice.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'قاعده قیمت یافت نشد.' }, { status: 404 });

  await db.partnerPrice.delete({ where: { id } });
  return NextResponse.json({ success: true, message: 'قیمت همکار حذف شد.' });
}

// ── 5. RESOLVE — قیمت نهایی برای (محصول، تعداد، مشتری) ──
// اگر مشتری همکار باشد: کمیسیون اختصاصی مشتری > کمیسیون پلکان
async function handleResolve(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی محاسبه قیمت همکار را ندارید.' }, { status: 403 });
  }

  const { productCode, quantity, centerId } = body as { productCode?: string; quantity?: number; centerId?: string };
  if (!productCode?.trim()) {
    return NextResponse.json({ error: 'کد محصول الزامی است.' }, { status: 400 });
  }

  const qty = Math.max(1, safeFloat(quantity, 1));
  const code = productCode.trim();

  const product = await db.product.findUnique({ where: { code } });
  if (!product) return NextResponse.json({ error: 'محصول یافت نشد.' }, { status: 404 });

  const tiers = await db.partnerPrice.findMany({ where: { productCode: code } });
  const tier = resolveTier(tiers, qty);

  // کمیسیون اختصاصی مشتری همکار (در صورت تعریف)
  let centerCommission: number | null = null;
  let centerName = '';
  let isPartner = false;
  if (centerId) {
    // v2.58.7 (G2): the center lookup was BU-ONLY — a user of company A
    // could resolve company B's center by id and read its name /
    // commissionPercent / isPartner. The lookup now runs through the
    // caller's company scope (admin: all non-isolated companies).
    const allowed = await companyScopeOf(user);
    const center = await db.center.findFirst({
      where: {
        id: centerId,
        businessUnitId: user.businessUnitId,
        ...(allowed !== null ? { companyId: { in: allowed } } : {}),
      },
      select: { name: true, commissionPercent: true, segment: true },
    });
    if (center) {
      centerName = center.name;
      isPartner = center.segment === 'partner';
      if (center.commissionPercent > 0) centerCommission = center.commissionPercent;
    }
  }

  const commission = centerCommission ?? tier?.commissionPercent ?? 0;
  const effectivePrice = tier ? tier.price : product.price;

  return NextResponse.json({
    success: true,
    data: {
      productCode: code,
      productName: product.name,
      quantity: qty,
      publicPrice: product.price,
      partnerPrice: tier ? tier.price : null,
      appliedPrice: effectivePrice,
      discountPercent: tier ? tierDiscountPercent(tier.price, product.price) : 0,
      tierMinQty: tier?.minQty ?? null,
      commissionPercent: commission,
      centerName,
      isPartner,
      isPartnerPrice: Boolean(tier),
      savings: tier ? Math.round((product.price - tier.price) * qty) : 0,
    },
  });
}

// ── 6. STATS ──
async function handleStats(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers && !perms.view_reports) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده آمار قیمت‌ها را ندارید.' }, { status: 403 });
  }

  const [totalRules, activeRules, productCount, partnerCenters] = await Promise.all([
    db.partnerPrice.count(),
    db.partnerPrice.count({ where: { active: true } }),
    db.partnerPrice.groupBy({ by: ['productCode'] }).then((g) => g.length),
    db.center.count({
      where: { businessUnitId: user.businessUnitId, segment: 'partner', isArchived: false },
    }),
  ]);

  return NextResponse.json({
    success: true,
    data: { totalRules, activeRules, productCount, partnerCenters },
  });
}
