'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SkeletonList } from '@/hooks/use-api';
import { toast } from 'sonner';
import {
  Shield, Users, Plus, Edit3, Trash2, Check, Save, RotateCcw,
  Building2, Briefcase, Heart, Star, Layers, Info, AlertTriangle, Lock,
  // v2.35.0 — یاس طب (isolated company) tab icon
  Wind,
} from 'lucide-react';
import {
  JobTitle, MenuAccessMatrix, BASE_ROLES,
  DEFAULT_MENU_ACCESS, effectiveMatrix, isValidJobTitleKey,
} from '@/lib/access-config';
import { CompanySlug, COMPANY_SLUGS, COMPANY_META, COMPANY_MENUS, allMenuKeys } from '@/lib/menu-catalog';

// ═══════════════════════════════════════════════════════════
// Access Customization — admin panel for per-company ×
// per-job-title module/menu/submenu visibility.
// Tab 1: job-title registry (عناوین شغلی)
// Tab 2: menu-access matrix (دسترسی منوها)
// ═══════════════════════════════════════════════════════════

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

const COMPANY_ICONS: Record<CompanySlug, React.ReactNode> = {
  holding: <Layers size={14} />,
  bazargani: <Briefcase size={14} />,
  aria: <Heart size={14} />,
  bgl: <Star size={14} />,
  yasteb: <Wind size={14} />,
};

const COMPANY_COLORS: Record<CompanySlug, { color: string; bg: string }> = {
  holding: { color: '#1F8B7D', bg: '#e6f7f4' },
  bazargani: { color: '#2980B9', bg: '#eaf3fb' },
  aria: { color: '#8E44AD', bg: '#f6eefb' },
  bgl: { color: '#2E2A5C', bg: '#eef0f8' },
  yasteb: { color: '#0D9488', bg: '#e6faf7' },
};

async function apiCall(action: string, payload: Record<string, unknown> = {}) {
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطای سرور'), { status: res.status });
  return data;
}

export default function AccessCustomization() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'titles' | 'matrix'>('titles');

  // registry + matrix state
  const [jobTitles, setJobTitles] = useState<JobTitle[]>([]);
  const [matrix, setMatrix] = useState<MenuAccessMatrix>({});
  const [userCounts, setUserCounts] = useState<Record<string, number>>({});
  const [dirty, setDirty] = useState(false);

  // matrix tab selections
  const [company, setCompany] = useState<CompanySlug>('bazargani');
  const [titleKey, setTitleKey] = useState('sales_expert');

  // job title dialog
  const [dialog, setDialog] = useState<{ mode: 'create' } | { mode: 'edit'; title: JobTitle } | null>(null);
  const [dlgLabel, setDlgLabel] = useState('');
  const [dlgKey, setDlgKey] = useState('');
  const [dlgBaseRole, setDlgBaseRole] = useState('standard');
  const [dlgDesc, setDlgDesc] = useState('');
  const [dlgError, setDlgError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiCall('get-access-config');
      const titles: JobTitle[] = data.jobTitles || [];
      const saved: MenuAccessMatrix = data.menuAccess || {};
      setJobTitles(titles);
      setMatrix(effectiveMatrix(saved));
      setUserCounts(data.userCounts || {});
      // keep a sensible default selection
      if (!titles.find((t) => t.key === titleKey)) {
        const first = titles.find((t) => t.baseRole !== 'admin') || titles[0];
        if (first) setTitleKey(first.key);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در بارگذاری تنظیمات دسترسی');
    } finally {
      setLoading(false);
    }
  }, [titleKey]);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  // v2.21.0 — latest-ref pattern: the load must fire ONCE on mount. Adding
  // `load` directly to the deps would re-fire it whenever titleKey changes
  // (load is a useCallback([titleKey])) and WIPE unsaved matrix edits; the
  // ref keeps the dep array honest while preserving mount-only semantics.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    queueMicrotask(() => loadRef.current());
  }, []);

  // ── matrix helpers ─────────────────────────────────────
  const selectableTitles = useMemo(
    () => jobTitles.filter((t) => t.baseRole !== 'admin'),
    [jobTitles],
  );

  const currentTitle = useMemo(
    () => jobTitles.find((t) => t.key === titleKey),
    [jobTitles, titleKey],
  );

  const row: string[] = useMemo(() => {
    const r = matrix[titleKey]?.[company];
    if (Array.isArray(r) && r.length > 0) return r;
    // rows are materialized on first edit; empty row = restricted to nothing
    if (Array.isArray(r)) return r;
    return allMenuKeys(company); // no row yet → full access
  }, [matrix, titleKey, company]);

  const isFullAccess = !Array.isArray(matrix[titleKey]?.[company]);
  const defaultRow = DEFAULT_MENU_ACCESS[titleKey]?.[company];
  const isDefaultRow = !!defaultRow && !isFullAccess && defaultRow.length === row.length && defaultRow.every((k) => row.includes(k));

  const toggleKey = (key: string, parentKey?: string, childKeys: string[] = []) => {
    setMatrix((prev) => {
      const cur = prev[titleKey]?.[company] ?? allMenuKeys(company);
      let next: string[];
      if (childKeys.length > 0 && key === parentKey) {
        // parent toggle → parent + all children
        const allOn = cur.includes(parentKey) && childKeys.every((c) => cur.includes(c));
        if (allOn) next = cur.filter((k) => k !== parentKey && !childKeys.includes(k));
        else next = Array.from(new Set([...cur, parentKey, ...childKeys]));
      } else if (parentKey) {
        // child toggle → ensure parent on when enabling
        if (cur.includes(key)) next = cur.filter((k) => k !== key);
        else next = Array.from(new Set([...cur, key, parentKey]));
      } else {
        if (cur.includes(key)) next = cur.filter((k) => k !== key);
        else next = [...cur, key];
      }
      return { ...prev, [titleKey]: { ...(prev[titleKey] || {}), [company]: next } };
    });
    setDirty(true);
  };

  const setAll = (on: boolean) => {
    setMatrix((prev) => ({
      ...prev,
      [titleKey]: { ...(prev[titleKey] || {}), [company]: on ? allMenuKeys(company) : [] },
    }));
    setDirty(true);
  };

  const resetRow = () => {
    setMatrix((prev) => {
      const titleRows = { ...(prev[titleKey] || {}) };
      if (defaultRow) titleRows[company] = [...defaultRow];
      else delete titleRows[company];
      return { ...prev, [titleKey]: titleRows };
    });
    setDirty(true);
  };

  const saveMatrix = async () => {
    try {
      const data = await apiCall('set-menu-access', { menuAccess: matrix });
      const saved: MenuAccessMatrix = data.menuAccess || {};
      setMatrix(effectiveMatrix(saved));
      setDirty(false);
      toast.success('دسترسی منوها برای همهٔ شرکت‌ها و عناوین ذخیره شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ذخیره');
    }
  };

  // ── job title registry helpers ─────────────────────────
  const openCreate = () => {
    setDlgLabel(''); setDlgKey(''); setDlgBaseRole('standard'); setDlgDesc(''); setDlgError(null);
    setDialog({ mode: 'create' });
  };

  const openEdit = (t: JobTitle) => {
    setDlgLabel(t.label); setDlgKey(t.key); setDlgBaseRole(t.baseRole); setDlgDesc(t.desc || ''); setDlgError(null);
    setDialog({ mode: 'edit', title: t });
  };

  const submitTitle = async () => {
    if (!dialog) return;
    const isEdit = dialog.mode === 'edit';
    if (!dlgLabel.trim()) { setDlgError('عنوان فارسی الزامی است.'); return; }
    if (!isEdit && !isValidJobTitleKey(dlgKey.trim())) {
      setDlgError('کلید باید ۳ تا ۳۰ کاراکتر لاتین کوچک باشد و با حرف شروع شود. مثال: tehran_agent');
      return;
    }
    const nextKey = isEdit ? dialog.title.key : dlgKey.trim();
    if (!isEdit && jobTitles.some((t) => t.key === nextKey)) { setDlgError('این کلید قبلاً استفاده شده است.'); return; }
    const next: JobTitle[] = isEdit
      ? jobTitles.map((t) => (t.key === nextKey
        ? { ...t, label: dlgLabel.trim(), desc: dlgDesc.trim() || undefined, baseRole: t.isSystem ? t.baseRole : dlgBaseRole }
        : t))
      : [...jobTitles, { key: nextKey, label: dlgLabel.trim(), baseRole: dlgBaseRole, desc: dlgDesc.trim() || undefined }];
    try {
      const data = await apiCall('set-job-titles', { jobTitles: next });
      setJobTitles(data.jobTitles || next);
      setDialog(null);
      toast.success(isEdit ? 'عنوان شغلی ویرایش شد' : `عنوان شغلی «${dlgLabel.trim()}» ایجاد شد`);
      if (!isEdit) setTitleKey(nextKey);
    } catch (e) {
      setDlgError(e instanceof Error ? e.message : 'خطا در ذخیره');
    }
  };

  const removeTitle = async (t: JobTitle) => {
    if (t.isSystem) return;
    const count = userCounts[t.key] || 0;
    if (count > 0) {
      toast.error(`این عنوان به ${toPersianNum(count)} کاربر اختصاص دارد. ابتدا عنوان کاربران را تغییر دهید.`);
      return;
    }
    if (!confirm(`عنوان شغلی «${t.label}» حذف شود؟`)) return;
    try {
      const next = jobTitles.filter((x) => x.key !== t.key);
      const data = await apiCall('set-job-titles', { jobTitles: next });
      setJobTitles(data.jobTitles || next);
      // drop matrix rows of the removed title
      setMatrix((prev) => {
        const copy = { ...prev };
        delete copy[t.key];
        return copy;
      });
      setDirty(true);
      toast.success('عنوان شغلی حذف شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف');
    }
  };

  // ── render ─────────────────────────────────────────────
  if (loading) return <SkeletonList count={4} />;
  if (error) {
    return (
      <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
        <p className="text-sm text-red-600 mb-3">{error}</p>
        <button onClick={() => load()} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Explainer */}
      <div className="bg-gradient-to-l from-teal-50 to-white rounded-xl border border-teal-100 p-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-teal-100 text-teal-700 flex items-center justify-center shrink-0"><Shield size={16} /></div>
          <div>
            <p className="text-sm font-bold text-gray-800">شخصی‌سازی دسترسی بر اساس کسب‌وکار هر شرکت</p>
            <p className="text-xs text-gray-500 leading-6 mt-1">
              هر شرکت مدل کسب‌وکار متفاوتی دارد: <b>بازرگانی</b> (B2B — مراکز درمانی خصوصی و دولتی، همکاران و نمایندگان)،
              <b> آریا مدیکال</b> (B2C — مصرف‌کننده نهایی) و <b>بهبود گستر لیام ایرانیان</b> (تولید — ترکیبی B2B + B2C).
              برای هر شرکت و هر عنوان شغلی مشخص کنید چه ماژول‌ها، منوها و زیرمنوهایی نمایش داده شود.
              دسترسی‌های امنیتی پایه (مالی، تولید و…) از نقش پایهٔ هر عنوان پیروی می‌کند.
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
          <button
            onClick={() => setTab('titles')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${tab === 'titles' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Users size={14} /> عناوین شغلی
          </button>
          <button
            onClick={() => setTab('matrix')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${tab === 'matrix' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
          >
            <Building2 size={14} /> دسترسی منوها و زیرمنوها
          </button>
          {dirty && (
            <span className="mr-auto flex items-center gap-1 text-[11px] text-amber-600 bg-amber-50 px-2 py-1 rounded-full">
              <AlertTriangle size={11} /> تغییرات ذخیره‌نشده
            </span>
          )}
        </div>
      </div>

      {tab === 'titles' && (
        <div className="space-y-3">
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-gray-50">
              <p className="text-xs font-bold text-gray-700">عناوین شغلی سامانه ({toPersianNum(jobTitles.length)} عنوان)</p>
              <button
                onClick={openCreate}
                className="h-8 gap-1.5 text-white text-xs rounded-lg px-3 font-medium flex items-center"
                style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
              >
                <Plus size={13} /> عنوان شغلی جدید
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[720px]">
                <thead>
                  <tr className="bg-gray-50 text-gray-500 border-b border-gray-100">
                    <th className="py-3 px-3 text-right font-bold">عنوان شغلی</th>
                    <th className="py-3 px-3 text-right font-bold">کلید</th>
                    <th className="py-3 px-3 text-right font-bold">نقش پایه (اختیارات امنیتی)</th>
                    <th className="py-3 px-3 text-center font-bold">کاربران</th>
                    <th className="py-3 px-3 text-center font-bold">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {jobTitles.map((t, i) => {
                    const br = BASE_ROLES.find((r) => r.key === t.baseRole) || BASE_ROLES[3];
                    const count = userCounts[t.key] || 0;
                    return (
                      <tr key={t.key} className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors ${i % 2 ? 'bg-gray-50/30' : ''}`}>
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-gray-800">{t.label}</span>
                            {t.isSystem && (
                              <Badge variant="outline" className="text-[11px] gap-1 border-gray-200 text-gray-400">
                                <Lock size={9} /> سیستمی
                              </Badge>
                            )}
                          </div>
                          {t.desc && <p className="text-[11px] text-gray-400 mt-0.5 leading-5 max-w-[min(28rem,calc(100vw-2rem))]">{t.desc}</p>}
                        </td>
                        <td className="py-3 px-3">
                          <code className="text-[11px] bg-gray-100 rounded px-1.5 py-0.5 text-gray-600" dir="ltr">{t.key}</code>
                        </td>
                        <td className="py-3 px-3">
                          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full"
                            style={{ color: br.key === 'admin' ? '#7c3aed' : br.key === 'finance' ? '#059669' : br.key === 'production' ? '#d97706' : '#0891b2', background: br.key === 'admin' ? '#f5f3ff' : br.key === 'finance' ? '#ecfdf5' : br.key === 'production' ? '#fffbeb' : '#ecfeff' }}>
                            {br.label}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-center">
                          <span className={`font-bold ${count > 0 ? 'text-gray-700' : 'text-gray-300'}`}>{toPersianNum(count)}</span>
                        </td>
                        <td className="py-3 px-3">
                          <div className="flex items-center justify-center gap-1">
                            <button onClick={() => openEdit(t)} className="text-gray-400 hover:text-teal-600 p-1.5 rounded-lg hover:bg-teal-50 transition-colors" title="ویرایش">
                              <Edit3 size={13} />
                            </button>
                            <button
                              onClick={() => removeTitle(t)}
                              disabled={t.isSystem}
                              className="text-gray-400 hover:text-red-600 p-1.5 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                              title={t.isSystem ? 'عناوین سیستمی قابل حذف نیستند' : 'حذف'}
                            >
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
          <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-start gap-2">
            <Info size={14} className="text-gray-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-gray-500 leading-6">
              «نقش پایه» تعیین‌کنندهٔ اختیارات امنیتی در سرور است (دسترسی به APIهای مالی، تولید، مدیریت کاربران و…).
              «دسترسی منوها» تعیین می‌کند هر عنوان در هر شرکت چه ماژول‌هایی ببیند — در تب بعدی تنظیم می‌شود.
              عنوان‌های سیستمی (مدیر سیستم، مالی، تولید، کاربر عادی) قابل حذف نیستند.
            </p>
          </div>
        </div>
      )}

      {tab === 'matrix' && (
        <div className="space-y-3">
          {/* Company selector */}
          <div className="bg-white rounded-xl border border-gray-100 p-3">
            <p className="text-[11px] text-gray-400 mb-2">انتخاب شرکت</p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              {COMPANY_SLUGS.map((slug) => {
                const meta = COMPANY_META[slug];
                const active = company === slug;
                const colors = COMPANY_COLORS[slug];
                return (
                  <button
                    key={slug}
                    onClick={() => setCompany(slug)}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border transition-all text-right ${active ? 'border-transparent shadow-sm' : 'border-gray-100 hover:border-gray-200 bg-gray-50/50'}`}
                    style={active ? { background: colors.bg } : undefined}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                      style={{ background: active ? '#fff' : colors.bg, color: colors.color }}>
                      {COMPANY_ICONS[slug]}
                    </div>
                    <div className="min-w-0">
                      <p className={`text-xs font-bold truncate ${active ? '' : 'text-gray-700'}`} style={active ? { color: colors.color } : undefined}>{meta.shortName}</p>
                      <p className="text-[11px] text-gray-400 truncate">{meta.businessModel}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Title selector + actions */}
          <div className="bg-white rounded-xl border border-gray-100 p-3">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
              <div className="flex-1">
                <p className="text-[11px] text-gray-400 mb-1.5">عنوان شغلی</p>
                <select
                  value={titleKey}
                  onChange={(e) => setTitleKey(e.target.value)}
                  className="w-full h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-700"
                >
                  {selectableTitles.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-end gap-2">
                <button onClick={() => setAll(true)} className="h-9 text-xs rounded-lg px-3 border border-gray-200 text-gray-600 hover:bg-gray-50">همه</button>
                <button onClick={() => setAll(false)} className="h-9 text-xs rounded-lg px-3 border border-gray-200 text-gray-600 hover:bg-gray-50">هیچ</button>
                <button onClick={resetRow} className="h-9 gap-1.5 text-xs rounded-lg px-3 border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center">
                  <RotateCcw size={12} /> پیش‌فرض
                </button>
                <button
                  onClick={saveMatrix}
                  className="h-9 gap-1.5 text-white text-xs rounded-lg px-4 font-medium flex items-center"
                  style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
                >
                  <Save size={13} /> ذخیرهٔ دسترسی‌ها
                </button>
              </div>
            </div>
            {currentTitle && (
              <div className="mt-2.5 flex items-center gap-2 flex-wrap">
                {isFullAccess ? (
                  <span className="text-[11px] text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full flex items-center gap-1">
                    <Check size={10} /> وضعیت فعلی: دسترسی کامل (پیش‌فرض)
                  </span>
                ) : isDefaultRow ? (
                  <span className="text-[11px] text-teal-700 bg-teal-50 px-2 py-1 rounded-full">وضعیت فعلی: الگوی پیش‌فرض سامانه</span>
                ) : (
                  <span className="text-[11px] text-amber-700 bg-amber-50 px-2 py-1 rounded-full">وضعیت فعلی: شخصی‌سازی‌شده</span>
                )}
                <span className="text-[11px] text-gray-400">
                  {toPersianNum(row.length)} آیتم از {toPersianNum(allMenuKeys(company).length)} مجاز است
                </span>
              </div>
            )}
          </div>

          {/* Menu tree */}
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <div className="space-y-1">
              {(COMPANY_MENUS[company] || []).map((m) => {
                const childKeys = (m.children || []).map((c) => c.key);
                const parentOn = row.includes(m.key);
                const childrenOn = childKeys.filter((c) => row.includes(c)).length;
                return (
                  <div key={m.key}>
                    <button
                      onClick={() => toggleKey(m.key, m.key, childKeys)}
                      className={`w-full flex items-center gap-3 p-2.5 rounded-xl border transition-all text-right ${parentOn ? 'border-teal-100 bg-teal-50/60' : 'border-gray-100 bg-gray-50/40 hover:border-gray-200'}`}
                    >
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-all ${parentOn ? 'border-teal-500 bg-teal-500 text-white' : 'border-gray-300 bg-white'}`}>
                        {parentOn && <Check size={12} strokeWidth={3} />}
                      </div>
                      <span className={`text-xs font-bold flex-1 ${parentOn ? 'text-gray-800' : 'text-gray-500'}`}>{m.label}</span>
                      {m.children && m.children.length > 0 && (
                        <span className={`text-[11px] ${childrenOn === m.children!.length ? 'text-teal-600' : childrenOn > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                          {toPersianNum(childrenOn)} از {toPersianNum(m.children!.length)}
                        </span>
                      )}
                    </button>
                    {m.children && m.children.length > 0 && (
                      <div className="mr-6 mt-1 pr-3 border-r border-gray-100 space-y-0.5">
                        {m.children.map((c) => {
                          const on = row.includes(c.key);
                          return (
                            <button
                              key={c.key}
                              onClick={() => toggleKey(c.key, m.key)}
                              className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg transition-all text-right ${on ? 'bg-teal-50/40' : 'hover:bg-gray-50'}`}
                            >
                              <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-all ${on ? 'border-teal-500 bg-teal-500 text-white' : 'border-gray-300 bg-white'}`}>
                                {on && <Check size={9} strokeWidth={3} />}
                              </div>
                              <span className={`text-[11px] ${on ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>{c.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-start gap-2">
            <Info size={14} className="text-gray-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-gray-500 leading-6">
              با فعال‌کردن هر منو، زیرمنوهای آن نیز به‌صورت پیش‌فرض فعال می‌شوند؛ می‌توانید زیرمنوها را جداگانه غیرفعال کنید.
              تغییرات پس از «ذخیره» برای کاربران در ورود بعدی اعمال می‌شود و نشست‌های فعال منوی جدید را در بارگذاری بعدی صفحه می‌گیرند.
              مدیر سیستم همیشه دسترسی کامل دارد.
            </p>
          </div>
        </div>
      )}

      {/* Job title dialog */}
      <Dialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle className="text-right">
              {dialog?.mode === 'edit' ? `ویرایش عنوان شغلی: ${dialog.title.label}` : 'عنوان شغلی جدید'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3.5 mt-2">
            {dlgError && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2.5">{dlgError}</p>}
            <div>
              <label className="text-[11px] font-medium text-gray-600 block mb-1.5" htmlFor="accesscustomization-f539-1">عنوان فارسی *</label>
              <Input id="accesscustomization-f539-1" value={dlgLabel} onChange={(e) => setDlgLabel(e.target.value)} placeholder="مثال: کارشناس فروش نمایندگان" className="h-9 rounded-lg text-xs" />
            </div>
            {dialog?.mode === 'create' && (
              <div>
                <label className="text-[11px] font-medium text-gray-600 block mb-1.5" htmlFor="accesscustomization-f544-2">کلید لاتین (یکتا) *</label>
                <Input id="accesscustomization-f544-2" value={dlgKey} onChange={(e) => setDlgKey(e.target.value.replace(/[^a-z0-9_]/g, ''))} placeholder="مثال: agent_sales" dir="ltr" className="h-9 rounded-lg text-xs font-mono" />
                <p className="text-[11px] text-gray-400 mt-1">برای استفاده در سیستم — فقط حروف کوچک لاتین، رقم و زیرخط</p>
              </div>
            )}
            <div>
              <label className="text-[11px] font-medium text-gray-600 block mb-1.5" htmlFor="accesscustomization-f550-3">نقش پایه (اختیارات امنیتی) *</label>
              <select id="accesscustomization-f550-3"
                value={dlgBaseRole}
                onChange={(e) => setDlgBaseRole(e.target.value)}
                disabled={dialog?.mode === 'edit' && dialog.title.isSystem}
                className="w-full h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-700 disabled:bg-gray-50 disabled:text-gray-400"
              >
                {BASE_ROLES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              {BASE_ROLES.find((r) => r.key === dlgBaseRole) && (
                <p className="text-[11px] text-gray-400 mt-1">{BASE_ROLES.find((r) => r.key === dlgBaseRole)!.desc}</p>
              )}
              {dialog?.mode === 'edit' && dialog.title.isSystem && (
                <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1"><Lock size={10} /> نقش پایهٔ عناوین سیستمی قابل تغییر نیست</p>
              )}
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-600 block mb-1.5" htmlFor="accesscustomization-f567-4">توضیح اختیارات</label>
              <Input id="accesscustomization-f567-4" value={dlgDesc} onChange={(e) => setDlgDesc(e.target.value)} placeholder="اختیاری — در فرم ایجاد کاربر نمایش داده می‌شود" className="h-9 rounded-lg text-xs" />
            </div>
            <div className="flex gap-2 pt-1">
              <Button onClick={submitTitle} className="flex-1 h-10 text-white text-sm rounded-xl font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                {dialog?.mode === 'edit' ? 'ذخیرهٔ تغییرات' : 'ایجاد عنوان'}
              </Button>
              <Button onClick={() => setDialog(null)} variant="outline" className="h-10 text-sm rounded-xl px-6 border-gray-200 text-gray-600">انصراف</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
