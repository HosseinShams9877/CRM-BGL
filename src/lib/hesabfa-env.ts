// ════════════════════════════════════════════════════════════
// hesabfa-env.ts — v2.57.0 (round 83) unit credentials from env
//
// Spec (upload/حسابفا.txt): the legacy PHP CRM had TWO independent
// Hesabfa businesses — `production` (BGL serial-manufactured goods
// like OXAN / SmartCuff) and `trading` (medical consumables) — and
// their credentials live ONLY in Environment Variables:
//   HESABFA_PRODUCTION_API_KEY / HESABFA_PRODUCTION_LOGIN_TOKEN
//   HESABFA_TRADING_API_KEY    / HESABFA_TRADING_LOGIN_TOKEN
//   HESABFA_BASE_URL (default https://api.hesabfa.com/v1)
// Nothing is ever committed to Git, written to logs, or shipped to
// the client — this module is server-only and always masks secrets.
//
// The two units map onto CRM companies:
//   production → slug 'bgl'      (شرکت BGL)
//   trading    → slug 'bazargani' (بازرگانی)
// `ensureEnvConnections()` idempotently mirrors env credentials
// into the HesabfaConnection rows (single runtime source of truth
// for the sync engine, keeps lastTest/lastSync bookkeeping intact).
// Manual per-company credentials set from the settings UI keep
// working for every OTHER company (aria / yasteb / holding …).
// ════════════════════════════════════════════════════════════
import { db } from '@/lib/db';

export type HesabfaUnit = 'production' | 'trading';

/** Unit → CRM company slug (fixed by the group structure). */
export const UNIT_COMPANY_SLUG: Record<HesabfaUnit, string> = {
  production: 'bgl',
  trading: 'bazargani',
};

/** CRM company slug → unit (inverse lookup). */
export const COMPANY_SLUG_UNIT: Record<string, HesabfaUnit> = {
  bgl: 'production',
  bazargani: 'trading',
};

export interface EnvCredential {
  unit: HesabfaUnit;
  companySlug: string;
  apiKey: string;
  loginToken: string;
  userId: string;
  baseUrl: string;
}

function readEnvPair(unit: HesabfaUnit): EnvCredential | null {
  const apiKey = (process.env[`HESABFA_${unit.toUpperCase()}_API_KEY`] || '').trim();
  const loginToken = (process.env[`HESABFA_${unit.toUpperCase()}_LOGIN_TOKEN`] || '').trim();
  if (!apiKey || !loginToken) return null;
  const userId = (process.env[`HESABFA_${unit.toUpperCase()}_USER_ID`] || '').trim();
  const baseUrl = (process.env.HESABFA_BASE_URL || 'https://api.hesabfa.com/v1').trim();
  return { unit, companySlug: UNIT_COMPANY_SLUG[unit], apiKey, loginToken, userId, baseUrl };
}

/** Both env credentials, units with missing env vars are absent. */
export function readEnvCredentials(): EnvCredential[] {
  return (['production', 'trading'] as HesabfaUnit[]).map(readEnvPair).filter((c): c is EnvCredential => c !== null);
}

/** Masked env credential view — safe for the client (never raw values). */
export function maskedEnvCredentials() {
  const mask = (s: string) => (s ? `••••••••${s.slice(-4)}` : '');
  const base = (process.env.HESABFA_BASE_URL || 'https://api.hesabfa.com/v1').trim();
  return (['production', 'trading'] as HesabfaUnit[]).map((unit) => {
    const c = readEnvPair(unit);
    return {
      unit,
      companySlug: UNIT_COMPANY_SLUG[unit],
      present: !!c,
      apiKeyMasked: c ? mask(c.apiKey) : '',
      loginTokenMasked: c ? mask(c.loginToken) : '',
      baseUrl: base,
    };
  });
}

/**
 * Idempotently mirror env credentials into HesabfaConnection rows.
 * - env present + company row missing/absent  → create active row
 * - env present + row exists (any origin)     → overwrite secrets with env
 *   (env is authoritative for the two unit companies; a rotated token
 *   in .env lands on the next call without any UI step)
 * - env absent → row untouched (UI-managed credentials survive)
 * Returns the number of connections written.
 */
export async function ensureEnvConnections(): Promise<number> {
  const creds = readEnvCredentials();
  let written = 0;
  for (const c of creds) {
    const company = await db.company.findUnique({ where: { slug: c.companySlug }, select: { id: true } });
    if (!company) continue;
    await db.hesabfaConnection.upsert({
      where: { companyId: company.id },
      create: {
        companyId: company.id,
        apiKey: c.apiKey,
        loginToken: c.loginToken,
        baseUrl: c.baseUrl,
        active: true,
      },
      update: { apiKey: c.apiKey, loginToken: c.loginToken, baseUrl: c.baseUrl, active: true },
    });
    written += 1;
  }
  return written;
}
