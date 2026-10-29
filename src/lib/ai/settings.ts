import { db } from '@/lib/db';
import type { AiApprovalMode } from './types';

// ════════════════════════════════════════════════════════════
// AI SALES SETTINGS — Feature Flags + Policy (v2.27.0)
//
// Live in the existing Meta key-value store (same pattern as
// ai_bridge.* and security.*). Reads are cached ~60s so per-request
// lookups stay cheap. Admin-managed via /api/ai-sales/settings.
//
// Key map (all optional — everything has a safe default):
//   ai_sales.enabled               'true' | 'false'          (global kill-switch)
//   ai_sales.enabled.<companyId>   'true' | 'false'          (per-company flag)
//   ai_sales.llm_provider          'zai' | 'openai_compat'   (default zai)
//   ai_sales.stt_provider          'zai' | 'openai_compat' | 'none'  (default zai)
//   ai_sales.approval_mode         'suggest'|'confirm'|'auto' (default confirm)
//   ai_sales.approval_mode.<companyId> per-company override
//   ai_sales.auto_analyze          'true' | 'false'          (default true)
//   ai_sales.coach_enabled         'true' | 'false'          (default true)
//   ai_sales.max_audio_mb          number                    (default 25, max 60)
//   ai_sales.retention_days        number                    (default 365)
//   ai_sales.monthly_cost_limit_rial number                  (default 0 = unlimited)
//   ai_sales.domain_vocabulary     free text                 (medical-device terms)
//   ai_sales.telephony_enabled     'true' | 'false'          (default false — v2.28.0)
//   ai_sales.telephony_company     company slug              (default company for webhook routing)
//   ai_sales.telephony_ext_map     JSON or "101=user" lines  (PBX ext → CRM username)
//   ai_sales.telephony_secret      hex string — NEVER in this interface (leak guard);
//                                    read directly from Meta by the webhook only
// ════════════════════════════════════════════════════════════

export interface AiSalesSettings {
  enabled: boolean;
  llmProvider: 'zai' | 'openai_compat';
  sttProvider: 'zai' | 'openai_compat' | 'none';
  approvalMode: AiApprovalMode;
  autoAnalyze: boolean;
  coachEnabled: boolean;
  maxAudioMb: number;
  retentionDays: number;
  monthlyCostLimitRial: number;
  domainVocabulary: string;
  telephonyEnabled: boolean;
  telephonyCompany: string;
  telephonyExtMap: string;
}

export const AI_SETTINGS_KEYS = [
  'ai_sales.enabled',
  'ai_sales.llm_provider',
  'ai_sales.stt_provider',
  'ai_sales.approval_mode',
  'ai_sales.auto_analyze',
  'ai_sales.coach_enabled',
  'ai_sales.max_audio_mb',
  'ai_sales.retention_days',
  'ai_sales.monthly_cost_limit_rial',
  'ai_sales.domain_vocabulary',
  'ai_sales.telephony_enabled',
  'ai_sales.telephony_company',
  'ai_sales.telephony_ext_map',
] as const;

export const DEFAULT_DOMAIN_VOCABULARY = [
  'ونتیلاتور (Ventilator)', 'بی‌پپ (BiPAP)', 'سی‌پپ (CPAP)', 'دستگاه بیهوشی (Anesthesia Machine)',
  'آسپیراتور تراکئال', 'نبولایزر', 'مانیتور علائم حیاتی', 'پالس اکسیمتر',
  'تخت ICU', 'تخت NICU', 'انکوباتور نوزادان', 'فوتوتراپی',
  'فیزیوتراپی تنفسی', 'اسپیرومتر', 'کپسول اکسیژن', 'کنسانتری اکسیژن‌ساز',
  'مصرفی تنفسی', 'ماسک ونتیلاتور', 'بگ آمبوی اورژانس',
  'ICU', 'NICU', 'CCU', 'اورژانس', 'اتاق عمل',
  'مهندسی پزشکی', 'مدیر تجهیزات پزشکی', 'تدارکات بیمارستان', 'مناقصه', 'استعلام قیمت',
  'گارانتی', 'قرارداد خدمات', 'آموزش کارکنان', 'نصب و راه‌اندازی', 'کالیبراسیون',
].join('، ');

const DEFAULTS: AiSalesSettings = {
  enabled: true,
  llmProvider: 'zai',
  sttProvider: 'zai',
  approvalMode: 'confirm',
  autoAnalyze: true,
  coachEnabled: true,
  maxAudioMb: 25,
  retentionDays: 365,
  monthlyCostLimitRial: 0,
  domainVocabulary: DEFAULT_DOMAIN_VOCABULARY,
  telephonyEnabled: false,
  telephonyCompany: '',
  telephonyExtMap: '',
};

const CACHE_TTL_MS = 60_000;
let cache: { value: AiSalesSettings; perCompany: Record<string, string>; at: number } | null = null;

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function clampInt(v: string | undefined, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function readAiMeta(): Promise<{ global: Record<string, string>; perCompany: Record<string, string> }> {
  const rows = await db.meta.findMany({ where: { key: { startsWith: 'ai_sales.' } } });
  const global: Record<string, string> = {};
  const perCompany: Record<string, string> = {};
  for (const r of rows) {
    if (r.key.startsWith('ai_sales.enabled.') || r.key.startsWith('ai_sales.approval_mode.')) {
      perCompany[r.key] = r.value;
    } else {
      global[r.key] = r.value;
    }
  }
  return { global, perCompany };
}

/** Current global AI settings (cached ~60s). */
export async function getAiSettings(): Promise<AiSalesSettings> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const { global, perCompany } = await readAiMeta();
  const value: AiSalesSettings = {
    enabled: parseBool(global['ai_sales.enabled'], DEFAULTS.enabled),
    llmProvider: global['ai_sales.llm_provider'] === 'openai_compat' ? 'openai_compat' : 'zai',
    sttProvider: ['openai_compat', 'none'].includes(global['ai_sales.stt_provider'])
      ? (global['ai_sales.stt_provider'] as AiSalesSettings['sttProvider'])
      : 'zai',
    approvalMode: (['suggest', 'confirm', 'auto'].includes(global['ai_sales.approval_mode'])
      ? global['ai_sales.approval_mode'] : DEFAULTS.approvalMode) as AiApprovalMode,
    autoAnalyze: parseBool(global['ai_sales.auto_analyze'], DEFAULTS.autoAnalyze),
    coachEnabled: parseBool(global['ai_sales.coach_enabled'], DEFAULTS.coachEnabled),
    maxAudioMb: clampInt(global['ai_sales.max_audio_mb'], 1, 60, DEFAULTS.maxAudioMb),
    retentionDays: clampInt(global['ai_sales.retention_days'], 7, 3650, DEFAULTS.retentionDays),
    monthlyCostLimitRial: Math.max(0, Number(global['ai_sales.monthly_cost_limit_rial']) || 0),
    domainVocabulary: global['ai_sales.domain_vocabulary']?.trim() || DEFAULTS.domainVocabulary,
    telephonyEnabled: parseBool(global['ai_sales.telephony_enabled'], DEFAULTS.telephonyEnabled),
    telephonyCompany: (global['ai_sales.telephony_company'] || '').trim().slice(0, 60),
    telephonyExtMap: (global['ai_sales.telephony_ext_map'] || '').slice(0, 20_000),
  };
  cache = { value, perCompany, at: Date.now() };
  return value;
}

/** Is AI Sales Intelligence enabled for this company? */
export async function isAiEnabledForCompany(companyId: string): Promise<boolean> {
  const settings = await getAiSettings();
  if (!settings.enabled) return false;
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    const v = cache.perCompany[`ai_sales.enabled.${companyId}`];
    return v === undefined ? true : v === 'true' || v === '1';
  }
  const { perCompany } = await readAiMeta();
  const v = perCompany[`ai_sales.enabled.${companyId}`];
  return v === undefined ? true : v === 'true' || v === '1';
}

/** Effective approval mode for a company (company override → global). */
export async function getApprovalModeForCompany(companyId: string): Promise<AiApprovalMode> {
  const settings = await getAiSettings();
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    const v = cache.perCompany[`ai_sales.approval_mode.${companyId}`];
    return (['suggest', 'confirm', 'auto'].includes(v) ? v : settings.approvalMode) as AiApprovalMode;
  }
  const { perCompany } = await readAiMeta();
  const v = perCompany[`ai_sales.approval_mode.${companyId}`];
  return (['suggest', 'confirm', 'auto'].includes(v) ? v : settings.approvalMode) as AiApprovalMode;
}

/** Invalidate the settings cache (called after admin saves). */
export function invalidateAiSettingsCache(): void {
  cache = null;
}

/** Persist a single setting key (upsert). */
export async function setAiSetting(key: string, value: string): Promise<void> {
  if (!key.startsWith('ai_sales.')) throw new Error('کلید تنظیمات نامعتبر است');
  await db.meta.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  invalidateAiSettingsCache();
}
