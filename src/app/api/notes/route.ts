import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده‌ است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'create') return await handleCreate(body, user);
    if (action === 'update') return await handleUpdate(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'toggle-pin') return await handleTogglePin(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('notes', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — user's notes
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده یادداشت‌ها را ندارید.' }, { status: 403 });
  }

  const notes = await db.note.findMany({
    where: { userId: user.id },
    orderBy: [{ isPinned: 'desc' }, { updatedAt: 'desc' }],
  });

  return NextResponse.json({ notes });
}

// ════════════════════════════════════════════════════════
//  GET
// ════════════════════════════════════════════════════════
async function handleGet(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده یادداشت را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه یادداشت الزامی است.' }, { status: 400 });
  }

  const note = await db.note.findFirst({
    where: { id, userId: user.id },
  });

  if (!note) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }

  return NextResponse.json({ note });
}

// ════════════════════════════════════════════════════════
//  CREATE
// ════════════════════════════════════════════════════════
async function handleCreate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی ایجاد یادداشت را ندارید.' }, { status: 403 });
  }

  const { title, content, color } = body as {
    title?: string;
    content?: string;
    color?: string;
  };

  if (!title) {
    return NextResponse.json({ error: 'عنوان یادداشت الزامی است.' }, { status: 400 });
  }

  const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
  const noteColor = validColors.includes(color || '') ? color! : 'default';

  const note = await db.note.create({
    data: {
      userId: user.id,
      title,
      content: content || '',
      color: noteColor,
    },
  });

  return NextResponse.json({ message: 'یادداشت با موفقیت ایجاد شد.', note }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  UPDATE
// ════════════════════════════════════════════════════════
async function handleUpdate(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی ویرایش یادداشت را ندارید.' }, { status: 403 });
  }

  const { id, title, content, color } = body as {
    id?: string;
    title?: string;
    content?: string;
    color?: string;
  };

  if (!id) {
    return NextResponse.json({ error: 'شناسه یادداشت الزامی است.' }, { status: 400 });
  }

  const existing = await db.note.findFirst({
    where: { id, userId: user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (color !== undefined) {
    const validColors = ['default', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'];
    if (validColors.includes(color)) data.color = color;
  }

  const note = await db.note.update({
    where: { id },
    data,
  });

  return NextResponse.json({ message: 'یادداشت با موفقیت به‌روزرسانی شد.', note });
}

// ════════════════════════════════════════════════════════
//  DELETE
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی حذف یادداشت را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه یادداشت الزامی است.' }, { status: 400 });
  }

  const existing = await db.note.findFirst({
    where: { id, userId: user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }

  await db.note.delete({ where: { id } });

  return NextResponse.json({ message: 'یادداشت با موفقیت حذف شد.' });
}

// ════════════════════════════════════════════════════════
//  TOGGLE PIN
// ════════════════════════════════════════════════════════
async function handleTogglePin(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.personal_notes) {
    return NextResponse.json({ error: 'شما دسترسی پین یادداشت را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه یادداشت الزامی است.' }, { status: 400 });
  }

  const existing = await db.note.findFirst({
    where: { id, userId: user.id },
  });
  if (!existing) {
    return NextResponse.json({ error: 'یادداشت یافت نشد.' }, { status: 404 });
  }

  const note = await db.note.update({
    where: { id },
    data: { isPinned: !existing.isPinned },
  });

  return NextResponse.json({ message: note.isPinned ? 'یادداشت سنجاق شد.' : 'یادداشت از سنجاق برداشته شد.', note });
}
