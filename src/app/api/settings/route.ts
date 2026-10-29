import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { assertConcurrencyToken } from '@/lib/concurrency';
import {
  getJobTitleRegistry, saveJobTitleRegistry, getMenuAccessMatrix, saveMenuAccessMatrix,
} from '@/lib/access-server';
import { apiErrorMessage, apiErrorStatus, ApiError } from '@/lib/api-error';
import { maskMetaValue } from '@/lib/meta-secrets';

// v2.58.0 (audit 85-a #1) — secret classification/masking lives in
// lib/meta-secrets (shared with its unit tests).

// Meta keys whose value is a credential — NEVER returned raw to the client
// (mirrors the masking discipline of /api/ai-bridge, /api/ai-sales/settings
// and lib/sms/settings.ts) — v2.58.0: moved to lib/meta-secrets.

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'get') return await handleGet(body, user);
    if (action === 'set') return await handleSet(body, user);
    if (action === 'get-business-units') return await handleGetBusinessUnits(body, user);
    if (action === 'update-business-unit') return await handleUpdateBusinessUnit(body, user);
    if (action === 'get-menu-config') return await handleGetMenuConfig(user);
    if (action === 'get-access-config') return await handleGetAccessConfig(user);
    if (action === 'set-job-titles') return await handleSetJobTitles(body, user);
    if (action === 'set-menu-access') return await handleSetMenuAccess(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('settings', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  GET — all meta key-values
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.system_status) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده تنظیمات را ندارید.' }, { status: 403 });
  }

  // v2.58.0 (audit 85-a #1): this endpoint used to dump EVERY Meta row raw —
  // including third-party credentials (sms.api_key / sms.password /
  // ai_bridge.api_key / ai_sales.telephony_secret / hesabfa tokens).
  // Secrets are now masked in place, before the response leaves the server,
  // and an explicit `keys` whitelist from the client is honored on top.
  const requestedKeys = Array.isArray(body.keys)
    ? body.keys.filter((k): k is string => typeof k === 'string' && k.length > 0)
    : null;

  const metas = await db.meta.findMany({
    orderBy: { key: 'asc' },
    ...(requestedKeys ? { where: { key: { in: requestedKeys } } } : {}),
  });

  const settings: Record<string, string> = {};
  for (const m of metas) {
    settings[m.key] = maskMetaValue(m.key, m.value);
  }

  return NextResponse.json({ settings });
}

// ════════════════════════════════════════════════════════
//  SET — update meta
//  v2.18.0 (ninth-round audit): the settings screen sends a whole
//  `{ settings: {...} }` object, but this handler only accepted a
//  single `{ key, value }` pair — every "ذخیرهٔ تنظیمات" click was
//  rejected with 400 («کلید تنظیمات الزامی است»). Both shapes are
//  accepted now; the bulk shape upserts each pair in a transaction.
// ════════════════════════════════════════════════════════
async function handleSet(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند تنظیمات را تغییر دهد.' }, { status: 403 });
  }

  const { key, value, settings } = body as {
    key?: string;
    value?: string;
    settings?: Record<string, string>;
  };

  const pairs: Array<{ key: string; value: string }> = [];

  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    for (const [k, v] of Object.entries(settings)) {
      if (typeof k !== 'string' || !k || typeof v !== 'string') {
        return NextResponse.json({ error: 'قالب تنظیمات نامعتبر است.' }, { status: 400 });
      }
      pairs.push({ key: k, value: v });
    }
  } else if (key) {
    pairs.push({ key, value: value || '' });
  }

  if (pairs.length === 0) {
    return NextResponse.json({ error: 'کلید تنظیمات الزامی است.' }, { status: 400 });
  }

  // Guard: meta keys that drive security-relevant integrations may only be
  // written through their dedicated routes (ai-bridge / hesabfa / sms /
  // ai-sales write their own validation + audit trail there).
  // v2.58.0 (audit 85-a #5): `sms.*` and `ai_sales.*` joined the blocklist —
  // this route previously bypassed the SMS fail-closed enable check and the
  // telephony-secret format validation.
  const keyOk = (k: string) =>
    !k.startsWith('ai_bridge.') &&
    !k.startsWith('hesabfa.') &&
    !k.startsWith('sms.') &&
    !k.startsWith('ai_sales.');
  if (pairs.some((pr) => !keyOk(pr.key))) {
    return NextResponse.json(
      { error: 'تنظیمات یکپارچه‌سازی از مسیر اختصاصی خود قابل تغییر است.' },
      { status: 400 },
    );
  }

  await p_txUpsert(pairs);

  return NextResponse.json({ message: 'تنظیمات با موفقیت ذخیره شد.' });
}

/** Upsert a batch of meta pairs inside one transaction. */
async function p_txUpsert(pairs: Array<{ key: string; value: string }>) {
  await db.$transaction(
    pairs.map((pr) =>
      db.meta.upsert({
        where: { key: pr.key },
        update: { value: pr.value },
        create: { key: pr.key, value: pr.value },
      }),
    ),
  );
}

// ════════════════════════════════════════════════════════
//  GET BUSINESS UNITS
// ════════════════════════════════════════════════════════
async function handleGetBusinessUnits(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.system_status) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده واحدهای کسب‌وکار را ندارید.' }, { status: 403 });
  }

  const businessUnits = await db.businessUnit.findMany({
    orderBy: { id: 'asc' },
    include: {
      _count: { select: { users: true, centers: true } },
    },
  });

  return NextResponse.json({ businessUnits });
}

// ════════════════════════════════════════════════════════
//  UPDATE BUSINESS UNIT
//  v2.24.0 — optimistic-concurrency guard: the write now lands inside
//  a transaction with a live re-read, and the
//  token turns a concurrent admin edit into a clean 409 Persian (before,
//  two admins saving features/userIds JSON blobs silently dropped the
//  loser's whole assignment).
//  v2.25.0 — the token is now the EXACT numeric CAS `version` (the 1000ms
//  updatedAt tolerance let two saves inside one second both pass); a
//  missing token answers 428.
// ════════════════════════════════════════════════════════
async function handleUpdateBusinessUnit(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند واحد کسب‌وکار را ویرایش کند.' }, { status: 403 });
  }

  const { id, expectedVersion, name, label, isActive, features, userIds } = body as {
    id?: string;
    expectedVersion?: number | string | null;
    name?: string;
    label?: string;
    isActive?: boolean;
    features?: Record<string, unknown>;
    userIds?: string[];
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه واحد کسب‌وکار الزامی است.' }, { status: 400 });
  }

  const existing = await db.businessUnit.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'واحد کسب‌وکار یافت نشد.' }, { status: 404 });
  }

  const data: Record<string, unknown> = { version: { increment: 1 } };
  if (name !== undefined) data.name = name;
  if (label !== undefined) data.label = label;
  if (isActive !== undefined) data.isActive = isActive;
  if (features !== undefined) data.features = JSON.stringify(features);
  if (userIds !== undefined) data.userIds = JSON.stringify(userIds);

  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      const live = await tx.businessUnit.findUnique({
        where: { id },
        select: { id: true, updatedAt: true, version: true },
      });
      if (!live) throw new ApiError(404, 'واحد کسب‌وکار یافت نشد.');

      assertConcurrencyToken({
        expectedVersion: expectedVersion ?? null,
        liveVersion: live.version,
        entityLabel: 'واحد کسب‌وکار',
        required: true,
      });

      return await tx.businessUnit.update({ where: { id }, data });
    });
  } catch (e: unknown) {
    if (e instanceof ApiError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    throw e;
  }

  return NextResponse.json({ message: 'واحد کسب‌وکار با موفقیت به‌روزرسانی شد.', businessUnit: updated });
}

// ════════════════════════════════════════════════════════
//  GET MENU CONFIG — any authenticated user (sidebar filtering)
//  Only exposes the saved matrix; menu labels/keys are not sensitive.
// ════════════════════════════════════════════════════════
async function handleGetMenuConfig(_user: AuthUser) {
  const menuAccess = await getMenuAccessMatrix();
  return NextResponse.json({ menuAccess });
}

// ════════════════════════════════════════════════════════
//  GET ACCESS CONFIG — admin / manage_users only
//  Returns the job-title registry + saved matrix + user counts.
// ════════════════════════════════════════════════════════
async function handleGetAccessConfig(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی مدیریت دسترسی را ندارید.' }, { status: 403 });
  }

  const [jobTitles, menuAccess] = await Promise.all([
    getJobTitleRegistry(),
    getMenuAccessMatrix(),
  ]);

  // how many users are assigned to each job title (for safe deletion)
  const users = await db.user.findMany({
    select: { jobTitle: true, role: true },
  });
  const counts: Record<string, number> = {};
  for (const u of users) {
    const key = u.jobTitle || u.role || 'standard';
    counts[key] = (counts[key] || 0) + 1;
  }

  return NextResponse.json({ jobTitles, menuAccess, userCounts: counts });
}

// ════════════════════════════════════════════════════════
//  SET JOB TITLES — admin only
// ════════════════════════════════════════════════════════
async function handleSetJobTitles(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند عناوین شغلی را ویرایش کند.' }, { status: 403 });
  }
  const { jobTitles } = body as { jobTitles?: unknown };
  try {
    const saved = await saveJobTitleRegistry(jobTitles);
    await db.auditEvent.create({
      data: {
        eventType: 'ACCESS_JOB_TITLES_UPDATED',
        category: 'user_management',
        subject: `${saved.length} عنوان شغلی`,
        userId: user.id,
      },
    });
    return NextResponse.json({ message: 'عناوین شغلی با موفقیت ذخیره شد.', jobTitles: saved });
  } catch (e) {
    const msg = apiErrorMessage(e, 'خطا در ذخیرهٔ عناوین شغلی');
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// ════════════════════════════════════════════════════════
//  SET MENU ACCESS — admin only
// ════════════════════════════════════════════════════════
async function handleSetMenuAccess(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند دسترسی منوها را ویرایش کند.' }, { status: 403 });
  }
  const { menuAccess } = body as { menuAccess?: unknown };
  try {
    const saved = await saveMenuAccessMatrix(menuAccess);
    await db.auditEvent.create({
      data: {
        eventType: 'ACCESS_MENU_MATRIX_UPDATED',
        category: 'user_management',
        subject: `${Object.keys(saved).length} عنوان شغلی`,
        userId: user.id,
      },
    });
    return NextResponse.json({ message: 'دسترسی منوها با موفقیت ذخیره شد.', menuAccess: saved });
  } catch (e) {
    const msg = apiErrorMessage(e, 'خطا در ذخیرهٔ ماتریس دسترسی');
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}