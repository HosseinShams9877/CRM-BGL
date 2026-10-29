import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  hashPassword, verifyPassword, needsRehash, createSession, validateSession,
  getLoginAttemptSecret, purgeStaleSessions,
  hashSessionToken,
} from '@/lib/auth';
import { normalizeRole } from '@/lib/auth';
import { getJobTitleRegistry } from '@/lib/access-server';
import { loginSchema, changePasswordSchema, parseBody } from '@/lib/validators';
import { changeOwnPassword, describePasswordPolicy } from '@/lib/password-service';
import { getPasswordPolicy } from '@/lib/security-policy';
import crypto from 'crypto';
import { clientIpOf } from '@/lib/rate-limit';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { getSessionMaxAgeMinutes } from '@/lib/security-policy';

const MAX_FAILURES = 5;
const BLOCK_SECONDS = 900;

// Cookie 'secure' flag: enabled in production unless explicitly disabled for
// plain-HTTP LAN deployments (set COOKIE_SECURE=false in .env in that case).
function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

// v2.47.0 — the cookie maxAge used to be a hardcoded 43200s (12h) while the
// server-side sliding expiry is admin-configurable (security.session_minutes,
// default 720). A shorter configured session left a dead cookie that kept
// triggering /api/auth/check round-trips; a longer one expired early in the
// browser. The cookie now mirrors the ACTUAL effective session length.
async function sessionCookieMaxAge(): Promise<number> {
  return (await getSessionMaxAgeMinutes()) * 60;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'login') return await handleLogin(body, req);
    if (action === 'check') return await handleCheck(req);
    if (action === 'logout') return await handleLogout(req);
    if (action === 'change-password') return await handleChangePassword(body, req);
    if (action === 'password-policy') return await handlePasswordPolicy();
    if (action === 'impersonate') return await handleImpersonate(body, req);
    if (action === 'impersonate-exit') return await handleImpersonateExit(req);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleLogin(body: Record<string, unknown>, req: NextRequest) {
  const parsed = parseBody(loginSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { username, password } = parsed.data;

  // v2.47.0 — clientIpOf: spoofable XFF is IGNORED unless TRUSTED_PROXY=true
  // (this key feeds the brute-force throttle — a rotating fake XFF used to
  // mint a fresh bucket per attempt, defeating MAX_FAILURES entirely).
  const ip = clientIpOf(req.headers);
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  // Brute-force throttle key: HMAC(secret, user|ip) — the secret MUST be the
  // HMAC key (the previous 3-arg call passed it as an options object, so it
  // was silently ignored — a real bug hidden by ignoreBuildErrors).
  const attemptKey = crypto
    .createHmac('sha256', getLoginAttemptSecret())
    .update(username.trim().toLowerCase() + '|' + ipHash)
    .digest('hex');

  // Check if blocked
  const existing = await db.loginAttempt.findUnique({ where: { attemptKey } });
  if (existing && existing.blockedUntil && new Date(existing.blockedUntil) > new Date()) {
    return NextResponse.json({ error: 'حساب شما موقتاً مسدود شده. لطفاً چند دقیقه بعد تلاش کنید.' }, { status: 429 });
  }

  const user = await db.user.findUnique({ where: { username: username.trim() } });
  if (!user || !user.isActive || !verifyPassword(password, user.passwordHash)) {
    // Record failure
    const failures = (existing?.failures || 0) + 1;
    const blocked = failures >= MAX_FAILURES ? new Date(Date.now() + BLOCK_SECONDS * 1000) : null;
    await db.loginAttempt.upsert({
      where: { attemptKey },
      update: { failures, lastFailedAt: new Date(), blockedUntil: blocked },
      create: { attemptKey, userId: user?.id, failures, firstFailedAt: new Date(), lastFailedAt: new Date(), blockedUntil: blocked },
    });
    // Audit
    await db.auditEvent.create({ data: { eventType: 'LOGIN_FAILED', category: 'authentication', subject: username } });
    return NextResponse.json({ error: 'نام کاربری یا رمز عبور اشتباه است' }, { status: 401 });
  }

  // Clear failures
  if (existing) await db.loginAttempt.delete({ where: { id: existing.id } });

  // v2.47.0 — transparent hash upgrade: a successful login against a
  // legacy format (bcrypt import, 10k-iteration v1, or a below-floor
  // iteration count) rewrites the stored hash to the CURRENT scheme.
  // The user notices nothing; the row converges to PBKDF2-210k without
  // a forced password-reset campaign. Best-effort only — a failure here
  // must never block the login itself.
  if (needsRehash(user.passwordHash)) {
    try {
      await db.user.update({
        where: { id: user.id },
        data: { passwordHash: hashPassword(password) },
      });
      await db.auditEvent.create({
        data: {
          eventType: 'PASSWORD_HASH_UPGRADED',
          category: 'authentication',
          subject: user.username,
          userId: user.id,
          details: 'ارتقای خودکار قالب هش به PBKDF2-210k پس از ورود موفق',
        },
      });
    } catch {
      // next successful login will retry the upgrade
    }
  }

  // Create session
  const ua = req.headers.get('user-agent') || '';
  let browserName = 'نامشخص';
  if (ua.includes('Firefox')) browserName = 'Firefox';
  else if (ua.includes('Edg')) browserName = 'Edge';
  else if (ua.includes('Chrome')) browserName = 'Chrome';
  else if (ua.includes('Safari')) browserName = 'Safari';

  const sessionId = await createSession(user.id, user.displayName, browserName, ipHash);

  // Opportunistic housekeeping: drop sessions idle for 30+ days
  await purgeStaleSessions();

  // Audit
  await db.auditEvent.create({ data: { eventType: 'LOGIN_SUCCESS', category: 'authentication', subject: username, userId: user.id } });

  const role = normalizeRole(user.role);
  const roleLabels: Record<string, string> = { admin: 'مدیر سیستم', finance: 'واحد مالی', production: 'واحد تولید', standard: 'کاربر عادی' };

  // Resolve job-title label (registry falls back to built-in defaults)
  const registry = await getJobTitleRegistry().catch(() => []);
  const jobTitleEntry = user.jobTitle ? registry.find((t) => t.key === user.jobTitle) : undefined;

  // Parse accessible companies
  let accessibleCompanies: string[] = [];
  try { const p = JSON.parse(user.companyIds || '[]'); if (Array.isArray(p)) accessibleCompanies = p; } catch { /* */ }
  if (role === 'admin') accessibleCompanies = []; // admin sees all

  const response = NextResponse.json({
    user: {
      id: user.id, username: user.username, displayName: user.displayName,
      role, roleLabel: jobTitleEntry?.label || roleLabels[role] || 'کاربر عادی',
      jobTitle: user.jobTitle || null,
      businessUnitId: user.businessUnitId,
      isAdmin: role === 'admin', isFinance: role === 'finance', isProduction: role === 'production',
      accessibleCompanies,
    },
  });

  response.cookies.set('bgl_session', sessionId, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax',
    maxAge: await sessionCookieMaxAge(),
    path: '/',
  });

  return response;
}

async function handleCheck(req: NextRequest) {
  const sessionId = req.cookies.get('bgl_session')?.value;
  if (!sessionId) return NextResponse.json({ authenticated: false });

  // v2.11.1: route through validateSession so the 12h sliding expiry and
  // revocation are enforced here. This handler previously refreshed
  // lastSeenAt DIRECTLY — a session idle for more than 12h (dead cookie)
  // was silently revived on every poll and stayed valid forever.
  const authUser = await validateSession(sessionId);
  if (!authUser) return NextResponse.json({ authenticated: false });

  const role = normalizeRole(authUser.role);
  const roleLabels: Record<string, string> = { admin: 'مدیر سیستم', finance: 'واحد مالی', production: 'واحد تولید', standard: 'کاربر عادی' };

  // Resolve job-title label (registry falls back to built-in defaults)
  const registry = await getJobTitleRegistry().catch(() => []);
  const jobTitleEntry = authUser.jobTitle ? registry.find((t) => t.key === authUser.jobTitle) : undefined;

  // Accessible companies — admins see all (empty list means unrestricted)
  const accessibleCompanies = role === 'admin' ? [] : authUser.companyIds;

  // Count unread mail
  const unread = await db.letterRecipient.count({ where: { userId: authUser.id, isRead: false } });

  return NextResponse.json({
    authenticated: true,
    user: {
      id: authUser.id, username: authUser.username, displayName: authUser.displayName,
      role, roleLabel: jobTitleEntry?.label || roleLabels[role] || 'کاربر عادی',
      jobTitle: authUser.jobTitle,
      businessUnitId: authUser.businessUnitId,
      isAdmin: role === 'admin', isFinance: role === 'finance', isProduction: role === 'production',
      accessibleCompanies,
    },
    // v2.34.6 — impersonation banner: who switched into this account
    impersonating: authUser.impersonator ? { byId: authUser.impersonator.id, byName: authUser.impersonator.displayName } : null,
    unreadMail: unread,
  });
}

// ══════════════════════════════════════════════════════════
// v2.34.6 — ADMIN IMPERSONATION
// An admin may temporarily operate another user's account to reproduce
// what that user sees (scoped menus, companies, dashboards). Security
// rules: (1) admin-only, (2) no chaining — an impersonation session can
// never impersonate again, (3) every start/exit writes an audit event,
// (4) exit revokes the impersonation session and issues a fresh admin
// session. The banner in the UI makes the state impossible to miss.
// ══════════════════════════════════════════════════════════
async function handleImpersonate(body: Record<string, unknown>, req: NextRequest) {
  const sessionToken = req.cookies.get('bgl_session')?.value;
  if (!sessionToken) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
  const admin = await validateSession(sessionToken);
  if (!admin) return NextResponse.json({ error: 'نشست نامعتبر یا منقضی شده است' }, { status: 401 });

  if (normalizeRole(admin.role) !== 'admin') {
    await db.auditEvent.create({ data: { eventType: 'IMPERSONATE_DENIED', category: 'security', subject: admin.username, details: 'تلاش کاربر غیرمدیر برای ورود به حساب دیگر' } });
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند به حساب کاربران وارد شود' }, { status: 403 });
  }
  // No chaining: an impersonation session cannot impersonate again.
  if (admin.impersonator) {
    return NextResponse.json({ error: 'در حالت مشاهدهٔ حساب کاربر نمی‌توان دوباره سوییچ کرد — ابتدا به حساب مدیر بازگردید' }, { status: 403 });
  }

  const { username } = body as { username?: string };
  const targetName = String(username || '').trim().toLowerCase();
  if (!targetName) return NextResponse.json({ error: 'نام کاربری الزامی است' }, { status: 400 });

  const target = await db.user.findUnique({ where: { username: targetName } });
  if (!target || !target.isActive) return NextResponse.json({ error: 'کاربر یافت نشد یا غیرفعال است' }, { status: 404 });
  if (target.id === admin.id) return NextResponse.json({ error: 'شما همین حالا هم با حساب خودتان هستید' }, { status: 400 });

  // v2.47.0 — clientIpOf (anti-spoof) for the impersonation session record
  const ip = clientIpOf(req.headers);
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  const ua = req.headers.get('user-agent') || '';
  const browserName = ua.includes('Firefox') ? 'Firefox' : ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Safari') ? 'Safari' : 'نامشخص';

  const token = await createSession(target.id, target.displayName, browserName + ' (نمای مدیر)', ipHash, admin.id);

  await db.auditEvent.create({ data: { eventType: 'IMPERSONATE_START', category: 'security', subject: target.username, userId: admin.id, details: `ورود مدیر ${admin.username} به حساب ${target.username}` } });

  const role = normalizeRole(target.role);
  const roleLabels: Record<string, string> = { admin: 'مدیر سیستم', finance: 'واحد مالی', production: 'واحد تولید', standard: 'کاربر عادی' };
  const registry = await getJobTitleRegistry().catch(() => []);
  const jobTitleEntry = target.jobTitle ? registry.find((t) => t.key === target.jobTitle) : undefined;
  let accessibleCompanies: string[] = [];
  try { const p = JSON.parse(target.companyIds || '[]'); if (Array.isArray(p)) accessibleCompanies = p; } catch { /* */ }
  if (role === 'admin') accessibleCompanies = [];

  const response = NextResponse.json({
    user: {
      id: target.id, username: target.username, displayName: target.displayName,
      role, roleLabel: jobTitleEntry?.label || roleLabels[role] || 'کاربر عادی',
      jobTitle: target.jobTitle || null,
      businessUnitId: target.businessUnitId,
      isAdmin: role === 'admin', isFinance: role === 'finance', isProduction: role === 'production',
      accessibleCompanies,
    },
    impersonating: { byId: admin.id, byName: admin.displayName },
  });
  response.cookies.set('bgl_session', token, { httpOnly: true, secure: cookieSecure(), sameSite: 'lax', maxAge: await sessionCookieMaxAge(), path: '/' });
  return response;
}

async function handleImpersonateExit(req: NextRequest) {
  const sessionToken = req.cookies.get('bgl_session')?.value;
  if (!sessionToken) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
  const current = await validateSession(sessionToken);
  if (!current) return NextResponse.json({ error: 'نشست نامعتبر یا منقضی شده است' }, { status: 401 });

  if (!current.impersonator) {
    return NextResponse.json({ error: 'این نشست در حالت مشاهدهٔ حساب کاربر نیست' }, { status: 400 });
  }

  const adminId = current.impersonator.id;
  const adminUser = await db.user.findUnique({ where: { id: adminId } });
  if (!adminUser || !adminUser.isActive) {
    return NextResponse.json({ error: 'حساب مدیر بازگشتی یافت نشد یا غیرفعال است — از خروج معمولی استفاده کنید' }, { status: 404 });
  }

  // Revoke the impersonation session, then issue a fresh admin session.
  await db.session.updateMany({
    where: { id: hashSessionToken(sessionToken), revokedAt: null },
    data: { revokedAt: new Date() },
  }).catch(() => undefined);

  // v2.47.0 — clientIpOf (anti-spoof) for the return-to-admin session record
  const ip = clientIpOf(req.headers);
  const ipHash = crypto.createHash('sha256').update(ip).digest('hex');
  const ua = req.headers.get('user-agent') || '';
  const browserName = ua.includes('Firefox') ? 'Firefox' : ua.includes('Edg') ? 'Edge' : ua.includes('Chrome') ? 'Chrome' : ua.includes('Safari') ? 'Safari' : 'نامشخص';
  const token = await createSession(adminUser.id, adminUser.displayName, browserName, ipHash);

  await db.auditEvent.create({ data: { eventType: 'IMPERSONATE_EXIT', category: 'security', subject: current.username, userId: adminUser.id, details: `بازگشت از حساب ${current.username} به حساب مدیر` } });

  const response = NextResponse.json({ success: true });
  response.cookies.set('bgl_session', token, { httpOnly: true, secure: cookieSecure(), sameSite: 'lax', maxAge: await sessionCookieMaxAge(), path: '/' });
  return response;
}

async function handleLogout(req: NextRequest) {
  const sessionToken = req.cookies.get('bgl_session')?.value;
  if (sessionToken) {
    // v2.31.3: rows are keyed by the token's SHA-256 — hash before lookup.
    // updateMany: an unknown/expired token must not throw here.
    await db.session.updateMany({
      where: { id: hashSessionToken(sessionToken), revokedAt: null },
      data: { revokedAt: new Date() },
    }).catch(() => undefined);
  }
  const response = NextResponse.json({ success: true });
  response.cookies.set('bgl_session', '', { maxAge: 0, path: '/' });
  return response;
}

// v2.58.3 (round 88, finding 7) — the personal change-password path now
// runs the SAME configurable central policy as the admin user-management
// route (lib/password-service.ts). A policy-rejected password leaves the
// hash AND every session untouched; no password or hash ever reaches a
// response or a log line.
async function handleChangePassword(body: Record<string, unknown>, req: NextRequest) {
  const sessionId = req.cookies.get('bgl_session')?.value;
  if (!sessionId) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });

  // v2.11.1: central validation — enforces the 12h expiry + revocation
  // (previously only existence and revokedAt were checked here).
  const authUser = await validateSession(sessionId);
  if (!authUser) return NextResponse.json({ error: 'نشست نامعتبر یا منقضی شده است' }, { status: 401 });

  const parsed = parseBody(changePasswordSchema, body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { currentPassword, newPassword } = parsed.data;

  try {
    await changeOwnPassword(authUser.id, currentPassword, newPassword, sessionId);
  } catch (e: unknown) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status === 'number' && e instanceof Error) {
      return NextResponse.json({ error: e.message }, { status });
    }
    throw e;
  }

  return NextResponse.json({ success: true, message: 'رمز عبور با موفقیت تغییر کرد' });
}

/** v2.58.3 — the CURRENT requirements are displayable to the user before
 *  they type a new password (policy flags + a Persian description; no
 *  secrets anywhere). */
async function handlePasswordPolicy() {
  const policy = await getPasswordPolicy();
  return NextResponse.json({
    policy: {
      minLength: policy.minLength,
      requireUpper: policy.requireUpper,
      requireNumber: policy.requireNumber,
      requireSpecial: policy.requireSpecial,
      description: describePasswordPolicy(policy),
    },
  });
}
