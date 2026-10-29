import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

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
    logApiError('territories', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════
async function handleList(_body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده مناطق را ندارید.' }, { status: 403 });
  }

  const territories = await db.territory.findMany({
    orderBy: { name: 'asc' },
  });

  return NextResponse.json({ territories });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.view_centers) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده منطقه را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه منطقه الزامی است.' }, { status: 400 });
  }

  const territory = await db.territory.findUnique({
    where: { id },
  });

  if (!territory) {
    return NextResponse.json({ error: 'منطقه یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ territory });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد منطقه را ندارید.' }, { status: 403 });
  }

  const { name, province, userIds } = body as {
    name?: string;
    province?: string;
    userIds?: string[];
  };

  if (!name) {
    return NextResponse.json({ error: 'نام منطقه الزامی است.' }, { status: 400 });
  }

  const existing = await db.territory.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: 'منطقه‌ای با این نام قبلاً ثبت شده است.' }, { status: 409 });
  }

  const territory = await db.territory.create({
    data: {
      name,
      province: province || null,
      userIds: JSON.stringify(userIds || []),
    },
  });

  return NextResponse.json({ message: 'منطقه با موفقیت ایجاد شد.', territory }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش منطقه را ندارید.' }, { status: 403 });
  }

  const { id, name, province, userIds } = body as {
    id?: string;
    name?: string;
    province?: string;
    userIds?: string[];
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه منطقه الزامی است.' }, { status: 400 });
  }

  const existing = await db.territory.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'منطقه یافت نشد.' }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (name !== undefined) {
    if (name !== existing.name) {
      const nameExists = await db.territory.findUnique({ where: { name } });
      if (nameExists) {
        return NextResponse.json({ error: 'منطقه‌ای با این نام قبلاً ثبت شده است.' }, { status: 409 });
      }
    }
    data.name = name;
  }
  if (province !== undefined) data.province = province;
  if (userIds !== undefined) data.userIds = JSON.stringify(userIds);

  const territory = await db.territory.update({
    where: { id },
    data,
  });

  return NextResponse.json({ message: 'منطقه با موفقیت به‌روزرسانی شد.', territory });
}

// ════════════════════════════════════════════════════════
//  DELETE
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.manage_users) {
    return NextResponse.json({ error: 'شما دسترسی حذف منطقه را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه منطقه الزامی است.' }, { status: 400 });
  }

  const existing = await db.territory.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: 'منطقه یافت نشد.' }, { status: 404 });
  }

  await db.territory.delete({ where: { id } });

  return NextResponse.json({ message: 'منطقه با موفقیت حذف شد.' });
}
