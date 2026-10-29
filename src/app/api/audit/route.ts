import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    // Admin only
    if (getCanonicalRole(user.role) !== 'admin') {
      return NextResponse.json({ error: 'فقط مدیر سیستم دسترسی دارد.' }, { status: 403 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'list') return await handleList(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('audit', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — with date/type/category filter
// ════════════════════════════════════════════════════════
async function handleList(body: Record<string, unknown>, _user: AuthUser) {
  const {
    page = 1,
    pageSize = 50,
    dateFrom,
    dateTo,
    eventType,
    category,
    userId,
  } = body as {
    page?: number;
    pageSize?: number;
    dateFrom?: string;
    dateTo?: string;
    eventType?: string;
    category?: string;
    userId?: string;
  };

  const where: Record<string, unknown> = {};

  if (dateFrom || dateTo) {
    const dateFilter: Record<string, unknown> = {};
    if (dateFrom) dateFilter.gte = new Date(dateFrom);
    if (dateTo) dateFilter.lte = new Date(dateTo);
    where.createdAt = dateFilter;
  }

  if (eventType) where.eventType = eventType;
  if (category) where.category = category;
  if (userId) where.userId = userId;

  // v2.58.0 (audit 85-a #6): page/pageSize clamped — NaN used to throw a
  // Prisma 500, huge pageSize dumped whole tables in one response.
  const p = Math.max(1, Math.min(Number.isFinite(Number(page)) ? Number(page) : 1, 500));
  const ps = Math.max(1, Math.min(Number.isFinite(Number(pageSize)) ? Number(pageSize) : 20, 100));
  const skip = (p - 1) * ps;
  const take = ps;

  const [items, total] = await Promise.all([
    db.auditEvent.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    db.auditEvent.count({ where }),
  ]);

  return NextResponse.json({
    items,
    total,
    page: p,
    pageSize: take,
    totalPages: Math.ceil(total / take),
  });
}
