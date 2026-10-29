'use client';

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { SkeletonList } from '@/hooks/use-api';
import { toast } from 'sonner';
import { Search, Users, Check, Shield, Building2, Edit3, KeyRound, Trash2, UserPlus, Lock, Unlock, Eye, EyeOff, LogIn, MapPin, Globe2, Map as MapIcon, Star, Loader2, X, Info } from 'lucide-react';
import { JobTitle, DEFAULT_JOB_TITLES } from '@/lib/access-config';

// ═══════════════════════════════════════════════════════════
// Admin user & access management — create users with
// username/password, assign role + companies, activate/disable
// ═══════════════════════════════════════════════════════════

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  roleLabel: string;
  jobTitle?: string | null;
  province?: string | null;
  isActive: boolean;
  companyIds: string;
  businessUnitId: string;
  // v2.36.0 — sales territory assignment (محدودهٔ فروش)
  territoryMode?: string | null;
  territoryProvinces?: string | null;
  territoryCenterIds?: string | null;
  createdAt: string;
}

// v2.36.0 — client-side summary chip for the user table (the lib itself
// imports the Prisma client and stays server-only).
function territoryChip(row: UserRow): { label: string; color: string; bg: string } {
  const mode = row.territoryMode || 'country';
  const parse = (raw?: string | null): string[] => {
    try {
      const p = JSON.parse(raw || '[]');
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  };
  if (mode === 'provinces') {
    const list = parse(row.territoryProvinces);
    if (list.length === 0) return { label: 'کل کشور', color: '#6b7280', bg: '#f3f4f6' };
    const head = list.slice(0, 2).join('، ');
    return {
      label: list.length > 2 ? `${head} +${toPersianNum(list.length - 2)}` : head,
      color: '#0f766e', bg: '#f0fdfa',
    };
  }
  if (mode === 'centers') {
    const list = parse(row.territoryCenterIds);
    if (list.length === 0) return { label: 'کل کشور', color: '#6b7280', bg: '#f3f4f6' };
    return { label: `${toPersianNum(list.length)} مرکز خاص`, color: '#7c2d12', bg: '#fef7ed' };
  }
  return { label: 'کل کشور', color: '#6b7280', bg: '#f3f4f6' };
}

// ── v2.36.0 — Sales Territory dialog (محدودهٔ دسترسی فروشنده) ──
const TERRITORY_SCOPED_MODULES = [
  'مراکز', 'مخاطبین', 'پیش‌فاکتورها', 'فاکتورها', 'فعالیت‌ها', 'پیگیری‌ها', 'مراجعات حضوری', 'گزارش‌ها',
];

interface TerritoryState {
  mode: 'country' | 'provinces' | 'centers';
  provinces: string[];
  centerIds: string[];
}

function TerritoryDialog({ target, onDone, onCancel }: {
  target: UserRow;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [state, setState] = useState<TerritoryState>({ mode: 'country', provinces: [], centerIds: [] });
  const [universe, setUniverse] = useState<{ province: string; count: number }[]>([]);
  const [assigned, setAssigned] = useState<{ id: string; name: string; province: string | null; city: string | null }[]>([]);
  const [centerCount, setCenterCount] = useState<number | null>(null);
  const [provSearch, setProvSearch] = useState('');
  const [centerSearch, setCenterSearch] = useState('');
  const [centerResults, setCenterResults] = useState<{ id: string; name: string; province: string | null; city: string | null }[]>([]);
  // debounce handles (refs — no re-render on assignment)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const centerSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // initial load — full assignment + picker universe
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await apiCall('territory-get', { id: target.id });
        if (!alive) return;
        const fallback = target.province && data.territory?.mode === 'country'
          ? [target.province]
          : [];
        setState({
          mode: data.territory?.mode || 'country',
          provinces: data.territory?.provinces?.length ? data.territory.provinces : fallback,
          centerIds: data.territory?.centerIds || [],
        });
        setUniverse(data.provincesUniverse || []);
        setAssigned(data.assignedCenters || []);
        setCenterCount(data.centerCount ?? null);
        setCanEdit(data.canEdit !== false);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'خطا در دریافت محدودهٔ فروش');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [target.id, target.province]);

  // live visible-center count (debounced)
  useEffect(() => {
    if (loading) return;
    if (previewTimer.current) clearTimeout(previewTimer.current);
    const t = setTimeout(async () => {
      try {
        const data = await apiCall('territory-preview', {
          id: target.id,
          mode: state.mode,
          provinces: state.provinces,
          centerIds: state.centerIds,
        });
        setCenterCount(data.centerCount ?? null);
      } catch { /* preview is advisory — silent */ }
    }, 350);
    previewTimer.current = t;
    return () => clearTimeout(t);
  }, [loading, state, target.id]);

  // center picker search (debounced)
  useEffect(() => {
    if (state.mode !== 'centers') return;
    const t = setTimeout(async () => {
      try {
        const data = await apiCall('territory-centers', { id: target.id, search: centerSearch, limit: 20 });
        setCenterResults(data.centers || []);
      } catch { /* silent */ }
    }, 250);
    centerSearchTimer.current = t;
    return () => clearTimeout(t);
  }, [state.mode, centerSearch, target.id]);

  const toggleProvince = (name: string) =>
    setState((prev) => ({
      ...prev,
      provinces: prev.provinces.includes(name)
        ? prev.provinces.filter((p) => p !== name)
        : [...prev.provinces, name],
    }));

  const toggleCenter = (id: string) =>
    setState((prev) => {
      if (prev.centerIds.includes(id)) {
        return { ...prev, centerIds: prev.centerIds.filter((c) => c !== id) };
      }
      const row = centerResults.find((c) => c.id === id) || assigned.find((c) => c.id === id);
      if (row && !assigned.find((c) => c.id === id)) setAssigned((a) => [...a, row]);
      return { ...prev, centerIds: [...prev.centerIds, id] };
    });

  const removeCenter = (id: string) =>
    setState((prev) => ({ ...prev, centerIds: prev.centerIds.filter((c) => c !== id) }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiCall('update-territory', {
        id: target.id,
        mode: state.mode,
        provinces: state.mode === 'provinces' ? state.provinces : [],
        centerIds: state.mode === 'centers' ? state.centerIds : [],
      });
      toast.success(
        state.mode === 'country'
          ? `محدودهٔ «${target.displayName}» به کل کشور تغییر کرد`
          : `محدودهٔ فروش «${target.displayName}» ثبت شد — ${toPersianNum(centerCount ?? 0)} مرکز قابل مشاهده`,
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت محدوده');
    } finally {
      setBusy(false);
    }
  };

  const filteredUniverse = universe.filter((u) =>
    !provSearch.trim() || u.province.includes(provSearch.trim()));
  const selectedCount =
    state.mode === 'provinces' ? state.provinces.length
    : state.mode === 'centers' ? state.centerIds.length
    : 0;

  const MODES: { key: TerritoryState['mode']; label: string; icon: React.ReactNode; desc: string }[] = [
    { key: 'country', label: 'مشاهدهٔ کل کشور (بدون محدودیت)', icon: <Globe2 size={15} />, desc: 'فقط مدیر فروش / مدیر هلدینگ — فعال‌سازی توسط مدیر سیستم' },
    { key: 'provinces', label: 'انتخاب استان‌ها', icon: <MapIcon size={15} />, desc: 'فقط مراکز استان‌های انتخابی نمایش داده می‌شود' },
    { key: 'centers', label: 'انتخاب شهرها / مراکز خاص', icon: <Star size={15} />, desc: 'برای موارد خاص: چند مرکز مشخص زیر مدیریت کارشناس' },
  ];

  return (
    <div className="space-y-4 mt-2" dir="rtl">
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2.5">{error}</p>}

      {loading ? (
        <div className="flex items-center justify-center py-10 text-gray-400 gap-2 text-sm">
          <Loader2 size={16} className="animate-spin" /> در حال بارگذاری محدودهٔ فروش...
        </div>
      ) : (
        <>
          {/* expert identity */}
          <div className="flex items-center gap-2.5 bg-gray-50 rounded-xl p-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              {target.displayName.slice(0, 1)}
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-900 truncate">{target.displayName}</p>
              <p className="text-[11px] text-gray-400 font-mono" dir="ltr">{target.username}</p>
            </div>
            <div className="mr-auto flex items-center gap-1.5 text-[11px] text-gray-400">
              <MapPin size={12} />
              {centerCount !== null ? (
                <span>تعداد مراکز قابل مشاهده: <b className="text-teal-700">{toPersianNum(centerCount)} مرکز</b></span>
              ) : '—'}
            </div>
          </div>

          {/* mode radios */}
          <div className="grid grid-cols-1 gap-2">
            {MODES.map((m) => {
              const active = state.mode === m.key;
              const locked = m.key === 'country' && !canEdit;
              return (
                <button
                  key={m.key}
                  type="button"
                  disabled={!canEdit}
                  onClick={() => setState((prev) => ({ ...prev, mode: m.key }))}
                  className={`p-3 rounded-xl border text-right transition-all flex items-start gap-2.5 ${
                    active ? 'border-teal-400 bg-teal-50/50 shadow-sm' : 'border-gray-200 hover:border-gray-300'
                  } ${!canEdit ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                    active ? 'bg-teal-100 text-teal-700' : 'bg-gray-100 text-gray-400'}`}>{m.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-xs font-bold ${active ? 'text-teal-800' : 'text-gray-700'}`}>
                      {m.label} {locked ? <span className="text-[10px] font-normal text-gray-400">(فقط مدیر)</span> : null}
                    </span>
                    <span className="block text-[11px] text-gray-400 mt-0.5">{m.desc}</span>
                  </span>
                  {active && <Check size={14} className="text-teal-600 shrink-0 mt-1" />}
                </button>
              );
            })}
          </div>

          {/* provinces picker */}
          {state.mode === 'provinces' && (
            <div className="rounded-xl border border-gray-200 p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input value={provSearch} onChange={(e) => setProvSearch(e.target.value)}
                    placeholder="جستجوی استان..." className="pr-8 h-8 rounded-lg text-xs border-gray-200" />
                </div>
                <button type="button" onClick={() => setState((p) => ({ ...p, provinces: universe.map((u) => u.province) }))}
                  className="h-8 px-2.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 shrink-0">
                  انتخاب همه
                </button>
                <button type="button" onClick={() => setState((p) => ({ ...p, provinces: [] }))}
                  className="h-8 px-2.5 text-[11px] rounded-lg border border-gray-200 text-gray-600 hover:border-gray-300 shrink-0">
                  پاک‌کردن
                </button>
              </div>
              <p className="text-[11px] text-gray-400">
                {toPersianNum(state.provinces.length)} استان انتخاب‌شده — عدد روبه‌روی هر استان = تعداد مراکز فعال آن
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-56 overflow-y-auto pl-1">
                {filteredUniverse.map((u) => {
                  const checked = state.provinces.includes(u.province);
                  return (
                    <label key={u.province} className={`flex items-center gap-2 rounded-lg border p-2 cursor-pointer transition-colors ${
                      checked ? 'border-teal-300 bg-teal-50/60' : 'border-gray-100 hover:border-gray-200'
                    }`}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleProvince(u.province)} className="h-3.5 w-3.5" />
                      <span className="text-[11px] font-medium text-gray-700 truncate flex-1">{u.province}</span>
                      {u.count > 0 && (
                        <span className="text-[10px] text-gray-400 shrink-0">{toPersianNum(u.count)}</span>
                      )}
                    </label>
                  );
                })}
                {filteredUniverse.length === 0 && (
                  <p className="col-span-3 text-center text-[11px] text-gray-300 py-4">استانی یافت نشد</p>
                )}
              </div>
            </div>
          )}

          {/* centers picker */}
          {state.mode === 'centers' && (
            <div className="rounded-xl border border-gray-200 p-3 space-y-2.5">
              <div className="relative">
                <Search size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input value={centerSearch} onChange={(e) => setCenterSearch(e.target.value)}
                  placeholder="جستجوی مرکز (نام یا شهر)..." className="pr-8 h-8 rounded-lg text-xs border-gray-200" />
              </div>
              <p className="text-[11px] text-gray-400">
                {toPersianNum(state.centerIds.length)} مرکز انتخاب‌شده — جستجو فقط در شرکت‌های همین کارشناس
              </p>
              {state.centerIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                  {state.centerIds.map((id) => {
                    const row = assigned.find((c) => c.id === id);
                    return (
                      <span key={id} className="inline-flex items-center gap-1 text-[11px] pl-1 pr-2 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200">
                        <span className="max-w-40 truncate">{row?.name || 'مرکز'}</span>
                        {row?.province && <span className="text-amber-500">{row.province}</span>}
                        <button type="button" onClick={() => removeCenter(id)} className="w-4 h-4 rounded-full hover:bg-amber-100 flex items-center justify-center">
                          <X size={10} />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div className="max-h-44 overflow-y-auto pl-1 divide-y divide-gray-50">
                {centerResults.map((c) => {
                  const checked = state.centerIds.includes(c.id);
                  return (
                    <label key={c.id} className={`flex items-center gap-2 py-2 px-1 cursor-pointer rounded-lg ${
                      checked ? 'bg-teal-50/60' : 'hover:bg-gray-50'}`}>
                      <Checkbox checked={checked} onCheckedChange={() => toggleCenter(c.id)} className="h-3.5 w-3.5" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-medium text-gray-700 truncate">{c.name}</span>
                        <span className="block text-[10px] text-gray-400 truncate">
                          {c.province || '—'}{c.city ? ` · ${c.city}` : ''}
                        </span>
                      </span>
                    </label>
                  );
                })}
                {centerResults.length === 0 && (
                  <p className="text-center text-[11px] text-gray-300 py-4">مرکزی یافت نشد</p>
                )}
              </div>
            </div>
          )}

          {/* scoped modules info */}
          <div className="rounded-xl bg-gray-50 border border-gray-100 p-3">
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-gray-500 mb-2">
              <Info size={12} /> داده‌هایی که تبعیت می‌کنند:
            </div>
            <div className="flex flex-wrap gap-1">
              {TERRITORY_SCOPED_MODULES.map((m) => (
                <span key={m} className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-500">
                  {m}
                </span>
              ))}
            </div>
            <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">
              محدودیت در سطح دیتابیس اعمال می‌شود، نه فقط منوها؛ حتی فراخوانی مستقیم API خارج از محدوده پاسخی ندارد.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={busy || !canEdit} className="flex-1 h-10 rounded-lg text-white font-semibold text-xs"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              {busy ? 'در حال ثبت...' : selectedCount > 0
                ? `ثبت محدوده (${toPersianNum(selectedCount)} ${state.mode === 'provinces' ? 'استان' : 'مرکز'})`
                : 'ثبت محدوده فروش'}
            </Button>
            <Button onClick={onCancel} variant="outline" className="h-10 rounded-lg text-xs">انصراف</Button>
          </div>
        </>
      )}
    </div>
  );
}

const ROLE_CFG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode; desc: string }> = {
  admin: { label: 'مدیر سیستم', color: '#7c3aed', bg: '#f5f3ff', icon: <Shield size={12} />, desc: 'دسترسی کامل به همهٔ بخش‌ها + مدیریت کاربران و تنظیمات' },
  finance: { label: 'واحد مالی', color: '#059669', bg: '#ecfdf5', icon: <Building2 size={12} />, desc: 'کارتابل حسابداری، صورت‌حساب‌ها، اسناد همهٔ کاربران (بدون ویرایش مراکز)' },
  production: { label: 'واحد تولید', color: '#d97706', bg: '#fffbeb', icon: <Building2 size={12} />, desc: 'فضای تولید، انبار و درخواست‌های خرید' },
  standard: { label: 'کاربر عادی', color: '#0891b2', bg: '#ecfeff', icon: <Users size={12} />, desc: 'کارشناس فروش: مراکز، اسناد خودش، تقویم، پیگیری و گزارش‌های پایه' },
};

// v2.31.11 — legal names + group domains (round 40 briefing): the holding
// itself is not assignable here (admins reach it implicitly); subsidiaries
// are labelled with their legal identity and domain in the group.
const COMPANY_OPTIONS = [
  { slug: 'bazargani', label: 'بهبود گستر لیان ایرانیان — واحد بازرگانی گروه' },
  { slug: 'aria', label: 'آریا مدیکال — فروش دستگاه و تجهیزات کمک تنفسی' },
  { slug: 'bgl', label: 'بهبود گستر لیام ایرانیان — تولید دستگاه‌های خلوص‌سنج' },
  // v2.35.0 — isolated company: yasteb users are walled off from the group
  // (finance/warehouse/catalog); a user is either group-side or یاس طب-side.
  { slug: 'yasteb', label: 'یاس طب — تولید ست‌های ونتیلاتور (مستقل)' },
];

const GROUP_SLUGS_USER_FORM = ['bazargani', 'aria', 'bgl'];
const ISOLATED_SLUGS_USER_FORM = ['yasteb'];

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function parseCompanyIds(raw: string): string[] {
  try {
    const p = JSON.parse(raw || '[]');
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

async function apiCall(action: string, payload: Record<string, unknown> = {}) {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطای سرور'), { status: res.status });
  return data;
}

// ── create / edit user form ────────────────────────────────
function UserForm({ initial, registry, onDone, onCancel }: {
  initial: UserRow | null;
  registry: JobTitle[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [username, setUsername] = useState(initial?.username || '');
  const [displayName, setDisplayName] = useState(initial?.displayName || '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState(initial?.jobTitle || initial?.role || 'standard');
  const [province, setProvince] = useState(initial?.province || '');
  const [companies, setCompanies] = useState<string[]>(
    initial ? parseCompanyIds(initial.companyIds) : ['bazargani']
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleCompany = (slug: string) =>
    setCompanies((prev) => (prev.includes(slug) ? prev.filter((x) => x !== slug) : [...prev, slug]));

  const validate = (): string | null => {
    if (!username.trim()) return 'نام کاربری الزامی است.';
    if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username.trim()))
      return 'نام کاربری باید ۳ تا ۳۰ کاراکتر لاتین (حرف، رقم، نقطه، خط تیره) باشد.';
    if (!displayName.trim()) return 'نام نمایشی الزامی است.';
    if (!initial && password.length < 6) return 'رمز عبور باید حداقل ۶ کاراکتر باشد.';
    if (initial && password && password.length < 6) return 'رمز عبور جدید باید حداقل ۶ کاراکتر باشد.';
    const baseRole = registry.find((t) => t.key === role)?.baseRole || 'standard';
    if (baseRole !== 'admin' && companies.length === 0) return 'حداقل یک شرکت برای این عنوان شغلی انتخاب کنید.';
    // v2.35.0 — یاس طب is an isolated company: it cannot be combined with
    // group companies in one assignment (server enforces the same rule).
    const hasGroup = companies.some((c) => GROUP_SLUGS_USER_FORM.includes(c));
    const hasIsolated = companies.some((c) => ISOLATED_SLUGS_USER_FORM.includes(c));
    if (hasGroup && hasIsolated) {
      return 'یاس طب شرکت مستقلی است؛ نمی‌توان آن را همراه با شرکت‌های گروه انتخاب کرد. ابتدا سایر شرکت‌ها را بردارید.';
    }
    return null;
  };

  const submit = async () => {
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true);
    setError(null);
    const baseRole = registry.find((t) => t.key === role)?.baseRole || 'standard';
    const roleLabel = registry.find((t) => t.key === role)?.label || ROLE_CFG[role]?.label || role;
    try {
      if (initial) {
        // Update existing user (job title change handled server-side)
        await apiCall('update', {
          id: initial.id,
          displayName: displayName.trim(),
          province: province || undefined,
          ...(password ? { newPassword: password } : {}),
          ...(initial.jobTitle !== role ? { jobTitle: role } : {}),
        });
        if (baseRole !== 'admin') {
          await apiCall('update-companies', { id: initial.id, companyIds: companies });
        }
        toast.success('اطلاعات کاربر به‌روزرسانی شد');
      } else {
        // Create new user — job title drives base role & label on the server
        await apiCall('create', {
          username: username.trim(),
          displayName: displayName.trim(),
          password,
          jobTitle: role,
          province: province || undefined,
          businessUnitId: 'production',
        });
        // Assign companies after creation
        const list = await apiCall('list', { search: username.trim(), pageSize: 5 });
        const created = (list.items || []).find((u: UserRow) => u.username === username.trim());
        // v2.58.0 (audit 85-b HIGH): the company-assignment failure used to
        // be swallowed (`.catch(() => undefined)`) AND silently skipped when
        // the re-query missed the user — the admin toasted «ایجاد شد» while
        // the new user could access nothing. Both failures now surface.
        if (!created) {
          toast.error('کاربر ساخته شد اما یافتن آن برای تخصیص شرکت‌ها ناموفق بود — دسترسی شرکت‌ها را دستی ویرایش کنید.');
        } else if (baseRole !== 'admin') {
          try {
            await apiCall('update-companies', { id: created.id, companyIds: companies });
          } catch {
            toast.error('کاربر ساخته شد اما تخصیص شرکت‌ها ناموفق بود — دسترسی شرکت‌ها را دستی ویرایش کنید.');
          }
        }
        toast.success(`کاربر «${displayName.trim()}» با عنوان شغلی «${roleLabel}» ایجاد شد`);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت کاربر');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 mt-2">
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2.5">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">نام کاربری * <span className="text-[11px] text-gray-400">(لاتین)</span></label>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="مثلاً sales.ali" className="h-10 rounded-lg" dir="ltr" disabled={!!initial} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesusers-f159-1">نام نمایشی *</label>
          <Input id="salesusers-f159-1" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="مثلاً علی محمدی" className="h-10 rounded-lg" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesusers-f166-2">
            {initial ? 'رمز عبور جدید (اختیاری)' : 'رمز عبور *'}
          </label>
          <div className="relative">
            <Input id="salesusers-f166-2"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={initial ? 'خالی = بدون تغییر' : 'حداقل ۶ کاراکتر'}
              className="h-10 rounded-lg pl-10"
              dir="ltr"
            />
            <button type="button" onClick={() => setShowPassword(!showPassword)}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesusers-f185-3">استان (اختیاری)</label>
          <Input id="salesusers-f185-3" value={province} onChange={(e) => setProvince(e.target.value)} placeholder="مثلاً تهران" className="h-10 rounded-lg" />
        </div>
      </div>

      {/* Job-title picker with base-role hints */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">
          عنوان شغلی * <span className="text-[11px] text-gray-400">(تعیین‌کنندهٔ اختیارات امنیتی و منوها)</span>
        </label>
        <div className="grid grid-cols-2 gap-2 max-h-64 overflow-y-auto pl-1">
          {(registry.length > 0 ? registry : DEFAULT_JOB_TITLES).map((t) => {
            const cfg = ROLE_CFG[t.baseRole] || ROLE_CFG.standard;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setRole(t.key)}
                className={`p-3 rounded-xl border text-right transition-all ${
                  role === t.key ? 'border-teal-400 bg-teal-50/50 shadow-sm' : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ background: cfg.bg, color: cfg.color }}>
                    {cfg.icon}
                  </span>
                  <span className={`text-xs font-bold truncate ${role === t.key ? 'text-teal-800' : 'text-gray-700'}`}>{t.label}</span>
                  {role === t.key && <Check size={13} className="text-teal-600 mr-auto shrink-0" />}
                </div>
                <p className="text-[11px] text-gray-400 leading-relaxed line-clamp-2">{t.desc || cfg.desc}</p>
                <p className="text-[11px] text-gray-300 mt-1">نقش پایه: {cfg.label}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Company assignment (hidden for admin — admin sees all) */}
      {(registry.find((t) => t.key === role)?.baseRole || 'standard') !== 'admin' && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">
            شرکت‌های قابل دسترسی ({toPersianNum(companies.length)} انتخاب‌شده)
          </label>
          <div className="flex gap-2">
            {COMPANY_OPTIONS.map((c) => (
              <button
                key={c.slug}
                type="button"
                onClick={() => toggleCompany(c.slug)}
                className={`flex-1 h-10 rounded-xl border text-xs font-bold transition-all ${
                  companies.includes(c.slug)
                    ? 'border-teal-400 bg-teal-50 text-teal-700'
                    : 'border-gray-200 text-gray-500 hover:border-gray-300'
                }`}
              >
                {companies.includes(c.slug) && <Check size={11} className="inline ml-1" />}
                {c.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-gray-400 mt-1">دسترسی داده‌ای کاربر فقط به شرکت‌های انتخابی محدود می‌شود</p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={busy} className="flex-1 h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : initial ? 'به‌روزرسانی کاربر' : 'ایجاد کاربر'}
        </Button>
        <Button onClick={onCancel} variant="outline" className="h-10 rounded-lg">انصراف</Button>
      </div>
    </div>
  );
}

// ── main component ─────────────────────────────────────────
export default function SalesUsers() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [registry, setRegistry] = useState<JobTitle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<UserRow | null>(null);
  // v2.36.0 — sales territory dialog target
  const [territoryTarget, setTerritoryTarget] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, access] = await Promise.all([
        apiCall('list', { pageSize: 200 }),
        fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get-access-config' }),
        }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      setUsers(data.items || []);
      if (access?.jobTitles) setRegistry(access.jobTitles);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت کاربران');
    } finally {
      setLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  // v2.34.6 — who am I? (drives the impersonation button: admin-only, never on self)
  const [me, setMe] = useState<{ username: string; role: string; impersonating: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/auth', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check' }),
        });
        const data = await res.json();
        if (data.authenticated) {
          setMe({ username: data.user.username, role: data.user.role, impersonating: !!data.impersonating });
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // v2.34.6 — admin impersonation: switch into a user's account (banner + audit on server)
  const impersonate = async (u: UserRow) => {
    try {
      const res = await fetch('/api/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'impersonate', username: u.username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ورود به حساب');
      toast.success(`به حساب «${u.displayName}» سوئیچ شد — برای بازگشت از بنر بالای صفحه استفاده کنید`);
      window.location.href = '/';
      window.location.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ورود به حساب');
    }
  };

  const toggleActive = async (u: UserRow) => {
    try {
      await apiCall('update', { id: u.id, isActive: !u.isActive });
      toast.success(u.isActive ? `کاربر «${u.displayName}» غیرفعال شد` : `کاربر «${u.displayName}» فعال شد`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در تغییر وضعیت');
    }
  };

  const resetPassword = async (u: UserRow) => {
    const newPassword = prompt(`رمز عبور جدید برای «${u.displayName}» (حداقل ۶ کاراکتر):`);
    if (!newPassword) return;
    if (newPassword.length < 6) { toast.error('رمز باید حداقل ۶ کاراکتر باشد'); return; }
    try {
      await apiCall('update', { id: u.id, newPassword });
      toast.success('رمز عبور با موفقیت بازنشانی شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در بازنشانی رمز');
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await apiCall('delete', { id: confirmDelete.id });
      toast.success('کاربر حذف شد');
      setConfirmDelete(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف');
    }
  };

  const filtered = useMemo(() => users.filter((u) => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      if (!u.username.toLowerCase().includes(q) && !u.displayName.includes(q)) return false;
    }
    if (filterRole !== 'all' && u.role !== filterRole) return false;
    if (filterStatus === 'active' && !u.isActive) return false;
    if (filterStatus === 'inactive' && u.isActive) return false;
    return true;
  }), [users, search, filterRole, filterStatus]);

  const activeCount = users.filter((u) => u.isActive).length;

  const stats = [
    { label: 'کل کاربران', value: toPersianNum(users.length), icon: <Users size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'فعال', value: toPersianNum(activeCount), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'مدیران', value: toPersianNum(users.filter((u) => u.role === 'admin').length), icon: <Shield size={16} />, color: '#7c3aed', bg: '#f5f3ff' },
    { label: 'کارشناسان', value: toPersianNum(users.filter((u) => u.role === 'standard').length), icon: <UserPlus size={16} />, color: '#0891b2', bg: '#ecfeff' },
  ];

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
              <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
            </div>
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو نام یا نام کاربری..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همهٔ نقش‌های پایه</option>
            {Object.entries(ROLE_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
            <option value="all">همه</option>
            <option value="active">فعال</option>
            <option value="inactive">غیرفعال</option>
          </select>
          <button
            onClick={() => { setEditing(null); setShowForm(true); }}
            className="h-9 gap-1.5 text-white text-xs rounded-lg px-3 font-medium flex items-center shrink-0"
            style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
          >
            <UserPlus size={13} /> کاربر جدید
          </button>
        </div>
      </div>

      {/* Users table */}
      {loading ? (
        <SkeletonList count={4} />
      ) : error ? (
        <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={load} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <Users size={28} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm font-bold text-gray-600 mb-1">کاربری یافت نشد</p>
          <p className="text-xs text-gray-400 mb-4">با ایجاد اولین کاربر، مدیریت دسترسی آغاز می‌شود</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[760px]">
              <thead>
                <tr className="bg-gray-50 text-gray-500 border-b border-gray-100">
                  <th className="py-3 px-3 text-right font-bold">کاربر</th>
                  <th className="py-3 px-3 text-right font-bold">نام کاربری</th>
                  <th className="py-3 px-3 text-right font-bold">سطح دسترسی</th>
                  <th className="py-3 px-3 text-right font-bold">شرکت‌ها</th>
                  <th className="py-3 px-3 text-center font-bold">وضعیت</th>
                  <th className="py-3 px-3 text-center font-bold">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u, i) => {
                  const role = ROLE_CFG[u.role] || ROLE_CFG.standard;
                  const comps = u.role === 'admin' ? ['همهٔ شرکت‌ها'] : parseCompanyIds(u.companyIds);
                  return (
                    <tr key={u.id} className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0 ${i % 2 ? 'bg-gray-50/30' : ''}`} style={{ animationDelay: `${i * 30}ms` }}>
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2.5">
                          {/* v2.27.0 — inactive avatar used an inline #d1d5db that
                              leaked white in dark mode (exposed by the AI test's
                              deactivated fixture user); dark: class variant instead */}
                          <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-white text-[11px] font-bold shrink-0 ${u.isActive ? '' : 'bg-slate-300 dark:bg-slate-600'}`}
                            style={u.isActive ? { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' } : undefined}>
                            {u.displayName.slice(0, 1)}
                          </div>
                          <div>
                            <p className="font-bold text-gray-900">{u.displayName}</p>
                            {u.province && <p className="text-[11px] text-gray-400">{u.province}</p>}
                            {/* v2.36.0 — sales territory chip (محدودهٔ فروش) */}
                            {(() => {
                              const chip = territoryChip(u);
                              return (
                                <span className="inline-flex items-center gap-1 mt-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-md"
                                  style={{ background: chip.bg, color: chip.color }}>
                                  <MapPin size={9} /> {chip.label}
                                </span>
                              );
                            })()}
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3 font-mono text-gray-600 text-right" dir="ltr">{u.username}</td>
                      <td className="py-3 px-3">
                        <div className="flex flex-col gap-1 items-start">
                          <span className="text-[11px] font-bold text-gray-800">
                            {registry.find((t) => t.key === u.jobTitle)?.label || u.roleLabel || role.label}
                          </span>
                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md inline-flex items-center gap-1" style={{ background: role.bg, color: role.color }}>
                            {role.icon} {role.label}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex flex-wrap gap-1">
                          {comps.length === 0 && <span className="text-gray-300">—</span>}
                          {comps.map((c) => (
                            <span key={c} className="text-[11px] px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-600">{c}</span>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-3 text-center">
                        <button
                          onClick={() => toggleActive(u)}
                          className={`text-[11px] font-bold px-2.5 py-1 rounded-full inline-flex items-center gap-1 transition-colors ${
                            u.isActive ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-gray-100 text-gray-400 hover:bg-gray-200'
                          }`}
                          title={u.isActive ? 'غیرفعال‌سازی' : 'فعال‌سازی'}
                        >
                          {u.isActive ? <><Unlock size={10} /> فعال</> : <><Lock size={10} /> غیرفعال</>}
                        </button>
                      </td>
                      <td className="py-3 px-3">
                        <div className="flex items-center justify-center gap-1">
                          {/* v2.36.0 — sales territory (محدودهٔ فروش): operational
                              experts only — admin/finance/production keep their
                              designed reach */}
                          {u.role === 'standard' && me?.role === 'admin' && !me.impersonating && (
                            <button onClick={() => setTerritoryTarget(u)} className="w-7 h-7 rounded-lg hover:bg-teal-50 text-teal-600 flex items-center justify-center"
                              title={`محدودهٔ فروش ${u.displayName} (استان‌ها / مراکز خاص)`}>
                              <MapPin size={13} />
                            </button>
                          )}
                          <button onClick={() => { setEditing(u); setShowForm(true); }} className="w-7 h-7 rounded-lg hover:bg-teal-50 text-teal-600 flex items-center justify-center" title="ویرایش">
                            <Edit3 size={13} />
                          </button>
                          {/* v2.34.6 — impersonate: admin-only, active users, never self, never while impersonating */}
                          {me?.role === 'admin' && !me.impersonating && u.isActive && me.username !== u.username && (
                            <button onClick={() => impersonate(u)} className="w-7 h-7 rounded-lg hover:bg-violet-50 text-violet-600 flex items-center justify-center" title={`ورود به حساب ${u.displayName} (نمای مدیر — با بنر بالای صفحه بازگشت)`}>
                              <LogIn size={13} />
                            </button>
                          )}
                          <button onClick={() => resetPassword(u)} className="w-7 h-7 rounded-lg hover:bg-amber-50 text-amber-600 flex items-center justify-center" title="بازنشانی رمز">
                            <KeyRound size={13} />
                          </button>
                          <button onClick={() => setConfirmDelete(u)} className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center" title="حذف">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={showForm} onOpenChange={(open) => { setShowForm(open); if (!open) setEditing(null); }}>
        <DialogContent className="max-w-[min(36rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle>{editing ? `ویرایش کاربر — ${editing.displayName}` : 'ایجاد کاربر جدید'}</DialogTitle>
          </DialogHeader>
          <UserForm
            initial={editing}
            registry={registry.length > 0 ? registry : DEFAULT_JOB_TITLES}
            onDone={() => { setShowForm(false); setEditing(null); load(); }}
            onCancel={() => { setShowForm(false); setEditing(null); }}
          />
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="max-w-[min(24rem,calc(100vw-2rem))]" dir="rtl">
          <DialogHeader><DialogTitle>حذف کاربر</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600 mt-2">
            آیا از حذف «<b>{confirmDelete?.displayName}</b>» مطمئن هستید؟
            نشست‌های فعال او نیز باطل می‌شود. این عمل قابل بازگشت نیست.
          </p>
          <div className="flex gap-2 mt-4">
            <Button onClick={handleDelete} className="flex-1 h-9 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs">حذف قطعی</Button>
            <Button onClick={() => setConfirmDelete(null)} variant="outline" className="flex-1 h-9 rounded-lg text-xs">انصراف</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* v2.36.0 — Sales Territory dialog (محدودهٔ دسترسی فروشنده) */}
      <Dialog open={!!territoryTarget} onOpenChange={(open) => { if (!open) setTerritoryTarget(null); }}>
        <DialogContent className="max-w-in(40rem,calc(100vw-2rem))] max-h-[88vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MapPin size={16} className="text-teal-600" />
              محدودهٔ فروش — {territoryTarget?.displayName}
            </DialogTitle>
          </DialogHeader>
          {territoryTarget && (
            <TerritoryDialog
              target={territoryTarget}
              onDone={() => { setTerritoryTarget(null); load(); }}
              onCancel={() => setTerritoryTarget(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
