import { db } from '@/lib/db';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { forScope } from '@/lib/logger';
import { getSessionMaxAgeMinutes } from '@/lib/security-policy';
import { getCanonicalRole } from '@/lib/roles';

export { getCanonicalRole };

const authLog = forScope('auth');

// v2.47.0 — password hashing parameters. PBKDF2-HMAC-SHA512 with
// 210,000 iterations (OWASP 2023 guidance; the old 10,000 was ~20×
// below it — a commodity GPU cluster burned through it far too
// cheaply). Stored format is versioned:
//   pbkdf2$<iterations>$<salt-hex>$<hash-hex>      ← v2 (this round)
//   <salt-hex>:<hash-hex>                           ← v1 (≤2.46, 10k)
//   $2a$/$2b$/$2y$…                                 ← bcrypt (PHP imports)
// verifyPassword() reads the format; login transparently REHASHES
// v1/bcrypt hashes to v2 on the first successful login (see the auth
// route) so the whole user base converges without a migration outage.
export const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';

const SESSION_COOKIE = 'bgl_session';
const SESSION_MAX_AGE = 43200; // 12 hours (seconds) — legacy default;
// v2.18.0: the effective idle-expiry comes from the admin-configurable
// security.session_minutes setting (falls back to this value).

// v2.47.0 — lastSeenAt write throttle: the old code wrote lastSeenAt on
// EVERY request (one UPDATE per API call, plus WAL churn). The sliding
// window only needs minute resolution — a 60s touch interval keeps the
// expiry semantics while cutting session-table writes ~99% under load.
const SESSION_TOUCH_INTERVAL_MS = 60_000;

// v2.47.0 — one-time-per-process audit of a broken territory assignment
// (fail-closed denies the user; the admin needs to know WHY). A Set keeps
// the hot path allocation-free after the first occurrence.
const territoryWarnedUserIds = new Set<string>();

// Secret used to derive login-attempt keys. MUST be provided via environment
// variable in production (see .env.example). A dev-only fallback is kept so
// local setups do not break, but it is loudly warned about.
// v2.58.0 (audit 85-a #8): production without BGL_HMAC_SECRET now falls
// back to a PER-PROCESS random secret (throttle keys simply reset on
// restart) instead of a hard-coded constant shared by every installation
// — scripts/start.mjs already fails fast in that situation; this covers
// odd launch paths (bare `next start`).
const LOGIN_ATTEMPT_SECRET =
  process.env.BGL_HMAC_SECRET ||
  (() => {
    if (process.env.NODE_ENV === 'production') {
      authLog.warn('BGL_HMAC_SECRET is not set — using a per-process random secret (throttle counters reset on restart). Set it in .env');
      return crypto.randomBytes(32).toString('hex');
    }
    return 'bgl-secret-dev-fallback';
  })();

export function getLoginAttemptSecret(): string {
  return LOGIN_ATTEMPT_SECRET;
}

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
  roleLabel: string;
  /** Job-title key from the access registry (drives sidebar menus). */
  jobTitle: string | null;
  businessUnitId: string;
  isActive: boolean;
  /** Slugs of companies this user may access. Admins bypass this list. */
  companyIds: string[];
  /** v2.41.0 (r57 port) — Sales Territory assignment (see lib/territory-scope).
   *  country/provinces/centers + the JSON column values; standard-role
   *  users with a restricted mode get every DB query auto-scoped. */
  territoryMode: string;
  territoryProvinces: string | null;
  territoryCenterIds: string | null;
  /** v2.34.6 — set when this session is an admin impersonation of another
   *  user: identifies the admin who switched into the account, so the UI
   *  can show a banner and offer a one-click return. Null on normal
   *  sessions. Impersonation sessions cannot themselves impersonate. */
  impersonator: { id: string; displayName: string } | null;
}

export interface RolePermissions {
  view_centers: boolean;
  edit_centers: boolean;
  create_centers: boolean;
  finance_write: boolean;
  product_create: boolean;
  view_reports: boolean;
  sales_report_write: boolean;
  mailbox: boolean;
  send_letters: boolean;
  calendar: boolean;
  personal_notes: boolean;
  upload_files: boolean;
  accounting_cartable: boolean;
  production_unit: boolean;
  view_other_sales_documents: boolean;
  export_data: boolean;
  archive_centers: boolean;
  manage_users: boolean;
  system_status: boolean;
  void_financial: boolean;
  manage_database: boolean;
  view_audit: boolean;
  manage_security: boolean;
  // v2.27.0 — AI Sales Intelligence permissions (ai.*)
  ai_calls_read: boolean;        // مشاهده تماس‌های تحلیل‌شده شرکت خود
  ai_transcript_read: boolean;   // خواندن متن مکالمه (داده حساس)
  ai_coaching_read: boolean;     // مشاهده کوچینگ
  ai_manager_dashboard: boolean; // داشبورد هوش مدیریتی (کراس‌کاربر)
  ai_playbook_manage: boolean;   // مدیریت پلی‌بوک
  ai_settings_manage: boolean;   // تنظیمات هوش مصنوعی
  ai_usage_view: boolean;        // گزارش مصرف و هزینه
  // v2.58.4 (user issue 2) — global AI bridge prompt templates are a
  // shared, everyone-chats-with-them asset: list/create/update/delete
  // is gated on this DEDICATED permission (admin holds it; every other
  // role must not silently mutate the shared prompts).
  ai_prompt_manage: boolean;     // مدیریت الگوهای سراسری پرامپت
}

/** v2.58.4 (user issue 4): the canonical mapper lives in src/lib/roles.ts.
 *  normalizeRole is kept as an alias — dozens of call sites import it
 *  from here; both names now delegate to getCanonicalRole(). */
export function normalizeRole(role: string): string {
  return getCanonicalRole(role);
}

export function getRolePermissions(role: string): RolePermissions {
  const r = normalizeRole(role);
  const shared: RolePermissions = {
    view_centers: true, edit_centers: true, create_centers: true,
    finance_write: true, product_create: true, view_reports: true,
    sales_report_write: true, mailbox: true, send_letters: true,
    calendar: true, personal_notes: true, upload_files: true,
    accounting_cartable: false, production_unit: false,
    view_other_sales_documents: false, export_data: false,
    archive_centers: false, manage_users: false, system_status: false,
    void_financial: false, manage_database: false, view_audit: false,
    manage_security: false,
    // v2.27.0 — AI Sales Intelligence: sales experts get call/coach access
    // to their own company; manager dashboards & settings stay admin-only.
    // v2.58.4 (issue 2): prompt templates stay admin-only by default.
    ai_calls_read: true, ai_transcript_read: true, ai_coaching_read: true,
    ai_manager_dashboard: false, ai_playbook_manage: false,
    ai_settings_manage: false, ai_usage_view: false,
    ai_prompt_manage: false,
  };
  if (r === 'admin') return { ...shared,
    production_unit: true, export_data: true, archive_centers: true,
    manage_users: true, system_status: true, void_financial: true,
    manage_database: true, view_audit: true, manage_security: true,
    accounting_cartable: true, view_other_sales_documents: true,
    ai_calls_read: true, ai_transcript_read: true, ai_coaching_read: true,
    ai_manager_dashboard: true, ai_playbook_manage: true,
    ai_settings_manage: true, ai_usage_view: true,
    ai_prompt_manage: true };
  if (r === 'finance') return {
    view_centers: false, edit_centers: false, create_centers: false,
    finance_write: true, product_create: false, view_reports: false,
    sales_report_write: false, mailbox: true, send_letters: true,
    calendar: false, personal_notes: false, upload_files: true,
    accounting_cartable: true, production_unit: false,
    view_other_sales_documents: true, export_data: false,
    archive_centers: false, manage_users: false, system_status: false,
    void_financial: false, manage_database: false, view_audit: false,
    manage_security: false,
    // v2.27.0 — AI Sales Intelligence: no AI access for finance.
    ai_calls_read: false, ai_transcript_read: false, ai_coaching_read: false,
    ai_manager_dashboard: false, ai_playbook_manage: false,
    ai_settings_manage: false, ai_usage_view: false,
    ai_prompt_manage: false,
  };
  if (r === 'production') return {
    view_centers: true, edit_centers: true, create_centers: true,
    finance_write: false, product_create: true, view_reports: true,
    sales_report_write: false, mailbox: true, send_letters: true,
    calendar: true, personal_notes: true, upload_files: true,
    accounting_cartable: false, production_unit: true,
    view_other_sales_documents: false, export_data: false,
    archive_centers: false, manage_users: false, system_status: false,
    void_financial: false, manage_database: false, view_audit: false,
    manage_security: false,
    // v2.27.0 — AI Sales Intelligence: no AI access for production.
    ai_calls_read: false, ai_transcript_read: false, ai_coaching_read: false,
    ai_manager_dashboard: false, ai_playbook_manage: false,
    ai_settings_manage: false, ai_usage_view: false,
    ai_prompt_manage: false,
  };
  return shared;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

/** v2.47.0 — does this stored hash need an upgrade to the current scheme?
 *  True for bcrypt imports, the legacy 10k `salt:hash` format, and any
 *  v2 hash whose iteration count is below the current floor. */
export function needsRehash(stored: string): boolean {
  if (!stored) return true;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) return true;
  if (stored.startsWith('pbkdf2$')) {
    const iter = Number(stored.split('$')[1]);
    return !Number.isFinite(iter) || iter < PBKDF2_ITERATIONS;
  }
  return true; // legacy salt:hash (10k) or unknown format
}

/** Parse the JSON-encoded company slugs stored on a user row. */
export function parseCompanyIds(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/**
 * Can this user access data of the given company slug?
 * - 'holding' (group-wide aggregate view) is admin-only.
 * - Admins can access every company.
 * - Everyone else is restricted to their assigned company slugs.
 * v2.58.4 (issue 4): the check goes through getCanonicalRole() — a
 * legacy 'administrator' row gets the same admin behavior as 'admin'.
 */
export function canAccessCompany(user: AuthUser, slug: string): boolean {
  if (getCanonicalRole(user.role) === 'admin') return true;
  if (slug === 'holding' || slug === 'all' || !slug) return false;
  return user.companyIds.includes(slug);
}

export function verifyPassword(password: string, stored: string): boolean {
  // Legacy imports from the previous PHP system (MariaDB dump) carry bcrypt
  // hashes ($2y$ / $2a$ / $2b$). Verify those transparently so imported
  // users keep their existing passwords. New/changed passwords are stored
  // with the PBKDF2 schemes below; the login route rehashes these on the
  // first successful login (needsRehash).
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(password, stored);
    } catch {
      return false;
    }
  }
  // v2.47.0 — versioned format: pbkdf2$<iter>$<salt>$<hash>
  if (stored.startsWith('pbkdf2$')) {
    const parts = stored.split('$');
    if (parts.length !== 4) return false;
    const iter = Number(parts[1]);
    const salt = parts[2];
    const hash = parts[3];
    // an attacker-written row must not choose the cost factor: refuse
    // anything that is not a sane positive integer (incl. huge values
    // that would hang the process).
    if (!Number.isInteger(iter) || iter < 1 || iter > 10_000_000) return false;
    if (!/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash)) return false;
    const verify = crypto
      .pbkdf2Sync(password, salt, iter, PBKDF2_KEYLEN, PBKDF2_DIGEST)
      .toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(verify, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  }
  // v1 legacy format: <salt>:<hash> at 10,000 iterations
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  if (salt.includes('$') || !/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(hash)) return false;
  const verify = crypto.pbkdf2Sync(password, salt, 10_000, 64, 'sha512').toString('hex');
  // v2.47.0 — timingSafeEqual throws RangeError on unequal buffer lengths;
  // a malformed/legacy stored hash (wrong hex length) must simply FAIL,
  // not crash the login handler.
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(verify, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * v2.31.3 — SHA-256 of a raw session token. The Session row's `id` IS this
 * hash, NEVER the token itself: the cookie carries the raw token, and any
 * surface that exposes row ids (the admin sessions screen, a DB dump, a
 * backup) therefore leaks a non-invertible digest, not a credential.
 * Round-31 leak this fixes: /api/sessions returned the raw id, which was
 * bit-for-bit the cookie value — anyone who could list sessions could
 * BE any user by setting the cookie. High-entropy random tokens need no
 * salt/pepper here (same construction as Laravel Sanctum / Rails).
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createSession(userId: string, displayName: string, browserName: string, ipHash: string, impersonatedBy?: string): Promise<string> {
  // The raw token goes ONLY to the cookie; the row stores its SHA-256.
  const token = crypto.randomBytes(32).toString('hex');
  await db.session.create({
    data: { id: hashSessionToken(token), userId, displayName, browserName, ipHash, ...(impersonatedBy ? { impersonatedBy } : {}) },
  });
  return token;
}

export async function validateSession(sessionToken: string): Promise<AuthUser | null> {
  // v2.31.3: lookup by the token's SHA-256 — the raw token never touches
  // the database as a key (and a leaked row id cannot be replayed as a
  // cookie: sha256(hash) matches no row).
  const session = await db.session.findUnique({ where: { id: hashSessionToken(sessionToken) } });
  if (!session || session.revokedAt) return null;

  // Server-side sliding expiry: a session is invalid if it has been idle
  // longer than the configured session length. The cookie maxAge alone is
  // NOT enough. (v2.18.0: length is admin-configurable, cached ~60s.)
  const maxAgeSeconds = (await getSessionMaxAgeMinutes()) * 60;
  const lastSeen = new Date(session.lastSeenAt).getTime();
  if (Number.isNaN(lastSeen) || Date.now() - lastSeen > maxAgeSeconds * 1000) {
    await db.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
    return null;
  }

  // v2.47.0 — touch throttle: only refresh lastSeenAt when it is stale by
  // more than the touch interval (see SESSION_TOUCH_INTERVAL_MS).
  if (Date.now() - lastSeen > SESSION_TOUCH_INTERVAL_MS) {
    await db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  const user = await db.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.isActive) return null;

  // v2.47.0 — a corrupted/unknown territory assignment now resolves to
  // ZERO access (fail-closed, lib/territory-scope). Surface it once per
  // process per user so an admin can repair the row instead of wondering
  // why the user «cannot see anything».
  if (!territoryWarnedUserIds.has(user.id)) {
    const { territoryConfigProblem } = await import('@/lib/territory-scope');
    const problem = territoryConfigProblem({
      role: user.role,
      territoryMode: user.territoryMode,
      territoryProvinces: user.territoryProvinces,
      territoryCenterIds: user.territoryCenterIds,
    });
    if (problem) {
      territoryWarnedUserIds.add(user.id);
      await db.auditEvent.create({
        data: {
          eventType: 'TERRITORY_CONFIG_INVALID',
          category: 'security',
          subject: user.username,
          userId: user.id,
          details: `دسترسی قلمرو این کاربر fail-closed شده است — ${problem}`,
        },
      }).catch(() => undefined); // best-effort: auth must not fail on audit-write errors
    }
  }

  // v2.34.6 — resolve the impersonating admin (if any) for the banner UI.
  let impersonator: { id: string; displayName: string } | null = null;
  if (session.impersonatedBy) {
    const admin = await db.user.findUnique({
      where: { id: session.impersonatedBy },
      select: { id: true, displayName: true },
    });
    impersonator = admin ? { id: admin.id, displayName: admin.displayName } : { id: session.impersonatedBy, displayName: 'مدیر حذف‌شده' };
  }

  return {
    id: user.id, username: user.username, displayName: user.displayName,
    // v2.58.4 (user issue 4) — the session carries the CANONICAL role:
    // every downstream `user.role === 'admin'` comparison (company
    // scope, users, files, AI settings, …) then behaves identically
    // for legacy DB rows ('administrator' etc.) and canonical ones.
    // getRolePermissions normalizes defensively anyway; this closes
    // the ~40 raw-string comparisons at their SOURCE.
    role: getCanonicalRole(user.role), roleLabel: user.roleLabel, jobTitle: user.jobTitle || null,
    businessUnitId: user.businessUnitId, isActive: user.isActive,
    companyIds: parseCompanyIds(user.companyIds),
    territoryMode: user.territoryMode || 'country',
    territoryProvinces: user.territoryProvinces ?? null,
    territoryCenterIds: user.territoryCenterIds ?? null,
    impersonator,
  };
}

/** Delete sessions that have been idle for more than 30 days (housekeeping). */
export async function purgeStaleSessions(): Promise<void> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  await db.session.deleteMany({ where: { lastSeenAt: { lt: cutoff } } }).catch(() => undefined);
}

/**
 * Revoke every active session of the given user. Used after role/company/password changes.
 * v2.31.3: `exceptSessionToken` is the RAW cookie token of the session that
 * must survive (hashed internally — callers pass the cookie value as-is).
 */
export async function revokeAllUserSessions(userId: string, exceptSessionToken?: string): Promise<void> {
  const exceptId = exceptSessionToken ? hashSessionToken(exceptSessionToken) : undefined;
  await db.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    data: { revokedAt: new Date() },
  }).catch(() => undefined);
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionId) return null;
  return validateSession(sessionId);
}

export { SESSION_COOKIE, SESSION_MAX_AGE };
