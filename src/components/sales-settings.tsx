'use client';

import React, { useState, useEffect } from 'react';
import { HesabfaConnectionsCard } from '@/components/hesabfa-connections';
import SmsDialog from '@/components/sms-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import AccessCustomization from '@/components/access-customization';
import { useTabAccess } from '@/components/access-context';
import {
  Settings, Shield, Database, Lock,
  Building2, Users, Globe, HardDrive,
  Percent, Download, Key, Wifi, MessageCircle,
  Image as ImageIcon, Upload, X as XIcon, Palette as PaletteIcon,
} from 'lucide-react';
// v2.48.0 — the SAME pure validators the API enforces, reused here for
// live client-side feedback (single source of truth, no drift).
import { LOGO_MAX_INPUT_BYTES, checkLogoDataUrl, normalizeSheba } from '@/lib/company-profile';
// v2.52.0 — per-company print template registry (تفکیک قالب چاپ): the
// selector cards + live letterhead preview share the exact palette the
// A4 sheet resolves from Company.printTemplate.
import { PRINT_TEMPLATES, PRINT_TEMPLATE_KEYS, resolvePrintTemplate } from '@/lib/print-templates';

type SettingsTab = 'general' | 'security' | 'access' | 'backup' | 'integrations';

// ==================== GENERAL SETTINGS (live: reads/writes /api/settings) ====================
function GeneralSettingsTab() {
  const [companyName, setCompanyName] = useState('');
  const [appName, setAppName] = useState('');
  const [website, setWebsite] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [economicCode, setEconomicCode] = useState('');
  const [vatRate, setVatRate] = useState('9');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get', keys: ['app.name', 'app.company', 'app.website', 'app.vat_rate', 'app.address', 'app.phone', 'app.economic_code'] }),
        });
        const data = await res.json();
        if (res.ok && data.settings) {
          setAppName(data.settings['app.name'] || 'سامانه فروش');
          setCompanyName(data.settings['app.company'] || 'هلدینگ بهبود گستر');
          setWebsite(data.settings['app.website'] || '');
          setAddress(data.settings['app.address'] || '');
          setPhone(data.settings['app.phone'] || '');
          setEconomicCode(data.settings['app.economic_code'] || '');
          setVatRate(data.settings['app.vat_rate'] || '9');
        }
      } catch {
        setError('خطا در دریافت تنظیمات');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // v2.18.0 — the save used to POST a `{ settings: {...} }` object while the
  // API only accepted single `{ key, value }` pairs, so every save failed
  // with 400. The API now accepts the bulk shape too.
  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set',
          settings: {
            'app.name': appName,
            'app.company': companyName,
            'app.website': website,
            'app.address': address,
            'app.phone': phone,
            'app.economic_code': economicCode,
            'app.vat_rate': vatRate,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
      setMessage('تنظیمات با موفقیت ذخیره شد');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
        <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-400">در حال دریافت تنظیمات...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {message && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-700">{message}</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{error}</div>}

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-4">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Building2 size={14} className="text-teal-600" /> اطلاعات شرکت</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f108-1">نام شرکت</label>
            <Input id="salessettings-f108-1" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="h-10 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f112-2">نام نمایشی سیستم</label>
            <Input id="salessettings-f112-2" value={appName} onChange={(e) => setAppName(e.target.value)} className="h-10 rounded-lg" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f117-3">وبسایت</label>
          <Input id="salessettings-f117-3" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" className="h-10 rounded-lg" dir="ltr" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f121-4">آدرس (سربرگ اسناد)</label>
          <Input id="salessettings-f121-4" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="تهران، خیابان ..." className="h-10 rounded-lg" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f126-5">تلفن شرکت</label>
            <Input id="salessettings-f126-5" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="۰۲۱-..." className="h-10 rounded-lg" dir="ltr" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f130-6">کد اقتصادی</label>
            <Input id="salessettings-f130-6" value={economicCode} onChange={(e) => setEconomicCode(e.target.value)} placeholder="۴۱۱۲..." className="h-10 rounded-lg" dir="ltr" />
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-400 -mt-2">این اطلاعات در سربرگ چاپ پیش‌فاکتور و فاکتور درج می‌شود</p>

      <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-4">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2"><Percent size={14} className="text-teal-600" /> مالی و صورت‌حساب</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f141-7">نرخ مالیات بر ارزش افزوده (٪)</label>
            <Input id="salessettings-f141-7" value={vatRate} onChange={(e) => setVatRate(e.target.value)} type="number" min={0} max={100} className="h-10 rounded-lg" dir="ltr" />
            <p className="text-[11px] text-gray-400 mt-1">نرخ پیش‌فرض محاسبهٔ اسناد فروش</p>
          </div>
        </div>
      </div>

      <button
        onClick={save}
        disabled={busy}
        className="w-full h-10 rounded-lg text-white font-semibold text-sm"
        style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
      >
        {busy ? 'در حال ذخیره...' : 'ذخیرهٔ تنظیمات'}
      </button>

      {/* v2.35.0 — per-company SENDER profile: registered once here,
          auto-pulled into every proforma/invoice (round-56 request:
          «ثبت اطلاعات شرکت یک‌بار، استفاده و فراخوانی خودکار»). */}
      <SenderProfilesSection />
    </div>
  );
}

// ==================== SENDER PROFILES (per company, v2.35.0) ====================
interface SenderCompany {
  slug: string;
  name: string;
  nationalId?: string | null;
  address?: string | null;
  phone?: string | null;
  postalCode?: string | null;
  headOfficeAddress?: string | null;
  factoryAddress?: string | null;
  bankName?: string | null;
  bankAccountHolder?: string | null;
  bankAccountNumber?: string | null;
  bankSheba?: string | null;
  // v2.48.0 — brand block + printed terms (letterhead preview / logo
  // upload / «توضیحات / شرایط» box of every proforma print).
  tagline?: string | null;
  logo?: string | null;
  proformaNote?: string | null;
  // v2.52.0 — per-company A4 print template key (null → 'bgl' default).
  printTemplate?: string | null;
  // v2.54.0 — per-company footer website (globe icon; null → global).
  website?: string | null;
}

const SENDER_BLANK = {
  name: '',
  tagline: '',
  nationalId: '', phone: '', postalCode: '',
  headOfficeAddress: '', factoryAddress: '',
  bankName: '', bankAccountHolder: '', bankAccountNumber: '', bankSheba: '',
  proformaNote: '',
  // v2.52.0 — '' = پیش‌فرض BGL (بدون انتخاب ثبت‌شده)
  printTemplate: '',
  // v2.54.0 — '' = بدون سایت اختصاصی (فوتر از تنظیمات کلی)
  website: '',
};

function SenderProfilesSection() {
  const [companies, setCompanies] = useState<SenderCompany[]>([]);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [form, setForm] = useState({ ...SENDER_BLANK });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // v2.48.0 — logo pipeline: logoDraft = newly-picked data-URL (saved with
  // the form); logoCleared = the user removed the logo (saves null → the
  // letterhead falls back to the shipped holding logo).
  const [logoDraft, setLogoDraft] = useState<string | null>(null);
  const [logoCleared, setLogoCleared] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/companies');
        const data = await res.json();
        if (res.ok && Array.isArray(data)) {
          setCompanies(data);
          if (data.length > 0) setSelectedSlug(data[0].slug);
        } else if (res.ok) {
          setCompanies([]);
        } else {
          setError(data?.error || 'خطا در دریافت شرکت‌ها');
        }
      } catch {
        setError('خطا در دریافت شرکت‌ها');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load the selected company's profile into the form (once per selection).
  const selected = companies.find((c) => c.slug === selectedSlug) || null;
  // v2.48.0 — the effect also fires when the companies ARRAY changes (the
  // post-save refresh). Wiping the success/error banner on every array
  // update hid the «ذخیره شد» message instantly — the banner now clears
  // only on a REAL company switch, so save feedback stays visible.
  const prevSlugRef = React.useRef(selectedSlug);
  useEffect(() => {
    const row = companies.find((c) => c.slug === selectedSlug);
    if (!row) return;
    const slugChanged = prevSlugRef.current !== selectedSlug;
    prevSlugRef.current = selectedSlug;
    // Queued — no synchronous setState in the effect body
    // (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      setForm({
        name: row.name || '',
        tagline: row.tagline || '',
        nationalId: row.nationalId || '',
        phone: row.phone || '',
        postalCode: row.postalCode || '',
        headOfficeAddress: row.headOfficeAddress || '',
        factoryAddress: row.factoryAddress || '',
        bankName: row.bankName || '',
        bankAccountHolder: row.bankAccountHolder || '',
        bankAccountNumber: row.bankAccountNumber || '',
        bankSheba: row.bankSheba || '',
        proformaNote: row.proformaNote || '',
        printTemplate: row.printTemplate || '',
        website: row.website || '',
      });
      setLogoDraft(null);
      setLogoCleared(false);
      if (slugChanged) {
        setMessage(null);
        setError(null);
      }
    });
  }, [selectedSlug, companies]);

  const set = (key: keyof typeof SENDER_BLANK) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  // v2.48.0 — live شبا feedback using the SAME pure validator the API
  // enforces (mod-97 checksum + IR canonical form).
  const shebaCheck = form.bankSheba.trim() === '' ? null : normalizeSheba(form.bankSheba);

  // v2.48.0 — file picker → data-URL draft (client pre-check with the same
  // pure lib; the server re-encodes with sharp and enforces the size cap).
  const onLogoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after a reject
    if (!file) return;
    if (file.size > LOGO_MAX_INPUT_BYTES) {
      setError('حجم لوگو نباید از ۲ مگابایت بیشتر باشد.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const check = checkLogoDataUrl(url);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      setError(null);
      setLogoDraft(url);
      setLogoCleared(false);
    };
    reader.onerror = () => setError('خواندن فایل لوگو ناموفق بود.');
    reader.readAsDataURL(file);
  };

  // Letterhead preview source: draft → stored logo → shipped fallback.
  const previewLogoSrc =
    logoDraft || (logoCleared ? '/logo-bgl.png' : selected?.logo || '/logo-bgl.png');
  const hasStoredLogo = !logoCleared && !!selected?.logo;

  // v2.52.0 — resolved print template for the LIVE preview (same pure
  // registry the A4 sheet uses; '' → 'bgl').
  const activeTpl = resolvePrintTemplate(form.printTemplate);

  const saveProfile = async () => {
    if (!selected) return;
    // Client-side guards (the API re-validates everything server-side).
    if (form.name.trim() === '') {
      setError('نام شرکت نمی‌تواند خالی باشد.');
      return;
    }
    if (shebaCheck && !shebaCheck.ok) {
      setError(shebaCheck.error);
      return;
    }
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        action: 'update-profile',
        slug: selected.slug,
        ...form,
      };
      if (logoDraft) payload.logo = logoDraft;
      else if (logoCleared) payload.logo = null;
      const res = await fetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'خطا در ذخیره');
      setMessage(data?.message || 'اطلاعات فرستنده ذخیره شد');
      // refresh the local copy so the form + preview stay in sync
      setCompanies((cs) =>
        cs.map((c) => (c.slug === selected.slug ? { ...c, ...(data?.data || form) } : c)),
      );
      setLogoDraft(null);
      setLogoCleared(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center">
        <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-400">در حال دریافت پروفایل شرکت‌ها...</p>
      </div>
    );
  }

  const ltr = { dir: 'ltr' } as const;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-4 space-y-4">
      <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
        <Building2 size={14} className="text-teal-600" /> اطلاعات فرستندهٔ شرکت‌ها (سربرگ پیش‌فاکتور / فاکتور)
      </h3>
      <p className="text-[11px] text-gray-400 leading-5">
        مشخصات فرستندهٔ اسناد هر شرکت یک‌بار اینجا ثبت می‌شود و هنگام صدور هر پیش‌فاکتور یا فاکتور،
        به‌صورت خودکار از همین اطلاعات فراخوانی می‌شود — بدون نیاز به ورود مجدد. برند (نام، شعار
        و لوگو)، اطلاعات حساب و شرایط چاپی، LIVE خوانده می‌شوند: با تغییر برند از همین فرم، همهٔ
        چاپ‌های بعدی خودکار به‌روز می‌شوند. نشانی دفتر مرکزی و کارخانه هرکدام جای مستقل خود را
        در قالب چاپ دارند و در صورت تکمیل هر دو، هر دو درج می‌شوند.
      </p>

      {companies.length === 0 ? (
        <p className="text-xs text-gray-400 py-4 text-center">شرکتی برای نمایش وجود ندارد.</p>
      ) : (
        <>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-company">شرکت</label>
            <select
              id="salessettings-sender-company"
              value={selectedSlug}
              onChange={(e) => setSelectedSlug(e.target.value)}
              className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white"
            >
              {companies.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </select>
          </div>

          {message && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-700">{message}</div>}
          {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{error}</div>}

          {/* v2.48.0 — brand block: letterhead live preview + logo upload.
              Mirrors the A4 print header (logo + name + tagline). */}
          <div className="border border-gray-200 rounded-xl p-3 space-y-3 bg-gray-50/60">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-gray-600 flex items-center gap-1.5">
                <ImageIcon size={13} className="text-teal-600" /> برند و سربرگ (پیش‌نمایش زنده)
              </p>
              {(hasStoredLogo || logoDraft) && (
                <button
                  type="button"
                  onClick={() => { setLogoCleared(true); setLogoDraft(null); }}
                  className="text-[11px] text-red-500 hover:text-red-600 font-medium flex items-center gap-1"
                >
                  <XIcon size={12} /> حذف لوگو
                </button>
              )}
            </div>

            {/* letterhead preview — the exact print composition.
                v2.52.0 — the mini banner strip above it renders the ACTIVE
                template's colors (banner + wave) so the admin sees which
                graphic language this company's proformas print in.
                v2.54.0 — gradient templates (Arya) render the actual
                banner sweep; a vertical footer-gradient chip joins the
                divider chip on the right. */}
            <div className="bg-white border-2 border-gray-900 rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-2 h-7 px-3"
                style={{
                  // v2.55.0 — optional mid stop (yasteb three-stop sweep);
                  // the label ink adapts: light-logo-zone templates print
                  // their name in dark ink, so the mini banner does too.
                  background: activeTpl.bannerGradient
                    ? `linear-gradient(to left, ${activeTpl.bannerGradient.from}${activeTpl.bannerGradient.mid ? `, ${activeTpl.bannerGradient.mid}` : ''}, ${activeTpl.bannerGradient.to})`
                    : activeTpl.palette.banner,
                }}
              >
                <span className="h-2.5 w-10 rounded-sm" style={{ background: activeTpl.palette.wave }} />
                <span
                  className="text-[10px] font-bold"
                  style={{ color: activeTpl.bannerNameColor || 'rgba(255,255,255,.95)' }}
                >
                  قالب چاپ: {activeTpl.nameFa}
                </span>
                {activeTpl.divider ? (
                  <span
                    className="mr-auto h-1.5 w-16 rounded-full"
                    style={{ background: `linear-gradient(to right, ${activeTpl.divider.from}, ${activeTpl.divider.to})` }}
                  />
                ) : null}
                {activeTpl.footerGradient ? (
                  <span
                    className="mr-auto h-3 w-16 rounded-sm"
                    style={{
                      // v2.55.0 — horizontal footer gradients (yasteb)
                      // preview on their real axis.
                      background: activeTpl.footerGradient.horizontal
                        ? `linear-gradient(to left, ${activeTpl.footerGradient.from}${activeTpl.footerGradient.mid ? `, ${activeTpl.footerGradient.mid}` : ''}, ${activeTpl.footerGradient.to})`
                        : `linear-gradient(180deg, ${activeTpl.footerGradient.from}, ${activeTpl.footerGradient.to})`,
                    }}
                  />
                ) : null}
                {activeTpl.footerRibbon ? (
                  <span
                    className="mr-auto h-1.5 w-14 rounded-full"
                    style={{ background: `linear-gradient(to right, ${activeTpl.footerRibbon.from}, ${activeTpl.footerRibbon.to})` }}
                  />
                ) : null}
              </div>
              <div className="px-4 py-3 flex items-center gap-3">
                <img
                  src={previewLogoSrc}
                  alt="لوگوی سربرگ"
                  className="h-12 w-20 object-contain shrink-0 rounded-md"
                  // v2.53.0 — a '-white' logo is an all-white lockup that
                  // only reads against the banner color; the preview shows
                  // it on the ACTIVE template's banner (exactly how the A4
                  // print renders it) instead of an invisible white-on-white.
                  // Same '-white.' / '-white-' convention as letterheadIdentity.
                  style={previewLogoSrc.includes('-white.') || previewLogoSrc.includes('-white-')
                    ? { background: activeTpl.palette.banner, padding: '4px 8px' }
                    : undefined}
                />
                <div className="min-w-0 flex-1 text-right">
                  <p className="text-base font-black text-gray-900 truncate">{form.name || 'نام شرکت'}</p>
                  {form.tagline.trim() !== '' && (
                    <p className="text-[11px] text-gray-600 truncate mt-0.5">{form.tagline}</p>
                  )}
                  <p className="text-[10px] text-gray-400 mt-1">همان چیزی که در سربرگ چاپ پیش‌فاکتور/فاکتور درج می‌شود</p>
                </div>
              </div>
            </div>

            {/* v2.52.0 — per-company print template selector (تفکیک قالب
                چاپ): radio-style cards from the pure registry. '' = پیش‌فرض. */}
            <div>
              <p className="text-xs font-bold text-gray-600 mb-2 flex items-center gap-1.5">
                <PaletteIcon size={13} className="text-teal-600" /> قالب چاپ پیش‌فاکتور / فاکتور
              </p>
              <div className="grid grid-cols-2 gap-2.5">
                {PRINT_TEMPLATE_KEYS.map((key) => {
                  const t = PRINT_TEMPLATES[key];
                  const isActive = (form.printTemplate || 'bgl') === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, printTemplate: key === 'bgl' ? '' : key }))}
                      className={`text-right rounded-xl border p-2.5 transition-all ${
                        isActive
                          ? 'border-teal-600 ring-2 ring-teal-600/20 bg-teal-50/50'
                          : 'border-gray-200 hover:border-gray-300 bg-white'
                      }`}
                      aria-pressed={isActive}
                    >
                      <span className="flex items-center gap-1.5 mb-1.5">
                        <span
                          className="h-4 w-8 rounded"
                          style={{
                            // v2.54.0 — gradient templates show their actual
                            // banner sweep (to left: 'from' sits at the right,
                            // the logo side — like the A4 sheet).
                            // v2.55.0 — the optional mid stop joins the sweep.
                            background: t.bannerGradient
                              ? `linear-gradient(to left, ${t.bannerGradient.from}${t.bannerGradient.mid ? `, ${t.bannerGradient.mid}` : ''}, ${t.bannerGradient.to})`
                              : t.palette.banner,
                          }}
                        />
                        <span className="h-4 w-4 rounded" style={{ background: t.palette.wave }} />
                        <span className="h-4 w-2 rounded-sm" style={{ background: t.palette.ink }} />
                        {t.zebra ? (
                          <span className="h-4 w-2 rounded-sm" style={{ background: t.zebra }} />
                        ) : null}
                        {t.footerGradient ? (
                          <span
                            className="h-3 w-2 rounded-sm"
                            style={{
                              // v2.55.0 — horizontal footer gradients preview
                              // on their real axis (yasteb).
                              background: t.footerGradient.horizontal
                                ? `linear-gradient(to left, ${t.footerGradient.from}${t.footerGradient.mid ? `, ${t.footerGradient.mid}` : ''}, ${t.footerGradient.to})`
                                : `linear-gradient(180deg, ${t.footerGradient.from}, ${t.footerGradient.to})`,
                            }}
                          />
                        ) : null}
                        {t.divider ? (
                          <span
                            className="h-2 w-7 rounded-full"
                            style={{ background: `linear-gradient(to right, ${t.divider.from}, ${t.divider.to})` }}
                          />
                        ) : null}
                        {t.footerRibbon ? (
                          <span
                            className="h-2 w-6 rounded-full"
                            style={{ background: `linear-gradient(to right, ${t.footerRibbon.from}, ${t.footerRibbon.to})` }}
                          />
                        ) : null}
                      </span>
                      <span className="block text-xs font-bold text-gray-800">{t.nameFa}</span>
                      <span className="block text-[10px] leading-4 text-gray-500 mt-0.5">{t.descriptionFa}</span>
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">انتخاب قالب فقط زبان بصری برگ A4 را تغییر می‌دهد؛ داده‌ها و چیدمان اجزا یکسان می‌ماند و همهٔ چاپ‌های بعدی خودکار همین قالب را می‌گیرند.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-name">نام شرکت</label>
                <Input id="salessettings-sender-name" value={form.name} onChange={set('name')} placeholder="شرکت ..." className="h-10 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-tagline">شعار / زیرنویس سربرگ</label>
                <Input id="salessettings-sender-tagline" value={form.tagline} onChange={set('tagline')} placeholder="تولیدکنندهٔ ..." className="h-10 rounded-lg" />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-logo">لوگوی شرکت</label>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="salessettings-sender-logo"
                  className="cursor-pointer inline-flex items-center gap-1.5 h-10 px-4 rounded-lg border border-teal-600 text-teal-700 text-xs font-semibold hover:bg-teal-50 transition-colors"
                >
                  <Upload size={13} /> انتخاب فایل لوگو
                </label>
                <input
                  id="salessettings-sender-logo"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={onLogoFile}
                  className="hidden"
                />
                <p className="text-[11px] text-gray-400 flex-1">
                  PNG / JPEG / WebP تا ۲ مگابایت — خودکار فشرده و ذخیره می‌شود؛
                  با پشتیبان‌گیری دیتابیس منتقل می‌شود.
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-nid">شناسه ملی</label>
              <Input id="salessettings-sender-nid" value={form.nationalId} onChange={set('nationalId')} placeholder="۱۴۰..." className="h-10 rounded-lg" {...ltr} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-phone">تلفن</label>
              <Input id="salessettings-sender-phone" value={form.phone} onChange={set('phone')} placeholder="۰۶۱-..." className="h-10 rounded-lg" {...ltr} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-postal">کد پستی</label>
              <Input id="salessettings-sender-postal" value={form.postalCode} onChange={set('postalCode')} placeholder="۱۳۹..." className="h-10 rounded-lg" {...ltr} />
            </div>
            <div>
              {/* v2.54.0 — per-company footer website (globe icon); خالی → سایت کلی گروه */}
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-website">وب‌سایت (فوتر چاپ)</label>
              <Input id="salessettings-sender-website" value={form.website} onChange={set('website')} placeholder="www.example.ir" className="h-10 rounded-lg" {...ltr} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-hq">نشانی دفتر مرکزی</label>
            <Input id="salessettings-sender-hq" value={form.headOfficeAddress} onChange={set('headOfficeAddress')} placeholder="تهران، ..." className="h-10 rounded-lg" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-factory">نشانی کارخانه</label>
            <Input id="salessettings-sender-factory" value={form.factoryAddress} onChange={set('factoryAddress')} placeholder="شهرک صنعتی..." className="h-10 rounded-lg" />
          </div>

          <div className="border-t border-dashed border-gray-200 pt-3">
            <p className="text-xs font-bold text-gray-500 mb-2.5">اطلاعات حساب بانکی (جعبهٔ «اطلاعات حساب» در چاپ)</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-bank">نام بانک</label>
                <Input id="salessettings-sender-bank" value={form.bankName} onChange={set('bankName')} placeholder="بانک ملت" className="h-10 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-holder">نام دارندهٔ حساب</label>
                <Input id="salessettings-sender-holder" value={form.bankAccountHolder} onChange={set('bankAccountHolder')} placeholder="نام شرکت" className="h-10 rounded-lg" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-acc">شماره حساب</label>
                <Input id="salessettings-sender-acc" value={form.bankAccountNumber} onChange={set('bankAccountNumber')} placeholder="۱۲۳۴..." className="h-10 rounded-lg" {...ltr} />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-sheba">شماره شبا</label>
                <Input id="salessettings-sender-sheba" value={form.bankSheba} onChange={set('bankSheba')} placeholder="IR..." className="h-10 rounded-lg" {...ltr} />
                {/* v2.48.0 — live mod-97 checksum feedback (same validator as the API) */}
                {shebaCheck && (
                  <p className={'text-[11px] mt-1.5 ' + (shebaCheck.ok ? 'text-emerald-600' : 'text-red-500')}>
                    {shebaCheck.ok ? '✓ معتبر — با فرمت استاندارد ذخیره می‌شود' : shebaCheck.error}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* v2.48.0 — company-level printed terms: replaces the built-in
              default bullets in the «توضیحات / شرایط» box of every print. */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-sender-note">شرایط / یادداشت چاپی پیش‌فاکتور</label>
            <textarea
              id="salessettings-sender-note"
              value={form.proformaNote}
              onChange={set('proformaNote')}
              rows={4}
              placeholder={'هر سطر = یک بند در جعبهٔ «توضیحات / شرایط» چاپ (حداکثر ۸ سطر)\nمثال:\nاعتبار این پیش‌فاکتور ۳۰ روز از تاریخ صدور است.\nارسال کالا پس از تأیید نهایی و تسویه انجام می‌شود.'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm bg-white resize-y leading-6"
            />
            <p className="text-[11px] text-gray-400 mt-1.5">
              خالی بگذارید تا شرایط پیش‌فرض قالب چاپ درج شود.
            </p>
          </div>

          <button
            onClick={saveProfile}
            disabled={busy || !selected}
            className="w-full h-10 rounded-lg text-white font-semibold text-sm"
            style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
          >
            {busy ? 'در حال ذخیره...' : `ذخیرهٔ اطلاعات فرستندهٔ ${selected?.name || ''}`}
          </button>
        </>
      )}
    </div>
  );
}

// ==================== TOGGLE ROW (shared by the security tab) ====================
function PolicyToggle({ value, onChange, label, desc }: { value: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0 ml-4">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        <p className="text-[11px] text-gray-400 mt-0.5">{desc}</p>
      </div>
      <button onClick={() => onChange(!value)} aria-label={label} className={'w-11 h-6 rounded-full transition-colors relative ' + (value ? 'bg-teal-500' : 'bg-gray-300')}>
        <div className={'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ' + (value ? 'right-0.5' : 'right-[22px]')} />
      </button>
    </div>
  );
}

// ==================== SECURITY SETTINGS (live: reads/writes /api/settings) ====================
// v2.18.0 — the security tab used to be local-only state with a dead save
// button. The password policy and session length now persist to Meta and
// are ENFORCED by /api/users (password create/update) and lib/auth (session
// idle expiry) via lib/security-policy.
function SecuritySettingsTab() {
  const [minLength, setMinLength] = useState('8');
  const [requireUpper, setRequireUpper] = useState(false);
  const [requireNumber, setRequireNumber] = useState(true);
  const [requireSpecial, setRequireSpecial] = useState(false);
  const [sessionMinutes, setSessionMinutes] = useState('720');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'get', keys: [
            'security.password_min_length', 'security.require_upper',
            'security.require_number', 'security.require_special',
            'security.session_minutes',
          ] }),
        });
        const data = await res.json();
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (res.ok && data.settings) {
          const s = data.settings as Record<string, string>;
          setMinLength(s['security.password_min_length'] || '8');
          setRequireUpper(s['security.require_upper'] === 'true');
          setRequireNumber(s['security.require_number'] !== 'false');
          setRequireSpecial(s['security.require_special'] === 'true');
          setSessionMinutes(s['security.session_minutes'] || '720');
        }
      } catch {
        setError('خطا در دریافت تنظیمات امنیتی');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'set',
          settings: {
            'security.password_min_length': String(Number(minLength) || 8),
            'security.require_upper': String(requireUpper),
            'security.require_number': String(requireNumber),
            'security.require_special': String(requireSpecial),
            'security.session_minutes': String(Number(sessionMinutes) || 720),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
      setMessage('سیاست امنیتی ذخیره شد و از این لحظه اعمال می‌شود');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
        <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-400">در حال دریافت تنظیمات...</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
        <Shield size={28} className="mx-auto mb-2 opacity-40" />
        <p className="text-sm">تنظیمات امنیتی فقط برای مدیر سیستم قابل مشاهده است.</p>
      </div>
    );
  }

  const Toggle = PolicyToggle;

  return (
    <div className="space-y-4">
      {message && <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-xs text-emerald-700">{message}</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{error}</div>}

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2"><Lock size={14} className="text-teal-600" /> سیاست رمز عبور</h3>
        <p className="text-[11px] text-gray-400 mb-3">در ایجاد کاربر و تغییر رمز عبور (به‌صورت الزامی) اعمال می‌شود.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f284-8">حداقل طول رمز (کاراکتر)</label>
            <Input id="salessettings-f284-8" value={minLength} onChange={(e) => setMinLength(e.target.value)} type="number" min={4} max={128} className="h-10 rounded-lg" dir="ltr" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f288-9">مدت جلسه (دقیقه)</label>
            <Input id="salessettings-f288-9" value={sessionMinutes} onChange={(e) => setSessionMinutes(e.target.value)} type="number" min={15} max={10080} className="h-10 rounded-lg" dir="ltr" />
            <p className="text-[11px] text-gray-400 mt-1">نشست پس از این مدت بی‌فعالیتی منقضی می‌شود.</p>
          </div>
        </div>
        <Toggle value={requireUpper} onChange={setRequireUpper} label="الزام حرف بزرگ انگلیسی" desc="رمز باید حداقل یک حرف A-Z داشته باشد" />
        <Toggle value={requireNumber} onChange={setRequireNumber} label="الزام عدد" desc="رمز باید حداقل یک عدد داشته باشد" />
        <Toggle value={requireSpecial} onChange={setRequireSpecial} label="الزام کاراکتر خاص" desc="رمز باید حداقل یک کاراکتر خاص (!@#...) داشته باشد" />
      </div>

      <button onClick={save} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold text-sm" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
        {busy ? 'در حال ذخیره...' : 'ذخیرهٔ سیاست امنیتی'}
      </button>
    </div>
  );
}

// ==================== BACKUP SECTION (live: /api/backup) ====================
// v2.18.0 — this tab used to list three invented backups with dead
// «پشتیبان‌گیری الان / بازیابی / دانلود» buttons. It now performs a REAL
// JSON snapshot export (admin only) and shows the honest export history.
function BackupSection() {
  const [busy, setBusy] = useState<null | 'package' | 'export'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [history, setHistory] = useState<Array<{
    id: string; jalaliDate: string; sizeBytes: number; rowCount: number;
    createdBy: string; truncated: boolean;
  }>>([]);
  // v2.58.1 (audit F7) — full packages (DB + files) shown alongside exports
  const [packages, setPackages] = useState<Array<{
    jalaliDate: string; createdAt: string; appVersion: string;
    database: { bytes: number; quickCheck: string };
    files: { count: number; totalBytes: number; missingContent: string[]; orphanDiskFiles: number };
  }>>([]);

  const loadHistory = async () => {
    try {
      const [histRes, pkgRes] = await Promise.all([
        fetch('/api/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'history' }),
        }),
        fetch('/api/backup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'packages' }),
        }),
      ]);
      if (histRes.status === 403 || pkgRes.status === 403) {
        setForbidden(true);
        return;
      }
      const histData = await histRes.json();
      const pkgData = await pkgRes.json();
      if (histRes.ok) setHistory(histData.history || []);
      if (pkgRes.ok) setPackages(pkgData.packages || []);
    } catch {
      setError('خطا در دریافت تاریخچهٔ پشتیبان');
    }
  };

  useEffect(() => {
    (async () => { await loadHistory(); })();
  }, []);

  // v2.58.1 (audit F7) — «پشتیبان‌گیری الان» now builds a REAL full backup
  // package (database + stored files incl. voice notes, verified manifest)
  // via /api/backup action=package. The old button called action=export —
  // a truncated JSON dump (2000 rows/table) that could never be restored
  // and contained NO file bytes: an incomplete backup marketed as a
  // complete one.
  const backupNow = async () => {
    setBusy('package');
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'package' }),
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تهیهٔ پشتیبان');
      setNotice(data.message || 'بستهٔ پشتیبان کامل ساخته شد.');
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در تهیهٔ پشتیبان');
    } finally {
      setBusy(null);
    }
  };

  // The JSON export stays available — labeled honestly as a LIMITED data
  // export (2000 rows/table, no file bytes, not restorable), never as a
  // backup.
  const exportData = async () => {
    setBusy('export');
    setError(null);
    try {
      const res = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export' }),
      });
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'خطا در تهیهٔ خروجی داده');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bgl-crm-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در تهیهٔ خروجی داده');
    } finally {
      setBusy(null);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes >= 1_048_576) return (bytes / 1_048_576).toFixed(1) + ' مگابایت';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' کیلوبایت';
    return bytes + ' بایت';
  };

  if (forbidden) {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-8 text-center text-gray-400">
        <HardDrive size={28} className="mx-auto mb-2 opacity-40" />
        <p className="text-sm">تهیهٔ پشتیبان فقط برای مدیر سیستم ممکن است.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-xs text-red-600">{error}</div>}

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2"><Database size={14} className="text-teal-600" /> تهیهٔ پشتیبان کامل</h3>
        <p className="text-[11px] text-gray-400 mb-4">
          بستهٔ پشتیبان کامل شامل دیتابیس (تصویر سازگار VACUUM) و تمام فایل‌های پیوست ذخیره‌شده (از جمله ویس‌ها) در پوشهٔ backups ساخته می‌شود؛
          صحت آن با quick_check و sha256 در manifest ثبت و تأیید می‌شود.
          بازیابی کامل با فرمان <span dir="ltr" className="font-mono">node scripts/restore-backup.mjs --latest</span> انجام می‌شود.
        </p>
        {notice && <div className="mb-3 bg-emerald-50 border border-emerald-100 rounded-lg p-2.5 text-[11px] text-emerald-700">{notice}</div>}
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={backupNow} disabled={busy !== null} className="h-10 gap-2 text-white text-xs rounded-lg px-5" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            <Download size={14} /> {busy === 'package' ? 'در حال تهیهٔ بستهٔ پشتیبان...' : 'پشتیبان‌گیری کامل الان'}
          </Button>
          <Button onClick={exportData} disabled={busy !== null} variant="outline" className="h-10 gap-2 text-xs rounded-lg px-4">
            <Download size={14} /> {busy === 'export' ? 'در حال تهیهٔ خروجی...' : 'خروجی داده (JSON)'}
          </Button>
        </div>
        <p className="text-[10px] text-gray-300 mt-3 leading-5">
          «خروجی داده» فقط یک فایل JSON محدود است (حداکثر ۲۰۰۰ ردیف از هر جدول، بدون بایت فایل‌ها و بدون امکان بازیابی خودکار) —
          برای انتقال داده به ابزارهای دیگر، نه پشتیبان. پشتیبانِ واقعی همان بستهٔ کامل است.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <h3 className="text-sm font-bold text-gray-900 mb-4">تاریخچهٔ پشتیبان‌ها</h3>
        <div className="space-y-2">
          {packages.length === 0 && history.length === 0 ? (
            <div className="p-4 bg-gray-50 rounded-xl text-center text-xs text-gray-400">
              هنوز پشتیبانی تهیه نشده است
            </div>
          ) : (
            <>
              {packages.map((p) => (
                <div key={p.createdAt} className="flex items-center justify-between p-3 bg-emerald-50/40 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center text-emerald-500"><Database size={16} /></div>
                    <div>
                      <p className="text-xs font-medium text-gray-900">{p.jalaliDate || p.createdAt.slice(0, 10)} — بستهٔ کامل</p>
                      <p className="text-[11px] text-gray-400">
                        دیتابیس {formatSize(p.database.bytes)} · {toPersianDigits(p.files.count)} فایل پیوست ({formatSize(p.files.totalBytes)})
                        {p.files.missingContent.length > 0 ? ` · ${toPersianDigits(p.files.missingContent.length)} پیوست بدون محتوا (گزارش شد)` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-400">{p.appVersion}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">{p.database.quickCheck === 'ok' ? 'تأییدشده' : 'نامشخص'}</span>
                  </div>
                </div>
              ))}
              {history.map((b) => (
                <div key={b.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-white flex items-center justify-center text-gray-400"><Database size={16} /></div>
                    <div>
                      <p className="text-xs font-medium text-gray-900">{b.jalaliDate}</p>
                      <p className="text-[11px] text-gray-400">خروجی داده · {toPersianDigits(b.rowCount)} ردیف · {formatSize(b.sizeBytes)}{b.truncated ? ' (بخشی)' : ' (کامل)'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-gray-400">{b.createdBy}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">موفق</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function toPersianDigits(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

// ==================== INTEGRATIONS SECTION (live: real connection states) ====================
// v2.18.0 — used to show four invented connection cards. Only REAL
// integrations exist here: حسابفا and the AI bridge, both with
// their actual stored connection state and an admin credentials form
// (validated by their dedicated routes).
function IntegrationsSection() {
  return (
    <div className="space-y-4">
      <HesabfaCard />
      <AiBridgeCard />
      <SmsSettingsCard />
    </div>
  );
}

// v2.33.0 — per-company Hesabfa connections (independent warehouses).
// Legacy single-token card replaced by the tabbed connection manager.
function HesabfaCard() {
  return <HesabfaConnectionsCard />;
}
function AiBridgeCard() {
  const [apiUrl, setApiUrl] = useState('');
  // v2.28.1: the key input always starts EMPTY. Pre-filling it with the
  // masked value from GET used to silently corrupt the stored key: any
  // save that did not retype the key wrote the masked string ("sk-1****ab")
  // into the DB. `keySet` tracks whether a key is stored at all; an empty
  // input on save now means "keep the stored key".
  const [apiKey, setApiKey] = useState('');
  const [keySet, setKeySet] = useState(false);
  // v2.34.7 — Whisper-compatible STT endpoint for voice notes (ویس → متن)
  const [sttUrl, setSttUrl] = useState('');
  const [sttModel, setSttModel] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<'loading' | 'connected' | 'empty' | 'forbidden'>('loading');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs?: number; model?: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await fetch('/api/ai-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', mode: 'get' }),
      });
      if (res.status === 403) {
        setStatus('forbidden');
        return;
      }
      const data = await res.json();
      if (res.ok && data.settings) {
        const s = data.settings as Record<string, string>;
        setApiUrl(s.api_url || '');
        setModel(s.model || '');
        setSttUrl(s.stt_url || '');
        setSttModel(s.stt_model || 'whisper-1');
        setKeySet(!!s.api_key);
        setApiKey('');
        // v2.28.1: the API key is OPTIONAL server-side (local Ollama/vLLM
        // endpoints work without one), so "configured" must depend on the
        // URL alone. A keyless local endpoint is a fully working setup.
        setStatus(s.api_url ? 'connected' : 'empty');
      } else {
        setStatus('empty');
      }
    } catch {
      setError('خطا در دریافت تنظیمات پل هوش مصنوعی');
      setStatus('empty');
    }
  };

  useEffect(() => {
    (async () => { await load(); })();
  }, []);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    setTestResult(null);
    try {
      // Empty key field = keep the stored key (it is never echoed back to
      // the form). Only send api_key when the admin actually typed one.
      const payload: Record<string, string> = { action: 'settings', mode: 'set', api_url: apiUrl, model, stt_url: sttUrl, stt_model: sttModel };
      if (apiKey.trim()) payload.api_key = apiKey.trim();
      const res = await fetch('/api/ai-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
      setMessage(apiKey.trim() ? 'تنظیمات پل هوش مصنوعی ذخیره شد' : 'ذخیره شد (کلید قبلی حفظ شد)');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/ai-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'settings', mode: 'set', api_key: '' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در حذف کلید');
      setMessage('کلید ذخیره‌شده حذف شد');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در حذف کلید');
    } finally {
      setBusy(false);
    }
  };

  // v2.28.1: one-click connectivity probe. Sanctioned endpoints (Claude/
  // OpenAI/Gemini) are unreachable from Iranian servers — the admin needs
  // an honest answer BEFORE a real chat or call analysis fails.
  const test = async () => {
    setTesting(true);
    setMessage(null);
    setError(null);
    setTestResult(null);
    try {
      const res = await fetch('/api/ai-bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'test', api_url: apiUrl || undefined, model: model || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تست اتصال');
      setTestResult(data as { ok: boolean; message: string; latencyMs?: number; model?: string });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در تست اتصال');
    } finally {
      setTesting(false);
    }
  };

  const connected = status === 'connected';

  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center" style={{ background: '#7c3aed15', color: '#7c3aed' }}><Globe size={18} /></div>
          <div>
            <h4 className="text-sm font-bold text-gray-900">پل هوش مصنوعی</h4>
            <p className="text-[11px] text-gray-400">اتصال دستیار هوشمند به سرویس مدل زبانی</p>
          </div>
        </div>
        {status === 'loading' ? (
          <div className="w-6 h-6 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
        ) : status === 'forbidden' ? (
          <span className="text-[11px] text-gray-400">فقط مدیر</span>
        ) : (
          <span className={'text-[11px] font-medium px-2 py-1 rounded-full ' + (connected ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-500')}>
            {connected ? 'پیکربندی شده' : 'پیکربندی نشده'}
          </span>
        )}
      </div>
      {status !== 'forbidden' && status !== 'loading' && (
        <div className="space-y-3">
          {message && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-[11px] text-emerald-700">{message}</div>}
          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[11px] text-red-600">{error}</div>}
          {testResult && (
            <div className={'rounded-lg p-2 text-[11px] border ' + (testResult.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-red-50 border-red-200 text-red-600')} dir="rtl">
              {testResult.ok
                ? `اتصال برقرار است — مدل: ${testResult.model || 'نامشخص'}، زمان پاسخ: ${testResult.latencyMs ?? '؟'} میلی‌ثانیه`
                : testResult.message}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f648-13">آدرس سرویس</label>
              <Input id="salessettings-f648-13" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder="http://localhost:11434/v1/chat/completions" className="h-10 rounded-lg" dir="ltr" />
              <p className="text-[10px] text-gray-400 mt-1">مسیر کامل Chat Completions لازم است؛ مثال Ollama: http://localhost:11434/v1/chat/completions</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f652-14">کلید API</label>
              <Input id="salessettings-f652-14" value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder={keySet ? 'کلید ذخیره شده — برای تغییر، کلید جدید را وارد کنید' : 'سرویس محلی (Ollama/vLLM) کلید نمی‌خواهد'} className="h-10 rounded-lg" dir="ltr" />
              <p className="text-[10px] text-gray-400 mt-1">
                {keySet
                  ? 'خالی گذاشتن = حفظ کلید ذخیره‌شده'
                  : 'برای استقرار خودمیزبان (Ollama/vLLM) این فیلد را خالی بگذارید'}
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f657-15">مدل (اختیاری)</label>
            <Input id="salessettings-f657-15" value={model} onChange={(e) => setModel(e.target.value)} placeholder="qwen2.5:14b" className="h-10 rounded-lg" dir="ltr" />
            <p className="text-[10px] text-gray-400 mt-1">نام مدل باید با نام مدل روی سرویس شما یکسان باشد (مثلاً نام دانلودشده در Ollama)</p>
          </div>
          <div className="border-t border-gray-100 pt-3 mt-1">
            <p className="text-xs font-bold text-gray-700 mb-2">تبدیل صدا به متن — ویس (اختیاری)</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f661-16">آدرس سرویس Whisper</label>
                <Input id="salessettings-f661-16" value={sttUrl} onChange={(e) => setSttUrl(e.target.value)} placeholder="https://provider.example.com/v1/audio/transcriptions" className="h-10 rounded-lg" dir="ltr" />
                <p className="text-[10px] text-gray-400 mt-1">برای تبدیل ویس‌های ثبت سریع فعالیت به متن — مسیر کامل audio/transcriptions؛ با همان کلید API بالا احراز می‌شود</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salessettings-f662-17">مدل STT</label>
                <Input id="salessettings-f662-17" value={sttModel} onChange={(e) => setSttModel(e.target.value)} placeholder="whisper-1" className="h-10 rounded-lg" dir="ltr" />
                <p className="text-[10px] text-gray-400 mt-1">پیش‌فرض whisper-1 — برای فارسی مدل‌های بزرگ‌تر (مثل large-v3) دقیق‌ترند</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button onClick={save} disabled={busy || testing} className="h-9 gap-1.5 text-white text-xs rounded-lg px-4" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
              <Key size={13} /> {busy ? 'در حال ذخیره...' : 'ذخیرهٔ تنظیمات'}
            </Button>
            <Button onClick={test} disabled={busy || testing} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg px-4 border-teal-600 text-teal-700 hover:bg-teal-50">
              <Wifi size={13} /> {testing ? 'در حال تست...' : 'تست اتصال'}
            </Button>
            {keySet && !apiKey && (
              <button type="button" onClick={clearKey} disabled={busy || testing} className="text-[11px] text-red-500 hover:text-red-600 underline underline-offset-2 disabled:opacity-50">
                حذف کلید ذخیره‌شده
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ==================== SMS SETTINGS (v2.43.0) ====================
// Admin card for the real SMS gateway. Secrets (API key / password)
// NEVER echo back: the form shows «ذخیره شده» state and an empty
// input means KEEP the stored value. Enabling validates fail-closed
// server-side; the test button performs a REAL send to a given phone.
interface SmsSettingsView {
  enabled: boolean;
  provider: 'kavenegar' | 'melipayamak' | 'sms_ir';
  providerLabel: string;
  sender: string;
  dailyLimit: number;
  signature: string;
  apiKeyConfigured: boolean;
  usernameConfigured: boolean;
  passwordConfigured: boolean;
}

function SmsSettingsCard() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'forbidden' | 'error'>('loading');
  const [view, setView] = useState<SmsSettingsView | null>(null);
  const [sentToday, setSentToday] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<SmsSettingsView['provider']>('kavenegar');
  const [sender, setSender] = useState('');
  const [dailyLimit, setDailyLimit] = useState('200');
  const [signature, setSignature] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testPhone, setTestPhone] = useState('');

  const load = async () => {
    try {
      const res = await fetch('/api/sms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-settings' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) { setStatus('forbidden'); return; }
      if (!res.ok) throw new Error(data.error || 'خطا');
      setView(data.settings);
      setSentToday(data.stats?.sentToday ?? 0);
      setEnabled(data.settings.enabled);
      setProvider(data.settings.provider);
      setSender(data.settings.sender);
      setDailyLimit(String(data.settings.dailyLimit));
      setSignature(data.settings.signature || '');
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    queueMicrotask(() => { void load(); });
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const payload: Record<string, unknown> = {
        action: 'set-settings',
        enabled, provider, sender,
        dailyLimit: Number(dailyLimit) || 200,
        signature,
      };
      // empty secret = keep stored value (server-side merge)
      if (apiKey.trim()) payload.apiKey = apiKey.trim();
      if (provider === 'melipayamak') {
        if (username.trim()) payload.username = username.trim();
        if (password.trim()) payload.password = password.trim();
      }
      const res = await fetch('/api/sms', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg({ ok: false, text: data.error || 'ذخیره ناموفق بود' }); return; }
      setMsg({ ok: true, text: 'تنظیمات پیامک ذخیره شد' });
      setApiKey(''); setUsername(''); setPassword('');
      await load();
    } catch (e: unknown) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'خطای شبکه' });
    } finally {
      setBusy(false);
    }
  };

  if (status === 'loading') {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-5">
        <div className="h-5 w-40 bg-gray-100 rounded animate-pulse mb-3" />
        <div className="h-9 bg-gray-50 rounded animate-pulse" />
      </div>
    );
  }

  if (status === 'forbidden') {
    return (
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex items-center gap-2">
        <MessageCircle size={16} className="text-gray-400" />
        <p className="text-xs text-gray-400">تنظیمات پیامک فقط برای مدیر سیستم قابل مشاهده است.</p>
      </div>
    );
  }

  const providerNeedsUserPass = provider === 'melipayamak';
  const secretReady = providerNeedsUserPass
    ? (view?.usernameConfigured || username.trim() !== '') && (view?.passwordConfigured || password.trim() !== '')
    : (view?.apiKeyConfigured || apiKey.trim() !== '');

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
      <div className="p-5 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageCircle size={16} className="text-indigo-600" />
          <div>
            <h3 className="text-sm font-bold text-gray-900">پیامک</h3>
            <p className="text-[11px] text-gray-400 mt-0.5">ارسال واقعی یادآوری وصول و پیگیری از سرویس پیامک ایرانی</p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-indigo-600 w-4 h-4" />
          <span className="text-xs text-gray-600 font-medium">فعال</span>
        </label>
      </div>
      <div className="p-5 space-y-4">
        {msg && (
          <p className={`text-xs rounded-lg p-2.5 ${msg.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>{msg.text}</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="smssettings-provider" className="block text-xs font-medium text-gray-600 mb-1.5">سرویس پیامک</label>
            <select
              id="smssettings-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as SmsSettingsView['provider'])}
              className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white"
              dir="rtl"
            >
              <option value="kavenegar">کاوه‌نگار (Kavenegar)</option>
              <option value="melipayamak">ملی‌پیامک (Melipayamak)</option>
              <option value="sms_ir">پیامک‌رسان (SMS.ir)</option>
            </select>
          </div>
          <div>
            <label htmlFor="smssettings-sender" className="block text-xs font-medium text-gray-600 mb-1.5">شمارهٔ فرستنده (خط ارسال)</label>
            <Input id="smssettings-sender" value={sender} onChange={(e) => setSender(e.target.value)} placeholder="مثلاً 10004346" dir="ltr" className="h-10 rounded-lg text-left" />
          </div>
        </div>
        {!providerNeedsUserPass ? (
          <div>
            <label htmlFor="smssettings-apikey" className="block text-xs font-medium text-gray-600 mb-1.5">
              کلید API {view?.apiKeyConfigured && <span className="text-emerald-600 font-normal">(ذخیره شده — خالی بگذارید تا حفظ شود)</span>}
            </label>
            <Input id="smssettings-apikey" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={view?.apiKeyConfigured ? '••••••••' : 'کلید API سرویس'} dir="ltr" className="h-10 rounded-lg text-left" />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="smssettings-username" className="block text-xs font-medium text-gray-600 mb-1.5">
                نام کاربری {view?.usernameConfigured && <span className="text-emerald-600 font-normal">(ذخیره شده)</span>}
              </label>
              <Input id="smssettings-username" value={username} onChange={(e) => setUsername(e.target.value)} dir="ltr" className="h-10 rounded-lg text-left" />
            </div>
            <div>
              <label htmlFor="smssettings-password" className="block text-xs font-medium text-gray-600 mb-1.5">
                رمز عبور {view?.passwordConfigured && <span className="text-emerald-600 font-normal">(ذخیره شده)</span>}
              </label>
              <Input id="smssettings-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" className="h-10 rounded-lg text-left" />
            </div>
          </div>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="smssettings-dailylimit" className="block text-xs font-medium text-gray-600 mb-1.5">سقف ارسال روزانه</label>
            <Input id="smssettings-dailylimit" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value.replace(/[^0-9]/g, ''))} dir="ltr" className="h-10 rounded-lg text-left" />
          </div>
          <div>
            <label htmlFor="smssettings-signature" className="block text-xs font-medium text-gray-600 mb-1.5">امضای پایین پیامک (اختیاری)</label>
            <Input id="smssettings-signature" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="مثلاً: بهبود گستر لیام ایرانیان" className="h-10 rounded-lg" />
          </div>
        </div>
        {enabled && !secretReady && (
          <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg p-2">
            برای فعال‌سازی، اطلاعات ورود سرویس پیامک الزامی است.
          </p>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={busy} className="h-9 px-4 rounded-lg text-white text-xs font-bold" style={{ background: '#6366f1' }}>
              {busy ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}
            </Button>
            <div className="flex items-center gap-1.5">
              <Input
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="شمارهٔ آزمایش 09..."
                dir="ltr"
                className="h-9 w-36 rounded-lg text-left text-xs"
                aria-label="شمارهٔ آزمایش"
              />
              <Button
                variant="outline"
                disabled={busy || !enabled || !testPhone.trim()}
                onClick={() => setTestOpen(true)}
                className="h-9 px-3 rounded-lg text-xs gap-1.5"
              >
                <Wifi size={12} /> آزمایش
              </Button>
            </div>
          </div>
          <span className="text-[10px] text-gray-400">ارسال امروز: {toPersianDigits(sentToday)} پیامک</span>
        </div>
        {status === 'error' && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">خطا در دریافت تنظیمات پیامک</p>}
      </div>
      <SmsDialog
        open={testOpen}
        onOpenChange={setTestOpen}
        presetPhone={testPhone}
        presetText={view ? `پیامک آزمایشی از سامانهٔ CRM — تنظیمات ارسال ${view.providerLabel} با موفقیت کار می‌کند.` : undefined}
        contextType="test"
        onSent={() => { void load(); }}
      />
    </div>
  );
}

export default function SalesSettings({ activeTab: propTab }: { activeTab?: string }) {
  // v2.26.0 — settings tabs are access-gated by the same menu-key
  // resolution the sidebar uses.
  const { isTabAllowed } = useTabAccess();
  const TAB_MENU_KEYS: Record<string, string> = {
    general: 'settings-general',
    security: 'settings-security',
    access: 'settings-access',
    backup: 'settings-backup',
    integrations: 'settings-integrations',
  };
  const [activeTab, setActiveTab] = useState<SettingsTab>(
    propTab === 'security' ? 'security' : propTab === 'access' ? 'access' : propTab === 'backup' ? 'backup' : propTab === 'integrations' ? 'integrations' : 'general'
  );

  // Keep the tab in sync when the sidebar navigates between settings submenus
  // while this component stays mounted.
  useEffect(() => {
    const known = ['general', 'security', 'access', 'backup', 'integrations'];
    if (propTab && known.includes(propTab)) {
      queueMicrotask(() => setActiveTab(propTab as SettingsTab));
    }
  }, [propTab]);

  const allTabs = [
    { key: 'general' as SettingsTab, label: 'تنظیمات عمومی', icon: <Settings size={14} /> },
    { key: 'security' as SettingsTab, label: 'امنیت و دسترسی', icon: <Shield size={14} /> },
    { key: 'access' as SettingsTab, label: 'شخصی‌سازی دسترسی', icon: <Users size={14} /> },
    { key: 'backup' as SettingsTab, label: 'پشتیبان‌گیری', icon: <HardDrive size={14} /> },
    { key: 'integrations' as SettingsTab, label: 'یکپارچه‌سازی', icon: <Globe size={14} /> },
  ];
  const tabs = allTabs.filter((t) => isTabAllowed(TAB_MENU_KEYS[t.key]));
  const currentTab: SettingsTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'general');

  const tabClass = (k: string) => "flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] " + (currentTab === k ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700');

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto" role="tablist" aria-label="تنظیمات">
          {tabs.map((tab) => (
            <button key={tab.key} role="tab" aria-selected={currentTab === tab.key} onClick={() => setActiveTab(tab.key)} className={tabClass(tab.key)}>{tab.icon} {tab.label}</button>
          ))}
        </div>
      </div>
      {currentTab === 'general' && <GeneralSettingsTab />}
      {currentTab === 'security' && <SecuritySettingsTab />}
      {currentTab === 'access' && <AccessCustomization />}
      {currentTab === 'backup' && <BackupSection />}
      {currentTab === 'integrations' && <IntegrationsSection />}
    </div>
  );
}
