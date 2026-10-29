'use client';

// ════════════════════════════════════════════════════════
// Creation dialogs for the sales-documents module:
// NewProformaDialog / NewReturnDialog / QuickSaleDialog.
// Extracted from sales-docs.tsx (P2-2 decomposition).
// ════════════════════════════════════════════════════════
import React, { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Plus, Zap, Gift, X, Undo2 } from 'lucide-react';
import { apiCall, apiGet, withToast } from '@/hooks/use-api';
import { toast } from 'sonner';
import { toJalaliString } from '@/lib/jalali';
import { toPersianNum, formatCurrency, validateDocItems, numberToPersianWords, PAYMENT_TERMS_OPTIONS, DEFAULT_PROFORMA_TERMS, type SenderAddressType, type ApiSalesDocument, type ApiSalesDocumentDetail, type ProformaCenterOption, type CompanyProfileOption, type ProductCatalogOption } from './sales-docs-shared';

// ==================== NEW PROFORMA DIALOG ====================
// v2.31.9 — redesigned after the official Lian proforma format
// (پیش‌فاکتور فروش شرکت بهبود گستر لیان ایرانیان، مرجع دور ۳۸). The
// dialog now mirrors the printed document's structure so the data-entry
// flow and the paper format agree field-for-field:
//   • header band  — شماره (auto) + تاریخ صدور + شرایط پرداخت
//   • seller card  — company profile (read-only) + کارشناس فروش/موبایل
//   • buyer card   — center pre-fill, editable identity block (snapshot)
//   • items table  — catalog picker, شرح/تعداد/واحد/قیمت/تخفیف + جمع
//   • bank card    — company bank account (read-only)
//   • terms box    — default conditions text from the reference format
//   • summary bar  — جمع/تخفیف/مالیات/قابل پرداخت + مبلغ به حروف
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

export function NewProformaDialog({
  centers,
  onCreated,
  userDisplayName,
  activeCompanySlug,
  defaultOpen,
  hero,
}: {
  centers: ProformaCenterOption[];
  onCreated: () => void;
  /** Prefills «کارشناس فروش» (the document's sales expert). */
  userDisplayName?: string;
  /** Seller card shown before a buyer/center is picked (sidebar switcher). */
  activeCompanySlug?: string;
  /** v2.34.0 — quick-proforma: the dialog starts open (menu → form, zero extra clicks). */
  defaultOpen?: boolean;
  /** v2.34.10 — hero variant: white button for the new gradient page header. */
  hero?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [centerId, setCenterId] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('نقدی');
  const [description, setDescription] = useState('');
  const [applyVat, setApplyVat] = useState(true);
  // Seller contact block (identity itself is the company profile, read-only)
  const [expertName, setExpertName] = useState('');
  const [expertMobile, setExpertMobile] = useState('');
  // Buyer identity block — pre-filled from the selected center, edited here,
  // submitted as the document's buyerSnapshot (legal snapshot semantics).
  const [buyer, setBuyer] = useState({ name: '', nationalId: '', economicCode: '', address: '', cityProvince: '', contactName: '', phone: '', postalCode: '' });
  const [items, setItems] = useState<ProformaItemRow[]>([{ ...BLANK_ITEM }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v2.42.0 — انتخابگر نشانی فرستنده: '' = پیش‌فرض (هر دو / تک‌نشانی)،
  // 'main_office' = فقط دفتر مرکزی، 'factory' = فقط کارخانه در چاپ.
  const [senderAddressType, setSenderAddressType] = useState<'' | SenderAddressType>('');
  // Catalog + company profiles (fetched once per dialog open)
  const [products, setProducts] = useState<ProductCatalogOption[]>([]);
  const [companies, setCompanies] = useState<CompanyProfileOption[]>([]);
  // Issue date shown in the header band (refreshed on every open — a
  // stale useMemo would freeze «امروز» across an overnight session).
  const [today, setToday] = useState('');

  useEffect(() => {
    if (open) {
      // Reset the form when the dialog opens so leftover rows/values from a
      // previous (possibly abandoned) proforma never leak into a new one.
      // Runs on the microtask queue — no synchronous setState in the effect
      // body (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        setCenterId('');
        setPaymentTerms('نقدی');
        // Default terms from the official Lian proforma — the reference
        // format's standard conditions line (مرجع دور ۳۸).
        setDescription(DEFAULT_PROFORMA_TERMS);
        setApplyVat(true);
        setExpertName(userDisplayName || '');
        setExpertMobile('');
        setBuyer({ name: '', nationalId: '', economicCode: '', address: '', cityProvince: '', contactName: '', phone: '', postalCode: '' });
        setItems([{ ...BLANK_ITEM }]);
        setSenderAddressType('');
        setError(null);
        setToday(toJalaliString(new Date().toISOString()) || '');
      });
      // Seller profiles + product catalog for the pickers (silent best-effort:
      // a failed fetch degrades to manual entry, never blocks the form).
      apiGet<CompanyProfileOption[]>('/api/companies')
        .then((rows) => setCompanies(Array.isArray(rows) ? rows : []))
        .catch(() => setCompanies([]));
      apiCall<{ items?: ProductCatalogOption[] }>('/api/products', 'list', { pageSize: 100, active: true })
        .then((res) => setProducts(res.items || []))
        .catch(() => setProducts([]));
    }
  }, [open, userDisplayName]);

  /** Selecting a center pre-fills the buyer identity block from master data. */
  const onCenterChange = (id: string) => {
    setCenterId(id);
    const c = centers.find((x) => x.id === id);
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
    // v2.29.1 — per-row validation replaces the silent `items.filter(...)`:
    // a partially filled row must block submit with a Persian error (it
    // previously vanished silently while the on-screen total still counted
    // it — silent data loss). Only untouched blank rows are skipped.
    const v = validateDocItems(items, {
      noun: 'محصول',
      emptyMessage: 'حداقل یک آیتم باید وارد شود.',
    });
    if (v.error) { setError(v.error); return; }
    setBusy(true);
    setError(null);
    // v2.31.9 — buyer identity snapshot (legal snapshot semantics: the
    // document keeps what was entered HERE even if center master data
    // changes later).
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

    const ok = await withToast(
      () => apiCall('/api/sales-documents', 'create', {
        documentType: 'proforma',
        centerId: centerId || undefined,
        description,
        applyVat,
        paymentTerms,
        salesExpertName: expertName,
        salesExpertMobile: expertMobile,
        buyerSnapshot: snapshot,
        // v2.42.0 — انتخابگر نشانی فرستنده (فقط وقتی انتخاب در شرکتِ فروشنده
        // ثبت‌شده باشد؛ در غیر این صورت undefined = پیش‌فرض دو-نشانی).
        senderAddressType: effSenderAddressType ?? undefined,
        items: v.submit.map((it) => ({
          productId: it.productId || undefined,
          productName: it.productName,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discount: it.discount,
          unit: it.unit || undefined,
        })),
      }),
      'پیش‌فاکتور با موفقیت ثبت شد'
    );
    if (ok) {
      setOpen(false);
      setCenterId('');
      setDescription(DEFAULT_PROFORMA_TERMS);
      setBuyer({ name: '', nationalId: '', economicCode: '', address: '', cityProvince: '', contactName: '', phone: '', postalCode: '' });
      setItems([{ ...BLANK_ITEM }]);
      onCreated();
    }
    setBusy(false);
  };

  const gross = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const totalDiscount = items.reduce((s, it) => s + it.discount, 0);
  const total = gross - totalDiscount;
  const payable = applyVat ? Math.round(total * 1.09) : total;

  /** Seller card: the selected center's owning company (the document's
   *  companyId follows the center), else the sidebar's active company. */
  const seller = useMemo(() => {
    const centerCompanySlug = centerId
      ? centers.find((c) => c.id === centerId)?.company?.slug
      : undefined;
    const slug = centerCompanySlug || activeCompanySlug;
    return companies.find((c) => c.slug === slug) || companies[0] || null;
  }, [centerId, centers, activeCompanySlug, companies]);

  // v2.42.0 — انتخابگر نشانی فرستنده: the picker only offers REGISTERED
  // addresses of the current seller; a stale choice (seller switched after
  // picking) degrades to the default instead of storing a dead reference.
  const hasHeadOffice = !!seller?.headOfficeAddress;
  const hasFactory = !!seller?.factoryAddress;
  const effSenderAddressType: SenderAddressType | null =
    senderAddressType === 'main_office' && hasHeadOffice ? 'main_office'
    : senderAddressType === 'factory' && hasFactory ? 'factory'
    : null;

  /** Section card with the badge-on-border title — the print sheet's
   *  «doc-badge» language translated into the form's Tailwind dialect. */
  const badgeCard = (badge: string, children: React.ReactNode, extra?: string) => (
    <div className={`relative border border-gray-200 rounded-xl p-3.5 pt-4 ${extra || ''}`}>
      <span className="absolute -top-2.5 right-3 bg-gray-900 text-white text-[10px] font-bold px-2.5 py-0.5 rounded-full">{badge}</span>
      {children}
    </div>
  );

  const buyerField = (label: string, key: keyof typeof buyer, placeholder?: string, dir?: 'ltr') => (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
      <Input
        value={buyer[key]}
        onChange={(e) => setBuyer((b) => ({ ...b, [key]: e.target.value }))}
        placeholder={placeholder || label}
        aria-label={label}
        dir={dir}
        className="h-9 rounded-lg text-xs border-gray-200"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* v2.34.10 — hero: white button on the gradient page header (like the reference design) */}
        <Button className={hero
          ? 'h-10 gap-1.5 text-sm rounded-lg px-4 font-semibold bg-white text-teal-800 hover:bg-teal-50 shadow-sm'
          : 'h-9 gap-1.5 text-white text-xs rounded-lg px-3'
        } style={hero ? undefined : { background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <Plus size={hero ? 15 : 13} /> {hero ? 'صدور پیش‌فاکتور' : 'پیش‌فاکتور جدید'}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(58rem,calc(100vw-2rem))] max-h-[88vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>ثبت پیش‌فاکتور فروش</DialogTitle></DialogHeader>
        <div className="space-y-3.5 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          {/* ── header band: title + number/date/terms ── */}
          <div className="flex flex-wrap items-center gap-2 bg-gray-50 border border-gray-100 rounded-xl px-3.5 py-2.5">
            <span className="text-[13px] font-extrabold text-gray-900">پیش‌فاکتور فروش</span>
            <span className="text-[10px] text-gray-400 hidden sm:inline">شماره و تاریخ پس از ثبت خودکار صادر می‌شود</span>
            <span className="flex-1" />
            <span className="text-[11px] text-gray-500">تاریخ صدور: {toPersianNum(today)}</span>
            <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
              شرایط پرداخت:
              <select
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
                aria-label="شرایط پرداخت"
                className="h-8 rounded-lg border border-gray-200 px-2 text-xs bg-white"
              >
                {PAYMENT_TERMS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          {/* ── seller + buyer identity cards ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {badgeCard('مشخصات فروشنده', (
              <div className="space-y-2">
                <p className="text-sm font-bold text-gray-900">{seller?.name || '—'}</p>
                {seller?.nationalId ? (
                  <p className="text-[11px] text-gray-500">شناسه ملی: <span dir="ltr">{toPersianNum(seller.nationalId)}</span>{seller.postalCode ? ` · کد پستی: ${toPersianNum(seller.postalCode)}` : ''}</p>
                ) : null}
                {/* v2.35.0 — the two sender addresses registered once in company
                    settings: shown here (read-only) and auto-printed on the doc. */}
                {seller?.headOfficeAddress ? (
                  <p className="text-[11px] text-gray-500 leading-5"><span className="font-medium text-teal-700">نشانی دفتر مرکزی:</span> {seller.headOfficeAddress}</p>
                ) : null}
                {seller?.factoryAddress ? (
                  <p className="text-[11px] text-gray-500 leading-5"><span className="font-medium text-teal-700">نشانی کارخانه:</span> {seller.factoryAddress}</p>
                ) : null}
                {!seller?.headOfficeAddress && !seller?.factoryAddress && seller?.address ? (
                  <p className="text-[11px] text-gray-500 leading-5">{seller.address}</p>
                ) : null}
                {/* v2.42.0 — انتخابگر نشانی فرستنده: فقط وقتی نمایش داده
                    می‌شود که دست‌کم یکی از دو نشانی ثبت شده باشد. */}
                {(hasHeadOffice || hasFactory) ? (
                  <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-2.5 py-2 space-y-1.5">
                    <span className="block text-[11px] font-medium text-gray-600">محل درج نشانی فرستنده در چاپ:</span>
                    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1" role="radiogroup" aria-label="محل درج نشانی فرستنده در چاپ">
                      {(hasHeadOffice && hasFactory) ? (
                        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                          <input
                            type="radio"
                            name="sender-address-type"
                            checked={effSenderAddressType === null}
                            onChange={() => setSenderAddressType('')}
                          />
                          هر دو نشانی (پیش‌فرض)
                        </label>
                      ) : null}
                      {hasHeadOffice ? (
                        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                          <input
                            type="radio"
                            name="sender-address-type"
                            checked={effSenderAddressType === 'main_office'}
                            onChange={() => setSenderAddressType('main_office')}
                          />
                          فقط دفتر مرکزی
                        </label>
                      ) : null}
                      {hasFactory ? (
                        <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer">
                          <input
                            type="radio"
                            name="sender-address-type"
                            checked={effSenderAddressType === 'factory'}
                            onChange={() => setSenderAddressType('factory')}
                          />
                          فقط کارخانه
                        </label>
                      ) : null}
                    </div>
                    <p className="text-[10px] text-gray-400">انتخاب در همین سند ثبت می‌شود و چاپ فقط همان نشانی را نمایش می‌دهد.</p>
                  </div>
                ) : null}
                {seller?.phone ? <p className="text-[11px] text-gray-500">تلفن: <span dir="ltr">{toPersianNum(seller.phone)}</span></p> : null}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salesdocsdialogs-exp-name">کارشناس فروش</label>
                    <Input id="salesdocsdialogs-exp-name" value={expertName} onChange={(e) => setExpertName(e.target.value)} placeholder="نام کارشناس" className="h-9 rounded-lg text-xs border-gray-200" />
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salesdocsdialogs-exp-mobile">موبایل کارشناس</label>
                    <Input id="salesdocsdialogs-exp-mobile" value={expertMobile} onChange={(e) => setExpertMobile(e.target.value)} placeholder="0912..." dir="ltr" className="h-9 rounded-lg text-xs border-gray-200" />
                  </div>
                </div>
              </div>
            ))}

            {badgeCard('مشخصات خریدار', (
              <div className="space-y-2">
                <div>
                  <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salesdocsdialogs-buyer-center">مرکز (از دفترچه مراکز)</label>
                  <select id="salesdocsdialogs-buyer-center" value={centerId} onChange={(e) => onCenterChange(e.target.value)} className="w-full h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                    <option value="">بدون مرکز (خریدار متفرقه)</option>
                    {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {buyerField('نام / شرکت', 'name', 'نام خریدار')}
                  {buyerField('شناسه ملی', 'nationalId', 'شناسه ملی / کد ملی', 'ltr')}
                  {buyerField('کد اقتصادی', 'economicCode', 'کد اقتصادی', 'ltr')}
                  {buyerField('کارشناس خرید', 'contactName', 'نام رابط طرف خریدار')}
                  {buyerField('شهر / استان', 'cityProvince', 'تهران / تهران')}
                  {buyerField('تلفن', 'phone', '021...', 'ltr')}
                  {buyerField('کد پستی', 'postalCode', 'کد پستی', 'ltr')}
                </div>
                {buyerField('نشانی', 'address', 'نشانی کامل خریدار')}
                <p className="text-[10px] text-gray-400">مشخصات بالا در این پیش‌فاکتور ثبت می‌شود (تصویر لحظهٔ صدور) و تغییر بعدی مرکز، سند صادرشده را بازنویسی نمی‌کند.</p>
              </div>
            ))}
          </div>

          {/* ── items table ── */}
          {badgeCard('اقلام کالا / خدمات', (
            <div className="space-y-2">
              {products.length > 0 && (
                <div className="flex items-center gap-2">
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) addFromCatalog(e.target.value); }}
                    aria-label="افزودن از کاتالوگ محصولات"
                    className="h-8 rounded-lg border border-dashed border-teal-300 bg-teal-50/50 px-2 text-xs text-teal-800 max-w-[22rem]"
                  >
                    <option value="">＋ افزودن از کاتالوگ محصولات…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>{p.code} — {p.name}</option>
                    ))}
                  </select>
                  <span className="text-[10px] text-gray-400">یا ردیف دستی اضافه کنید</span>
                </div>
              )}
              {items.map((it, i) => (
                <div key={i}>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-1.5 sm:gap-2 items-center">
                    <div className="col-span-4 min-w-0">
                      <Input
                        className="h-9 rounded-lg text-xs"
                        aria-label="شرح کالا یا خدمت"
                        placeholder="شرح کالا / خدمت"
                        value={it.productName}
                        onChange={(e) => updateItem(i, { productName: e.target.value, productId: null, productCode: null })}
                      />
                      {it.productCode ? (
                        <p className="text-[9.5px] text-gray-400 mt-0.5 px-1 truncate">کد کالا: {toPersianNum(it.productCode)}</p>
                      ) : null}
                    </div>
                    <Input className="col-span-1 h-9 rounded-lg text-xs" type="number" min={1} aria-label="تعداد" placeholder="تعداد" value={it.quantity || ''} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                    <Input className="col-span-2 h-9 rounded-lg text-xs" aria-label="واحد" placeholder="واحد (عدد)" value={it.unit} onChange={(e) => updateItem(i, { unit: e.target.value })} />
                    <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={0} aria-label="قیمت واحد (ریال)" placeholder="قیمت واحد (ریال)" value={it.unitPrice || ''} onChange={(e) => updateItem(i, { unitPrice: Number(e.target.value) })} />
                    <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={0} aria-label="تخفیف (ریال)" placeholder="تخفیف" value={it.discount || ''} onChange={(e) => updateItem(i, { discount: Number(e.target.value) })} />
                    <div className="col-span-1 flex items-center justify-between gap-1">
                      <span className="text-[10px] font-bold text-gray-600 whitespace-nowrap" title="مبلغ کل ردیف">
                        {it.quantity * it.unitPrice - it.discount > 0 ? formatCompactRow(it.quantity * it.unitPrice - it.discount) : '—'}
                      </span>
                      <button type="button" onClick={() => setItems(items.filter((_, idx) => idx !== i))} aria-label={`حذف ردیف ${toPersianNum(i + 1)}`} className="w-7 h-7 rounded-lg text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0">
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
              <button onClick={addItem} className="text-xs text-teal-700 hover:underline flex items-center gap-1">
                <Plus size={12} /> افزودن ردیف
              </button>
            </div>
          ))}

          {/* ── bank + terms ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            {badgeCard('اطلاعات حساب', (
              seller?.bankName || seller?.bankAccountNumber || seller?.bankSheba ? (
                <div className="space-y-1">
                  <div className="flex justify-between text-[11px]"><span className="text-gray-500">نام بانک:</span><span className="font-medium text-gray-800">{seller?.bankName || '—'}</span></div>
                  <div className="flex justify-between text-[11px]"><span className="text-gray-500">نام دارنده:</span><span className="font-medium text-gray-800">{seller?.bankAccountHolder || seller?.name}</span></div>
                  <div className="flex justify-between text-[11px]"><span className="text-gray-500">شماره حساب:</span><span className="font-medium text-gray-800" dir="ltr">{toPersianNum(seller?.bankAccountNumber || '—')}</span></div>
                  <div className="flex justify-between text-[11px]"><span className="text-gray-500">شماره شبا:</span><span className="font-medium text-gray-800" dir="ltr">{seller?.bankSheba || '—'}</span></div>
                  <p className="text-[10px] text-gray-400 pt-0.5">مشخصات فرستنده از پروفایل شرکت صادرکننده خوانده می‌شود — ویرایش از تنظیمات سیستم ▸ اطلاعات فرستندهٔ شرکت‌ها.</p>
                </div>
              ) : (
                <p className="text-[11px] text-gray-400">برای این شرکت اطلاعات حساب بانکی ثبت نشده است — از پیش‌نمایش چاپ با خط‌چین نمایش داده می‌شود.</p>
              )
            ))}

            {badgeCard('توضیحات / شرایط', (
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                aria-label="توضیحات و شرایط"
                placeholder="شرایط و توضیحات پیش‌فاکتور..."
                rows={5}
                className="rounded-lg text-xs resize-none border-gray-200 leading-6"
              />
            ))}
          </div>

          {/* ── financial summary ── */}
          <div className="border border-gray-200 rounded-xl p-3 bg-gray-50/60">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <label className="flex items-center gap-2 text-gray-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={applyVat}
                  onChange={(e) => setApplyVat(e.target.checked)}
                  className="accent-teal-600 w-4 h-4"
                />
                اعمال مالیات بر ارزش افزوده (٪۹)
              </label>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-gray-600">
                <span>جمع کل: <b className="text-gray-900">{formatCurrency(gross)}</b></span>
                <span>تخفیف: <b className="text-gray-900">{formatCurrency(totalDiscount)}</b></span>
                {applyVat && <span>ارزش افزوده: <b className="text-gray-900">{formatCurrency(Math.round(total * 0.09))}</b></span>}
                <span className="text-[13px]">مبلغ قابل پرداخت: <b className="text-teal-700">{formatCurrency(payable)}</b></span>
              </div>
            </div>
            <p className="text-[11px] text-gray-500 mt-2 pt-2 border-t border-gray-200 border-dashed">
              مبلغ قابل پرداخت به حروف: {numberToPersianWords(payable)} ریال
            </p>
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت پیش‌فاکتور'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Compact in-row total (keeps the 1-unit grid column readable). */
function formatCompactRow(n: number): string {
  if (n >= 1_000_000_000) return toPersianNum((n / 1_000_000_000).toFixed(1)) + ' م.ر';
  if (n >= 1_000_000) return toPersianNum((n / 1_000_000).toFixed(0)) + ' م.ر';
  return toPersianNum(Math.round(n).toLocaleString('en-US'));
}

// ==================== NEW RETURN DIALOG ====================
export function NewReturnDialog({ centers, invoices, onCreated, hero }: {
  centers: Array<{ id: string; name: string }>;
  invoices: ApiSalesDocument[];
  onCreated: () => void;
  /** v2.34.10 — hero variant: glass button on the gradient page header. */
  hero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sourceInvoiceId, setSourceInvoiceId] = useState('');
  const [centerId, setCenterId] = useState('');
  const [reason, setReason] = useState('');
  const [applyVat, setApplyVat] = useState(false);
  const [items, setItems] = useState<Array<{ productName: string; quantity: number; unitPrice: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Reset the form when the dialog opens (leftover invoice/reason/items
      // from an abandoned return never leak into a new one). Microtask —
      // no synchronous setState in the effect body.
      queueMicrotask(() => {
        setSourceInvoiceId('');
        setCenterId('');
        setReason('');
        setApplyVat(false);
        setItems([]);
        setError(null);
      });
    }
  }, [open]);

  const loadInvoiceItems = async (invoiceId: string) => {
    setItems([]);
    if (!invoiceId) return;
    try {
      const res = await apiCall<{ data: ApiSalesDocumentDetail }>('/api/sales-documents', 'get', { id: invoiceId });
      setItems((res.data.items || []).map((it) => ({
        productName: it.productName,
        quantity: 1,
        unitPrice: it.unitPrice,
      })));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت اقلام فاکتور');
    }
  };

  const submit = async () => {
    // v2.29.1 — per-row validation replaces the silent filter (see
    // sales-docs-shared.ts): partially filled rows block submit instead of
    // vanishing while the displayed total still counted them.
    const v = validateDocItems(items, {
      noun: 'محصول',
      emptyMessage: 'حداقل یک قلم کالا برای مرجوعی لازم است.',
    });
    if (v.error) { setError(v.error); return; }
    setBusy(true);
    setError(null);
    try {
      const source = invoices.find((i) => i.id === sourceInvoiceId);
      await apiCall('/api/sales-documents', 'create', {
        documentType: 'return',
        centerId: centerId || source?.centerId || undefined,
        description: `مرجوعی از فاکتور ${source?.documentNumber || '—'}${reason ? ' — دلیل: ' + reason : ''}`,
        applyVat,
        items: v.submit,
      });
      setOpen(false);
      setSourceInvoiceId('');
      setReason('');
      setItems([]);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت مرجوعی');
    } finally {
      setBusy(false);
    }
  };

  const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <button
        onClick={() => setOpen(true)}
        className={hero
          ? 'h-10 gap-1.5 text-sm rounded-lg px-4 font-medium flex items-center shrink-0 bg-white/15 text-white border border-white/30 hover:bg-white/25 transition-colors'
          : 'h-9 gap-1.5 text-white text-xs rounded-lg px-3 font-medium flex items-center shrink-0'
        }
        style={hero ? undefined : { background: 'linear-gradient(135deg, #dc2626, #7c3aed)' }}
        title="ثبت مرجوعی جدید از فاکتور"
      >
        <Undo2 size={hero ? 15 : 13} /> {hero ? 'سند مرجوعی' : 'مرجوعی جدید'}
      </button>
      <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>ثبت مرجوعی (برگشت از فروش)</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocsdialogs-f232-3">فاکتور مرجع</label>
              <select id="salesdocsdialogs-f232-3"
                value={sourceInvoiceId}
                onChange={(e) => { setSourceInvoiceId(e.target.value); loadInvoiceItems(e.target.value); }}
                className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white"
              >
                <option value="">انتخاب فاکتور (اختیاری)</option>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.documentNumber || inv.id.slice(-6)} — {inv.center?.name || 'بدون مرکز'}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocsdialogs-f247-4">مرکز</label>
              <select id="salesdocsdialogs-f247-4" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
                <option value="">مطابق فاکتور مرجع</option>
                {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocsdialogs-f256-5">دلیل مرجوعی</label>
            <Input id="salesdocsdialogs-f256-5" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً ایراد فنی، انصراف مشتری، ارسال اشتباه..." className="h-10 rounded-lg" />
          </div>

          <div className="border border-gray-100 rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-gray-700">اقلام مرجوعی</p>
              <button onClick={() => setItems([...items, { productName: '', quantity: 1, unitPrice: 0 }])} className="text-xs text-teal-700 hover:underline flex items-center gap-1">
                <Plus size={12} /> افزودن ردیف
              </button>
            </div>
            {items.length === 0 && (
              <p className="text-[11px] text-gray-400 text-center py-2">
                با انتخاب فاکتور مرجع، اقلام آن بارگذاری می‌شود؛ یا به‌صورت دستی ردیف اضافه کنید
              </p>
            )}
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input className="flex-1 h-9 rounded-lg text-xs" aria-label="نام محصول" placeholder="نام محصول" value={it.productName}
                  onChange={(e) => setItems(items.map((x, idx) => idx === i ? { ...x, productName: e.target.value } : x))} />
                <Input className="w-20 h-9 rounded-lg text-xs" type="number" min={1} aria-label="تعداد" placeholder="تعداد" value={it.quantity || ''}
                  onChange={(e) => setItems(items.map((x, idx) => idx === i ? { ...x, quantity: Number(e.target.value) } : x))} />
                <Input className="w-32 h-9 rounded-lg text-xs" type="number" min={0} aria-label="قیمت واحد" placeholder="قیمت واحد" value={it.unitPrice || ''}
                  onChange={(e) => setItems(items.map((x, idx) => idx === i ? { ...x, unitPrice: Number(e.target.value) } : x))} />
                <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="w-8 h-8 rounded-lg text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0">
                  <X size={14} />
                </button>
              </div>
            ))}
            {items.length > 0 && (
              <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={applyVat}
                    onChange={(e) => setApplyVat(e.target.checked)}
                    className="accent-teal-600 w-4 h-4"
                  />
                  اعمال مالیات بر ارزش افزوده
                </label>
                <p className="text-xs text-gray-500">جمع مرجوعی: {formatCurrency(total)}</p>
              </div>
            )}
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #dc2626, #7c3aed)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت سند مرجوعی'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== QUICK SALE DIALOG (فروش سریع B2C) ====================
export function QuickSaleDialog({ centers, onCreated, onInvoiceIssued, hero }: {
  centers: Array<{ id: string; name: string }>;
  onCreated: () => void;
  /** v2.39.0 — the quick-sale flow ISSUES an invoice, so its dispatch
   *  document (سند ارسال مراسلات) was auto-issued with it: the carton
   *  label dialog opens immediately for printing. */
  onInvoiceIssued?: (invoiceId: string, invoiceNumber: string | null) => void;
  /** v2.34.10 — hero variant: glass button on the gradient page header. */
  hero?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<Array<{ code: string; name: string; price: number; unit: string }>>([]);
  // مشتری: انتخاب از موجود یا ثبت سریع با موبایل
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('new');
  const [centerId, setCenterId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerMobile, setCustomerMobile] = useState('');
  const [applyVat, setApplyVat] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('نقدی');
  const [awardPoints, setAwardPoints] = useState(true);
  const [items, setItems] = useState<Array<{ productId?: string; productCode?: string; productName: string; quantity: number; unitPrice: number }>>([
    { productName: '', quantity: 1, unitPrice: 0 },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || products.length > 0) return;
    apiCall<{ items?: Array<{ code: string; name: string; price: number; unit: string }> }>('/api/products', 'list', { pageSize: 200 })
      .then((res) => setProducts(res.items || []))
      .catch(() => undefined);
  }, [open, products.length]);

  useEffect(() => {
    if (open) {
      // Reset the document form asynchronously so the effect body itself stays
      // free of synchronous setState (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        setError(null);
        setCustomerMode('new');
        setCenterId(''); setCustomerName(''); setCustomerMobile('');
        setItems([{ productName: '', quantity: 1, unitPrice: 0 }]);
      });
    }
  }, [open]);

  const addItem = () => setItems([...items, { productName: '', quantity: 1, unitPrice: 0 }]);
  const updateItem = (i: number, patch: Partial<typeof items[number]>) =>
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const pickProduct = (i: number, code: string) => {
    const p = products.find((pr) => pr.code === code);
    if (p) {
      updateItem(i, { productId: undefined, productCode: p.code, productName: p.name, unitPrice: p.price });
    }
  };

  const total = items.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const vatAmount = applyVat ? Math.round(total * 0.09) : 0;
  const finalAmount = total + vatAmount;
  const willEarnPoints = awardPoints ? Math.floor(finalAmount / 100000) : 0;

  const submit = async () => {
    setError(null);
    // v2.29.1 — per-row validation replaces the silent filter; quick-sale
    // accepts price 0 (server only rejects negatives for this action).
    const v = validateDocItems(items, {
      noun: 'کالا',
      allowZeroPrice: true,
      emptyMessage: 'حداقل یک کالا وارد کنید.',
    });
    if (v.error) { setError(v.error); return; }
    if (customerMode === 'existing' && !centerId) { setError('مشتری را انتخاب کنید.'); return; }
    if (customerMode === 'new') {
      if (!customerName.trim()) { setError('نام مشتری الزامی است.'); return; }
      if (customerMobile.trim().replace(/[^۰-۹0-9]/g, '').length < 10) { setError('موبایل معتبر وارد کنید (حداقل ۱۰ رقم).'); return; }
    }
    setBusy(true);
    try {
      const res = await fetch('/api/sales-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'quick-sale',
          centerId: customerMode === 'existing' ? centerId : undefined,
          customerName: customerMode === 'new' ? customerName : undefined,
          customerMobile: customerMode === 'new' ? customerMobile : undefined,
          items: v.submit.map((it) => ({
            productId: it.productId,
            productName: it.productName,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
          })),
          applyVat,
          paymentMethod,
          awardPoints,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت فروش');
      const pts = data.data?.awardedPoints || 0;
      const createdNew = data.data?.customer?.created;
      // v2.39.0 — the invoice exists → its سند ارسال was auto-issued with
      // it; hand the invoice to the parent so the carton label opens.
      const issuedDocId: string | undefined = data.data?.document?.id;
      const issuedDocNo: string | null = data.data?.document?.documentNumber ?? null;
      const autoShipment: string | null = data.data?.shipment?.shipmentNumber ?? null;
      toast.success(
        `${data.message || 'فروش سریع ثبت شد'}${autoShipment ? ` · سند ارسال ${autoShipment} صادر شد` : ''}${pts > 0 ? ` · ${pts} امتیاز باشگاه` : ''}${createdNew ? ' · مشتری جدید ثبت شد' : ''}`
      );
      setOpen(false);
      onCreated();
      if (onInvoiceIssued && issuedDocId) onInvoiceIssued(issuedDocId, issuedDocNo);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت فروش');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className={hero
          ? 'h-10 gap-1.5 text-sm rounded-lg px-4 font-semibold inline-flex items-center justify-center bg-white/15 text-white border border-white/30 hover:bg-white/25 transition-colors'
          : 'h-9 gap-1.5 text-white text-xs rounded-lg px-3 font-medium inline-flex items-center justify-center transition-opacity hover:opacity-90'
        }
          style={hero ? undefined : { background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }} title="ثبت فاکتور تأییدشده در یک مرحله">
          <Zap size={hero ? 15 : 13} /> {hero ? 'فاکتور فروش' : 'فروش سریع'}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap size={18} className="text-violet-600" /> فروش سریع (B2C)
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          {/* Customer */}
          <div className="border border-violet-100 rounded-xl p-3 space-y-2.5 bg-violet-50/30">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-gray-700">مشتری:</span>
              <button type="button" onClick={() => setCustomerMode('new')}
                className={`h-8 px-3 rounded-lg text-[11px] font-medium transition-colors ${customerMode === 'new' ? 'bg-violet-600 text-white' : 'bg-white border border-gray-200 text-gray-500'}`}>
                مشتری جدید (موبایل)
              </button>
              <button type="button" onClick={() => setCustomerMode('existing')}
                className={`h-8 px-3 rounded-lg text-[11px] font-medium transition-colors ${customerMode === 'existing' ? 'bg-violet-600 text-white' : 'bg-white border border-gray-200 text-gray-500'}`}>
                مشتری موجود
              </button>
            </div>
            {customerMode === 'new' ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">نام و نام خانوادگی <span className="text-red-500">*</span></label>
                  <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="مثلاً: خانم رضایی" className="h-9 rounded-lg text-xs" />
                </div>
                <div>
                  <label className="block text-[11px] font-medium text-gray-600 mb-1">موبایل <span className="text-red-500">*</span></label>
                  <Input value={customerMobile} onChange={(e) => setCustomerMobile(e.target.value)} placeholder="۰۹۱۲..." className="h-9 rounded-lg text-xs" dir="ltr" />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor="salesdocsdialogs-f456-6">انتخاب مشتری</label>
                <select id="salesdocsdialogs-f456-6" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                  <option value="">— انتخاب مشتری —</option>
                  {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* Items */}
          <div className="border border-gray-100 rounded-xl p-3 space-y-2">
            <p className="text-xs font-bold text-gray-700">کالاها</p>
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:gap-2 items-center">
                <select
                  className="col-span-4 h-9 rounded-lg text-xs border border-gray-200 bg-white px-1.5"
                  value={it.productCode || ''}
                  onChange={(e) => pickProduct(i, e.target.value)}
                >
                  <option value="">— انتخاب کالا / دستی —</option>
                  {products.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
                </select>
                <Input className="col-span-3 h-9 rounded-lg text-xs" aria-label="نام کالا" placeholder="نام کالا (دستی)" value={it.productName} onChange={(e) => updateItem(i, { productName: e.target.value, productCode: undefined })} />
                <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={1} aria-label="تعداد" placeholder="تعداد" value={it.quantity || ''} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={0} aria-label="قیمت (تومان)" placeholder="قیمت (تومان)" value={it.unitPrice || ''} onChange={(e) => updateItem(i, { unitPrice: Number(e.target.value) })} />
                <button type="button" onClick={() => setItems(items.filter((_, idx) => idx !== i))} aria-label={`حذف ردیف ${toPersianNum(i + 1)}`} className="w-8 h-8 rounded-lg text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0">
                  <X size={14} />
                </button>
              </div>
            ))}
            <button onClick={addItem} className="text-xs text-teal-700 hover:underline flex items-center gap-1">
              <Plus size={12} /> افزودن ردیف
            </button>
          </div>

          {/* Payment + VAT + points */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-gray-600 mb-1" htmlFor="salesdocsdialogs-f491-7">روش پرداخت</label>
              <select id="salesdocsdialogs-f491-7" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className="w-full h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                <option value="نقدی">نقدی</option>
                <option value="کارت‌خوان">کارت‌خوان</option>
                <option value="کارت به کارت">کارت به کارت</option>
                <option value="">بدون ثبت پرداخت</option>
              </select>
            </div>
            <label className="flex items-end gap-2 text-xs text-gray-700 cursor-pointer select-none pb-2">
              <input type="checkbox" checked={applyVat} onChange={(e) => setApplyVat(e.target.checked)} className="accent-teal-600 w-4 h-4" />
              اعمال مالیات ارزش افزوده
            </label>
            <label className="flex items-end gap-2 text-xs text-gray-700 cursor-pointer select-none pb-2">
              <input type="checkbox" checked={awardPoints} onChange={(e) => setAwardPoints(e.target.checked)} className="accent-amber-600 w-4 h-4" />
              امتیاز باشگاه مشتریان
            </label>
          </div>

          {/* Summary */}
          <div className="bg-gray-50 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
            <div className="text-xs text-gray-600 space-y-0.5">
              <p>جمع اقلام: <b>{formatCurrency(total)}</b></p>
              {applyVat && <p>مالیات (۹٪): <b>{formatCurrency(vatAmount)}</b></p>}
            </div>
            <div className="text-left">
              <p className="text-[11px] text-gray-400">مبلغ نهایی</p>
              <p className="text-lg font-bold text-gray-900">{formatCurrency(finalAmount)}</p>
              {willEarnPoints > 0 && (
                <p className="text-[11px] text-amber-600 font-medium flex items-center gap-1 mt-0.5">
                  <Gift size={10} /> {toPersianNum(willEarnPoints)} امتیاز باشگاه اعمال می‌شود
                </p>
              )}
            </div>
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-11 rounded-xl text-white font-semibold" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت فاکتور فروش سریع'}
          </Button>
          <p className="text-[11px] text-gray-400 text-center">
            فاکتور بلافاصله تأیید می‌شود؛ پرداخت کامل ثبت شده و امتیاز باشگاه به‌صورت خودکار محاسبه می‌شود (هر ۱۰۰ هزار تومان = ۱ امتیاز).
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== EDIT DOCUMENT DIALOG ====================
// v2.20.0 — the `update` API action existed since v1.5 but was unreachable
// from the UI: documents in draft/rejected could never be edited, so users
// had to cancel and recreate them to fix a typo. This dialog also carries
// `expectedVersion` (optimistic concurrency, v2.25.0): if another user saved
// the document in the meantime, the server answers 409 and the user is offered
// a reload instead of silently destroying the other user's work.
type EditableItem = {
  id?: string; // existing item id — undefined means a newly added row
  productId?: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  description: string;
  _delete?: boolean; // marked for deletion (strikethrough until submit)
};

export function EditDocDialog({
  open,
  onOpenChange,
  doc,
  centers,
  onEdited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doc: ApiSalesDocument;
  centers: Array<{ id: string; name: string }>;
  onEdited: () => void;
}) {
  const [centerId, setCenterId] = useState('');
  const [description, setDescription] = useState('');
  const [applyVat, setApplyVat] = useState(true);
  const [items, setItems] = useState<EditableItem[]>([]);
  // v2.25.0 — numeric CAS token (exact compare). v2.27.1: the deprecated
  // updatedAt fallback was removed server-side; version is the only token.
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const loadDetail = async () => {
    setLoading(true);
    try {
      const res = await apiCall<{ data: ApiSalesDocumentDetail }>('/api/sales-documents', 'get', { id: doc.id });
      const d = res.data;
      setCenterId(d.centerId || '');
      setDescription(d.description || '');
      setApplyVat((d.taxAmount || 0) > 0);
      setItems((d.items || []).map((it) => ({
        id: it.id,
        productId: undefined,
        productName: it.productName,
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        discount: it.discount,
        description: it.description || '',
      })));
      // v2.20.0 — the client's copy of the row version, sent back on save.
      // v2.25.0 — the exact numeric CAS token is the only token (v2.27.1).
      setExpectedVersion(typeof d.version === 'number' ? d.version : null);
      setError(null);
      setConflict(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت جزئیات سند');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      // Reset + fetch fresh state whenever the dialog opens (also used by
      // the conflict "reload" action).
      queueMicrotask(() => { void loadDetail(); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc.id]);

  const updateItem = (i: number, patch: Partial<EditableItem>) =>
    setItems(items.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));

  const addItem = () =>
    setItems([...items, { productName: '', quantity: 1, unitPrice: 0, discount: 0, description: '' }]);

  const markDeleted = (i: number) => updateItem(i, { _delete: true });
  const restore = (i: number) => {
    const next = [...items];
    const { _delete, ...rest } = next[i];
    void _delete;
    next[i] = rest;
    setItems(next);
  };

  const submit = async () => {
    setError(null);
    setConflict(false);

    // Client-side validation mirrors the server contract (v2.20.0).
    const active = items.filter((it) => !it._delete);
    if (active.length === 0) {
      setError('حداقل یک آیتم باید وارد شود.');
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it._delete) continue;
      if (!it.productName.trim()) {
        setError(`نام محصول در ردیف ${toPersianNum(i + 1)} الزامی است.`);
        return;
      }
      if (!it.quantity || it.quantity <= 0) {
        setError(`تعداد در ردیف ${toPersianNum(i + 1)} باید بیشتر از صفر باشد.`);
        return;
      }
      if (!it.unitPrice || it.unitPrice <= 0) {
        setError(`قیمت واحد در ردیف ${toPersianNum(i + 1)} باید بیشتر از صفر باشد.`);
        return;
      }
    }

    setBusy(true);
    try {
      await apiCall('/api/sales-documents', 'update', {
        id: doc.id,
        centerId: centerId || null,
        description,
        applyVat,
        items: items.map((it) => ({ ...it })),
        expectedVersion,
      });
      toast.success('سند با موفقیت ویرایش شد');
      onOpenChange(false);
      onEdited();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error ? e.message : 'خطا در ویرایش سند';
      if (status === 409) {
        // Optimistic-concurrency conflict — offer a reload of the server
        // state instead of overwriting the other user's changes.
        setConflict(true);
        setError(msg);
      } else {
        setError(msg);
      }
    }
    setBusy(false);
  };

  const total = items
    .filter((it) => !it._delete)
    .reduce((s, it) => s + it.quantity * it.unitPrice - it.discount, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader><DialogTitle>ویرایش سند {doc.documentNumber || ''}</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          {conflict && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="font-bold">تغییر همزمان شناسایی شد</p>
              <p>{error}</p>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs rounded-lg border-amber-300 text-amber-800 hover:bg-amber-100"
                disabled={loading || busy}
                onClick={() => { void loadDetail(); }}
              >
                <Undo2 size={12} /> بارگذاری آخرین نسخه سند
              </Button>
              <p className="text-[11px] text-amber-700">با بارگذاری مجدد، آخرین تغییرات ذخیره‌شدهٔ سند جایگزین فرم فعلی می‌شود.</p>
            </div>
          )}
          {!conflict && error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
          {loading ? (
            <p className="text-xs text-gray-400 text-center py-8">در حال دریافت سند...</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocsdialogs-f723-8">مرکز</label>
                  <select id="salesdocsdialogs-f723-8" value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
                    <option value="">بدون مرکز</option>
                    {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesdocsdialogs-f730-9">توضیحات</label>
                  <Input id="salesdocsdialogs-f730-9" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="یادداشت سند..." className="h-10 rounded-lg" />
                </div>
              </div>

              <div className="border border-gray-100 rounded-xl p-3 space-y-2">
                <p className="text-xs font-bold text-gray-700">اقلام سند</p>
                {items.map((it, i) => (
                  <div key={it.id || `new-${i}`} className={`grid grid-cols-1 sm:grid-cols-12 gap-2 items-center ${it._delete ? 'opacity-40' : ''}`}>
                    {it._delete ? (
                      <p className="col-span-10 text-xs text-gray-500 line-through">{it.productName} — برای حذف علامت خورده</p>
                    ) : (
                      <>
                        <Input className="col-span-4 h-9 rounded-lg text-xs" aria-label="نام محصول" placeholder="نام محصول" value={it.productName} onChange={(e) => updateItem(i, { productName: e.target.value })} />
                        <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={1} aria-label="تعداد" placeholder="تعداد" value={it.quantity || ''} onChange={(e) => updateItem(i, { quantity: Number(e.target.value) })} />
                        <Input className="col-span-3 h-9 rounded-lg text-xs" type="number" min={0} aria-label="قیمت واحد (ریال)" placeholder="قیمت واحد (ریال)" value={it.unitPrice || ''} onChange={(e) => updateItem(i, { unitPrice: Number(e.target.value) })} />
                        <Input className="col-span-2 h-9 rounded-lg text-xs" type="number" min={0} aria-label="تخفیف" placeholder="تخفیف" value={it.discount || ''} onChange={(e) => updateItem(i, { discount: Number(e.target.value) })} />
                      </>
                    )}
                    <div className="col-span-1 flex justify-end">
                      {it._delete ? (
                        <button onClick={() => restore(i)} className="text-[11px] text-emerald-700 hover:underline" title="بازگردانی">بازگردانی</button>
                      ) : (
                        <button onClick={() => markDeleted(i)} className="text-red-400 hover:text-red-600" title="حذف ردیف"><X size={14} /></button>
                      )}
                    </div>
                  </div>
                ))}
                <button onClick={addItem} className="text-xs text-teal-700 hover:underline flex items-center gap-1">
                  <Plus size={12} /> افزودن ردیف
                </button>
                <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                  <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={applyVat}
                      onChange={(e) => setApplyVat(e.target.checked)}
                      className="accent-teal-600 w-4 h-4"
                    />
                    اعمال مالیات بر ارزش افزوده
                  </label>
                  <p className="text-xs text-gray-500">
                    {applyVat ? `با مالیات: ${formatCurrency(Math.round(total * 1.09))}` : `بدون مالیات: ${formatCurrency(total)}`}
                  </p>
                </div>
              </div>

              <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                {busy ? 'در حال ذخیره...' : 'ذخیره تغییرات'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
