'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useTabAccess } from '@/components/access-context';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { NewShipmentDialog, ShipmentStatusActions, ShipmentStatusBadge, ShipmentRow } from '@/components/shipment-dialogs';
import { listAllPages } from '@/hooks/use-api';
import { toJalaliString } from '@/lib/jalali';
// v2.36.0 (round 62) — popup Jalali calendar replaces the TYPED deadline field.
import { JalaliDatePicker } from '@/components/jalali-date-picker';
import { Search, Plus, Factory, Truck, ClipboardCheck, Check, Package, Building2, MapPin, Send } from 'lucide-react';

// ==================== TYPES ====================
type ProdTab = 'orders' | 'shipments';
type ProdOrderStatus = 'pending' | 'in-progress' | 'quality-check' | 'ready' | 'shipped' | 'delivered' | 'cancelled';
type ShipStatus = 'preparing' | 'ready' | 'in-transit' | 'delivered' | 'returned';

interface ProductionOrder {
  id: string;
  number: string;
  centerName: string;
  city: string;
  productCode: string;
  productName: string;
  quantity: number;
  unit: string;
  status: ProdOrderStatus;
  orderDate: string;
  deadline: string;
  completedDate: string;
  assignedTo: string;
  notes: string;
  progress: number;
}

// ==================== CONFIGS ====================
const ORDER_STATUS: Record<ProdOrderStatus, { label: string; color: string; bg: string }> = {
  'pending': { label: 'در انتظار', color: '#6b7280', bg: '#f3f4f6' },
  'in-progress': { label: 'در حال تولید', color: '#0891b2', bg: '#ecfeff' },
  'quality-check': { label: 'کنترل کیفیت', color: '#d97706', bg: '#fffbeb' },
  'ready': { label: 'آماده ارسال', color: '#6366f1', bg: '#eef2ff' },
  'shipped': { label: 'ارسال شده', color: '#1F8B7D', bg: '#ecfdf5' },
  'delivered': { label: 'تحویل داده', color: '#059669', bg: '#ecfdf5' },
  'cancelled': { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
};

const SHIP_STATUS: Record<ShipStatus, { label: string; color: string; bg: string }> = {
  'preparing': { label: 'در حال آماده‌سازی', color: '#d97706', bg: '#fffbeb' },
  'ready': { label: 'آماده بارگیری', color: '#6366f1', bg: '#eef2ff' },
  'in-transit': { label: 'در راه', color: '#0891b2', bg: '#ecfeff' },
  'delivered': { label: 'تحویل داده', color: '#059669', bg: '#ecfdf5' },
  'returned': { label: 'برگشتی', color: '#dc2626', bg: '#fef2f2' },
};

// ==================== REAL DATA ADAPTER ====================
/** Purchase-request shape from /api/production (list action). */
interface ApiPurchaseRequest {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'approved' | 'rejected' | 'ordered';
  requestedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Convert a purchase request into a production order row. */
function requestToOrder(r: ApiPurchaseRequest): ProductionOrder {
  const status: ProdOrderStatus =
    r.status === 'approved' ? 'in-progress' :
    r.status === 'ordered' ? 'delivered' :
    r.status === 'rejected' ? 'cancelled' : 'pending';
  return {
    id: r.id,
    number: `PR-${r.id.slice(-6).toUpperCase()}`,
    centerName: 'واحد تولید',
    city: '',
    productCode: '',
    productName: r.title,
    quantity: 1,
    unit: 'عدد',
    status,
    orderDate: r.createdAt.slice(0, 10),
    deadline: '',
    completedDate: status === 'delivered' ? r.updatedAt.slice(0, 10) : '',
    assignedTo: r.requestedBy || '—',
    notes: r.description || '',
    progress: status === 'delivered' ? 100 : status === 'in-progress' ? 50 : 0,
  };
}

// ==================== REAL DATA ADAPTER ====================

// ==================== HELPERS ====================
function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

// ==================== NEW ORDER DIALOG (real save) ====================
/** v2.16.0 — the old dialog's ثبت سفارش button only closed the form.
 *  This one POSTs a real purchase request to /api/production
 *  ({title, description}; quantity/deadline/center folded into them). */
function NewOrderDialog({ open, onOpenChange, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSaved: () => void;
}) {
  const [product, setProduct] = useState('');
  const [center, setCenter] = useState('');
  const [quantity, setQuantity] = useState('');
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      // Reset asynchronously (react-hooks/set-state-in-effect)
      queueMicrotask(() => {
        setProduct('');
        setCenter('');
        setQuantity('');
        setDeadline('');
        setNotes('');
        setError(null);
      });
    }
  }, [open]);

  const submit = async () => {
    if (!product.trim()) {
      setError('نام یا کد محصول الزامی است.');
      return;
    }
    const qty = quantity.trim();
    const title = qty ? `${product.trim()} — ${qty} عدد` : product.trim();
    const descParts = [
      center.trim() ? `مرکز: ${center.trim()}` : '',
      deadline.trim() ? `مهلت: ${deadline.trim()}` : '',
      notes.trim(),
    ].filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          title,
          description: descParts.join('\n') || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت سفارش تولید');
      toast.success('سفارش تولید با موفقیت ثبت شد');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت سفارش تولید');
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
      <DialogHeader><DialogTitle>ثبت سفارش تولید</DialogTitle></DialogHeader>
      <div className="space-y-4 mt-2">
        {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproduction-f176-1">محصول *</label><Input id="salesproduction-f176-1" aria-label="محصول" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="کد یا نام" className="h-10 rounded-lg" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproduction-f177-2">مرکز / واحد</label><Input id="salesproduction-f177-2" aria-label="مرکز" value={center} onChange={(e) => setCenter(e.target.value)} placeholder="نام مرکز (اختیاری)" className="h-10 rounded-lg" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproduction-f180-3">تعداد</label><Input id="salesproduction-f180-3" aria-label="تعداد" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="۰" className="h-10 rounded-lg" dir="ltr" /></div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproduction-f181-4">مهلت (شمسی)</label><JalaliDatePicker id="salesproduction-f181-4" ariaLabel="مهلت (شمسی)" value={deadline} onChange={setDeadline} inputClassName="h-10 rounded-lg" placeholder="انتخاب مهلت (اختیاری)" allowClear /></div>
        </div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="salesproduction-f183-5">توضیحات</label><Textarea id="salesproduction-f183-5" aria-label="توضیحات" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات..." className="rounded-lg resize-none" rows={3} /></div>
        <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {busy ? 'در حال ثبت...' : 'ثبت سفارش'}
        </Button>
      </div>
    </DialogContent>
  );
}

// ==================== MAIN COMPONENT ====================
export default function SalesProduction({ activeTab: propTab }: { activeTab?: string }) {
  // v2.16.0 — accept both 'ship' and 'shipments' (page.tsx sends
  // 'shipments'; the old 'ship'-only check made the ارسال و بارنامه
  // menu land on the production-orders tab)
  const [activeTab, setActiveTab] = useState<ProdTab>(propTab === 'ship' || propTab === 'shipments' ? 'shipments' : 'orders');
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  // v2.17.0 — REAL shipment records from /api/shipments (the old tab faked
  // them from delivered purchase requests; carrier/tracking were always
  // empty and nothing was ever actually registered).
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [shipmentsLoading, setShipmentsLoading] = useState(true);
  const [shipmentsError, setShipmentsError] = useState<string | null>(null);
  const [showNewShipment, setShowNewShipment] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [showNewOrder, setShowNewOrder] = useState(false);

  // ── Load real purchase requests ──
  const loadOrders = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch('/api/production', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', pageSize: 200 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت سفارشات تولید');
      setOrders((data.items || []).map(requestToOrder));
    } catch (e) {
      // Production permission may be missing — show empty instead of crashing
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت سفارشات تولید');
      setOrders([]);
    } finally {
      setLoading(false);
    }
  };

  // ── Load real shipments (v2.17.0) ──
  const loadShipments = useCallback(async () => {
    setShipmentsLoading(true);
    setShipmentsError(null);
    try {
      // Walk every page — same v2.16.0 rule as the pipeline.
      const rows = await listAllPages<ShipmentRow>('/api/shipments', 'list', {}, 20);
      setShipments(rows);
    } catch (e) {
      setShipmentsError(e instanceof Error ? e.message : 'خطا در دریافت ارسال‌ها');
      setShipments([]);
    } finally {
      setShipmentsLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `loadOrders` asynchronous (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(loadOrders);
    queueMicrotask(loadShipments);
  }, [loadShipments]);

  const inProgress = orders.filter(o => o.status === 'in-progress' || o.status === 'quality-check').length;
  const ready = orders.filter(o => o.status === 'ready').length;
  const delivered = orders.filter(o => o.status === 'delivered').length;
  // v2.17.0 — shipment stats from the real records
  const activeShipments = shipments.filter(s => s.status === 'preparing' || s.status === 'ready' || s.status === 'in-transit').length;
  const deliveredShipments = shipments.filter(s => s.status === 'delivered').length;

  const stats = [
    { label: 'سفارشات فعال', value: toPersianNum(orders.filter(o => o.status !== 'delivered' && o.status !== 'cancelled').length), icon: <ClipboardCheck size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'در حال تولید', value: toPersianNum(inProgress), icon: <Factory size={16} />, color: '#0891b2', bg: '#ecfeff' },
    { label: 'آماده ارسال', value: toPersianNum(ready), icon: <Package size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'تحویل داده', value: toPersianNum(delivered), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'ارسال فعال', value: toPersianNum(activeShipments), icon: <Truck size={16} />, color: '#d97706', bg: '#fffbeb' },
    { label: 'تحویل مرسوله', value: toPersianNum(deliveredShipments), icon: <Send size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
  ];

  // v2.16.0 — sync tab when the sidebar navigates between submenus while
  // this component stays mounted (React keeps the instance alive).
  useEffect(() => {
    if (propTab === 'ship' || propTab === 'shipments' || propTab === 'orders') {
      queueMicrotask(() => {
        if (propTab === 'orders') setActiveTab('orders');
        else setActiveTab('shipments');
      });
    }
  }, [propTab]);

  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        if (!o.number.toLowerCase().includes(q) && !o.centerName.includes(q) && !o.productName.includes(q)) return false;
      }
      if (filterStatus !== 'all' && o.status !== filterStatus) return false;
      return true;
    });
  }, [orders, search, filterStatus]); // v2.16.0: `orders` was missing — list stayed empty until search/filter changed

  const filteredShipments = useMemo(() => {
    return shipments.filter(s => {
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const docNo = (s.salesDocument?.documentNumber || '').toLowerCase();
        const center = (s.salesDocument?.center?.name || '').toLowerCase();
        if (!docNo.includes(q) && !center.includes(q)
          && !(s.shipmentNumber || '').toLowerCase().includes(q)
          && !(s.carrierName || '').toLowerCase().includes(q)
          && !(s.trackingCode || '').toLowerCase().includes(q)) return false;
      }
      if (filterStatus !== 'all' && s.status !== filterStatus) return false;
      return true;
    });
  }, [shipments, search, filterStatus]); // v2.16.0: deps complete · v2.17.0: real rows

  // v2.26.0 — tabs access-gated (production-orders / production-ship).
  const { isTabAllowed } = useTabAccess();
  const PROD_TAB_MENU_KEYS: Record<string, string> = { orders: 'production-orders', shipments: 'production-ship' };
  const tabs = [
    { key: 'orders' as ProdTab, label: 'سفارشات تولید', icon: <Factory size={14} />, count: orders.length },
    { key: 'shipments' as ProdTab, label: 'ارسال و بارنامه', icon: <Truck size={14} />, count: shipments.length },
  ].filter((t) => isTabAllowed(PROD_TAB_MENU_KEYS[t.key]));
  const currentTab: ProdTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'orders');

  return (
    <div className="space-y-4">
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

      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            {tabs.map((tab) => (
              <button key={tab.key} role="tab" aria-selected={currentTab === tab.key} onClick={() => { setActiveTab(tab.key); setFilterStatus('all'); setSearch(''); }} className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${currentTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {tab.icon}{tab.label}
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${currentTab === tab.key ? 'bg-teal-100 text-teal-700' : 'bg-gray-200 text-gray-500'}`}>{toPersianNum(tab.count)}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-1">
            <div className="relative flex-1">
              <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
            </div>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
              <option value="all">همه وضعیت‌ها</option>
              {(Object.entries(currentTab === 'orders' ? ORDER_STATUS : SHIP_STATUS) as [string, { label: string }][]).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            {currentTab === 'orders' ? (
              <Dialog open={showNewOrder} onOpenChange={setShowNewOrder}>
                <DialogTrigger asChild>
                  <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}><Plus size={13} /> سفارش جدید</Button>
                </DialogTrigger>
                <NewOrderDialog open={showNewOrder} onOpenChange={setShowNewOrder} onSaved={loadOrders} />
              </Dialog>
            ) : (
              <Dialog open={showNewShipment} onOpenChange={setShowNewShipment}>
                <DialogTrigger asChild>
                  <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}><Plus size={13} /> ثبت ارسال</Button>
                </DialogTrigger>
                <NewShipmentDialog open={showNewShipment} onOpenChange={setShowNewShipment} onSaved={loadShipments} />
              </Dialog>
            )}
          </div>
        </div>
      </div>

      {currentTab === 'orders' ? (
        <div className="space-y-2">
          {loading ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><Factory size={32} className="mx-auto mb-2 opacity-40 animate-pulse" /><p className="text-sm">در حال بارگذاری سفارشات...</p></div>
          ) : loadError ? (
            <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
              <p className="text-sm text-red-600 mb-3">{loadError}</p>
              <button onClick={loadOrders} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><Factory size={32} className="mx-auto mb-2 opacity-40" /><p className="text-sm">سفارشی یافت نشد</p></div>
          ) : (
            filteredOrders.map(o => {
              const sc = ORDER_STATUS[o.status];
              return (
                <div key={o.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: sc.bg, color: sc.color }}><Factory size={18} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-bold text-gray-900">{o.number}</h4>
                        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500">
                        <span className="flex items-center gap-1"><Building2 size={10} /> {o.centerName}</span>
                        <span className="flex items-center gap-1"><MapPin size={10} /> {o.city}</span>
                        <span className="font-mono text-gray-400" dir="ltr">{o.productCode}</span>
                      </div>
                    </div>
                    <div className="hidden md:flex flex-col items-end shrink-0 w-44">
                      <p className="text-xs font-medium text-gray-700">{o.productName}</p>
                      <p className="text-[11px] text-gray-400">{toPersianNum(o.quantity)} {o.unit} · {o.assignedTo || 'بدون تخصیص'}</p>
                      <div className="w-full h-2 bg-gray-100 rounded-full mt-2 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${o.progress}%`, background: o.progress === 100 ? '#059669' : o.progress > 50 ? '#d97706' : '#0891b2' }} />
                      </div>
                    </div>
                    <div className="hidden sm:flex flex-col items-end shrink-0 w-20">
                      <span className="text-xs text-gray-600">مهلت: {o.deadline}</span>
                      <span className="text-[11px] text-gray-400">{toPersianNum(o.progress)}٪</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {shipmentsLoading ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><Truck size={32} className="mx-auto mb-2 opacity-40 animate-pulse" /><p className="text-sm">در حال بارگذاری ارسال‌ها...</p></div>
          ) : shipmentsError ? (
            <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
              <p className="text-sm text-red-600 mb-3">{shipmentsError}</p>
              <button onClick={loadShipments} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
            </div>
          ) : filteredShipments.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400"><Truck size={32} className="mx-auto mb-2 opacity-40" /><p className="text-sm">ارسالی یافت نشد</p></div>
          ) : (
            filteredShipments.map(s => {
              const sc = SHIP_STATUS[s.status as ShipStatus];
              return (
                <div key={s.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
                  <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: sc.bg, color: sc.color }}><Truck size={18} /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h4 className="text-sm font-bold text-gray-900" dir="ltr">{s.shipmentNumber || s.id.slice(-8)}</h4>
                        <ShipmentStatusBadge status={s.status} />
                        {s.salesDocument?.documentNumber && <span className="text-[11px] text-gray-400" dir="ltr">← {s.salesDocument.documentNumber}</span>}
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500">
                        <span className="flex items-center gap-1"><Building2 size={10} /> {s.salesDocument?.center?.name || 'بدون مرکز'}</span>
                        {s.salesDocument?.center?.city && <span className="flex items-center gap-1"><MapPin size={10} /> {s.salesDocument.center.city}</span>}
                        {s.carrierName && <span>{s.carrierName}</span>}
                        {s.trackingCode && <span className="font-mono text-gray-400" dir="ltr">{s.trackingCode}</span>}
                      </div>
                      <ShipmentStatusActions shipment={s} onDone={loadShipments} />
                    </div>
                    <div className="hidden sm:flex flex-col items-end shrink-0 w-28">
                      <span className="text-[11px] text-gray-600">{s.itemsSummary || '—'}</span>
                      <span className="text-[11px] text-gray-400">{s.weight}</span>
                    </div>
                    <div className="hidden md:flex flex-col items-end shrink-0 w-24">
                      <span className="text-xs text-gray-600">ارسال: {toJalaliString(s.dispatchedAt)}</span>
                      <span className="text-[11px] text-gray-400">تحویل: {toJalaliString(s.deliveredAt)}</span>
                    </div>
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