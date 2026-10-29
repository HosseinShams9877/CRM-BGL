import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser, hashPassword, verifyPassword, normalizeRole, parseCompanyIds, revokeAllUserSessions } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { getJobTitleRegistry } from '@/lib/access-server';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { validatePasswordAgainstPolicy } from '@/lib/security-policy';
import {
  IRAN_PROVINCES, TERRITORY_MODES, TerritoryMode,
  parseTerritoryArray, territorySummary,
} from '@/lib/territory-scope';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;
    // v2.31.3: RAW cookie token — revokeAllUserSessions hashes it internally
    // to find the row that must survive an admin's edit of this user.
    const currentSessionToken = req.cookies.get('bgl_session')?.value;

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user, currentSessionToken);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'change-role') return await handleChangeRole(body, user);
    if (action === 'update-companies') return await handleUpdateCompanies(body, user);
    // v2.36.0 — Sales Territory & Data Permission Management
    if (action === 'territory-get') return await handleTerritoryGet(body, user);
    if (action === 'territory-preview') return await handleTerritoryPreview(body, user);
    if (action === 'territory-centers') return await handleTerritoryCenters(body, user);
    if (action === 'update-territory') return await handleUpdateTerritory(body, user, currentSessionToken);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('users', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده کاربران را ندارید.' }, { status: 403 });
  }

  const { page = 1, pageSize = 20, search, role, isActive } = body as {
    page?: number;
    pageSize?: number;
    search?: string;
    role?: string;
    isActive?: boolean;
  };

  const where: Record<string, unknown> = { businessUnitId: user.businessUnitId };
  if (role) where.role = role;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where.OR = [
      { username: { contains: search } },
      { displayName: { contains: search } },
    ];
  }

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [items, total] = await Promise.all([
    db.user.findMany({
      where,
      skip,
      take,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // v2.36.0 — territory columns join the list payload (table badge)
      select: TERRITORY_USER_SELECT,
    }),
    db.user.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  // Admin can view any user, others can view themselves
  const perms = getRolePermissions(user.role);
  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  }

  if (!perms.manage_users && id !== user.id) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده این کاربر را ندارید.' }, { status: 403 });
  }

  const targetUser = await db.user.findUnique({
    where: { id },
    // v2.36.0 — territory columns for the profile view
    select: TERRITORY_USER_SELECT,
  });

  if (!targetUser) {
    return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ user: targetUser });
}

// ════════════════════════════════════════════════════════
//  CREATE — Admin only
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند کاربر جدید ایجاد کند.' }, { status: 403 });
  }

  const { username, displayName, password, role, roleLabel, jobTitle, province, businessUnitId } = body as {
    username?: string;
    displayName?: string;
    password?: string;
    role?: string;
    roleLabel?: string;
    jobTitle?: string;
    province?: string;
    businessUnitId?: string;
  };

  if (!username || !displayName || !password) {
    return NextResponse.json({ error: 'نام کاربری، نام نمایشی و رمز عبور الزامی است.' }, { status: 400 });
  }

  // v2.18.0 — enforce the admin-configurable password policy
  // (settings → امنیت و دسترسی) instead of accepting any string.
  const policyError = await validatePasswordAgainstPolicy(password);
  if (policyError) {
    return NextResponse.json({ error: policyError }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { username } });
  if (existing) {
    return NextResponse.json({ error: 'این نام کاربری قبلاً ثبت شده است.' }, { status: 409 });
  }

  // Resolve job title (preferred) → base role + display label
  let normalizedRole = normalizeRole(role || 'standard');
  let finalRoleLabel: string | undefined = roleLabel;
  let finalJobTitle: string | null = null;
  if (jobTitle) {
    const registry = await getJobTitleRegistry();
    const entry = registry.find((t) => t.key === jobTitle);
    if (!entry) {
      return NextResponse.json({ error: 'عنوان شغلی نامعتبر است.' }, { status: 400 });
    }
    normalizedRole = normalizeRole(entry.baseRole);
    finalRoleLabel = entry.label;
    finalJobTitle = entry.key;
  }
  const roleLabels: Record<string, string> = {
    admin: 'مدیر سیستم',
    finance: 'کارشناس مالی',
    production: 'واحد تولید',
    standard: 'کاربر عادی',
  };

  const newUser = await db.user.create({
    data: {
      username,
      displayName,
      passwordHash: hashPassword(password),
      role: normalizedRole,
      roleLabel: finalRoleLabel || roleLabels[normalizedRole] || 'کاربر عادی',
      jobTitle: finalJobTitle,
      province: province || null,
      businessUnitId: businessUnitId || user.businessUnitId,
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      roleLabel: true,
      jobTitle: true,
      province: true,
      isActive: true,
      companyIds: true,
      businessUnitId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ message: 'کاربر با موفقیت ایجاد شد.', user: newUser }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser, currentSessionToken?: string) {
  const perms = getRolePermissions(user.role);
  const { id, displayName, province, isActive, newPassword, currentPassword, jobTitle } = body as {
    id?: string;
    displayName?: string;
    province?: string;
    isActive?: boolean;
    newPassword?: string;
    /** v2.58.7 (A7): REQUIRED proof-of-identity whenever a user changes
     *  their OWN password through this route (a hijacked session must not
     *  be able to lock the real owner out permanently). Admins resetting
     *  OTHER users' passwords keep the manage_users authority path. */
    currentPassword?: string;
    jobTitle?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  }

  // Non-admin can only update their own profile (not isActive)
  if (!perms.manage_users && id !== user.id) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش این کاربر را ندارید.' }, { status: 403 });
  }

  const existing = await db.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (displayName !== undefined) data.displayName = displayName;
  if (province !== undefined) data.province = province;
  if (isActive !== undefined && perms.manage_users) data.isActive = isActive;
  if (newPassword && (id === user.id || perms.manage_users)) {
    // v2.58.7 (A7 — session-hijack hardening): changing your OWN password
    // now requires the CURRENT password (the dedicated /api/auth
    // change-password action always verified it; this route accepted a
    // bare session cookie). The UI's self-service dialog already sends
    // currentPassword through /api/auth, so no component changes are
    // needed. Admin resetting ANOTHER user's password is unaffected.
    if (id === user.id) {
      if (!currentPassword) {
        return NextResponse.json(
          { error: 'برای تغییر رمز عبور خود، رمز فعلی الزامی است.' },
          { status: 400 },
        );
      }
      if (!verifyPassword(currentPassword, existing.passwordHash)) {
        return NextResponse.json({ error: 'رمز فعلی نادرست است.' }, { status: 403 });
      }
    }
    // v2.18.0 — password changes follow the same configurable policy
    const policyError = await validatePasswordAgainstPolicy(newPassword);
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }
    data.passwordHash = hashPassword(newPassword);
  }

  // Job-title change (admin only) — updates base role + label and revokes sessions
  let jobTitleChanged = false;
  if (jobTitle !== undefined && perms.manage_users && id !== user.id) {
    const registry = await getJobTitleRegistry();
    const entry = jobTitle ? registry.find((t) => t.key === jobTitle) : undefined;
    if (jobTitle && !entry) {
      return NextResponse.json({ error: 'عنوان شغلی نامعتبر است.' }, { status: 400 });
    }
    const nextKey = entry ? entry.key : null;
    if ((existing.jobTitle || null) !== nextKey) {
      jobTitleChanged = true;
      data.jobTitle = nextKey;
      if (entry) {
        data.role = normalizeRole(entry.baseRole);
        data.roleLabel = entry.label;
      } else {
        data.role = 'standard';
        data.roleLabel = 'کاربر عادی';
      }
    }
  }

  const updated = await db.user.update({
    where: { id },
    data,
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      roleLabel: true,
      jobTitle: true,
      province: true,
      isActive: true,
      companyIds: true,
      businessUnitId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Security: password reset or deactivation must not leave old sessions alive.
  // When the user resets their own password, keep only the current session.
  if (newPassword && id === user.id) {
    await revokeAllUserSessions(id, currentSessionToken);
  } else if (newPassword || data.isActive === false || jobTitleChanged) {
    await revokeAllUserSessions(id);
  }

  if (jobTitleChanged) {
    await db.auditEvent.create({
      data: {
        eventType: 'USER_JOB_TITLE_CHANGED',
        category: 'user_management',
        subject: `${existing.username}: ${existing.jobTitle || existing.role} → ${jobTitle || 'بدون عنوان'}`,
        userId: user.id,
      },
    });
  }

  return NextResponse.json({ message: 'اطلاعات کاربر به‌روزرسانی شد.', user: updated });
}

// ════════════════════════════════════════════════════════
//  DELETE — Admin only
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند کاربر حذف کند.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  }

  if (id === user.id) {
    return NextResponse.json({ error: 'شما نمی‌توانید حساب خود را حذف کنید.' }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  }

  // v2.58.0 (audit 85-c): user deletion is now one transaction (sessions
  // cleaned atomically with the row) and FK RESTRICT violations (a user
  // who owns notes/activities via restricted relations) answer a clean
  // Persian 409 instead of a raw Prisma P2003 500.
  try {
    await db.$transaction([
      db.user.delete({ where: { id } }),
      db.session.deleteMany({ where: { userId: id } }),
    ]);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2003' || e.code === 'P2025')) {
      return NextResponse.json(
        { error: 'این کاربر دارای داده‌های وابسته (یادداشت/فعالیت/…) است و قابل حذف نیست. ابتدا آن‌ها را منتقل یا حذف کنید.' },
        { status: 409 },
      );
    }
    throw e;
  }

  return NextResponse.json({ message: 'کاربر با موفقیت حذف شد.' });
}

// ════════════════════════════════════════════════════════
//  SALES TERRITORY (v2.36.0)
//  «ثبت یک‌بار، اعمال خودکار در تمام کوئری‌ها» — admins assign a
//  sales expert's province/center scope once; every DB query for that
//  user is then auto-scoped (lib/territory-scope + route wiring).
// ════════════════════════════════════════════════════════

const TERRITORY_USER_SELECT = {
  id: true, username: true, displayName: true, role: true, roleLabel: true,
  jobTitle: true, province: true, isActive: true, companyIds: true,
  territoryMode: true, territoryProvinces: true, territoryCenterIds: true,
  businessUnitId: true, createdAt: true, updatedAt: true,
} as const;

/** Company ids of the TARGET user (the expert being scoped). */
async function targetCompanyIds(target: { role: string; companyIds: string | null }): Promise<string[] | null> {
  if (getCanonicalRole(target.role) === 'admin') return null;
  const slugs = parseCompanyIds(target.companyIds).filter((s) => !['holding', 'all'].includes(s));
  if (slugs.length === 0) return [];
  const rows = await db.company.findMany({ where: { slug: { in: slugs } }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Province universe for the picker = canonical 31 ∪ distinct DB values
 *  (within the target's companies), each with a live center count. */
async function provinceUniverse(companyIds: string[] | null) {
  const rows = await db.center.groupBy({
    by: ['province'],
    where: {
      status: 'active',
      ...(companyIds !== null ? { companyId: { in: companyIds } } : {}),
    },
    _count: { _all: true },
  });
  const byName = new Map<string, number>();
  for (const r of rows) {
    if (!r.province) continue;
    byName.set(r.province, (byName.get(r.province) || 0) + r._count._all);
  }
  const names = [...new Set([...IRAN_PROVINCES, ...byName.keys()])];
  return names.map((name) => ({ province: name, count: byName.get(name) || 0 }));
}

/** Live count of active centers a candidate territory would expose. */
async function countTerritoryCenters(
  companyIds: string[] | null,
  mode: TerritoryMode,
  provinces: string[],
  centerIds: string[],
): Promise<number> {
  if (mode === 'country') {
    return db.center.count({
      where: { status: 'active', ...(companyIds !== null ? { companyId: { in: companyIds } } : {}) },
    });
  }
  if (mode === 'provinces') {
    return db.center.count({
      where: {
        status: 'active', province: { in: provinces },
        ...(companyIds !== null ? { companyId: { in: companyIds } } : {}),
      },
    });
  }
  return db.center.count({
    where: {
      status: 'active', id: { in: centerIds },
      ...(companyIds !== null ? { companyId: { in: companyIds } } : {}),
    },
  });
}

// ── territory-get: full assignment + picker universe + counts ──
async function handleTerritoryGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  const { id } = body as { id?: string };
  if (!id) return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  if (!perms.manage_users && id !== user.id) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده این کاربر را ندارید.' }, { status: 403 });
  }
  const target = await db.user.findUnique({ where: { id }, select: TERRITORY_USER_SELECT });
  if (!target) return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });

  const companyIds = await targetCompanyIds(target);
  const mode = (TERRITORY_MODES as readonly string[]).includes(target.territoryMode)
    ? (target.territoryMode as TerritoryMode)
    : 'country';
  const provinces = parseTerritoryArray(target.territoryProvinces);
  const centerIds = parseTerritoryArray(target.territoryCenterIds);

  const [universe, assignedCenters, visibleCount] = await Promise.all([
    provinceUniverse(companyIds),
    centerIds.length > 0
      ? db.center.findMany({
          where: { id: { in: centerIds } },
          select: { id: true, name: true, province: true, city: true, companyId: true },
          orderBy: { name: 'asc' },
        })
      : Promise.resolve([]),
    countTerritoryCenters(companyIds, mode, provinces, centerIds),
  ]);

  return NextResponse.json({
    user: {
      id: target.id, displayName: target.displayName, username: target.username,
      // v2.58.4 (issue 4): the UI receives the CANONICAL role so legacy
      // DB rows render with the right labels and guards.
      role: getCanonicalRole(target.role), jobTitle: target.jobTitle, province: target.province,
      companyIds: parseCompanyIds(target.companyIds),
    },
    territory: { mode, provinces, centerIds, summary: territorySummary(target), updatedAt: target.updatedAt },
    provincesUniverse: universe,
    assignedCenters,
    centerCount: visibleCount,
    canEdit: perms.manage_users && getCanonicalRole(target.role) === 'standard' && target.id !== user.id,
  });
}

// ── territory-preview: live visible-center count for a candidate ──
async function handleTerritoryPreview(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی مدیریت کاربران را ندارید.' }, { status: 403 });
  }
  const { id, mode, provinces, centerIds } = body as {
    id?: string; mode?: string; provinces?: string[]; centerIds?: string[];
  };
  if (!id) return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  const target = await db.user.findUnique({
    where: { id },
    select: { role: true, companyIds: true },
  });
  if (!target) return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });

  const m: TerritoryMode = (TERRITORY_MODES as readonly string[]).includes(String(mode))
    ? (mode as TerritoryMode)
    : 'country';
  const companyIds = await targetCompanyIds(target);
  const count = await countTerritoryCenters(
    companyIds, m, Array.isArray(provinces) ? provinces : [], Array.isArray(centerIds) ? centerIds : [],
  );
  return NextResponse.json({ centerCount: count });
}

// ── territory-centers: searchable picker INSIDE the target's companies ──
async function handleTerritoryCenters(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی مدیریت کاربران را ندارید.' }, { status: 403 });
  }
  const { id, search = '', limit = 30 } = body as { id?: string; search?: string; limit?: number };
  if (!id) return NextResponse.json({ error: 'شناسه کاربر الزامی است.' }, { status: 400 });
  const target = await db.user.findUnique({
    where: { id },
    select: { role: true, companyIds: true },
  });
  if (!target) return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });

  const companyIds = await targetCompanyIds(target);
  const raw = String(search).trim();
  const norm = raw.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
  const where: Record<string, unknown> = {
    status: 'active',
    ...(companyIds !== null ? { companyId: { in: companyIds } } : {}),
    ...(raw
      ? { OR: [{ name: { contains: norm } }, { name: { contains: raw } }, { city: { contains: raw } }] }
      : {}),
  };
  const centers = await db.center.findMany({
    where,
    select: { id: true, name: true, province: true, city: true },
    orderBy: [{ name: 'asc' }],
    take: Math.max(1, Math.min(Number(limit) || 30, 50)),
  });
  return NextResponse.json({ centers });
}

// ── update-territory: validate + persist + audit + revoke sessions ──
async function handleUpdateTerritory(
  body: Record<string, unknown>,
  user: AuthUser,
  currentSessionToken?: string,
) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند محدوده فروش را تعیین کند.' }, { status: 403 });
  }
  const { id, mode, provinces, centerIds } = body as {
    id?: string; mode?: string; provinces?: string[]; centerIds?: string[];
  };
  if (!id || !mode) {
    return NextResponse.json({ error: 'شناسه کاربر و نوع محدوده الزامی است.' }, { status: 400 });
  }
  if (!TERRITORY_MODES.includes(mode as TerritoryMode)) {
    return NextResponse.json({ error: 'نوع محدوده نامعتبر است.' }, { status: 400 });
  }
  const target = await db.user.findUnique({ where: { id }, select: TERRITORY_USER_SELECT });
  if (!target) return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  if (target.id === user.id) {
    return NextResponse.json({ error: 'امکان تغییر محدودهٔ حساب خودتان وجود ندارد.' }, { status: 400 });
  }
  // Territory scopes OPERATIONAL experts only — admin/finance/production
  // keep their designed reach (finance must see every company's financials).
  if (getCanonicalRole(target.role) !== 'standard') {
    return NextResponse.json(
      { error: 'محدودهٔ فروش فقط برای کاربران عملیاتی (نقش پایهٔ کاربر عادی) قابل تعیین است.' },
      { status: 400 },
    );
  }

  const cleanProvinces = [...new Set((Array.isArray(provinces) ? provinces : []).map((p) => String(p).trim()).filter(Boolean))];
  const cleanCenterIds = [...new Set((Array.isArray(centerIds) ? centerIds : []).map((c) => String(c).trim()).filter(Boolean))];

  const companyIds = await targetCompanyIds(target);

  if (mode === 'provinces') {
    if (cleanProvinces.length === 0) {
      return NextResponse.json({ error: 'حداقل یک استان انتخاب کنید.' }, { status: 400 });
    }
    if (cleanProvinces.length > 40) {
      return NextResponse.json({ error: 'حداکثر ۴۰ استان قابل انتخاب است.' }, { status: 400 });
    }
    const universe = new Set((await provinceUniverse(companyIds)).map((p) => p.province));
    const invalid = cleanProvinces.filter((p) => !universe.has(p));
    if (invalid.length > 0) {
      return NextResponse.json({ error: `استان نامعتبر: ${invalid.join('، ')}` }, { status: 400 });
    }
  }

  if (mode === 'centers') {
    if (cleanCenterIds.length === 0) {
      return NextResponse.json({ error: 'حداقل یک مرکز انتخاب کنید.' }, { status: 400 });
    }
    if (cleanCenterIds.length > 2000) {
      return NextResponse.json({ error: 'حداکثر ۲۰۰۰ مرکز قابل انتخاب است.' }, { status: 400 });
    }
    // centers must exist AND belong to the target's companies (an expert
    // can never be granted a center outside their own company scope).
    const rows = cleanCenterIds.length
      ? await db.center.findMany({
          where: { id: { in: cleanCenterIds } },
          select: { id: true, companyId: true },
        })
      : [];
    const existing = new Map(rows.map((r) => [r.id, r.companyId]));
    const missing = cleanCenterIds.filter((c) => !existing.has(c));
    if (missing.length > 0) {
      return NextResponse.json({ error: `${missing.length} مرکز یافت نشد.` }, { status: 400 });
    }
    if (companyIds !== null) {
      const foreign = cleanCenterIds.filter((c) => !companyIds.includes(existing.get(c) as string));
      if (foreign.length > 0) {
        return NextResponse.json(
          { error: `${foreign.length} مرکز خارج از شرکت‌های این کارشناس است.` },
          { status: 400 },
        );
      }
    }
  }

  const updated = await db.user.update({
    where: { id },
    data: {
      territoryMode: mode,
      territoryProvinces: mode === 'provinces' ? JSON.stringify(cleanProvinces) : '[]',
      territoryCenterIds: mode === 'centers' ? JSON.stringify(cleanCenterIds) : '[]',
      territoryUpdatedAt: new Date(),
    },
    select: TERRITORY_USER_SELECT,
  });

  await db.auditEvent.create({
    data: {
      eventType: 'USER_TERRITORY_UPDATED',
      category: 'user_management',
      subject: `${target.displayName} (${target.username}): ${territorySummary(updated)} — ${
        mode === 'provinces' ? cleanProvinces.join('، ') : mode === 'centers' ? `${cleanCenterIds.length} مرکز` : 'بدون محدودیت'
      }`,
      userId: user.id,
    },
  });

  // Security: the scope change must take effect immediately — stale
  // sessions would keep the previous (possibly wider) territory.
  await revokeAllUserSessions(id, id === user.id ? currentSessionToken : undefined);

  return NextResponse.json({
    message:
      mode === 'country'
        ? 'محدودهٔ فروش این کارشناس به کل کشور (بدون محدودیت) تغییر کرد.'
        : `محدودهٔ فروش «${target.displayName}» ثبت شد و از همین لحظه در همهٔ کوئری‌ها اعمال می‌شود.`,
    user: updated,
  });
}

// ════════════════════════════════════════════════════════
//  CHANGE ROLE — Admin only
// ════════════════════════════════════════════════════════
async function handleChangeRole(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند نقش کاربر را تغییر دهد.' }, { status: 403 });
  }

  const { id, role, roleLabel } = body as {
    id?: string;
    role?: string;
    roleLabel?: string;
  };

  if (!id || !role) {
    return NextResponse.json({ error: 'شناسه و نقش جدید الزامی است.' }, { status: 400 });
  }

  if (id === user.id) {
    return NextResponse.json({ error: 'شما نمی‌توانید نقش خود را تغییر دهید.' }, { status: 400 });
  }

  const validRoles = ['admin', 'finance', 'production', 'standard'];
  if (!validRoles.includes(role)) {
    return NextResponse.json({ error: 'نقش نامعتبر است.' }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  }

  const roleLabels: Record<string, string> = {
    admin: 'مدیر سیستم',
    finance: 'کارشناس مالی',
    production: 'واحد تولید',
    standard: 'کاربر عادی',
  };

  const updated = await db.user.update({
    where: { id },
    data: {
      role,
      roleLabel: roleLabel || roleLabels[role] || 'کاربر عادی',
    },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      roleLabel: true,
      jobTitle: true,
      province: true,
      isActive: true,
      companyIds: true,
      businessUnitId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Security: a role change must immediately revoke existing sessions so the
  // new permissions take effect on next login.
  await revokeAllUserSessions(id);
  await db.auditEvent.create({
    data: {
      eventType: 'USER_ROLE_CHANGED',
      category: 'user_management',
      subject: `${existing.username}: ${existing.role} → ${role}`,
      userId: user.id,
    },
  });

  return NextResponse.json({ message: 'نقش کاربر با موفقیت تغییر کرد.', user: updated });
}

// ════════════════════════════════════════════════════════
//  UPDATE COMPANIES — Admin/Holding Manager
// ════════════════════════════════════════════════════════
async function handleUpdateCompanies(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند دسترسی شرکت‌ها را مدیریت کند.' }, { status: 403 });
  }

  const { id, companyIds } = body as { id?: string; companyIds?: string[] };
  if (!id || !Array.isArray(companyIds)) {
    return NextResponse.json({ error: 'شناسه کاربر و لیست شرکت‌ها الزامی است.' }, { status: 400 });
  }
  if (companyIds.length > 3) {
    return NextResponse.json({ error: 'هر کارشناس فروش حداکثر ۳ شرکت می‌تواند داشته باشد.' }, { status: 400 });
  }

  // v2.35.0 — yasteb (شرکت مستقل) sits OUTSIDE the group aggregate: a user
  // is either a group user or an isolated-company user, never both — a
  // mixed assignment would merge isolated data into that user's group
  // views, exactly what the isolation must prevent.
  const GROUP_SLUGS = ['bazargani', 'aria', 'bgl'];
  const ISOLATED_SLUGS = ['yasteb'];
  const hasGroup = companyIds.some((c) => GROUP_SLUGS.includes(c));
  const hasIsolated = companyIds.some((c) => ISOLATED_SLUGS.includes(c));
  if (hasGroup && hasIsolated) {
    return NextResponse.json(
      { error: 'یاس طب شرکت مستقلی است و نمی‌تواند همراه با شرکت‌های گروه به یک کاربر اختصاص یابد؛ ابتدا شرکت‌های گروه را بردارید.' },
      { status: 400 },
    );
  }

  const validSlugs = [...GROUP_SLUGS, ...ISOLATED_SLUGS];
  const invalid = companyIds.filter(c => !validSlugs.includes(c));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `شرکت نامعتبر: ${invalid.join(', ')}` }, { status: 400 });
  }

  const existing = await db.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'کاربر یافت نشد.' }, { status: 404 });
  }
  if (getCanonicalRole(existing.role) === 'admin') {
    return NextResponse.json({ error: 'مدیر سیستم به تمام شرکت‌ها دسترسی دارد و قابل تغییر نیست.' }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id },
    data: { companyIds: JSON.stringify(companyIds) },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      roleLabel: true,
      jobTitle: true,
      isActive: true,
      companyIds: true,
      businessUnitId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await db.auditEvent.create({
    data: {
      eventType: 'USER_COMPANIES_UPDATED',
      category: 'user_management',
      subject: `${existing.displayName}: ${JSON.stringify(companyIds)}`,
      userId: user.id,
    },
  });

  // Security: company scope changed → old sessions may hold stale permissions
  await revokeAllUserSessions(id);

  return NextResponse.json({ message: 'دسترسی شرکت‌ها با موفقیت به‌روزرسانی شد.', user: updated });
}
