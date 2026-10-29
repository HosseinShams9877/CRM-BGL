'use client';

// ════════════════════════════════════════════════════════════
// AI SALES — SETTINGS (v2.27.0) — admin panel
// Provider + policy + feature flags + per-company switches +
// usage/cost dashboard.
// ════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Bot, Save, RefreshCw, Coins, Phone, MessageSquare, Calendar, KeyRound, ShieldCheck, Webhook, Copy, Check } from 'lucide-react';
import { toPersianNum, AiSkeleton, AiErrorState, aiApiJson, faDate } from './shared';
import { AI_APPROVAL_MODE_LABEL, type AiApprovalMode } from '@/lib/ai/types';

interface SettingsDto {
  settings: {
    enabled: boolean; llmProvider: 'zai' | 'openai_compat'; sttProvider: 'zai' | 'openai_compat' | 'none';
    approvalMode: AiApprovalMode; autoAnalyze: boolean; coachEnabled: boolean;
    maxAudioMb: number; retentionDays: number; monthlyCostLimitRial: number;
    domainVocabulary: string; defaultVocabulary: string;
    telephonyEnabled: boolean; telephonyCompany: string; telephonyExtMap: string;
  };
  telephony: { secretSet: boolean; secretMasked: string };
  companies: { id: string; slug: string; name: string; enabled: boolean; approvalMode: string }[];
}

interface UsageDto {
  monthly: { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalAudioSeconds: number; totalCostRial: number };
  byFeature: { feature: string; calls: number; tokens: number; costRial: number }[];
  daily: { date: string; calls: number; tokens: number; costRial: number }[];
  byUser: { displayName: string; calls: number; tokens: number; costRial: number }[];
}

const FEATURE_LABEL: Record<string, string> = {
  call_analysis: 'تحلیل مکالمه', coaching: 'کوچینگ', brief: 'پیش‌تماس',
  memory: 'حافظه مشتری', playbook: 'پلی‌بوک', supervisor: 'خلاصه مدیر', stt: 'تبدیل صدا به متن',
};

export function AiSettings({ companySlug, isAdmin }: { companySlug: string; isAdmin: boolean }) {
  const [data, setData] = useState<SettingsDto | null>(null);
  const [usage, setUsage] = useState<UsageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [vocab, setVocab] = useState('');
  const [maxAudioMb, setMaxAudioMb] = useState(25);
  const [retentionDays, setRetentionDays] = useState(365);
  const [costLimit, setCostLimit] = useState(0);
  // v2.28.0 — telephony (call-center webhook)
  const [teleCompany, setTeleCompany] = useState('');
  const [teleExtMap, setTeleExtMap] = useState('');
  const [secretMasked, setSecretMasked] = useState('');
  const [secretSet, setSecretSet] = useState(false);
  const [newSecret, setNewSecret] = useState(''); // shown exactly once after generation
  const [copied, setCopied] = useState(false);
  const [armRotate, setArmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    const [s, u] = await Promise.all([
      aiApiJson<SettingsDto>('/api/ai-sales/settings', { action: 'get' }),
      aiApiJson<UsageDto>('/api/ai-sales/usage', { companySlug: companySlug === 'holding' ? undefined : companySlug }),
    ]);
    setLoading(false);
    if (!s.ok || !s.data) { setError(s.error || 'خطا'); return; }
    setError('');
    setData(s.data);
    setVocab(s.data.settings.domainVocabulary || '');
    setMaxAudioMb(s.data.settings.maxAudioMb);
    setRetentionDays(s.data.settings.retentionDays);
    setCostLimit(s.data.settings.monthlyCostLimitRial);
    setTeleCompany(s.data.settings.telephonyCompany || '');
    setTeleExtMap(s.data.settings.telephonyExtMap || '');
    setSecretSet(!!s.data.telephony?.secretSet);
    setSecretMasked(s.data.telephony?.secretMasked || '');
    setNewSecret('');
    setArmRotate(false);
    if (u.ok && u.data) setUsage(u.data);
  }, [companySlug]);

  useEffect(() => {
    // kick off without calling setState synchronously (codebase pattern)
    void (async () => { await load(); })();
  }, [load]);

  if (!isAdmin) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-xs text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400" dir="rtl">
        <ShieldCheck size={20} className="mx-auto mb-2 text-slate-400" aria-hidden="true" />
        تنظیمات هوش مصنوعی فقط برای مدیر سیستم فعال است.
      </div>
    );
  }

  const set = (patch: Record<string, unknown>) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, ...patch } } as SettingsDto);
  };

  /** Rotate the webhook signing secret — its own API call so unsaved form edits are untouched. */
  const rotateSecret = async () => {
    if (!armRotate) { setArmRotate(true); setTimeout(() => setArmRotate(false), 4000); return; }
    setRotating(true);
    setArmRotate(false);
    const res = await aiApiJson<{ generatedSecret?: string }>('/api/ai-sales/settings', {
      action: 'set',
      telephonySecret: 'generate',
    });
    setRotating(false);
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    if (res.data?.generatedSecret) {
      setNewSecret(res.data.generatedSecret);
      setSecretSet(true);
      toast.success('کلید جدید ساخته شد — همین حالا در PBX به‌روزرسانی کنید.');
      void load();
    }
  };

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { toast.error('کپی ناموفق بود — دستی انتخاب و کپی کنید.'); }
  };

  const webhookUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/api/ai-sales/telephony/webhook`
    : '/api/ai-sales/telephony/webhook';

  const save = async () => {
    if (!data) return;
    setSaving(true);
    const res = await aiApiJson('/api/ai-sales/settings', {
      action: 'set',
      enabled: data.settings.enabled,
      llmProvider: data.settings.llmProvider,
      sttProvider: data.settings.sttProvider,
      approvalMode: data.settings.approvalMode,
      autoAnalyze: data.settings.autoAnalyze,
      coachEnabled: data.settings.coachEnabled,
      maxAudioMb, retentionDays,
      monthlyCostLimitRial: costLimit,
      domainVocabulary: vocab,
      telephonyCompany: teleCompany,
      telephonyExtMap: teleExtMap,
      companyFlags: Object.fromEntries(data.companies.map((c) => [c.id, c.enabled])),
      companyApprovalModes: Object.fromEntries(data.companies.map((c) => [c.id, c.approvalMode])),
    });
    setSaving(false);
    if (!res.ok) { toast.error(res.error || 'خطا'); return; }
    toast.success('تنظیمات ذخیره شد.');
    void load();
  };

  return (
    <div className="space-y-5" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-slate-800 dark:text-slate-100">
            <Bot size={18} className="text-slate-600 dark:text-slate-300" aria-hidden="true" />
            تنظیمات هوش مصنوعی فروش
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">ارائه‌دهنده‌ها، سیاست تأیید، پرچم‌های قابلیت و کنترل هزینه.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => { setLoading(true); void load(); }} className="h-8 gap-1 text-xs" aria-label="رفرش">
            <RefreshCw size={13} aria-hidden="true" /> رفرش
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || !data} className="gap-1.5 bg-slate-800 hover:bg-slate-900 dark:bg-slate-200 dark:text-slate-900">
            <Save size={14} aria-hidden="true" /> {saving ? 'در حال ذخیره…' : 'ذخیره تنظیمات'}
          </Button>
        </div>
      </div>

      {loading && <AiSkeleton rows={5} />}
      {!loading && error && <AiErrorState message={error} onRetry={() => void load()} />}

      {!loading && data && (
        <>
          {/* Global switches */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">پرچم‌های قابلیت (Feature Flags)</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <FlagRow icon={<Bot size={14} />} label="ماژول هوش مصنوعی فروش" checked={data.settings.enabled} onChange={(v) => set({ enabled: v })} />
              <FlagRow icon={<MessageSquare size={14} />} label="تحلیل خودکار بعد از بارگذاری" checked={data.settings.autoAnalyze} onChange={(v) => set({ autoAnalyze: v })} />
              <FlagRow icon={<Calendar size={14} />} label="مربی هوشمند (کوچینگ)" checked={data.settings.coachEnabled} onChange={(v) => set({ coachEnabled: v })} />
            </div>
          </div>

          {/* Providers */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><KeyRound size={15} aria-hidden="true" /> ارائه‌دهنده‌ها (Provider)</h3>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">موتور تحلیل (LLM)</label>
                  <Select value={data.settings.llmProvider} onValueChange={(v) => set({ llmProvider: v as 'zai' | 'openai_compat' })}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zai">داخلی (پیش‌فرض — بدون نیاز به کلید)</SelectItem>
                      <SelectItem value="openai_compat">OpenAI-سازگار (تنظیمات ai-bridge)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[10px] leading-4 text-slate-400">سرویس OpenAI-سازگار از تنظیمات «اتصال هوش مصنوعی» موجود در تنظیمات سیستم خوانده می‌شود.</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">تبدیل صدا به متن (STT)</label>
                  <Select value={data.settings.sttProvider} onValueChange={(v) => set({ sttProvider: v as 'zai' | 'openai_compat' | 'none' })}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="zai">داخلی (انگلیسی/چینی — بدون نیاز به کلید)</SelectItem>
                      <SelectItem value="openai_compat">OpenAI-سازگار Whisper (پیشنهادی برای فارسی)</SelectItem>
                      <SelectItem value="none">غیرفعال (فقط متن دستی)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">سیاست تأیید اقدامات</label>
                  <Select value={data.settings.approvalMode} onValueChange={(v) => set({ approvalMode: v as AiApprovalMode })}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(['suggest', 'confirm', 'auto'] as AiApprovalMode[]).map((m) => (
                        <SelectItem key={m} value={m}>{AI_APPROVAL_MODE_LABEL[m]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Privacy + cost */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><Coins size={15} aria-hidden="true" /> حریم خصوصی و هزینه</h3>
              <div className="space-y-3">
                <NumberField label="حداکثر حجم فایل صوتی (مگابایت)" value={maxAudioMb} onChange={setMaxAudioMb} min={1} max={60} />
                <NumberField label="دوره نگهداری صوت و متن (روز)" value={retentionDays} onChange={setRetentionDays} min={7} max={3650} />
                <NumberField label="سقف هزینه ماهانه (ریال — صفر = نامحدود)" value={costLimit} onChange={setCostLimit} min={0} max={1_000_000_000} />
                <p className="rounded-lg bg-slate-50 p-2 text-[10px] leading-5 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  سرویس داخلی (zai) بدون هزینه اضافه است؛ سرویس خارجی بر اساس توکن/دقیقه صوت تخمین زده می‌شود و با پر شدن سقف، پردازش جدید متوقف می‌شود.
                </p>
              </div>
            </div>
          </div>

          {/* v2.28.0 — Telephony (call-center webhook) */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
                <Webhook size={15} aria-hidden="true" /> اتصال تلفنی (Call Center Webhook)
              </h3>
              <Switch
                checked={data.settings.telephonyEnabled}
                onCheckedChange={(v) => set({ telephonyEnabled: v })}
                aria-label="فعال‌سازی وب‌هوک تلفنی"
              />
            </div>
            <p className="mb-3 text-[11px] leading-5 text-slate-500 dark:text-slate-400">
              مرکز تلفن (Asterisk / 3CX / Simotel و…) پس از پایان هر تماس ضبط‌شده، رویداد را با امضای HMAC به این نشانی می‌فرستد؛
              مکالمه به‌صورت خودکار به صف تحلیل هوش مصنوعی می‌رود. راهنمای کامل: AI_CALL_CENTER_INTEGRATION.md
            </p>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">آدرس وب‌هوک (Webhook URL)</label>
                  <div className="flex items-center gap-2" dir="ltr">
                    <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">{webhookUrl}</code>
                    <Button size="sm" variant="outline" onClick={() => void copyText(webhookUrl)} className="h-8 w-8 shrink-0 p-0" aria-label="کپی آدرس وب‌هوک">
                      {copied ? <Check size={13} className="text-emerald-600" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
                    </Button>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">شرکت پیش‌فرض مسیریابی تماس‌ها</label>
                  <Select value={teleCompany || 'none'} onValueChange={(v) => setTeleCompany(v === 'none' ? '' : v)}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="انتخاب شرکت" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">خودکار (تطبیق شماره / کارشناس)</SelectItem>
                      {data.companies.map((c) => (
                        <SelectItem key={c.id} value={c.slug}>{c.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[10px] leading-4 text-slate-400">اگر رویداد companySlug نداشته باشد و تطبیق شماره هم یکتا نباشد، تماس به این شرکت نسبت داده می‌شود.</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">نگاشت داخلی‌ها به کارشناسان</label>
                  <Textarea
                    value={teleExtMap}
                    onChange={(e) => setTeleExtMap(e.target.value)}
                    rows={4}
                    placeholder={'101=ali&#10;102=sara&#10;یا JSON: {"101":"ali","102":"sara"}'}
                    className="text-xs leading-6" dir="ltr"
                  />
                  <p className="mt-1 text-[10px] leading-4 text-slate-400">هر سطر: شمارهٔ داخلی = نام‌کاربری در CRM. تماس‌های هر داخلی به کارشناس مربوطه نسبت داده می‌شود.</p>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">کلید امضای وب‌هوک (HMAC-SHA256)</label>
                  {newSecret ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2" dir="ltr">
                        <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800 dark:border-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200">{newSecret}</code>
                        <Button size="sm" variant="outline" onClick={() => void copyText(newSecret)} className="h-8 w-8 shrink-0 p-0" aria-label="کپی کلید جدید">
                          <Copy size={13} aria-hidden="true" />
                        </Button>
                      </div>
                      <p className="rounded-lg bg-amber-50 p-2 text-[10px] leading-5 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                        این کلید فقط همین یک‌بار نمایش داده می‌شود — آن را کپی و در پیکربندی PBX قرار دهید. کلید قبلی دیگر معتبر نیست.
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400" dir="ltr">
                        {secretSet ? secretMasked : '— تنظیم نشده —'}
                      </code>
                      <Button
                        size="sm"
                        variant={armRotate ? 'destructive' : 'outline'}
                        onClick={() => void rotateSecret()}
                        disabled={rotating}
                        className="h-8 shrink-0 gap-1 text-[11px]"
                      >
                        <KeyRound size={12} aria-hidden="true" />
                        {rotating ? 'در حال ساخت…' : armRotate ? 'مطمئنید؟ دوباره کلیک کنید' : secretSet ? 'کلید جدید' : 'تولید کلید'}
                      </Button>
                    </div>
                  )}
                  <p className="mt-1 text-[10px] leading-4 text-slate-400">
                    هدر درخواست PBX: <code dir="ltr">x-signature-256: HMAC-SHA256(body, key)</code> — بدون امضای معتبر، درخواست رد می‌شود (401).
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[10px] leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-400" dir="rtl">
                  <p className="mb-1 font-bold text-slate-600 dark:text-slate-300">نمونهٔ رویداد (POST):</p>
                  <pre className="overflow-x-auto whitespace-pre-wrap" dir="ltr">{`{
  "provider": "asterisk",
  "externalId": "1736543-001",
  "direction": "inbound",
  "agentExt": "101",
  "callerNumber": "09121234567",
  "startedAt": "2026-08-28T10:30:00Z",
  "durationSec": 240,
  "mimeType": "audio/wav",
  "audioBase64": "…"
}`}</pre>
                </div>
              </div>
            </div>
          </div>

          {/* Per-company flags */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">فعال‌سازی به تفکیک شرکت</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-700 dark:text-slate-400">
                    <th className="p-2 font-semibold">شرکت</th>
                    <th className="p-2 font-semibold">فعال</th>
                    <th className="p-2 font-semibold">سیاست تأیید</th>
                  </tr>
                </thead>
                <tbody>
                  {data.companies.map((c, i) => (
                    <tr key={c.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                      <td className="p-2 font-semibold text-slate-700 dark:text-slate-200">{c.name}</td>
                      <td className="p-2">
                        <Switch
                          checked={c.enabled}
                          onCheckedChange={(v) => {
                            const companies = [...data.companies];
                            companies[i] = { ...c, enabled: v };
                            setData({ ...data, companies });
                          }}
                          aria-label={`فعال‌سازی برای ${c.name}`}
                        />
                      </td>
                      <td className="p-2">
                        <Select
                          value={c.approvalMode}
                          onValueChange={(v) => {
                            const companies = [...data.companies];
                            companies[i] = { ...c, approvalMode: v };
                            setData({ ...data, companies });
                          }}
                        >
                          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(['suggest', 'confirm', 'auto'] as AiApprovalMode[]).map((m) => (
                              <SelectItem key={m} value={m}>{AI_APPROVAL_MODE_LABEL[m]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Domain vocabulary */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <h3 className="mb-2 text-sm font-bold text-slate-700 dark:text-slate-200">واژگان تخصصی دامنه (Medical Device Domain)</h3>
            <p className="mb-2 text-[11px] leading-5 text-slate-500 dark:text-slate-400">این اصطلاحات در پرامپت تحلیل تزریق می‌شوند تا دقت استخراج تجهیزات پزشکی (مثل ونتیلاتور، BiPAP، ICU) بالا برود.</p>
            <Textarea value={vocab} onChange={(e) => setVocab(e.target.value)} rows={4} className="text-xs leading-6" />
            <Button size="sm" variant="ghost" onClick={() => setVocab(data.settings.defaultVocabulary)} className="mt-2 h-7 text-[11px]">
              بازگرداندن واژگان پیش‌فرض
            </Button>
          </div>

          {/* Usage */}
          {usage && (
            <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200"><Phone size={15} aria-hidden="true" /> مصرف ماه جاری</h3>
              <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
                <Stat label="فراخوانی AI" value={toPersianNum(usage.monthly.totalCalls)} />
                <Stat label="توکن ورودی" value={toPersianNum(usage.monthly.totalInputTokens.toLocaleString('en-US'))} />
                <Stat label="توکن خروجی" value={toPersianNum(usage.monthly.totalOutputTokens.toLocaleString('en-US'))} />
                <Stat label="دقیقه صوت" value={toPersianNum(Math.round(usage.monthly.totalAudioSeconds / 60))} />
                <Stat label="هزینه تخمینی (ریال)" value={toPersianNum(usage.monthly.totalCostRial)} />
              </div>
              {usage.byFeature.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {usage.byFeature.map((f) => (
                    <span key={f.feature} className="rounded-full bg-slate-100 px-3 py-1 text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {FEATURE_LABEL[f.feature] || f.feature}: {toPersianNum(f.calls)} فراخوانی
                    </span>
                  ))}
                </div>
              )}
              {usage.byUser.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-bold text-slate-600 dark:text-slate-300">مصرف به تفکیک کاربر</h4>
                  <ul className="grid grid-cols-1 gap-1 text-[11px] text-slate-500 dark:text-slate-400 sm:grid-cols-2">
                    {usage.byUser.map((u, i) => (
                      <li key={i}>{u.displayName}: {toPersianNum(u.calls)} فراخوانی</li>
                    ))}
                  </ul>
                </div>
              )}
              {usage.daily.length > 0 && (
                <p className="mt-3 text-[10px] text-slate-400">آخرین فراخوانی: {faDate(usage.daily[usage.daily.length - 1].date)}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FlagRow({ icon, label, checked, onChange }: { icon: React.ReactNode; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <span className="flex items-center gap-2 text-xs font-semibold text-slate-700 dark:text-slate-200">
        <span className="text-violet-600 dark:text-violet-400" aria-hidden="true">{icon}</span> {label}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function NumberField({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</label>
      <input
        type="number" value={value} min={min} max={max}
        onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(n); }}
        className="h-9 w-full rounded-lg border border-slate-300 bg-white px-3 text-xs outline-none focus:border-slate-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 p-3 text-center dark:bg-slate-800/60">
      <div className="text-sm font-black text-slate-800 dark:text-slate-100">{value}</div>
      <div className="text-[10px] text-slate-500 dark:text-slate-400">{label}</div>
    </div>
  );
}
