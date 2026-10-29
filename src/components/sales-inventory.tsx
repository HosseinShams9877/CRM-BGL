'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useTabAccess } from '@/components/access-context';
import { HesabfaInventory } from '@/components/hesabfa-inventory';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Search, Plus, Package, Route, AlertTriangle, TrendingDown, TrendingUp, Box, Hash, Edit3, RefreshCw, Truck, ArrowRightLeft, Warehouse } from 'lucide-react';

// ==================== TYPES ====================
type InvTab = 'stock' | 'movements' | 'hesabfa';
type InvStatus = 'in-stock' | 'low-stock' | 'out-of-stock' | 'reserved' | 'incoming';
type MovementType = 'in' | 'out' | 'transfer' | 'return' | 'adjust';

interface InventoryItem {
  id: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  currentStock: number;
  reservedStock: number;
  availableStock: number;
  minStock: number;
  status: InvStatus;
  warehouse: string;
  lastInDate: string;
  lastOutDate: string;
  avgPrice: number;
  totalValue: number;
}

interface StockMovement {
  id: string;
  date: string;
  time: string;
  type: MovementType;
  productCode: string;
  productName: string;
  quantity: number;
  unit: string;
  fromWarehouse: string;
  toWarehouse: string;
  relatedDoc: string;
  personName: string;
  notes: string;
}

// ==================== CONFIGS ====================
const STATUS_CFG: Record<InvStatus, { label: string; color: string; bg: string }> = {
  'in-stock': { label: 'موجود', color: '#059669', bg: '#ecfdf5' },
  'low-stock': { label: 'کمبود', color: '#d97706', bg: '#fffbeb' },
  'out-of-stock': { label: 'ناموجود', color: '#dc2626', bg: '#fef2f2' },
  'reserved': { label: 'رزرو شده', color: '#6366f1', bg: '#eef2ff' },
  'incoming': { label: 'در راه', color: '#0891b2', bg: '#ecfeff' },
};

const MOVEMENT_CFG: Record<MovementType, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  'in': { label: 'ورود', color: '#059669', bg: '#ecfdf5', icon: <TrendingUp size={12} /> },
  'out': { label: 'خروج', color: '#dc2626', bg: '#fef2f2', icon: <TrendingDown size={12} /> },
  'transfer': { label: 'انتقال', color: '#6366f1', bg: '#eef2ff', icon: <ArrowRightLeft size={12} /> },
  'return': { label: 'برگشت', color: '#d97706', bg: '#fffbeb', icon: <RefreshCw size={12} /> },
  'adjust': { label: 'تعدیل', color: '#7c3aed', bg: '#f5f3ff', icon: <Edit3 size={12} /> },
};

// ==================== REAL DATA ADAPTER ====================
/** Serial shape returned by /api/inventory (list action). */
interface ApiSerial {
  id: string;
  productCode: string | null;
  serialNumber: string;
  status: 'available' | 'sold' | 'returned' | 'defective';
  centerId: string | null;
  notes: string;
  soldAt: string | null;
  createdAt: string;
  /** v2.34.12 — owning company (per-company warehouses); null = shared stock. */
  company?: { slug: string; name: string } | null;
}

// v2.34.12 — legal names of the per-company warehouses (fixed roster).
const COMPANY_WAREHOUSE_NAMES: Record<string, string> = {
  bgl: 'بهبود گستر لیام ایرانیان',
  bazargani: 'بهبود گستر لیان ایرانیان',
  aria: 'آریا مدیکال',
};

/** Convert an inventory serial into a stock item row (aggregated per product).
 *  v2.16.0 — «موجودی فعلی» counts only serials that are physically in the
 *  warehouse and sellable (available + returned). The old code used
 *  list.length, which counted SOLD serials too — 1 in stock + 2 sold
 *  displayed as a stock of 3. */
function serialsToItems(serials: ApiSerial[]): InventoryItem[] {
  const byProduct = new Map<string, ApiSerial[]>();
  for (const s of serials) {
    const key = s.productCode || 'بدون کد';
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(s);
  }
  return [...byProduct.entries()].map(([code, list]) => {
    const available = list.filter((s) => s.status === 'available').length;
    const returned = list.filter((s) => s.status === 'returned').length;
    const defective = list.filter((s) => s.status === 'defective').length;
    const onShelf = available + returned; // sellable stock in the warehouse
    const status: InvStatus = available === 0 ? 'out-of-stock' : defective > 0 ? 'low-stock' : 'in-stock';
    const lastIn = list.reduce((m, s) => (s.createdAt > m ? s.createdAt : m), list[0]?.createdAt || '');
    const lastOut = list.reduce((m, s) => ((s.soldAt || '') > m ? (s.soldAt || '') : m), '');
    // v2.34.12 — warehouse owner label from the serial's company stamp
    // (all serials of one product normally share it; a mixed row = چند انبار).
    const owners = [...new Set(list.map((s) => s.company?.name).filter(Boolean))] as string[];
    const warehouseLabel = owners.length === 1 ? owners[0] : owners.length > 1 ? 'چند انبار' : 'انبار مشترک';
    return {
      id: code,
      code,
      name: list[0]?.notes || code,
      category: 'سریال‌محور',
      unit: 'دستگاه',
      currentStock: onShelf,
      reservedStock: 0,
      availableStock: available,
      minStock: 1,
      status,
      warehouse: warehouseLabel,
      lastInDate: (lastIn || '').slice(0, 10),
      lastOutDate: (lastOut || '').slice(0, 10),
      avgPrice: 0,
      totalValue: 0,
    };
  });
}

/** Convert serials into movement rows (legacy StockMovement shape). */
function serialsToMovements(serials: ApiSerial[]): StockMovement[] {
  return serials.map((s) => ({
    id: s.id,
    date: (s.soldAt || s.createdAt).slice(0, 10),
    time: (s.soldAt || s.createdAt).slice(11, 19),
    type: (s.status === 'sold' ? 'out' : s.status === 'returned' ? 'return' : 'adjust') as MovementType,
    productCode: s.productCode || '—',
    productName: s.notes || s.productCode || s.serialNumber,
    quantity: 1,
    unit: 'دستگاه',
    fromWarehouse: s.status === 'sold' ? (s.company?.name || 'انبار مشترک') : '',
    toWarehouse: s.status === 'sold' ? 'مرکز فروش' : '',
    relatedDoc: s.serialNumber,
    personName: '',
    notes: s.status === 'sold' ? 'فروش' : s.status,
  }));
}

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد ریال';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون ریال';
  return toPersianNum(amount.toLocaleString()) + ' ریال';
}

function formatCompact(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون';
  return toPersianNum(amount.toLocaleString());
}

// ==================== NEW SERIAL FORM (real: creates inventory serial) ====================
function NewSerialForm({ products, companySlug, isAdmin, onDone }: {
  products: Array<{ id: string; code: string; name: string }>;
  companySlug?: string | null;
  isAdmin?: boolean;
  onDone: () => void;
}) {
  const [productCode, setProductCode] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // v2.34.12 — the entry lands in the ACTIVE company's warehouse (admins
  // on the holding view still create shared/neutral stock).
  const targetWarehouse = companySlug && COMPANY_WAREHOUSE_NAMES[companySlug]
    ? `انبار ${COMPANY_WAREHOUSE_NAMES[companySlug]}`
    : isAdmin ? 'انبار مشترک (بدون شرکت)' : 'انبار شرکت شما';

  const submit = async () => {
    if (!serialNumber.trim()) {
      setError('شماره سریال الزامی است.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          productCode: productCode || undefined,
          serialNumber: serialNumber.trim(),
          notes: notes || undefined,
          companySlug: companySlug && companySlug !== 'holding' ? companySlug : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت سریال');
      toast.success('کالا به انبار اضافه شد');
      setSerialNumber(''); setNotes('');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت سریال');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 mt-2">
      <p className="text-[11px] text-teal-800 bg-teal-50 border border-teal-100 rounded-lg p-2" aria-live="polite">
        ثبت در: {targetWarehouse}
      </p>
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesinventory-f204-1">محصول</label>
        <select id="salesinventory-f204-1" value={productCode} onChange={(e) => setProductCode(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
          <option value="">بدون کد محصول</option>
          {products.map((p) => <option key={p.id} value={p.code}>{p.code} — {p.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesinventory-f211-2">شماره سریال *</label>
        <Input id="salesinventory-f211-2" value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="مثلاً SN-2026-0001" className="h-10 rounded-lg" dir="ltr" />
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesinventory-f215-3">توضیحات</label>
        <Textarea id="salesinventory-f215-3" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="مشخصات ورود، تأمین‌کننده و..." className="rounded-lg resize-none" rows={3} />
      </div>
      <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
        {busy ? 'در حال ثبت...' : 'ثبت ورود به انبار'}
      </Button>
    </div>
  );
}

// ==================== MAIN COMPONENT ====================
export default function SalesInventory({ activeTab: propTab, companySlug, isAdmin: isAdminProp }: { activeTab?: string; companySlug?: string | null; isAdmin?: boolean }) {
  // v2.26.0 — tabs access-gated by the sidebar's menu-key resolution.
  // v2.57.0 (round 83) — ?module=inventory-hesabfa deep-link now lands on
  // the hesabfa tab (the old init only handled 'movements', so the
  // sidebar item «موجودی حسابفا» opened the LOCAL stock tab instead).
  const { isTabAllowed } = useTabAccess();
  const [activeTab, setActiveTab] = useState<InvTab>(propTab === 'movements' ? 'movements' : propTab === 'hesabfa' ? 'hesabfa' : 'stock');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [, setLoading] = useState(true); // loading flag not rendered (optimistic list)
  const [, setLoadError] = useState<string | null>(null); // error surfaced via toast
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('all');
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortBy, setSortBy] = useState('code');
  const [showNewMovement, setShowNewMovement] = useState(false);
  const [products, setProducts] = useState<Array<{ id: string; code: string; name: string }>>([]);

  // ── Load real inventory serials ──
  // v2.34.12 — pageSize raised 200 → 1000: the imported Hesabfa stock
  // alone is 267 serials, so the old cap silently truncated the list
  // (even for admins). Also passes the active company slug so admins
  // view one company's warehouse at a time (scoped users are narrowed
  // server-side regardless). Deps: switching the active company in the
  // top navbar now reloads the list (useCallback keeps the identity
  // stable between renders).
  const loadInventory = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const payload: Record<string, unknown> = { action: 'list', pageSize: 1000 };
      const scopeSlug = companySlug ?? null;
      if (scopeSlug && scopeSlug !== 'holding') payload.companySlug = scopeSlug;
      const res = await fetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت انبار');
      const serials: ApiSerial[] = data.items || [];
      setItems(serialsToItems(serials));
      setMovements(serialsToMovements(serials));
    } catch (e) {
      // v2.58.0 (audit 85-b): the error state was never rendered and no
      // toast ever fired — an /api/inventory failure showed an empty list
      // with zero feedback. The comment above was false.
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت انبار');
      toast.error(e instanceof Error ? e.message : 'خطا در دریافت انبار');
      setItems([]);
      setMovements([]);
    } finally {
      setLoading(false);
    }
  }, [companySlug]);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `loadInventory` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(loadInventory);
  }, [loadInventory]);

  useEffect(() => {
    fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', pageSize: 500 }),
    })
      .then((r) => r.json())
      .then((d) => setProducts(d.items || []))
      .catch(() => undefined);
  }, []);

  const categories = useMemo(() => [...new Set(items.map(i => i.category))], [items]);

  const totalValue = items.reduce((s, i) => s + i.totalValue, 0);
  const lowStockCount = items.filter(i => i.status === 'low-stock' || i.status === 'out-of-stock').length;
  const reservedCount = items.reduce((s, i) => s + i.reservedStock, 0);
  const totalItems = items.length;
  const incomingCount = 0;

  const stats = [
    { label: 'ارزش انبار', value: formatCompact(totalValue), icon: <Package size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'تعداد اقلام', value: toPersianNum(totalItems), icon: <Box size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'کمبود/ناموجود', value: toPersianNum(lowStockCount), icon: <AlertTriangle size={16} />, color: '#dc2626', bg: '#fef2f2' },
    { label: 'رزرو شده', value: toPersianNum(reservedCount), icon: <Hash size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'در راه', value: toPersianNum(incomingCount), icon: <Truck size={16} />, color: '#0891b2', bg: '#ecfeff' },
    { label: 'کل حرکات', value: toPersianNum(movements.length), icon: <Route size={16} />, color: '#d97706', bg: '#fffbeb' },
  ];

  // v2.21.0 — `items`/`movements` were missing from the deps: the memos
  // computed against the initial empty arrays and were not guaranteed to
  // recompute when the serials arrived (stale empty table). Deps are now
  // complete.
  const filteredItems = useMemo(() => {
    const result = items.filter(i => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!i.code.toLowerCase().includes(q) && !i.name.includes(q) && !i.category.includes(q)) return false;
      }
      if (filterCategory !== 'all' && i.category !== filterCategory) return false;
      if (filterStatus !== 'all' && i.status !== filterStatus) return false;
      return true;
    });
    result.sort((a, b) => {
 switch (sortBy) {
   case 'code': return a.code.localeCompare(b.code);
   case 'name': return a.name.localeCompare(b.name, 'fa');
   case 'stock': return a.availableStock - b.availableStock;
   case 'value': return b.totalValue - a.totalValue;
   default: return 0;
 }
    });
    return result;
  }, [items, search, filterCategory, filterStatus, sortBy]);

  const filteredMovements = useMemo(() => {
    return movements.filter(m => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!m.productCode.toLowerCase().includes(q) && !m.productName.includes(q) && !m.personName.includes(q)) return false;
      }
      return true;
    });
  }, [movements, search]);

  // v2.26.0 — tabs access-gated (inventory-stock / inventory-movements).
  const INV_TAB_MENU_KEYS: Record<string, string> = { stock: 'inventory-stock', movements: 'inventory-movements', hesabfa: 'inventory-hesabfa' };
  const ctxCompany = companySlug ?? null;
  const isAdmin = isAdminProp ?? false;
  const tabs = [
    { key: 'stock' as InvTab, label: 'موجودی کالا', icon: <Package size={14} />, count: items.length },
    { key: 'movements' as InvTab, label: 'حرکت کالا', icon: <Route size={14} />, count: movements.length },
    { key: 'hesabfa' as InvTab, label: 'موجودی حسابفا', icon: <Box size={14} />, count: 0 },
  ].filter((t) => isTabAllowed(INV_TAB_MENU_KEYS[t.key]));
  const currentTab: InvTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'stock');

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
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

      {/* Tabs + Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1" role="tablist" aria-label="نماهای انبار">
            {tabs.map((tab) => (
              <button key={tab.key} role="tab" aria-selected={currentTab === tab.key} onClick={() => setActiveTab(tab.key)} className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${currentTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {tab.icon}{tab.label}
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${currentTab === tab.key ? 'bg-teal-100 text-teal-700' : 'bg-gray-200 text-gray-500'}`}>{toPersianNum(tab.count)}</span>
              </button>
            ))}
          </div>
          {/* v2.34.12 — which warehouse is on screen (per-company separation). */}
          <span
            className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-teal-800 bg-teal-50 border border-teal-100 rounded-lg px-2.5 py-2 whitespace-nowrap"
            title="انبار در حال نمایش"
          >
            <Warehouse size={13} className="shrink-0" />
            {(ctxCompany && COMPANY_WAREHOUSE_NAMES[ctxCompany]) || (isAdmin ? 'همهٔ انبارها (تجمیعی)' : 'انبار شرکت شما')}
          </span>
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو کد، نام محصول..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
            </div>
            {currentTab === 'stock' && (
              <>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                  <option value="all">همه دسته‌ها</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                  <option value="all">همه وضعیت‌ها</option>
                  {Object.entries(STATUS_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                  <option value="code">کد</option><option value="name">نام</option><option value="stock">موجود</option><option value="value">ارزش</option>
                </select>
              </>
            )}
            <Dialog open={showNewMovement} onOpenChange={setShowNewMovement}>
              <DialogTrigger asChild>
                <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                  <Plus size={13} /> ورود کالا (سریال)
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
                <DialogHeader><DialogTitle>ثبت ورود کالای سریال‌دار</DialogTitle></DialogHeader>
                <NewSerialForm
                  products={products}
                  companySlug={companySlug ?? null}
                  isAdmin={isAdmin}
                  onDone={() => { setShowNewMovement(false); loadInventory(); }}
                />
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* Content */}
      {currentTab === 'hesabfa' && (
        <HesabfaInventory currentCompanySlug={ctxCompany ?? null} isAdmin={isAdmin} />
      )}
      {currentTab === 'stock' ? (
        <>
          <div className="overflow-x-auto bg-white rounded-xl border border-gray-100">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-100">
                  <th className="py-3 px-3 text-right font-bold text-gray-500">کد / نام</th>
                  <th className="py-3 px-3 text-right font-bold text-gray-500 hidden md:table-cell">دسته‌بندی</th>
                  <th className="py-3 px-3 text-center font-bold text-gray-500">موجود</th>
                  <th className="py-3 px-3 text-center font-bold text-gray-500 hidden lg:table-cell">رزرو</th>
                  <th className="py-3 px-3 text-center font-bold text-gray-500">در دسترس</th>
                  <th className="py-3 px-3 text-right font-bold text-gray-500 hidden lg:table-cell">انبار</th>
                  <th className="py-3 px-3 text-left font-bold text-gray-500">ارزش</th>
                  <th className="py-3 px-3 text-center font-bold text-gray-500">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr><td colSpan={8} className="py-12 text-center text-gray-400"><Package size={24} className="mx-auto mb-2 opacity-40" /><br />محصولی یافت نشد</td></tr>
                ) : (
                  filteredItems.map(item => {
                    const sc = STATUS_CFG[item.status];
                    return (
                      <tr key={item.id} className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors">
                        <td className="py-3 px-3">
                          <p className="text-sm font-bold text-gray-900">{item.name}</p>
                          <p className="text-[11px] text-gray-400 font-mono text-right" dir="ltr">{item.code}</p>
                        </td>
                        <td className="py-3 px-3 hidden md:table-cell"><span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{item.category}</span></td>
                        <td className="py-3 px-3 text-center font-bold text-gray-900">{toPersianNum(item.currentStock)} {item.unit}</td>
                        <td className="py-3 px-3 text-center text-indigo-600 hidden lg:table-cell">{toPersianNum(item.reservedStock)}</td>
                        <td className="py-3 px-3 text-center">
                          <span className={`font-bold ${item.availableStock <= item.minStock ? 'text-red-600' : 'text-gray-900'}`}>{toPersianNum(item.availableStock)}</span>
                        </td>
                        <td className="py-3 px-3 text-[11px] text-gray-500 hidden lg:table-cell">{item.warehouse}</td>
                        <td className="py-3 px-3 text-left font-bold text-gray-900">{formatCurrency(item.totalValue)}</td>
                        <td className="py-3 px-3 text-center">
                          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          {filteredMovements.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><Route size={32} className="mx-auto mb-2 opacity-40" /><p className="text-sm">حرکتی یافت نشد</p></div>
          ) : (
            filteredMovements.map(m => {
              const mc = MOVEMENT_CFG[m.type];
              return (
                <div key={m.id} className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: mc.bg, color: mc.color }}>{mc.icon}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: mc.bg, color: mc.color }}>{mc.label}</span>
                      <span className="text-sm font-bold text-gray-900">{m.productName}</span>
                      <span className="text-[11px] text-gray-400 font-mono" dir="ltr">{m.productCode}</span>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-gray-500">
                      <span>{toPersianNum(Math.abs(m.quantity))} {m.unit}</span>
                      {m.fromWarehouse && <span>از: {m.fromWarehouse}</span>}
                      {m.toWarehouse && <span>به: {m.toWarehouse}</span>}
                      {m.relatedDoc && <span className="text-gray-400">{m.relatedDoc}</span>}
                    </div>
                  </div>
                  <div className="hidden sm:flex flex-col items-end shrink-0 w-24">
                    <span className="text-xs text-gray-600">{m.date}</span>
                    <span className="text-[11px] text-gray-400">{m.personName}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
