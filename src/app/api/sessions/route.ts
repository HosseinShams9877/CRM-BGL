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
    if (action === 'revoke') return await handleRevoke(body, user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('sessions', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════
//  LIST — active sessions
// ════════════════════════════════════════════════════════
async function handleList(_body: Record<string, unknown>, _user: AuthUser) {
  // v2.31.3: Session.id is the SHA-256 of the cookie token, NOT the token
  // itself (round-31 leak: this list used to return the raw id, which was
  // bit-for-bit the cookie value — anyone who could read this response
  // could BE any user). The id below is a non-invertible digest: safe to
  // display, useless as a credential, and still the key for `revoke`.
  const sessions = await db.session.findMany({
    where: { revokedAt: null },
    orderBy: { lastSeenAt: 'desc' },
  });

  return NextResponse.json({ sessions });
}

// ════════════════════════════════════════════════════════
//  REVOKE
// ════════════════════════════════════════════════════════
async function handleRevoke(body: Record<string, unknown>, user: AuthUser) {
  const { id } = body as { id: string };
  if (!id) {
    return NextResponse.json({ error: 'شناسه نشست الزامی است.' }, { status: 400 });
  }

  const session = await db.session.findUnique({ where: { id } });
  if (!session) {
    return NextResponse.json({ error: 'نشست یافت نشد.' }, { status: 404 });
  }

  if (session.userId === user.id) {
    return NextResponse.json({ error: 'شما نمی‌توانید نشست خود را از اینجا ابطال کنید.' }, { status: 400 });
  }

  await db.session.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ message: 'نشست با موفقیت ابطال شد.' });
}