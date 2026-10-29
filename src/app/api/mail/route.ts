import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions, AuthUser } from '@/lib/auth';
import { visibleColleagueUserIds } from '@/lib/company-scope';
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

    if (action === 'list-inbox') return await handleListInbox(body, user);
    if (action === 'list-sent') return await handleListSent(body, user);
    if (action === 'get') return await handleGet(body, user);
    if (action === 'send') return await handleSend(body, user);
    if (action === 'mark-read') return await handleMarkRead(body, user);
    if (action === 'mark-unread') return await handleMarkUnread(body, user);
    if (action === 'delete') return await handleDelete(body, user);
    if (action === 'unread-count') return await handleUnreadCount(user);
    if (action === 'directory') return await handleDirectory(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('mail', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST INBOX
// ════════════════════════════════════════════════════════
async function handleListInbox(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده صندوق ورودی را ندارید.' }, { status: 403 });
  }

  const { page = 1, pageSize = 20 } = body as { page?: number; pageSize?: number };

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [recipients, total] = await Promise.all([
    db.letterRecipient.findMany({
      where: { userId: user.id },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        letter: {
          include: {
            recipients: { select: { userId: true, isRead: true } },
          },
        },
      },
    }),
    db.letterRecipient.count({ where: { userId: user.id } }),
  ]);

  const letters = recipients.map((r) => ({
    ...r.letter,
    isRead: r.isRead,
    readAt: r.readAt,
  }));

  const unreadCount = await db.letterRecipient.count({
    where: { userId: user.id, isRead: false },
  });

  return NextResponse.json({
    letters,
    total,
    unreadCount,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}

// ════════════════════════════════════════════════════════
//  LIST SENT
// ════════════════════════════════════════════════════════
async function handleListSent(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.send_letters) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده نامه‌های ارسالی را ندارید.' }, { status: 403 });
  }

  const { page = 1, pageSize = 20 } = body as { page?: number; pageSize?: number };

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [letters, total] = await Promise.all([
    db.letter.findMany({
      where: { senderId: user.id },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      include: {
        recipients: { select: { userId: true, isRead: true } },
      },
    }),
    db.letter.count({ where: { senderId: user.id } }),
  ]);

  return NextResponse.json({
    letters,
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
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده نامه را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه نامه الزامی است.' }, { status: 400 });
  }

  const letter = await db.letter.findUnique({
    where: { id },
    include: {
      recipients: true,
    },
  });

  if (!letter) {
    return NextResponse.json({ error: 'نامه یافت نشد.' }, { status: 404 });
  }

  // Verify user is sender or recipient
  const isSender = letter.senderId === user.id;
  const isRecipient = letter.recipients.some((r) => r.userId === user.id);
  if (!isSender && !isRecipient) {
    return NextResponse.json({ error: 'شما دسترسی مشاهده این نامه را ندارید.' }, { status: 403 });
  }

  return NextResponse.json({ letter });
}

// ════════════════════════════════════════════════════════
//  DIRECTORY — minimal user list for compose (v2.19.0)
//  Compose used to require manage_users, so regular users with
//  send_letters saw an empty recipient picker. This action returns
//  the caller's own business-unit colleagues: id + displayName only.
// ════════════════════════════════════════════════════════
async function handleDirectory(user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox && !perms.send_letters) {
    return NextResponse.json({ error: 'شما دسترسی صندوق پستی را ندارید.' }, { status: 403 });
  }

  // v2.35.0 — isolated-company staff (یاس طب) never mix into the group
  // directory, and vice versa: the recipient picker follows the shared
  // colleague-visibility rule instead of the raw business-unit list.
  const colleagueIds = await visibleColleagueUserIds(user);
  const users = await db.user.findMany({
    where: {
      businessUnitId: user.businessUnitId,
      isActive: true,
      id: { in: colleagueIds, not: user.id },
    },
    select: { id: true, displayName: true, roleLabel: true, role: true },
    orderBy: { displayName: 'asc' },
    take: 200,
  });

  return NextResponse.json({ users });
}

// ════════════════════════════════════════════════════════
//  SEND — create letter with recipients
// ════════════════════════════════════════════════════════
async function handleSend(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.send_letters) {
    return NextResponse.json({ error: 'شما دسترسی ارسال نامه را ندارید.' }, { status: 403 });
  }

  const { subject, body: letterBody, recipientIds } = body as {
    subject?: string;
    body?: string;
    recipientIds?: string[];
  };

  const subjectText = (subject || '').trim();
  const bodyText = letterBody || '';

  if (!subjectText) {
    return NextResponse.json({ error: 'موضوع نامه الزامی است.' }, { status: 400 });
  }
  if (subjectText.length > 200) {
    return NextResponse.json({ error: 'موضوع نامه نباید از ۲۰۰ نویسه بیشتر باشد.' }, { status: 400 });
  }
  if (bodyText.length > 8000) {
    return NextResponse.json({ error: 'متن نامه نباید از ۸۰۰۰ نویسه بیشتر باشد.' }, { status: 400 });
  }

  if (!recipientIds || !Array.isArray(recipientIds) || recipientIds.length === 0) {
    return NextResponse.json({ error: 'حداقل یک گیرنده باید انتخاب شود.' }, { status: 400 });
  }
  if (recipientIds.length > 50) {
    return NextResponse.json({ error: 'حداکثر ۵۰ گیرنده در هر نامه.' }, { status: 400 });
  }

  // Validate recipients: must exist AND belong to the sender's business
  // unit — internal mail never crosses the tenant boundary (v2.19.0).
  // v2.35.0 — and never crosses the isolation wall either (group staff
  // cannot mail یاس طب staff and vice versa).
  const colleagueIds = await visibleColleagueUserIds(user);
  const validRecipientIds = recipientIds.filter((rid) => colleagueIds.includes(rid));
  const recipients = await db.user.findMany({
    where: { id: { in: validRecipientIds }, businessUnitId: user.businessUnitId },
    select: { id: true },
  });

  if (recipients.length !== recipientIds.length) {
    return NextResponse.json({ error: 'برخی از گیرندگان معتبر نیستند.' }, { status: 400 });
  }

  const letter = await db.letter.create({
    data: {
      subject: subjectText,
      body: bodyText,
      senderId: user.id,
      recipients: {
        create: recipientIds.map((userId) => ({ userId })),
      },
    },
    include: {
      recipients: true,
    },
  });

  return NextResponse.json({ message: 'نامه با موفقیت ارسال شد.', letter }, { status: 201 });
}

// ════════════════════════════════════════════════════════
//  MARK READ
// ════════════════════════════════════════════════════════
async function handleMarkRead(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox) {
    return NextResponse.json({ error: 'شما دسترسی ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه نامه الزامی است.' }, { status: 400 });
  }

  const recipient = await db.letterRecipient.findFirst({
    where: { letterId: id, userId: user.id },
  });

  if (!recipient) {
    return NextResponse.json({ error: 'نامه یافت نشد.' }, { status: 404 });
  }

  await db.letterRecipient.update({
    where: { id: recipient.id },
    data: { isRead: true, readAt: new Date() },
  });

  return NextResponse.json({ message: 'نامه به عنوان خوانده‌شده علامت‌گذاری شد.' });
}

// ════════════════════════════════════════════════════════
//  MARK UNREAD
// ════════════════════════════════════════════════════════
async function handleMarkUnread(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox) {
    return NextResponse.json({ error: 'شما دسترسی ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه نامه الزامی است.' }, { status: 400 });
  }

  const recipient = await db.letterRecipient.findFirst({
    where: { letterId: id, userId: user.id },
  });

  if (!recipient) {
    return NextResponse.json({ error: 'نامه یافت نشد.' }, { status: 404 });
  }

  await db.letterRecipient.update({
    where: { id: recipient.id },
    data: { isRead: false, readAt: null },
  });

  return NextResponse.json({ message: 'نامه به عنوان خوانده‌نشده علامت‌گذاری شد.' });
}

// ════════════════════════════════════════════════════════
//  DELETE
// ════════════════════════════════════════════════════════
async function handleDelete(body: Record<string, unknown>, user: AuthUser) {
  const perms = getRolePermissions(user.role);
  if (!perms.send_letters) {
    return NextResponse.json({ error: 'شما دسترسی حذف نامه را ندارید.' }, { status: 403 });
  }

  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه نامه الزامی است.' }, { status: 400 });
  }

  const letter = await db.letter.findUnique({ where: { id } });
  if (!letter) {
    return NextResponse.json({ error: 'نامه یافت نشد.' }, { status: 404 });
  }

  if (letter.senderId !== user.id) {
    return NextResponse.json({ error: 'فقط فرستنده می‌تواند نامه را حذف کند.' }, { status: 403 });
  }

  await db.letter.delete({ where: { id } });

  return NextResponse.json({ message: 'نامه با موفقیت حذف شد.' });
}

// ════════════════════════════════════════════════════════
//  UNREAD COUNT
// ════════════════════════════════════════════════════════
async function handleUnreadCount(user: AuthUser) {
  // Same read gate as every other mailbox action (v2.19.0 — was ungated).
  const perms = getRolePermissions(user.role);
  if (!perms.mailbox) {
    return NextResponse.json({ error: 'شما دسترسی صندوق پستی را ندارید.' }, { status: 403 });
  }
  const count = await db.letterRecipient.count({
    where: { userId: user.id, isRead: false },
  });
  return NextResponse.json({ count });
}
