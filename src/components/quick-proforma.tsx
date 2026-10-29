'use client';

// ════════════════════════════════════════════════════════════
// quick-proforma.tsx — v2.34.9 QuickProformaScreen (round 56)
//
// «صدور سریع پیش‌فاکتور» used to open the NewProformaDialog over the
// documents list — a 58rem modal with 11px labels, h-9 inputs and 1.5-unit
// gaps. The user's round-56 feedback: «صفحه اون خیلی جمع شده و باز تر بشه
// که نوشته ها و کادر ها بهتر دیده بشوند». The form is therefore now a
// DEDICATED FULL PAGE (the same dedicated-page pattern as the center
// dossier, v2.34.8):
//   • max-w-5xl canvas — no dialog chrome, no 88vh scroll ceiling
//   • 13px labels, h-11 text-sm inputs, 20px paddings, 20px section gaps
//   • items rendered as a proper roomy table with column headers
//   • after saving, an in-page success panel shows the issued number and
//     offers «پیش‌فاکتور جدید» / «مشاهدهٔ فهرست» (no modal to dismiss)
//
// Data flow and validation are IDENTICAL to NewProformaDialog (same
// endpoints, same buyer-snapshot semantics, same per-row item validation)
// — only the presentation opens up. The dialog remains in use inside the
// sales-documents module.
//
// v2.38.0 (round 64) — «مشخصات خریدار» center field made SEARCHABLE:
//   • the legacy <select> listed only the first 200 of the 1,500+ centers
//     (pageSize:200 preload); it is now the shared CenterCombobox with
//     server-side search (name/city/province, ZWNJ-normalized, layout-twin
//     aware — same engine as every other center search since r58/r61)
//   • picking a row pre-fills the whole buyer identity block straight from
//     the search payload (the /api/centers search action returns the
//     identity fields since v2.38.0 — no second fetch); the seller card's
//     company follows the picked row's company
//   • شناسه ملی / کد اقتصادی typed once are LEARNED: the create endpoint
//     writes them back onto the center master data (last-issued-wins) so
//     the next proforma for the same center starts pre-filled
// ════════════════════════════════════════════════════════════
import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FilePlus2, Plus, X, Check, Loader2, ListChecks, CheckCircle2 } from 'lucide-react';
import { apiCall, apiGet } from '@/hooks/use-api';
import { toast } from 'sonner';
import { toJalaliString } from '@/lib/jalali';
import { CenterCombobox, type PickedCenter } from '@/components/center-combobox';
import {
  toPersianNum, formatCurrency, validateDocItems, numberToPersianWords,
  PAYMENT_TERMS_OPTIONS, DEFAULT_PROFORMA_TERMS,
  type CompanyProfileOption, type ProductCatalogOption,
} from './sales-docs-shared';

interface ProformaItemRow {
  productId: string | null;
  productCode: string | null;
  productName: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  discount: number;
}

const BLANK_ITEM: ProformaItemRow = {
  productId: null, productCode: null, productName: '',
  quantity: 1, unit: '', unitPrice: 0, discount: 0,
};

/** Compact in-row total — the full currency string stays in the summary
 * bar; the 1-unit column needs the short form (same rule as the dialog). */
function formatCompactRow(n: number): string {
  if (n >= 1_000_000_000) return toPersianNum((n / 1_000_000_000).toFixed(1)) + ' م.ر';
  if (n >= 1_000_000) return toPersianNum((n / 1_000_000).toFixed(0)) + ' م.ر';
  return toPersianNum(Math.round(n).toLocaleString('en-US'));
}

export function QuickProformaScreen({
  userDisplayName,
  activeCompanySlug,
  onViewDocs,
}: {
  /** Prefills «کارشناس فروش» (the document's sales expert). */
  userDisplayName?: string;
  /** Seller card shown before a buyer/center is picked (sidebar switcher). */
  activeCompanySlug?: string;
  /** Optional jump to the sales-documents list after a save. */
  onViewDocs?: () => void;
}) {
  const [centerId, setCenterId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('نقدی');
  const [description, setDescription] = useState(DEFAULT_PROFORMA_TERMS);
  const [applyVat, setApplyVat] = useState(true);
  // Seller contact block (identity itself is the company profile, read-only)
  const [expertName, setExpertName] = useState(userDisplayName || '');
  const [expertMobile, setExpertMobile] = useState('');
  // v2.38.0 (round 64) — the buyer card's center field is now a SEARCHABLE
  // combobox (the legacy <select> only ever listed the first 200 of the
  // 1,500+ centers). `pickedCenter` is the full search row: it pre-fills the
  // buyer identity block AND identifies the owning company for the seller
  // card (the old centers[200] preload is gone — search is server-side).
  const [pickedCenter, setPickedCenter] = useState<PickedCenter | null>(null);
  // Buyer identity block — pre-filled from the selected center, edited here,
  // submitted as the document's buyerSnapshot (legal snapshot semantics).
  // شناسه ملی / کد اقتصادی typed here are LEARNED server-side on submit
  // (last-issued-wins) so the next proforma for the same center starts filled.
  const [buyer, setBuyer] = useState({ name: '', nationalId: '', economicCode: '', address: '', cityProvince: '', contactName: '', phone: '', postalCode: '' });
  const [items, setItems] = useState<ProformaItemRow[]>([{ ...BLANK_ITEM }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Catalog + company profiles (fetched once per mount — this is a page,
  // not a dialog that re-opens)
  const [products, setProducts] = useState<ProductCatalogOption[]>([]);
  const [companies, setCompanies] = useState<CompanyProfileOption[]>([]);
  const [today, setToday] = useState('');
  // After a successful save: the issued document summary (success panel).
  const [saved, setSaved] = useState<{ documentNumber: string | null; payable: number } | null>(null);

  useEffect(() => {
    queueMicrotask(() => { setToday(toJalaliString(new Date().toISOString()) || ''); });
    apiGet<CompanyProfileOption[]>('/api/companies')
      .then((rows) => setCompanies(Array.isArray(rows) ? rows : []))
      .catch(() => setCompanies([]));
    apiCall<{ items?: ProductCatalogOption[] }>('/api/products', 'list', { pageSize: 100, active: true })
      .then((res) => setProducts(res.items || []))
      .catch(() => setProducts([]));
  }, []);

  /** Picking a center from the searchable combobox pre-fills the buyer
   *  identity block from the center's master data (v2.38.0: the search row
   *  itself carries the identity fields — no second fetch). Clearing the
   *  pick empties the block (خریدار متفرقه types everything by hand). */
  const onPickCenter = (c: PickedCenter | null) => {
    setPickedCenter(c);
    setCenterId(c?.id || '');
    setBuyer({
      name: c?.name || '',
      nationalId: c?.nationalId || '',
      economicCode: c?.economicCode || '',
      address: c?.address || '',
      cityProvince: [c?.province, c?.city].filter(Boolean).join(' / '),
      contactName: c?.contactName || '',
      phone: c?.phone || c?.mobile || '',
      postalCode: c?.postalCode || '',
    });
  };

  const addItem = () => setItems([...items, { ...BLANK_ITEM }]);
  const updateItem = (i: number, patch: Partial<ProformaItemRow>) =>
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  /** Catalog picker appends a pre-filled row (name/واحد/قیمت/کد/IRC). */
  const addFromCatalog = (productId: string) => {
    const p = products.find((x) => x.id === productId);
    if (!p) return;
    setItems((rows) => {
      const blankIdx = rows.findIndex((r) => !r.productName.trim() && !r.productId);
      const row: ProformaItemRow = {
        productId: p.id,
        productCode: p.code,
        productName: p.name,
        quantity: 1,
        unit: p.unit || 'عدد',
        unitPrice: p.price || 0,
        discount: 0,
      };
      if (blankIdx >= 0) return rows.map((r, i) => (i === blankIdx ? row : r));
      return [...rows, row];
    });
  };

  const submit = async () => {
    // Per-row validation (same engine as the dialog): a partially filled
    // row blocks submit; only untouched blank rows are skipped.
    const v = validateDocItems(items, {
      noun: 'محصول',
      emptyMessage: 'حداقل یک آیتم باید وارد شود.',
    });
    if (v.error) { setError(v.error); return; }
    setBusy(true);
    setError(null);
    // Buyer identity snapshot (legal snapshot semantics: the document keeps
    // what was entered HERE even if center master data changes later).
    const [province = '', city = ''] = buyer.cityProvince.split(' / ').map((s) => s.trim());
    const snapshot: Record<string, string> = {};
    if (buyer.name.trim()) snapshot.name = buyer.name.trim();
    if (buyer.nationalId.trim()) snapshot.nationalId = buyer.nationalId.trim();
    if (buyer.economicCode.trim()) snapshot.economicCode = buyer.economicCode.trim();
    if (buyer.address.trim()) snapshot.address = buyer.address.trim();
    if (city) snapshot.city = city;
    if (province) snapshot.province = province;
    if (buyer.phone.trim()) snapshot.phone = buyer.phone.trim();
    if (buyer.postalCode.trim()) snapshot.postalCode = buyer.postalCode.trim();
    if (buyer.contactName.trim()) snapshot.contactName = buyer.contactName.trim();

    try {
      const res = await apiCall<{ data?: { documentNumber?: string | null } }>('/api/sales-documents', 'create', {
        documentType: 'proforma',
        centerId: centerId || undefined,
        description,
        applyVat,
        paymentTerms,
        salesExpertName: expertName,
        salesExpertMobile: expertMobile,
        buyerSnapshot: snapshot,
        items: v.submit.map((it) => ({
          productId: it.productId || undefined,
          productName: it.productName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discount: it.discount,
          unit: it.unit || undefined,
        })),
      });
      const payable = applyVat
        ? Math.round(items.reduce((s, it) => s + it.quantity * it.unitPrice - it.discount, 0) * 1.09)
        : items.reduce((s, it) => s + it.quantity * it.unitPrice - it.discount, 0);
      setSaved({ documentNumber: res.data?.documentNumber ?? null, payable });
      toast.success('پیش‌فاکتور با موفقیت ثبت شد');
      // Reset for the next issuance (in place — no navigation needed).
      resetForm();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ثبت پیش‌فاکتور');
    } finally {
      setBusy(false);
    }
  };

  const resetForm = () => {
    setCenterId('');
    setPickedCenter(null);
    setPaymentTerms('نقدی');
    setDescription(DEFAULT_PROFORMA_TERMS);
    setApplyVat(true);
    setExpertName(userDisplayName || '');
    setExpertMobile('');
    setBuyer({ name: '', nationalId: '', economicCode: '', address: '', cityProvince: '', contactName: '', phone: '', postalCode: '' });
    setItems([{ ...BLANK_ITEM }]);
    setError(null);
    setToday(toJalaliString(new Date().toISOString()) || '');
  };

  const gross = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const totalDiscount = items.reduce((s, it) => s + it.discount, 0);
  const total = gross - totalDiscount;
  const payable = applyVat ? Math.round(total * 1.09) : total;

  /** Seller card: the selected center's owning company (the document's
   * companyId follows the center), else the sidebar's active company.
   * v2.38.0 — the company slug now travels on the picked combobox row
   * (the 200-row centers preload is gone with the legacy <select>). */
  const seller = useMemo(() => {
    const slug = pickedCenter?.company?.slug || activeCompanySlug;
    return companies.find((c) => c.slug === slug) || companies[0] || null;
  }, [pickedCenter, activeCompanySlug, companies]);

  /** Roomy section card — the dialog's badgeCard opened up (v2.34.9). */
  const badgeCard = (badge: string, children: React.ReactNode, extra?: string) => (
    <div className={`relative border border-gray-200 rounded-2xl p-5 pt-6 bg-white ${extra || ''}`}>
      <span className="absolute -top-3 right-4 bg-gray-900 text-white text-[11px] font-bold px-3 py-1 rounded-full">{badge}</span>
      {children}
    </div>
  );

  const buyerField = (label: string, key: keyof typeof buyer, placeholder?: string, dir?: 'ltr') => (
    <div>
      <label className="block text-[13px] font-medium text-gray-600 mb-1.5">{label}</label>
      <Input
        value={buyer[key]}
        onChange={(e) => setBuyer((b) => ({ ...b, [key]: e.target.value }))}
        placeholder={placeholder || label}
        aria-label={label}
        dir={dir}
        className="h-11 rounded-xl text-sm border-gray-200"
      />
    </div>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-5" data-quick-proforma>
      {/* ── page header ── */}
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <FilePlus2 size={20} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">صدور سریع پیش‌فاکتور</h2>
          <p className="text-xs text-gray-400">فرم کامل پیش‌فاکتور فروش — شماره و تاریخ پس از ثبت خودکار صادر می‌شود{today ? ` · امروز ${today}` : ''}</p>
        </div>
      </div>

      {/* ── success panel (replaces the closing dialog) ── */}
      {saved && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 space-y-3" data-qp-saved role="status">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} className="text-emerald-600 shrink-0" />
            <p className="text-sm font-bold text-emerald-800">
              پیش‌فاکتور {saved.documentNumber ? <>شمارهٔ <span dir="ltr">{toPersianNum(saved.documentNumber)}</span> </> : ''}با موفقیت ثبت شد.
            </p>
          </div>
          <p className="text-[13px] text-emerald-700">مبلغ قابل پرداخت: {formatCurrency(saved.payable)} — {numberToPersianWords(saved.payable)} ریال</p>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              type="button"
              onClick={() => setSaved(null)}
              data-qp-new
              className="h-10 gap-1.5 text-white text-xs rounded-xl px-5"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
            >
              <Plus size={14} /> صدور پیش‌فاکتور جدید
            </Button>
            {onViewDocs && (
              <Button
                type="button"
                variant="outline"
                onClick={onViewDocs}
                data-qp-view-docs
                className="h-10 gap-1.5 text-xs rounded-xl px-5 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
              >
                <ListChecks size={14} /> مشاهدهٔ فهرست پیش‌فاکتورها
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-6">
        {error && <p className="text-[13px] text-red-600 bg-red-50 rounded-xl p-3" role="alert">{error}</p>}

        {/* ── header band: terms + payment ── */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 bg-gray-50 border border-gray-100 rounded-2xl px-5 py-4">
          <span className="text-base font-extrabold text-gray-900">پیش‌فاکتور فروش</span>
          <span className="text-xs text-gray-400 hidden sm:inline">شماره و تاریخ پس از ثبت خودکار صادر می‌شود</span>
          <span className="flex-1" />
          <span className="text-[13px] text-gray-500">تاریخ صدور: {toPersianNum(today)}</span>
          <label className="flex items-center gap-2 text-[13px] text-gray-500">
            شرایط پرداخت:
            <select
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
              aria-label="شرایط پرداخت"
              className="h-10 rounded-xl border border-gray-200 px-3 text-sm bg-white"
            >
              {PAYMENT_TERMS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>

        {/* ── seller + buyer identity cards ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {badgeCard('مشخصات فروشنده', (
            <div className="space-y-3">
              <p className="text-base font-bold text-gray-900">{seller?.name || '—'}</p>
              {seller?.nationalId ? (
                <p className="text-[13px] text-gray-500">شناسه ملی: <span dir="ltr">{toPersianNum(seller.nationalId)}</span>{seller.postalCode ? ` · کد پستی: ${toPersianNum(seller.postalCode)}` : ''}</p>
              ) : null}
              {seller?.address ? <p className="text-[13px] text-gray-500 leading-6">{seller.address}</p> : null}
              {seller?.phone ? <p className="text-[13px] text-gray-500">تلفن: <span dir="ltr">{toPersianNum(seller.phone)}</span></p> : null}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5" htmlFor="quickproforma-exp-name">کارشناس فروش</label>
                  <Input id="quickproforma-exp-name" value={expertName} onChange={(e) => setExpertName(e.target.value)} placeholder="نام کارشناس" className="h-11 rounded-xl text-sm border-gray-200" />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5" htmlFor="quickproforma-exp-mobile">موبایل کارشناس</label>
                  <Input id="quickproforma-exp-mobile" value={expertMobile} onChange={(e) => setExpertMobile(e.target.value)} placeholder="0912..." dir="ltr" className="h-11 rounded-xl text-sm border-gray-200" />
                </div>
              </div>
            </div>
          ))}

          {badgeCard('مشخصات خریدار', (
            <div className="space-y-3">
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5" htmlFor="quickproforma-buyer-center">مرکز (جستجوی دفترچه مراکز)</label>
                {/* v2.38.0 — searchable server-side combobox (all 1,500+ centers,
                not just the first 200); picking a row pre-fills the block below */}
                <div data-qp-center-picker>
                  <CenterCombobox
                    value={pickedCenter}
                    onChange={onPickCenter}
                    placeholder="جستجوی نام مرکز، شهر یا استان…"
                    size="md"
                  />
                </div>
                <p className="text-[11px] text-gray-400 mt-1.5">برای خریدار متفرقه جستجو را خالی بگذارید و مشخصات را دستی وارد کنید — شناسه ملی و کد اقتصادی واردشده برای مرکز انتخابی ذخیره می‌شود و دفعهٔ بعد خودکار پر می‌شود.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {buyerField('نام / شرکت', 'name', 'نام خریدار')}
                {buyerField('شناسه ملی', 'nationalId', 'شناسه ملی / کد ملی', 'ltr')}
                {buyerField('کد اقتصادی', 'economicCode', 'کد اقتصادی', 'ltr')}
                {buyerField('کارشناس خرید', 'contactName', 'نام رابط طرف خریدار')}
                {buyerField('شهر / استان', 'cityProvince', 'تهران / تهران')}
                {buyerField('تلفن', 'phone', '021...', 'ltr')}
                {buyerField('کد پستی', 'postalCode', 'کد پستی', 'ltr')}
              </div>
              {buyerField('نشانی', 'address', 'نشانی کامل خریدار')}
              <p className="text-xs text-gray-400 leading-5">مشخصات بالا در این پیش‌فاکتور ثبت می‌شود (تصویر لحظهٔ صدور) و تغییر بعدی مرکز، سند صادرشده را بازنویسی نمی‌کند.</p>
            </div>
          ))}
        </div>

        {/* ── items table ── */}
        {badgeCard('اقلام کالا / خدمات', (
          <div className="space-y-3">
            {products.length > 0 && (
              <div className="flex items-center gap-3 flex-wrap">
                <select
                  value=""
                  onChange={(e) => { if (e.target.value) addFromCatalog(e.target.value); }}
                  aria-label="افزودن از کاتالوگ محصولات"
                  className="h-10 rounded-xl border border-dashed border-teal-300 bg-teal-50/50 px-3 text-[13px] text-teal-800 max-w-[26rem]"
                >
                  <option value="">＋ افزودن از کاتالوگ محصولات…</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                  ))}
                </select>
                <span className="text-xs text-gray-400">یا ردیف دستی اضافه کنید</span>
              </div>
            )}

            {/* column headers — the cramped 12-unit grid needed a legend */}
            <div className="hidden sm:grid grid-cols-12 gap-2 px-1 text-[11px] font-bold text-gray-400" aria-hidden="true">
              <span className="col-span-4">شرح کالا / خدمت</span>
              <span className="col-span-1 text-center">تعداد</span>
              <span className="col-span-2 text-center">واحد</span>
              <span className="col-span-2 text-center">قیمت واحد (ریال)</span>
              <span className="col-span-2 text-center">تخفیف (ریال)</span>
              <span className="col-span-1 text-center">جمع</span>
            </div>

            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-2 items-center">
                <div className="sm:col-span-4 min-w-0">
                  <Input
                    className="h-11 rounded-xl text-sm"
                    aria-label="شرح کالا یا خدمت"
                    placeholder="شرح کالا / خدمت"
                    value={it.productName}
                    onChange={(e) => updateItem(i, { productName: e.target.value, productId: null, productCode: null })}
                  />
                  {it.productCode ? (
                    <p className="text-[11px] text-gray-400 mt-1 px-1 truncate">کد کالا: {toPersianNum(it.productCode)}</p>
                  ) : null}
                </div>
                <Input className="sm:col-span-1 h-11 rounded-xl text-sm text-center" type="number" min={1} aria-label="تعداد" placeholder="تعداد" value={it.quantity || ''} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                <Input className="sm:col-span-2 h-11 rounded-xl text-sm" aria-label="واحد" placeholder="واحد (عدد)" value={it.unit} onChange={(e) => updateItem(i, { unit: e.target.value })} />
                <Input className="sm:col-span-2 h-11 rounded-xl text-sm" type="number" min={0} aria-label="قیمت واحد (ریال)" placeholder="قیمت واحد (ریال)" value={it.unitPrice || ''} onChange={(e) => updateItem(i, { unitPrice: Number(e.target.value) })} />
                <Input className="sm:col-span-2 h-11 rounded-xl text-sm" type="number" min={0} aria-label="تخفیف (ریال)" placeholder="تخفیف" value={it.discount || ''} onChange={(e) => updateItem(i, { discount: Number(e.target.value) })} />
                <div className="sm:col-span-1 flex items-center justify-end gap-1.5">
                  <span className="text-xs font-bold text-gray-600 whitespace-nowrap" title="مبلغ کل ردیف">
                    {it.quantity * it.unitPrice - it.discount > 0 ? formatCompactRow(it.quantity * it.unitPrice - it.discount) : '—'}
                  </span>
                  <button type="button" onClick={() => setItems(items.filter((_, idx) => idx !== i))} aria-label={`حذف ردیف ${toPersianNum(i + 1)}`} className="w-9 h-9 rounded-xl text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0">
                    <X size={15} />
                  </button>
                </div>
              </div>
            ))}
            <button onClick={addItem} className="text-[13px] text-teal-700 hover:underline flex items-center gap-1.5 pt-1">
              <Plus size={14} /> افزودن ردیف
            </button>
          </div>
        ))}

        {/* ── bank + terms ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {badgeCard('اطلاعات حساب', (
            seller?.bankName || seller?.bankAccountNumber || seller?.bankSheba ? (
              <div className="space-y-2">
                <div className="flex justify-between text-[13px]"><span className="text-gray-500">نام بانک:</span><span className="font-medium text-gray-800">{seller?.bankName || '—'}</span></div>
                <div className="flex justify-between text-[13px]"><span className="text-gray-500">نام دارنده:</span><span className="font-medium text-gray-800">{seller?.bankAccountHolder || seller?.name}</span></div>
                <div className="flex justify-between text-[13px]"><span className="text-gray-500">شماره حساب:</span><span className="font-medium text-gray-800" dir="ltr">{toPersianNum(seller?.bankAccountNumber || '—')}</span></div>
                <div className="flex justify-between text-[13px]"><span className="text-gray-500">شماره شبا:</span><span className="font-medium text-gray-800" dir="ltr">{seller?.bankSheba || '—'}</span></div>
                <p className="text-xs text-gray-400 pt-1">اطلاعات حساب از پروفایل شرکت صادرکننده خوانده می‌شود.</p>
              </div>
            ) : (
              <p className="text-[13px] text-gray-400">برای این شرکت اطلاعات حساب بانکی ثبت نشده است — از پیش‌نمایش چاپ با خط‌چین نمایش داده می‌شود.</p>
            )
          ))}

          {badgeCard('توضیحات / شرایط', (
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              aria-label="توضیحات و شرایط"
              placeholder="شرایط و توضیحات پیش‌فاکتور..."
              rows={6}
              className="rounded-xl text-sm resize-none border-gray-200 leading-7"
            />
          ))}
        </div>

        {/* ── financial summary ── */}
        <div className="border border-gray-200 rounded-2xl p-5 bg-gray-50/60">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2.5 text-gray-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={applyVat}
                onChange={(e) => setApplyVat(e.target.checked)}
                className="accent-teal-600 w-4 h-4"
              />
              اعمال مالیات بر ارزش افزوده (٪۹)
            </label>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[13px] text-gray-600">
              <span>جمع کل: <b className="text-gray-900">{formatCurrency(gross)}</b></span>
              <span>تخفیف: <b className="text-gray-900">{formatCurrency(totalDiscount)}</b></span>
              {applyVat && <span>ارزش افزوده: <b className="text-gray-900">{formatCurrency(Math.round(total * 0.09))}</b></span>}
              <span className="text-base">مبلغ قابل پرداخت: <b className="text-teal-700">{formatCurrency(payable)}</b></span>
            </div>
          </div>
          <p className="text-[13px] text-gray-500 mt-3 pt-3 border-t border-gray-200 border-dashed">
            مبلغ قابل پرداخت به حروف: {numberToPersianWords(payable)} ریال
          </p>
        </div>

        <Button onClick={submit} disabled={busy} data-qp-submit className="w-full h-12 rounded-xl text-white font-bold text-sm" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          {busy ? 'در حال ثبت...' : 'ثبت پیش‌فاکتور'}
        </Button>
      </div>
    </div>
  );
}
