'use client';

import React, { useState, useMemo, useEffect } from 'react';
import { useTabAccess } from '@/components/access-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
// v2.35.1 (round 61) — keyboard-layout auto-fix (client-side filter twins)
import { searchVariants } from '@/lib/keyboard-layout';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Search, Plus, Edit3, Trash2, X, Check, Boxes, Tag, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import PaginationControls from '@/components/ui/pagination-controls';

// ==================== TYPES ====================
export type ProductTab = 'list' | 'specs' | 'categories';

interface Product {
  id: string;
  code: string;
  name: string;
  price: number;
  unit: string;
  active: boolean;
  source: string;
  category: string;
  specs: Record<string, string>;
  warrantyMonths: number;
  createdAt: string;
  /** v2.23.0 — optimistic-concurrency token for updates (stale → 409) */
  updatedAt?: string;
  usageCount: number;
  /** v2.25.0 — numeric CAS token (exact compare server-side). */
  version?: number;
  /** v2.31.9 — کد IRC (ثبت/پروانه ورود) printed on the Lian proforma. */
  ircCode?: string | null;
}

type SpecRow = { key: string; value: string };

// ==================== CONFIGS ====================
const CATEGORY_OPTIONS = [
  'تجهیزات پزشکی', 'تجهیزات صنعتی', 'مواد مصرفی', 'ملزومات آزمایشگاهی',
  'قطعات یدکی', 'نرم‌افزار و سرویس', 'سایر',
];

const UNITS = ['عدد', 'دستگاه', 'بسته', 'کیلوگرم', 'لیتر', 'متر', 'سرویس'];

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد ریال';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(1)) + ' میلیون ریال';
  return toPersianNum(Math.round(amount).toLocaleString('en-US')) + ' ریال';
}

function parseSpecs(raw: string | undefined | null): Record<string, string> {
  try {
    const p = JSON.parse(raw || '{}');
    return typeof p === 'object' && p ? p : {};
  } catch {
    return {};
  }
}

async function apiCall(action: string, payload: Record<string, unknown> = {}) {
  const res = await fetch('/api/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطای سرور'), { status: res.status });
  return data;
}

// ==================== SPEC EDITOR (dynamic key-value) ====================
function SpecEditor({ rows, onChange }: { rows: SpecRow[]; onChange: (rows: SpecRow[]) => void }) {
  const update = (i: number, patch: Partial<SpecRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            className="flex-1 h-9 rounded-lg text-xs"
            aria-label="نام مشخصه" placeholder="نام مشخصه (مثلاً توان مصرفی)"
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
          />
          <Input
            className="flex-1 h-9 rounded-lg text-xs"
            aria-label="مقدار مشخصه" placeholder="مقدار (مثلاً ۲۲۰ ولت)"
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            className="w-8 h-8 rounded-lg text-red-500 hover:bg-red-50 flex items-center justify-center shrink-0"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
        className="text-xs text-teal-700 hover:underline flex items-center gap-1"
      >
        <Plus size={12} /> افزودن مشخصهٔ فنی
      </button>
    </div>
  );
}

// ==================== PRODUCT FORM (create/edit) ====================
function ProductForm({ initial, onDone, onCancel }: {
  initial: Product | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState(initial?.code || '');
  const [name, setName] = useState(initial?.name || '');
  const [category, setCategory] = useState(initial?.category || CATEGORY_OPTIONS[0]);
  const [price, setPrice] = useState(initial?.price || 0);
  const [unit, setUnit] = useState(initial?.unit || 'عدد');
  const [active, setActive] = useState(initial?.active ?? true);
  const [warrantyMonths, setWarrantyMonths] = useState<number>(initial?.warrantyMonths ?? 12);
  // v2.31.9 — کد IRC (ثبت/ورود تجهیزات پزشکی): printed under the item
  // name on the Lian proforma format alongside کد کالا.
  const [ircCode, setIrcCode] = useState(initial?.ircCode || '');
  const [specRows, setSpecRows] = useState<SpecRow[]>(
    initial ? Object.entries(initial.specs).map(([key, value]) => ({ key, value })) : [{ key: '', value: '' }]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!code.trim() || !name.trim()) {
      setError('کد و نام محصول الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const specs = Object.fromEntries(
        specRows.filter((r) => r.key.trim() && r.value.trim()).map((r) => [r.key.trim(), r.value.trim()])
      );
      const payload = {
        code: code.trim(),
        name: name.trim(),
        category,
        price: Number(price) || 0,
        unit,
        active,
        specs,
        warrantyMonths: Number(warrantyMonths) || 0,
        ircCode: ircCode.trim() || null,
      };
      if (initial) {
        // v2.23.0 — send the concurrency token: a concurrent edit by
        // another user answers 409 with a Persian message instead of a
        // silent overwrite. v2.25.0 — the exact numeric CAS token is the
        // only token (v2.27.1: updatedAt fallback removed server-side).
        await apiCall('update', {
          id: initial.id,
          expectedVersion: typeof (initial as { version?: number }).version === 'number'
            ? (initial as { version?: number }).version
            : undefined,
          ...payload,
        });
        toast.success('محصول به‌روزرسانی شد');
      } else {
        await apiCall('create', payload);
        toast.success('محصول جدید ثبت شد');
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت محصول');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 mt-2">
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f199-1">کد محصول *</label>
          <Input id="salesproducts-f199-1" value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثلاً ICU-201" className="h-10 rounded-lg" dir="ltr" disabled={!!initial} />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f203-2">نام محصول *</label>
          <Input id="salesproducts-f203-2" value={name} onChange={(e) => setName(e.target.value)} placeholder="نام کامل محصول" className="h-10 rounded-lg" />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f210-3">دسته‌بندی</label>
          <select id="salesproducts-f210-3" value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
            {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f216-4">واحد</label>
          <select id="salesproducts-f216-4" value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f222-5">قیمت واحد (ریال)</label>
          <Input id="salesproducts-f222-5" value={price || ''} onChange={(e) => setPrice(Number(e.target.value))} type="number" min={0} className="h-10 rounded-lg" dir="ltr" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f226-6">گارانتی (ماه)</label>
          <Input id="salesproducts-f226-6" value={warrantyMonths} onChange={(e) => setWarrantyMonths(Number(e.target.value))} type="number" min={0} max={120} className="h-10 rounded-lg" dir="ltr" />
        </div>
      </div>

      {/* v2.31.9 — کد IRC: medical-device registration code (Lian proforma) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproducts-f229-7">کد IRC (ثبت / پروانه ورود)</label>
        <Input id="salesproducts-f229-7" value={ircCode} onChange={(e) => setIrcCode(e.target.value)} placeholder="مثلاً 9087404071772735 — خالی برای کالاهای بدون پروانه" className="h-10 rounded-lg" dir="ltr" />
      </div>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-bold text-gray-700 flex items-center gap-1.5">
            <Wrench size={13} /> مشخصات فنی محصول
          </p>
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="accent-teal-600" />
            فعال
          </label>
        </div>
        <SpecEditor rows={specRows} onChange={setSpecRows} />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={submit} disabled={busy} className="flex-1 h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : initial ? 'به‌روزرسانی محصول' : 'ثبت محصول'}
        </Button>
        <Button onClick={onCancel} variant="outline" className="h-10 rounded-lg">انصراف</Button>
      </div>
    </div>
  );
}

// ==================== PRODUCT DETAIL DIALOG ====================
function ProductDetail({ product, onEdit, onDelete }: { product: Product; onEdit: () => void; onDelete: () => void }) {
  const specEntries = Object.entries(product.specs);
  return (
    <div className="space-y-4">
      <div className="bg-gradient-to-l from-teal-50 to-white rounded-xl p-4 border border-teal-100">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-base font-bold text-gray-900">{product.name}</h3>
              <Badge variant={product.active ? 'default' : 'secondary'} className={product.active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-gray-100 text-gray-500'}>
                {product.active ? 'فعال' : 'غیرفعال'}
              </Badge>
            </div>
            <p className="text-xs text-gray-500" dir="ltr">{product.code}</p>
          </div>
          <div className="text-left">
            <p className="text-lg font-extrabold" style={{ color: '#1F8B7D' }}>{formatCurrency(product.price)}</p>
            <p className="text-[11px] text-gray-400">به ازای هر {product.unit}</p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="bg-gray-50 rounded-lg p-2.5 text-center border border-gray-100">
          <p className="text-xs font-bold text-gray-800">{product.category || '—'}</p>
          <p className="text-[11px] text-gray-400">دسته‌بندی</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5 text-center border border-gray-100">
          <p className="text-xs font-bold text-gray-800">{product.source || 'دستی'}</p>
          <p className="text-[11px] text-gray-400">منبع ثبت</p>
        </div>
        <div className="bg-gray-50 rounded-lg p-2.5 text-center border border-gray-100">
          <p className="text-xs font-bold text-gray-800">{toPersianNum(product.usageCount)}</p>
          <p className="text-[11px] text-gray-400">استفاده در اسناد</p>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-gray-600 mb-2 flex items-center gap-1.5">
          <Wrench size={13} /> مشخصات فنی
        </p>
        {specEntries.length === 0 ? (
          <p className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3 text-center">مشخصه‌ای ثبت نشده است</p>
        ) : (
          <div className="border border-gray-100 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {specEntries.map(([k, v], i) => (
                  <tr key={k} className={i % 2 ? 'bg-gray-50/60' : ''}>
                    <td className="py-2 px-3 text-gray-500 font-medium w-2/5">{k}</td>
                    <td className="py-2 px-3 text-gray-900 font-bold">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={onEdit} className="flex-1 h-9 gap-1.5 text-xs rounded-lg text-white" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          <Edit3 size={13} /> ویرایش محصول
        </Button>
        <Button onClick={onDelete} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg text-red-600 border-red-200 hover:bg-red-50">
          <Trash2 size={13} /> حذف
        </Button>
      </div>
    </div>
  );
}

// ==================== MAIN COMPONENT ====================
export default function SalesProducts({ activeTab: propTab, focusProductId }: { activeTab?: string; focusProductId?: string }) {
  // v2.26.0 — internal tabs are access-gated with the same menu-key
  // resolution the sidebar uses (products-list / products-specs / products-cats).
  const { isTabAllowed } = useTabAccess();
  const PRODUCT_TAB_MENU_KEYS: Record<string, string> = {
    list: 'products-list',
    specs: 'products-specs',
    categories: 'products-cats',
  };
  const [activeTab, setActiveTab] = useState<ProductTab>(propTab === 'categories' ? 'categories' : propTab === 'specs' ? 'specs' : 'list');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [detail, setDetail] = useState<Product | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 12;

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', pageSize: 500 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت محصولات');
      setProducts((data.items || []).map((p: Record<string, unknown>) => ({
        id: p.id as string,
        code: p.code as string,
        name: p.name as string,
        price: p.price as number,
        unit: p.unit as string,
        active: p.active as boolean,
        source: p.source as string,
        category: (p.category as string) || '',
        specs: parseSpecs(p.specs as string),
        createdAt: p.createdAt as string,
        usageCount: (p.usageCount as number) || (p._count as { salesDocumentItems?: number } | undefined)?.salesDocumentItems || 0,
        warrantyMonths: (p.warrantyMonths as number) ?? 12,
        updatedAt: (p.updatedAt as string) || undefined, // v2.23.0 — concurrency token
      })));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت محصولات');
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(load);
  }, []);

  // v2.26.0 — global-search deep link: once products load, open the exact
  // product's detail dialog instead of just landing on the list.
  useEffect(() => {
    if (!focusProductId || loading || products.length === 0) return;
    queueMicrotask(() => {
      const target = products.find((p) => p.id === focusProductId);
      if (target) {
        setDetail(target);
        setShowDetail(true);
      }
    });
  }, [focusProductId, loading, products]);

  // v2.26.0 — destructive action confirmation moved from window.confirm to
  // the standard AlertDialog (PHASE 33); raw alert() → Persian toast.
  const [pendingDelete, setPendingDelete] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = (p: Product) => setPendingDelete(p);

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await apiCall('delete', { id: pendingDelete.id });
      toast.success('محصول حذف شد');
      setShowDetail(false);
      setPendingDelete(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف محصول');
    } finally {
      setDeleting(false);
    }
  };

  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);

  const filtered = useMemo(() => products.filter((p) => {
    if (search.trim()) {
      // v2.35.1 (round 61) — client-side filter matches the query's Persian-
      // layout twins too («shk» → «سان»); Latin codes keep matching via the
      // raw variant.
      const qs = searchVariants(search).map((v) => v.toLowerCase());
      if (!qs.some((v) => p.code.toLowerCase().includes(v) || p.name.includes(v))) return false;
      const specStr = Object.entries(p.specs).map(([k, v]) => `${k}:${v}`).join(' ');
      if (!qs.some((v) => specStr.includes(v))) return false;
    }
    if (filterCategory !== 'all' && p.category !== filterCategory) return false;
    if (filterStatus !== 'all' && String(p.active) !== filterStatus) return false;
    return true;
  }), [products, search, filterCategory, filterStatus]);

  // Client-side pagination over filtered list
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const activeCount = products.filter((p) => p.active).length;
  const withSpecs = products.filter((p) => Object.keys(p.specs).length > 0).length;

  const stats = [
    { label: 'کل محصولات', value: toPersianNum(products.length), icon: <Boxes size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'فعال', value: toPersianNum(activeCount), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'دارای مشخصات فنی', value: toPersianNum(withSpecs), icon: <Wrench size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'دسته‌بندی‌ها', value: toPersianNum(categories.length), icon: <Tag size={16} />, color: '#d97706', bg: '#fffbeb' },
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
            <p className="text-lg lg:text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Tabs + toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1" role="tablist" aria-label="نماهای محصولات">
            {[
              { key: 'list' as ProductTab, label: 'لیست محصولات', icon: <Boxes size={14} /> },
              { key: 'specs' as ProductTab, label: 'مشخصات فنی', icon: <Wrench size={14} /> },
              { key: 'categories' as ProductTab, label: 'دسته‌بندی', icon: <Tag size={14} /> },
            ].filter((t) => isTabAllowed(PRODUCT_TAB_MENU_KEYS[t.key])).map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all whitespace-nowrap min-h-[36px] ${
                  activeTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو نام، کد یا مشخصه..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
            </div>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
              <option value="all">همه دسته‌ها</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
              <option value="all">همه</option>
              <option value="true">فعال</option>
              <option value="false">غیرفعال</option>
            </select>
            <Dialog open={showForm} onOpenChange={(open) => { setShowForm(open); if (!open) setEditing(null); }}>
              <DialogContent className="max-w-[min(36rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
                <DialogHeader>
                  <DialogTitle>{editing ? 'ویرایش محصول' : 'ثبت محصول جدید'}</DialogTitle>
                </DialogHeader>
                <ProductForm
                  initial={editing}
                  onDone={() => { setShowForm(false); setEditing(null); load(); }}
                  onCancel={() => { setShowForm(false); setEditing(null); }}
                />
              </DialogContent>
              <button
                onClick={() => { setEditing(null); setShowForm(true); }}
                className="h-9 gap-1.5 text-white text-xs rounded-lg px-3 font-medium flex items-center shrink-0"
                style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
              >
                <Plus size={13} /> محصول جدید
              </button>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
          <div className="w-8 h-8 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-400">در حال دریافت محصولات...</p>
        </div>
      ) : loadError ? (
        <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
          <p className="text-sm text-red-600 mb-3">{loadError}</p>
          <button onClick={load} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
        </div>
      ) : activeTab === 'list' ? (
        filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <Boxes size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">محصولی یافت نشد</p>
          </div>
        ) : (
          <>
          <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 text-gray-500 border-b border-gray-100">
                  <th className="py-3 px-3 text-right font-bold">کد</th>
                  <th className="py-3 px-3 text-right font-bold">نام محصول</th>
                  <th className="py-3 px-3 text-right font-bold">دسته</th>
                  <th className="py-3 px-3 text-right font-bold">قیمت</th>
                  <th className="py-3 px-3 text-center font-bold">مشخصات</th>
                  <th className="py-3 px-3 text-center font-bold">وضعیت</th>
                  <th className="py-3 px-3 text-center font-bold">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((p, i) => (
                  <tr key={p.id} className={`border-b border-gray-50 hover:bg-gray-50/50 transition-colors animate-fade-in opacity-0 ${i % 2 ? 'bg-gray-50/30' : ''}`} style={{ animationDelay: `${i * 30}ms` }}>
                    <td className="py-3 px-3 font-mono text-gray-600 text-right" dir="ltr">{p.code}</td>
                    <td className="py-3 px-3">
                      <button onClick={() => { setDetail(p); setShowDetail(true); }} className="font-bold text-gray-900 hover:text-teal-700 transition-colors text-right">
                        {p.name}
                      </button>
                    </td>
                    <td className="py-3 px-3">
                      {p.category ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{p.category}</span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-3 px-3 text-gray-800 font-bold">{formatCurrency(p.price)}</td>
                    <td className="py-3 px-3 text-center">
                      {Object.keys(p.specs).length > 0 ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-teal-50 text-teal-700">{toPersianNum(Object.keys(p.specs).length)} مورد</span>
                      ) : <span className="text-gray-300 text-[11px]">بدون مشخصه</span>}
                    </td>
                    <td className="py-3 px-3 text-center">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${p.active ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'}`}>
                        {p.active ? 'فعال' : 'غیرفعال'}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <div className="flex items-center justify-center gap-1">
                        <button onClick={() => { setEditing(p); setShowForm(true); }} className="w-7 h-7 rounded-lg hover:bg-teal-50 text-teal-600 flex items-center justify-center" title="ویرایش">
                          <Edit3 size={13} />
                        </button>
                        <button onClick={() => handleDelete(p)} className="w-7 h-7 rounded-lg hover:bg-red-50 text-red-500 flex items-center justify-center" title="حذف">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls
            page={safePage}
            totalPages={totalPages}
            total={filtered.length}
            onPageChange={setPage}
            label="محصول"
          />
          </>
        )
      ) : activeTab === 'specs' ? (
        /* Specs comparison view */
        filtered.length === 0 ? (
          <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
            <Wrench size={32} className="mx-auto mb-2 opacity-40" />
            <p className="text-sm">محصولی برای نمایش مشخصات وجود ندارد</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {filtered.map((p, i) => (
              <div key={p.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 40}ms` }}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <h4 className="text-sm font-bold text-gray-900">{p.name}</h4>
                    <p className="text-[11px] text-gray-400" dir="ltr">{p.code}</p>
                  </div>
                  <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{p.category || '—'}</span>
                </div>
                {Object.keys(p.specs).length === 0 ? (
                  <p className="text-[11px] text-gray-300 bg-gray-50 rounded-lg p-2 text-center">مشخصه‌ای ثبت نشده</p>
                ) : (
                  <div className="space-y-1">
                    {Object.entries(p.specs).slice(0, 5).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between text-[11px] border-b border-gray-50 pb-1">
                        <span className="text-gray-500">{k}</span>
                        <span className="text-gray-900 font-bold">{v}</span>
                      </div>
                    ))}
                    {Object.keys(p.specs).length > 5 && (
                      <button onClick={() => { setDetail(p); setShowDetail(true); }} className="text-[11px] text-teal-700 hover:underline">
                        + {toPersianNum(Object.keys(p.specs).length - 5)} مشخصهٔ دیگر
                      </button>
                    )}
                  </div>
                )}
                <button onClick={() => { setEditing(p); setShowForm(true); }} className="mt-3 w-full h-8 rounded-lg border border-teal-200 text-teal-700 text-xs font-medium hover:bg-teal-50 transition-colors flex items-center justify-center gap-1">
                  <Edit3 size={12} /> ویرایش مشخصات
                </button>
              </div>
            ))}
          </div>
        )
      ) : (
        /* Categories view */
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {(categories.length ? categories : CATEGORY_OPTIONS).map((cat, i) => {
            const items = products.filter((p) => p.category === cat);
            return (
              <div key={cat} className="bg-white rounded-xl border border-gray-100 p-4 text-center hover:shadow-sm transition-all animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="w-12 h-12 rounded-xl mx-auto mb-3 flex items-center justify-center" style={{ background: '#eef2ff', color: '#6366f1' }}>
                  <Tag size={22} />
                </div>
                <h4 className="text-sm font-bold text-gray-900 mb-1">{cat}</h4>
                <p className="text-2xl font-extrabold text-gray-800">{toPersianNum(items.length)}</p>
                <p className="text-[11px] text-gray-400 mb-2">محصول ثبت‌شده</p>
                <button onClick={() => setFilterCategory(cat)} className="text-[11px] text-teal-700 hover:underline">
                  مشاهدهٔ محصولات
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail dialog */}
      <Dialog open={showDetail} onOpenChange={setShowDetail}>
        {detail && (
          <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]" dir="rtl">
            <DialogHeader><DialogTitle>جزئیات محصول</DialogTitle></DialogHeader>
            <ProductDetail
              product={detail}
              onEdit={() => { setShowDetail(false); setEditing(detail); setShowForm(true); }}
              onDelete={() => handleDelete(detail)}
            />
          </DialogContent>
        )}
      </Dialog>

      {/* v2.26.0 — destructive confirmation (was window.confirm) */}
      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف محصول</AlertDialogTitle>
            <AlertDialogDescription>
              حذف محصول «{pendingDelete?.name}» قابل بازگشت نیست. مطمئن هستید؟
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>انصراف</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => { e.preventDefault(); void confirmDelete(); }}
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
