'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Search, Plus, HandCoins, Package, Percent, Layers, Trash2, Pencil, Calculator, Loader2, RefreshCw, Handshake, CheckCircle2, XCircle } from 'lucide-react';

// ════════════════════════════════════════════════════════════════
//  PARTNER PRICING — لیست قیمت همکاران (بازرگانی B2B)
//  قیمت عمده/پلکانی به ازای هر محصول + درصد کمیسیون
//  ماشین‌حساب قیمت: انتخاب محصول، تعداد و مشتری همکار → قیمت نهایی
// ════════════════════════════════════════════════════════════════

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد تومان';
  if (amount >= 1_000_000) return toPersianNum(Math.round(amount / 1_000_000)) + ' میلیون تومان';
  return toPersianNum(amount.toLocaleString()) + ' تومان';
}

interface PartnerPriceRule {
  id: string;
  productCode: string;
  productName?: string;
  publicPrice?: number;
  unit?: string;
  minQty: number;
  price: number;
  discountPercent: number;
  commissionPercent: number;
  note: string;
  active: boolean;
  /** v2.23.0 — optimistic-concurrency token for updates (stale → 409) */
  updatedAt?: string;
}

interface ApiProduct {
  id: string;
  code: string;
  name: string;
  price: number;
  unit: string;
  active: boolean;
}

interface ApiCenter {
  id: string;
  name: string;
  segment: string | null;
  commissionPercent: number | null;
}

interface ResolveResult {
  productCode: string;
  productName: string;
  quantity: number;
  publicPrice: number;
  partnerPrice: number | null;
  appliedPrice: number;
  discountPercent: number;
  tierMinQty: number | null;
  commissionPercent: number;
  centerName: string;
  isPartner: boolean;
  isPartnerPrice: boolean;
  savings: number;
}

// ── Rule create/edit dialog ──
function RuleDialog({ open, onOpenChange, onDone, products, editing }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
  products: ApiProduct[];
  editing: PartnerPriceRule | null;
}) {
  const [productCode, setProductCode] = useState('');
  const [minQty, setMinQty] = useState('1');
  const [price, setPrice] = useState('');
  const [commissionPercent, setCommissionPercent] = useState('0');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Prefill/reset the form asynchronously so the effect body itself stays
      // free of synchronous setState (react-hooks/set-state-in-effect).
      queueMicrotask(() => {
        if (editing) {
          setProductCode(editing.productCode);
          setMinQty(String(editing.minQty));
          setPrice(String(editing.price));
          setCommissionPercent(String(editing.commissionPercent));
          setNote(editing.note || '');
        } else {
          setProductCode(''); setMinQty('1'); setPrice(''); setCommissionPercent('0'); setNote('');
        }
        setError(null);
      });
    }
  }, [open, editing]);

  const selectedProduct = products.find((p) => p.code === productCode);

  const submit = async () => {
    if (!productCode) { setError('محصول را انتخاب کنید.'); return; }
    if (!price || Number(price) <= 0) { setError('قیمت همکار باید بیشتر از صفر باشد.'); return; }
    if (Number(minQty) < 1) { setError('حداقل تعداد باید ۱ یا بیشتر باشد.'); return; }
    setBusy(true);
    setError(null);
    try {
      const payload = editing
        ? {
            action: 'update', id: editing.id, price: Number(price), minQty: Number(minQty),
            commissionPercent: Number(commissionPercent) || 0, note,
            // v2.25.0 — exact numeric CAS token (v2.27.1: the updatedAt
            // fallback is removed server-side; version is always loaded)
            expectedVersion: typeof (editing as { version?: number }).version === 'number'
              ? (editing as { version?: number }).version
              : undefined,
          }
        : { action: 'create', productCode, minQty: Number(minQty), price: Number(price), commissionPercent: Number(commissionPercent) || 0, note };
      const res = await fetch('/api/partner-pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت');
      toast.success(data.message || 'ثبت شد');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HandCoins size={18} className="text-amber-600" />
            {editing ? `ویرایش پلکان — ${editing.productName || editing.productCode}` : 'قیمت همکار جدید (پلکان)'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          {!editing && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="partnerpricing-f172-1">محصول</label>
              <select id="partnerpricing-f172-1" value={productCode} onChange={(e) => setProductCode(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
                <option value="">— انتخاب محصول —</option>
                {products.filter((p) => p.active).map((p) => (
                  <option key={p.code} value={p.code}>{p.name} ({p.code})</option>
                ))}
              </select>
              {selectedProduct && (
                <p className="text-[11px] text-gray-400 mt-1">قیمت عمومی: {formatCurrency(selectedProduct.price)}</p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="partnerpricing-f187-2">حداقل تعداد (پلکان)</label>
              <Input id="partnerpricing-f187-2" value={minQty} onChange={(e) => setMinQty(e.target.value)} dir="ltr" inputMode="decimal" className="h-10 rounded-lg" placeholder="مثلاً ۱۰" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="partnerpricing-f191-3">قیمت همکار (تومان)</label>
              <Input id="partnerpricing-f191-3" value={price} onChange={(e) => setPrice(e.target.value)} dir="ltr" inputMode="decimal" className="h-10 rounded-lg" placeholder="مثلاً 850000" />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5 flex items-center gap-1">
              <Percent size={13} /> درصد کمیسیون همکار (۰ تا ۱۰۰)
            </label>
            <Input value={commissionPercent} onChange={(e) => setCommissionPercent(e.target.value)} dir="ltr" inputMode="decimal" className="h-10 rounded-lg" placeholder="مثلاً ۵" />
          </div>

          {selectedProduct && Number(price) > 0 && (
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-2.5 text-center">
              <p className="text-[11px] text-gray-600">
                تخفیف نسبت به قیمت عمومی:
                <span className="font-bold text-amber-700 mr-1">
                  {toPersianNum(Math.max(0, Math.round((1 - Number(price) / (selectedProduct.price || 1)) * 100)))}٪
                </span>
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="partnerpricing-f215-4">توضیح (اختیاری)</label>
            <Textarea id="partnerpricing-f215-4" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="rounded-lg resize-none" placeholder="مثلاً: فقط برای همکاران طلایی" />
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-11 rounded-xl text-white font-semibold" style={{ background: 'linear-gradient(135deg, #b45309, #92400e)' }}>
            {busy ? 'در حال ثبت...' : editing ? 'ذخیرهٔ تغییرات' : 'ثبت قیمت همکار'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Price calculator ──
function PriceCalculator({ products, partnerCenters }: { products: ApiProduct[]; partnerCenters: ApiCenter[] }) {
  const [productCode, setProductCode] = useState('');
  const [quantity, setQuantity] = useState('10');
  const [centerId, setCenterId] = useState('');
  const [result, setResult] = useState<ResolveResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calc = async () => {
    if (!productCode) { setError('محصول را انتخاب کنید.'); return; }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/partner-pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', productCode, quantity: Number(quantity) || 1, centerId: centerId || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در محاسبه');
      setResult(data.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در محاسبه');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3" dir="rtl">
      <h4 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
        <Calculator size={15} className="text-amber-600" /> ماشین‌حساب قیمت همکار
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select value={productCode} onChange={(e) => setProductCode(e.target.value)} className="h-10 rounded-lg border border-gray-200 px-2 text-xs bg-white">
          <option value="">— محصول —</option>
          {products.filter((p) => p.active).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
        <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} dir="ltr" inputMode="decimal" className="h-10 rounded-lg text-xs" placeholder="تعداد" />
        <select value={centerId} onChange={(e) => setCenterId(e.target.value)} className="h-10 rounded-lg border border-gray-200 px-2 text-xs bg-white">
          <option value="">— مشتری (اختیاری) —</option>
          {partnerCenters.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.segment === 'partner' ? ' (همکار)' : ''}</option>
          ))}
        </select>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
      <Button onClick={calc} disabled={busy} className="h-10 gap-1.5 text-white text-sm rounded-lg w-full sm:w-auto px-5" style={{ background: 'linear-gradient(135deg, #b45309, #92400e)' }}>
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Calculator size={14} />} محاسبهٔ قیمت
      </Button>

      {result && (
        <div className="bg-gradient-to-l from-amber-50 to-white border border-amber-100 rounded-xl p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">قیمت عمومی</p>
            <p className="text-sm font-bold text-gray-500 line-through decoration-red-300">{formatCurrency(result.publicPrice)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">قیمت همکار {result.tierMinQty ? `(از ${toPersianNum(result.tierMinQty)} عدد)` : ''}</p>
            <p className="text-sm font-bold text-amber-700">{formatCurrency(result.appliedPrice)}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">تخفیف</p>
            <p className="text-sm font-bold text-green-600">{toPersianNum(result.discountPercent)}٪{result.savings > 0 ? ` · ${formatCurrency(result.savings)} صرفه‌جویی` : ''}</p>
          </div>
          <div>
            <p className="text-[11px] text-gray-400 mb-0.5">کمیسیون {result.centerName ? `(${result.centerName})` : ''}</p>
            <p className="text-sm font-bold text-gray-900 flex items-center gap-1">
              {result.commissionPercent > 0 ? (
                <><Percent size={12} className="text-amber-600" /> {toPersianNum(result.commissionPercent)}</>
              ) : '—'}
            </p>
          </div>
          {!result.isPartnerPrice && (
            <p className="col-span-full text-[11px] text-gray-400 flex items-center gap-1">
              <XCircle size={11} /> برای این تعداد پلکانی تعریف نشده — قیمت عمومی اعمال شد.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ════════════════════════════════════════════════════════════════
export default function PartnerPricing() {
  const [rules, setRules] = useState<PartnerPriceRule[]>([]);
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [partnerCenters, setPartnerCenters] = useState<ApiCenter[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<PartnerPriceRule | null>(null);
  const [stats, setStats] = useState<{ totalRules: number; activeRules: number; productCount: number; partnerCenters: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, productsRes, statsRes] = await Promise.all([
        fetch('/api/partner-pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list' }),
        }),
        fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list', pageSize: 200 }),
        }),
        fetch('/api/partner-pricing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'stats' }),
        }),
      ]);
      const rulesData = await rulesRes.json();
      const productsData = await productsRes.json();
      const statsData = await statsRes.json();
      if (!rulesRes.ok) throw new Error(rulesData.error || 'خطا در دریافت قیمت‌ها');
      setRules(Array.isArray(rulesData.data) ? rulesData.data : []);
      const prods = (productsData.items || []).map((p: ApiProduct) => ({ ...p }));
      setProducts(prods);
      setStats(statsData.data || null);

      // بارگذاری مراکز همکار برای ماشین‌حساب
      const centersRes = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', pageSize: 100, segment: 'partner' }),
      });
      const centersData = await centersRes.json();
      if (centersRes.ok && Array.isArray(centersData.items)) {
        setPartnerCenters(centersData.items.map((c: ApiCenter) => ({
          id: c.id, name: c.name, segment: c.segment ?? null, commissionPercent: c.commissionPercent ?? null,
        })));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در دریافت داده‌ها');
    } finally {
      setLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  // گروه‌بندی قواعد بر اساس محصول
  const grouped = useMemo(() => {
    const filtered = rules.filter((r) => {
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (r.productName || '').includes(q) || r.productCode.toLowerCase().includes(q) || r.note.includes(q);
    });
    const map = new Map<string, PartnerPriceRule[]>();
    for (const r of filtered) {
      const list = map.get(r.productCode) || [];
      list.push(r);
      map.set(r.productCode, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rules, search]);

  // v2.26.0 — window.confirm replaced with the standard AlertDialog (PHASE 33).
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const deleteRule = (id: string) => setPendingDeleteId(id);

  const confirmDeleteRule = async () => {
    if (!pendingDeleteId || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/partner-pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: pendingDeleteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در حذف');
      toast.success(data.message || 'حذف شد');
      setPendingDeleteId(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف');
    } finally {
      setDeleting(false);
    }
  };

  const toggleActive = async (rule: PartnerPriceRule) => {
    try {
      const res = await fetch('/api/partner-pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update', id: rule.id, active: !rule.active,
          // v2.25.0 — exact numeric CAS token (v2.27.1: fallback removed)
          expectedVersion: typeof (rule as { version?: number }).version === 'number'
            ? (rule as { version?: number }).version
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا');
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا');
    }
  };

  return (
    <div className="space-y-4" dir="rtl">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-100 text-amber-600"><Layers size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">پلکان‌های قیمت</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-gray-900">{toPersianNum(stats?.totalRules ?? rules.length)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">پلکان‌ها</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-green-100 text-green-600"><CheckCircle2 size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">فعال</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-green-600">{toPersianNum(stats?.activeRules ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">فعال</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-teal-100 text-teal-600"><Package size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">محصولات با قیمت همکار</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-teal-600">{toPersianNum(stats?.productCount ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">محصولات</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-orange-100 text-orange-700"><Handshake size={16} /></div>
            <span className="text-[11px] text-gray-400 hidden lg:block">مراکز همکار</span>
          </div>
          <p className="text-lg lg:text-xl font-bold text-orange-700">{toPersianNum(stats?.partnerCenters ?? 0)}</p>
          <p className="text-[11px] text-gray-400 lg:hidden">همکاران</p>
        </div>
      </div>

      {/* Calculator */}
      <PriceCalculator products={products} partnerCenters={partnerCenters} />

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی محصول..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={load} variant="outline" size="sm" className="h-9 gap-1.5 text-xs rounded-lg">
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> به‌روزرسانی
            </Button>
            <Button onClick={() => setShowNew(true)} className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #b45309, #92400e)' }}>
              <Plus size={13} /> پلکان قیمت جدید
            </Button>
          </div>
        </div>
      </div>

      {/* Rules grouped by product */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-amber-600" />
          <p className="text-sm text-gray-400">در حال دریافت لیست قیمت‌ها...</p>
        </div>
      ) : grouped.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
          <HandCoins size={36} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">هنوز قیمت همکاری تعریف نشده است</p>
          <p className="text-[11px] mt-1">برای هر محصول چند پلکان (از ۱ عدد، از ۱۰ عدد، از ۵۰ عدد...) با قیمت و کمیسیون جداگانه تعریف کنید</p>
        </div>
      ) : (
        grouped.map(([code, productRules]) => (
          <div key={code} className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <div className="p-3 border-b border-gray-50 flex items-center gap-3 bg-amber-50/50">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-amber-100 text-amber-700 shrink-0">
                <Package size={16} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="text-sm font-bold text-gray-900 truncate">{productRules[0].productName || code}</h4>
                <p className="text-[11px] text-gray-400" dir="ltr">{code} · قیمت عمومی: {formatCurrency(productRules[0].publicPrice || 0)}</p>
              </div>
              <span className="text-[11px] px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-bold shrink-0">
                {toPersianNum(productRules.length)} پلکان
              </span>
            </div>
            <div className="divide-y divide-gray-50">
              {productRules.sort((a, b) => a.minQty - b.minQty).map((rule) => {
                const discountVsPublic = rule.publicPrice ? Math.max(0, Math.round((1 - rule.price / rule.publicPrice) * 100)) : 0;
                return (
                  <div key={rule.id} className="flex items-center gap-3 p-3 group/rule">
                    <div className="w-14 text-center shrink-0">
                      <p className="text-[11px] text-gray-400">از</p>
                      <p className="text-sm font-bold text-gray-900">{toPersianNum(rule.minQty)}</p>
                      <p className="text-[11px] text-gray-400">{rule.unit || 'عدد'}</p>
                    </div>
                    <div className="flex-1 min-w-0 grid grid-cols-2 md:grid-cols-4 gap-2">
                      <div>
                        <p className="text-[11px] text-gray-400">قیمت همکار</p>
                        <p className="text-xs font-bold text-amber-700">{formatCurrency(rule.price)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400">تخفیف</p>
                        <p className="text-xs font-bold text-green-600">{toPersianNum(discountVsPublic)}٪</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400">کمیسیون</p>
                        <p className="text-xs font-bold text-gray-700">{rule.commissionPercent > 0 ? `${toPersianNum(rule.commissionPercent)}٪` : '—'}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-gray-400">وضعیت</p>
                        <button onClick={() => toggleActive(rule)} className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${rule.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                          {rule.active ? 'فعال' : 'غیرفعال'}
                        </button>
                      </div>
                    </div>
                    {rule.note && <p className="hidden md:block text-[11px] text-gray-400 max-w-[120px] truncate shrink-0">{rule.note}</p>}
                    <div className="flex items-center gap-1 shrink-0 opacity-100 md:opacity-0 md:group-hover/rule:opacity-100 transition-opacity">
                      <button onClick={() => { setEditing(rule); }} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600" title="ویرایش">
                        <Pencil size={13} />
                      </button>
                      <button onClick={() => deleteRule(rule.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500" title="حذف">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      <RuleDialog open={showNew} onOpenChange={setShowNew} onDone={load} products={products} editing={null} />
      <RuleDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} onDone={() => { setEditing(null); load(); }} products={products} editing={editing} />

      {/* v2.26.0 — destructive confirmation (was window.confirm) */}
      <AlertDialog open={Boolean(pendingDeleteId)} onOpenChange={(open) => { if (!open) setPendingDeleteId(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف پلکان قیمت</AlertDialogTitle>
            <AlertDialogDescription>
              این پلکان قیمت حذف شود؟ این عمل قابل بازگشت نیست.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>انصراف</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void confirmDeleteRule(); }}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? 'در حال حذف...' : 'حذف قطعی'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
