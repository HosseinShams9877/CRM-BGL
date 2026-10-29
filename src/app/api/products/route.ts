import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { getAllowedCompanyIds, strictIsolatedCompanyWhere } from '@/lib/company-scope';
import { logApiError } from '@/lib/logger';
import { assertConcurrencyToken } from '@/lib/concurrency';
import { parseIntRial } from '@/lib/money';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
// v2.35.1 (round 61) — keyboard-layout auto-fix: a Latin-only query also
// matches its Persian-layout twin, so «sj,kjdlhj,v» finds «ست ونتیلاتور»
// while the raw text keeps matching Latin product codes.
import { searchVariants } from '@/lib/keyboard-layout';

// ════════════════════════════════════════════════════════
// v2.35.0 — CATALOG TENANCY
// Historically the product catalog was one shared master-data list for the
// whole holding. Isolated companies (یاس طب) instead get a STRICTLY private
// catalog: their users see only rows stamped with their company, and rows
// they create are stamped automatically. Group behavior is unchanged —
// shared (companyId NULL) rows remain visible to every group company, and
// a group user's view additionally contains rows stamped with their own
// companies. Isolated rows never leak back into any group view.
// ════════════════════════════════════════════════════════
interface CatalogScope {
  where: Record<string, unknown>;
  allows: (productCompanyId: string | null) => boolean;
}

async function catalogScope(user: AuthUser): Promise<CatalogScope> {
  const strict = await strictIsolatedCompanyWhere(user);
  if (strict) {
    const ids = strict.companyId.in;
    return { where: strict, allows: (c) => c !== null && ids.includes(c) };
  }
  const allowed = (await getAllowedCompanyIds(user)) ?? [];
  return {
    where: { OR: [{ companyId: null }, { companyId: { in: allowed } }] },
    allows: (c) => c === null || allowed.includes(c),
  };
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'delete') return await handleDelete(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('products', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const {
    page = 1,
    pageSize = 50,
    search,
    active,
    source,
  } = body as {
    page?: number;
    pageSize?: number;
    search?: string;
    active?: boolean;
    source?: string;
  };

  // v2.25.0 — clamp the pagination window (pageSize was unbounded: a single
  // request could drag the whole product table through the serializer).
  const p = Math.max(1, Math.min(Number(page) || 1, 10000));
  const ps = Math.max(1, Math.min(Number(pageSize) || 50, 100));

  // v2.35.0 — catalog tenancy (see header). The scope rides in an AND so
  // the search OR below composes cleanly with it.
  const scope = await catalogScope(user);
  const where: Record<string, unknown> = { AND: [scope.where] };
  if (active !== undefined) where.active = active;
  if (source) where.source = source;
  if (search) {
    // v2.35.1 (round 61) — layout variants ride the same OR set the raw
    // search used; group/tenant scope composes unchanged (AND + OR).
    where.OR = searchVariants(String(search)).flatMap((v) => [
      { name: { contains: v } },
      { code: { contains: v } },
    ]);
  }

  const skip = (Number(p) - 1) * Number(ps);
  const take = Number(ps);

  const [items, total] = await Promise.all([
    db.product.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    db.product.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: Number(p),
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه محصول الزامی است.' }, { status: 400 });
  }

  const product = await db.product.findUnique({
    where: { id },
    include: {
      salesDocumentItems: {
        take: 5,
        orderBy: { createdAt: 'desc' },
      },
    },
  });

  // v2.35.0 — catalog tenancy: out-of-scope rows answer 404 (no leak).
  const scope = await catalogScope(user);
  if (!product || !scope.allows(product.companyId)) {
    return NextResponse.json({ error: 'محصول یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ product });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.product_create) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد محصول را ندارید.' }, { status: 403 });
  }

  const { code, name, price, unit, active, source, category, specs, warrantyMonths, ircCode } = body as {
    code?: string;
    name?: string;
    price?: number;
    unit?: string;
    active?: boolean;
    source?: string;
    category?: string;
    specs?: Record<string, string>;
    warrantyMonths?: number;
    // v2.31.9 — کد IRC (Lian proforma format): registration code printed
    // under the item name; optional (non-medical products carry none).
    ircCode?: string | null;
  };

  if (!code || !name) {
    return NextResponse.json({ error: 'کد و نام محصول الزامی است.' }, { status: 400 });
  }

  // v2.47.0 — integer-Rial invariant: fractional prices are rejected at the
  // write boundary (see src/lib/money.ts) instead of silently entering the
  // Float column and breaking report sums.
  const priceValue = price === undefined ? 0 : parseIntRial(price);
  if (priceValue === null) {
    return NextResponse.json({ error: 'قیمت محصول باید عدد ریالیِ صحیح باشد.' }, { status: 400 });
  }

  const existing = await db.product.findUnique({ where: { code } });
  if (existing) {
    return NextResponse.json({ error: 'محصولی با این کد قبلاً ثبت شده است.' }, { status: 409 });
  }

  // v2.23.0 — the pre-check above is a fast path, not a guarantee: two
  // concurrent creates with the same code both pass it, and the loser
  // used to crash into Prisma P2002 → raw 500. The unique index is the
  // real referee; a P2002 here is now a clean Persian 409.
  let product;
  try {
    product = await db.product.create({
      data: {
        code,
        name,
        price: priceValue,
        unit: unit || 'عدد',
        category: category || '',
        specs: JSON.stringify(specs && typeof specs === 'object' ? specs : {}),
        active: active !== false,
        source: source || 'دستی',
        warrantyMonths: Math.max(0, Math.min(120, Math.round(Number(warrantyMonths ?? 12) || 12))),
        ircCode: (typeof ircCode === 'string' && ircCode.trim()) ? ircCode.trim().slice(0, 40) : null,
        // v2.35.0 — isolated-company users create PRIVATE catalog rows;
        // group users keep creating shared (NULL) rows exactly as before.
        companyId: (await strictIsolatedCompanyWhere(user))?.companyId.in[0] ?? null,
      },
    });
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === 'P2002') {
      return NextResponse.json({ error: 'محصولی با این کد قبلاً ثبت شده است.' }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ message: 'محصول با موفقیت ایجاد شد.', product }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.product_create) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش محصول را ندارید.' }, { status: 403 });
  }

  const { id, code, name, price, unit, active, source, category, specs, warrantyMonths, ircCode, expectedVersion } = body as {
    id?: string;
    code?: string;
    name?: string;
    price?: number;
    unit?: string;
    active?: boolean;
    source?: string;
    category?: string;
    specs?: Record<string, string>;
    warrantyMonths?: number;
    ircCode?: string | null;
    expectedVersion?: number | string | null;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه محصول الزامی است.' }, { status: 400 });
  }

  const existing = await db.product.findUnique({ where: { id } });
  // v2.35.0 — catalog tenancy: out-of-scope rows answer 404 (no leak).
  const updScope = await catalogScope(user);
  if (!existing || !updScope.allows(existing.companyId)) {
    return NextResponse.json({ error: 'محصول یافت نشد.' }, { status: 404 });
  }

  const data: Record<string, unknown> = { version: { increment: 1 } };
  if (name !== undefined) data.name = name;
  if (price !== undefined) {
    const p = parseIntRial(price);
    if (p === null) return NextResponse.json({ error: 'قیمت محصول باید عدد ریالیِ صحیح باشد.' }, { status: 400 });
    data.price = p;
  }
  if (unit !== undefined) data.unit = unit;
  if (active !== undefined) data.active = active;
  if (source !== undefined) data.source = source;
  if (category !== undefined) data.category = category;
  // v2.31.9 — کد IRC (nullable; null clears)
  if (ircCode !== undefined) {
    data.ircCode = (typeof ircCode === 'string' && ircCode.trim()) ? ircCode.trim().slice(0, 40) : null;
  }
  if (specs !== undefined && specs !== null && typeof specs === 'object') data.specs = JSON.stringify(specs);
  if (warrantyMonths !== undefined) {
    data.warrantyMonths = Math.max(0, Math.min(120, Math.round(Number(warrantyMonths) || 0)));
  }

  // v2.23.0 — the update runs inside a transaction with a live re-read:
  // (a) concurrency-token mismatch → 409 (another user edited the product
  //     meanwhile — the old code silently overwrote their changes);
  // (b) the code-uniqueness race (check outside, write inside) is settled
  //     by the unique index itself → P2002 → clean Persian 409, not a 500.
  // v2.25.0 — the token is the EXACT numeric CAS `version` (the 1000ms
  // updatedAt tolerance let two saves inside one second both pass); a
  // missing token answers 428 (edit paths require it).
  let product;
  try {
    product = await db.$transaction(async (tx) => {
      const live = await tx.product.findUnique({
        where: { id },
        select: { id: true, code: true, updatedAt: true, version: true },
      });
      if (!live) throw new ApiError(404, 'محصول یافت نشد.');

      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'محصول',
        required: true,
      });

      if (code !== undefined && code !== live.code) {
        const codeExists = await tx.product.findUnique({ where: { code } });
        if (codeExists) {
          throw new ApiError(409, 'محصولی با این کد قبلاً ثبت شده است.');
        }
        data.code = code;
      }

      return await tx.product.update({
        where: { id },
        data,
      });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    if ((e as { code?: string })?.code === 'P2002') {
      return NextResponse.json({ error: 'محصولی با این کد قبلاً ثبت شده است.' }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({ message: 'محصول با موفقیت به‌روزرسانی شد.', product });
}

// ════════════════════════════════════════════════════════
//  DELETE (soft — set active=false)
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.product_create) {
    return NextResponse.json({ error: 'شما دسترسی حذف محصول را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه محصول الزامی است.' }, { status: 400 });
  }

  const existing = await db.product.findUnique({ where: { id } });
  // v2.35.0 — catalog tenancy: out-of-scope rows answer 404 (no leak).
  const delScope = await catalogScope(user);
  if (!existing || !delScope.allows(existing.companyId)) {
    return NextResponse.json({ error: 'محصول یافت نشد.' }, { status: 404 });
  }

  await db.product.update({
    where: { id },
    data: { active: false, version: { increment: 1 } },
  });

  return NextResponse.json({ message: 'محصول غیرفعال شد.' });
}
