import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════
//  SECURITY POLICY — v2.18.0 (ninth-round audit)
//  The settings «امنیت و دسترسی» tab used to be local-only state with a
//  dead save button: nothing persisted and nothing was enforced. The
//  policy now lives in Meta and is READ BY THE REAL CODE PATHS:
//    • password rules  → /api/users create + password update
//    • session length  → session idle expiry in lib/auth
//  Values are cached for a short TTL so per-request reads stay cheap.
// ════════════════════════════════════════════════════════

export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
}

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUpper: false,
  requireNumber: true,
  requireSpecial: false,
};

const DEFAULT_SESSION_MINUTES = 720; // 12 hours

const CACHE_TTL_MS = 60_000;

let policyCache: { value: PasswordPolicy; at: number } | null = null;
let sessionCache: { value: number; at: number } | null = null;

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function readMeta(keys: string[]): Promise<Record<string, string>> {
  const rows = await db.meta.findMany({ where: { key: { in: keys } } });
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/** Current password policy (cached ~60s). */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  if (policyCache && Date.now() - policyCache.at < CACHE_TTL_MS) {
    return policyCache.value;
  }
  const meta = await readMeta([
    'security.password_min_length',
    'security.require_upper',
    'security.require_number',
    'security.require_special',
  ]);
  const value: PasswordPolicy = {
    minLength: clampInt(meta['security.password_min_length'], 4, 128, DEFAULT_POLICY.minLength),
    requireUpper: meta['security.require_upper'] === 'true',
    requireNumber: meta['security.require_number'] !== 'false', // default on
    requireSpecial: meta['security.require_special'] === 'true',
  };
  policyCache = { value, at: Date.now() };
  return value;
}

/** Test seam: drop the caches so policy changes apply immediately. */
export function resetSecurityPolicyCache(): void {
  policyCache = null;
  sessionCache = null;
}

/** Current session idle-expiry in minutes (cached ~60s). */
export async function getSessionMaxAgeMinutes(): Promise<number> {
  if (sessionCache && Date.now() - sessionCache.at < CACHE_TTL_MS) {
    return sessionCache.value;
  }
  const meta = await readMeta(['security.session_minutes']);
  const value = clampInt(meta['security.session_minutes'], 15, 10080, DEFAULT_SESSION_MINUTES);
  sessionCache = { value, at: Date.now() };
  return value;
}

/** Human-readable description of the current requirements (for the UI). */
export function describePasswordPolicy(policy: PasswordPolicy): string {
  const parts = [`حداقل ${policy.minLength} کاراکتر`];
  if (policy.requireUpper) parts.push('حداقل یک حرف بزرگ انگلیسی');
  if (policy.requireNumber) parts.push('حداقل یک عدد');
  if (policy.requireSpecial) parts.push('حداقل یک کاراکتر خاص (!@#…)');
  return parts.join('، ');
}

/** Validate a password against the current policy. Returns a Persian error
 *  message, or null when the password is acceptable. */
export async function validatePasswordAgainstPolicy(password: string): Promise<string | null> {
  const policy = await getPasswordPolicy();
  if (password.length < policy.minLength) {
    return `رمز عبور باید حداقل ${policy.minLength} کاراکتر باشد.`;
  }
  if (policy.requireUpper && !/[A-Z]/.test(password)) {
    return 'رمز عبور باید حداقل یک حرف بزرگ انگلیسی داشته باشد.';
  }
  if (policy.requireNumber && !/[0-9]/.test(password)) {
    return 'رمز عبور باید حداقل یک عدد داشته باشد.';
  }
  if (policy.requireSpecial && !/[^A-Za-z0-9]/.test(password)) {
    return 'رمز عبور باید حداقل یک کاراکتر خاص (!@#...) داشته باشد.';
  }
  return null;
}
