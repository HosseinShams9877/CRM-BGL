import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hasAiPermission, aiDenied, aiAudit } from '@/lib/ai/api-helpers';
import { getAiSettings, setAiSetting, AI_SETTINGS_KEYS, DEFAULT_DOMAIN_VOCABULARY } from '@/lib/ai/settings';
import { generateTelephonySecret, maskSecret } from '@/lib/ai/telephony-ingest';
import { validateExtMap } from '@/lib/ai/providers/telephony';

// ════════════════════════════════════════════════════════════
// AI SALES — SETTINGS API (v2.27.0) — ADMIN ONLY
// POST actions: get | set | company-flags
// ════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    if (!hasAiPermission(user, 'ai_settings_manage')) {
      return aiDenied('تنظیمات هوش مصنوعی فقط برای مدیر سیستم فعال است.');
    }

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };

    if (action === 'get') return await handleGet();
    if (action === 'set') return await handleSet(body, user);
    if (action === 'company-flags') return await handleCompanyFlags();

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('ai-sales-settings', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleGet() {
  const settings = await getAiSettings();
  const companies = await db.company.findMany({ select: { id: true, slug: true, name: true } });
  const flags = await db.meta.findMany({ where: { key: { startsWith: 'ai_sales.enabled.' } } });
  const approvalModes = await db.meta.findMany({ where: { key: { startsWith: 'ai_sales.approval_mode.' } } });
  const secretRow = await db.meta.findUnique({ where: { key: 'ai_sales.telephony_secret' } });
  const flagMap: Record<string, boolean> = {};
  for (const c of companies) {
    const row = flags.find((f) => f.key === `ai_sales.enabled.${c.id}`);
    flagMap[c.id] = row ? row.value === 'true' : true;
  }
  const modeMap: Record<string, string> = {};
  for (const c of companies) {
    const row = approvalModes.find((f) => f.key === `ai_sales.approval_mode.${c.id}`);
    modeMap[c.id] = row?.value || settings.approvalMode;
  }
  return NextResponse.json({
    settings: { ...settings, defaultVocabulary: DEFAULT_DOMAIN_VOCABULARY },
    // telephony secret — status only; the raw value NEVER leaves the server
    // (regeneration returns it exactly once, in the set response)
    telephony: {
      secretSet: !!secretRow?.value,
      secretMasked: maskSecret(secretRow?.value || ''),
    },
    companies: companies.map((c) => ({ id: c.id, slug: c.slug, name: c.name, enabled: flagMap[c.id], approvalMode: modeMap[c.id] })),
    keys: AI_SETTINGS_KEYS,
  });
}

async function handleSet(body: Record<string, unknown>, user: import('@/lib/auth').AuthUser) {
  const {
    enabled, llmProvider, sttProvider, approvalMode, autoAnalyze, coachEnabled,
    maxAudioMb, retentionDays, monthlyCostLimitRial, domainVocabulary,
    companyFlags, companyApprovalModes,
    telephonyEnabled, telephonyCompany, telephonyExtMap, telephonySecret,
  } = body as {
    enabled?: boolean; llmProvider?: string; sttProvider?: string; approvalMode?: string;
    autoAnalyze?: boolean; coachEnabled?: boolean; maxAudioMb?: number; retentionDays?: number;
    monthlyCostLimitRial?: number; domainVocabulary?: string;
    companyFlags?: Record<string, boolean>; companyApprovalModes?: Record<string, string>;
    telephonyEnabled?: boolean; telephonyCompany?: string; telephonyExtMap?: string; telephonySecret?: string;
  };

  const updates: Array<[string, string]> = [];
  if (typeof enabled === 'boolean') updates.push(['ai_sales.enabled', String(enabled)]);
  if (llmProvider === 'zai' || llmProvider === 'openai_compat') updates.push(['ai_sales.llm_provider', llmProvider]);
  // v2.34.7 — openai_compat: Whisper-compatible endpoint for Persian STT
  if (sttProvider === 'zai' || sttProvider === 'openai_compat' || sttProvider === 'none') updates.push(['ai_sales.stt_provider', sttProvider]);
  if (approvalMode && ['suggest', 'confirm', 'auto'].includes(approvalMode)) updates.push(['ai_sales.approval_mode', approvalMode]);
  if (typeof autoAnalyze === 'boolean') updates.push(['ai_sales.auto_analyze', String(autoAnalyze)]);
  if (typeof coachEnabled === 'boolean') updates.push(['ai_sales.coach_enabled', String(coachEnabled)]);
  if (typeof maxAudioMb === 'number' && Number.isFinite(maxAudioMb)) updates.push(['ai_sales.max_audio_mb', String(Math.max(1, Math.min(60, Math.round(maxAudioMb))))]);
  if (typeof retentionDays === 'number' && Number.isFinite(retentionDays)) updates.push(['ai_sales.retention_days', String(Math.max(7, Math.min(3650, Math.round(retentionDays))))]);
  if (typeof monthlyCostLimitRial === 'number' && Number.isFinite(monthlyCostLimitRial) && monthlyCostLimitRial >= 0) updates.push(['ai_sales.monthly_cost_limit_rial', String(monthlyCostLimitRial)]);
  if (typeof domainVocabulary === 'string') updates.push(['ai_sales.domain_vocabulary', domainVocabulary.slice(0, 4000)]);

  // ── v2.28.0 — telephony ──
  if (typeof telephonyEnabled === 'boolean') updates.push(['ai_sales.telephony_enabled', String(telephonyEnabled)]);
  if (typeof telephonyCompany === 'string') {
    const slug = telephonyCompany.trim();
    if (slug) {
      const c = await db.company.findUnique({ where: { slug }, select: { id: true } });
      if (!c) return NextResponse.json({ error: `شرکت با شناسهٔ «${slug}» یافت نشد.` }, { status: 400 });
    }
    updates.push(['ai_sales.telephony_company', slug.slice(0, 60)]);
  }
  if (typeof telephonyExtMap === 'string') {
    const v = validateExtMap(telephonyExtMap);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    updates.push(['ai_sales.telephony_ext_map', telephonyExtMap.slice(0, 20_000)]);
  }

  let generatedSecret: string | null = null;
  if (typeof telephonySecret === 'string') {
    const s = telephonySecret.trim();
    if (s === 'generate') {
      generatedSecret = generateTelephonySecret();
      updates.push(['ai_sales.telephony_secret', generatedSecret]);
    } else if (s === '') {
      updates.push(['ai_sales.telephony_secret', '']); // explicit clear → webhook 404s
    } else if (/^[A-Za-z0-9_-]{32,128}$/.test(s)) {
      updates.push(['ai_sales.telephony_secret', s]);
    } else {
      return NextResponse.json({ error: 'کلید امضای وب‌هوک باید حداقل ۳۲ کاراکتر (حروف/اعداد) باشد یا «generate» برای تولید خودکار.' }, { status: 400 });
    }
  }

  if (companyFlags) {
    const companies = await db.company.findMany({ select: { id: true } });
    for (const c of companies) {
      if (c.id in companyFlags) updates.push([`ai_sales.enabled.${c.id}`, companyFlags[c.id] ? 'true' : 'false']);
    }
  }
  if (companyApprovalModes) {
    const companies = await db.company.findMany({ select: { id: true } });
    for (const c of companies) {
      const mode = companyApprovalModes[c.id];
      if (mode && ['suggest', 'confirm', 'auto'].includes(mode)) updates.push([`ai_sales.approval_mode.${c.id}`, mode]);
    }
  }

  for (const [key, value] of updates) {
    await setAiSetting(key, value);
  }
  await aiAudit(
    'AI_SETTINGS_UPDATED', 'ai_sales',
    `${updates.length} key(s)${updates.some(([k]) => k === 'ai_sales.telephony_secret') ? '; telephony-secret-rotated' : ''}`,
    user.id,
  );

  // v2.47.0 — a shorter retention window must take effect IMMEDIATELY, not
  // "whenever the next webhook arrives": rows already past the new cutoff
  // are swept right here (bounded, best-effort — a failure never blocks
  // the settings save).
  let retentionSwept: { recordingsDeleted: number; audioFilesDeleted: number } | undefined;
  if (updates.some(([k]) => k === 'ai_sales.retention_days')) {
    try {
      const { sweepExpiredAiRecordings } = await import('@/lib/ai/retention-sweep');
      const r = await sweepExpiredAiRecordings();
      retentionSwept = { recordingsDeleted: r.recordingsDeleted, audioFilesDeleted: r.audioFilesDeleted };
    } catch { /* best-effort */ }
  }

  // the generated secret is returned EXACTLY ONCE — never again (get returns masked only)
  return NextResponse.json(
    generatedSecret
      ? { message: 'تنظیمات هوش مصنوعی ذخیره شد.', generatedSecret, ...(retentionSwept ? { retentionSwept } : {}) }
      : { message: 'تنظیمات هوش مصنوعی ذخیره شد.', ...(retentionSwept ? { retentionSwept } : {}) },
  );
}

async function handleCompanyFlags() {
  const companies = await db.company.findMany({ select: { id: true, slug: true, name: true } });
  const flags = await db.meta.findMany({ where: { key: { startsWith: 'ai_sales.enabled.' } } });
  return NextResponse.json({
    companies: companies.map((c) => ({
      slug: c.slug, name: c.name,
      enabled: flags.find((f) => f.key === `ai_sales.enabled.${c.id}`)?.value !== 'false',
    })),
  });
}
