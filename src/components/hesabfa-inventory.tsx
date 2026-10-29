'use client';
// ════════════════════════════════════════════════════════════
// hesabfa-inventory.tsx — v2.57.1 (round 84) read-only Hesabfa hub
// v2.57.1: ستون‌های dir="ltr" (کد/تاریخ/مبلغ/شماره) با text-right
// هم‌تراز سرستون‌های text-right شدند — مقدار دقیقاً زیر عنوان
// سرستون می‌نشیند (پیش‌تر dir="ltr" توارث start را به چپ می‌چرخاند).
// Source of truth: Hesabfa. Company → Warehouse → Item → Quantity.
// Sub-views (per upload/حسابفا.txt):
//   موجودی   — snapshots + Available-For-Sale (stock − active reservations)
//   کالاها   — item catalog with sell price
//   فاکتورها — cached invoices (فروش/خرید) + detected serials
//   مخاطبین  — contacts with بدهکاری/بستانکاری + manual center link
//   سریال‌ها  — production serials synced from invoices (status history)
// Admin: company filter (aggregate / per-company) + sync buttons for
// the viewed company. Regular users see only their own companies.
// ════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Search, AlertTriangle, Package, Warehouse, FileText, Users, Hash, Link2, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface SnapshotRow {
  id: string; companyId: string; itemCode: string; itemName: string; unit: string;
  warehouseCode: string; warehouseName: string; quantity: number; fetchedAt: string;
  reservedCount?: number; availableForSale?: number | null;
}
interface ItemRow {
  id: string; itemCode: string; name: string; barCode: string; unit: string;
  buyPrice: number; sellPrice: number; categoryPath: string; active: boolean;
}
interface ContactRow {
  id: string; code: string; name: string; contactType: number; phone: string;
  mobile: string; city: string; balance: number;
  linkedCenterId: string | null; linkedCenterName: string | null;
}
interface InvoiceRow {
  id: string; number: string; invoiceType: number; date: string;
  contactName: string; contactCode: string; totalAmount: number; serials: string[];
}
interface SerialRow {
  id: string; serialNumber: string; status: string; productCode: string | null;
  hesabfaItemCode: string; hesabfaInvoiceNumber: string; soldAt: string | null;
  notes: string;
}
interface CompanyStatus {
  slug: string; name: string; isIsolated?: boolean; connected: boolean;
  lastSyncAt: string | null; stale: boolean; lastSyncStats: Record<string, number> | null;
}
type SubView = 'stock' | 'items' | 'invoices' | 'contacts' | 'serials';

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  try { return new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)); }
  catch { return iso; }
};
const fa = (n: number) => new Intl.NumberFormat('fa-IR').format(n);
const SERIAL_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  available: { label: 'موجود', color: '#059669', bg: '#ecfdf5' },
  sold: { label: 'فروخته‌شده', color: '#dc2626', bg: '#fef2f2' },
  returned: { label: 'مرجوعی', color: '#d97706', bg: '#fffbeb' },
  defective: { label: 'معیوب', color: '#6b7280', bg: '#f3f4f6' },
  demo: { label: 'دمو', color: '#7c3aed', bg: '#f5f3ff' },
  reserved: { label: 'رزرو شده', color: '#4f46e5', bg: '#eef2ff' },
  expert: { label: 'نزد کارشناس', color: '#0891b2', bg: '#ecfeff' },
};

export function HesabfaInventory({ currentCompanySlug, isAdmin }: { currentCompanySlug: string | null; isAdmin: boolean }) {
  const [subView, setSubView] = useState<SubView>('stock');
  const [rows, setRows] = useState<SnapshotRow[]>([]);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [serials, setSerials] = useState<SerialRow[]>([]);
  const [invoiceType, setInvoiceType] = useState<'all' | 0 | 1>('all');
  const [companies, setCompanies] = useState<CompanyStatus[]>([]);
  const [filterCompany, setFilterCompany] = useState<string>(currentCompanySlug ?? '');
  const [warehouse, setWarehouse] = useState('');
  const [q, setQ] = useState('');
  // v2.58.0 (audit 85-b): the search field keeps its own immediate value;
  // `q` is the DEBOUNCED mirror that drives `load` — previously every
  // keystroke re-created `load` (dep on q) and fired the effect fetch
  // immediately, then the 350ms debounce fired a second identical one.
  const [qInput, setQInput] = useState('');
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<ContactRow | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const PAGE = 50;

  const call = useCallback(async (body: Record<string, unknown>) => {
    const res = await fetch('/api/hesabfa', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || 'خطای سرور');
    return data as Record<string, unknown>;
  }, []);

  // v2.58.0 (audit 85-b HIGH): request-sequence guard — a slower earlier
  // response can no longer overwrite the state of a newer one (previously
  // last-writer-wins raced on company/warehouse/page switches).
  const loadSeqRef = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const common = { companySlug: filterCompany || undefined, q: q || undefined, page, pageSize: PAGE };
      let action = 'inventory';
      if (subView === 'items') action = 'items';
      else if (subView === 'contacts') action = 'contacts';
      else if (subView === 'invoices') action = 'invoices';
      else if (subView === 'serials') action = 'serials';
      const body: Record<string, unknown> = { action, ...common };
      if (subView === 'stock' && warehouse) body.warehouseCode = warehouse;
      if (subView === 'invoices' && invoiceType !== 'all') body.invoiceType = invoiceType;
      const res = await fetch('/api/hesabfa', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = (await res.json()) as {
        rows?: Array<SnapshotRow | ItemRow | ContactRow | InvoiceRow | SerialRow>;
        companies?: CompanyStatus[]; total: number;
      };
      // NB: every API handler answers under `rows` (the sub-view only
      // decides WHICH action fires and how each row renders).
      const viewRows = data.rows ?? [];
      if (seq !== loadSeqRef.current) return; // stale response — a newer request owns the state
      if (subView === 'items') setItems(viewRows as ItemRow[]);
      else if (subView === 'contacts') setContacts(viewRows as ContactRow[]);
      else if (subView === 'invoices') setInvoices(viewRows as InvoiceRow[]);
      else if (subView === 'serials') setSerials(viewRows as SerialRow[]);
      else setRows(viewRows as SnapshotRow[]);
      setCompanies(data.companies ?? []);
      setTotal(data.total ?? 0);
    } catch {
      if (seq !== loadSeqRef.current) return;
      setError('خطا در دریافت داده‌های حسابفا');
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, [filterCompany, warehouse, q, page, subView, invoiceType]);

  // microtask queue — see sales-inventory.tsx for the same pattern.
  // v2.58.0: also clears a pending search debounce on unmount.
  useEffect(() => {
    queueMicrotask(load);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [load]);

  // v2.58.0: debounce commits q + resets page; the [load] effect then fires
  // exactly ONE fetch (no immediate effect-fetch + debounced second fetch).
  const onSearch = (value: string) => {
    setQInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { setQ(value); setPage(1); }, 350);
  };

  const syncNow = async (section: 'items' | 'contacts' | 'invoices' | 'inventory' = 'inventory') => {
    const target = filterCompany || (companies.length === 1 ? companies[0].slug : '');
    if (!target) { setError('ابتدا یک شرکت را انتخاب کنید'); return; }
    setSyncing(section); setNotice(null); setError(null);
    try {
      const action = section === 'inventory' ? 'sync-inventory' : `sync-${section}`;
      const r = await call({ action, companySlug: target });
      setNotice(String(r.message ?? 'همگام‌سازی انجام شد'));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطای همگام‌سازی');
    } finally {
      setSyncing(null);
    }
  };

  const warehouses = Array.from(new Map(rows.filter((r) => r.warehouseCode !== '0').map((r) => [r.warehouseCode, r.warehouseName])).entries());
  const anyConnected = companies.some((c) => c.connected);
  const totalPages = Math.max(1, Math.ceil(total / PAGE));
  const isolatedOnly = companies.length === 1 && !!companies[0].isIsolated;
  const canSync = isAdmin || isolatedOnly;

  const subTabs: { key: SubView; label: string; icon: React.ReactNode }[] = [
    { key: 'stock', label: 'موجودی', icon: <Warehouse size={13} /> },
    { key: 'items', label: 'کالاها', icon: <Package size={13} /> },
    { key: 'invoices', label: 'فاکتورها', icon: <FileText size={13} /> },
    { key: 'contacts', label: 'مخاطبین', icon: <Users size={13} /> },
    { key: 'serials', label: 'سریال‌ها', icon: <Hash size={13} /> },
  ];

  return (
    <div className="space-y-4" data-hesabfa-inventory>
      {/* sub-view tabs */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 w-fit" role="tablist" aria-label="نماهای حسابفا">
        {subTabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={subView === t.key}
            data-hesabfa-subtab={t.key}
            onClick={() => { setSubView(t.key); setPage(1); setWarehouse(''); setQ(''); setQInput(''); }}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[34px] ${
              subView === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* company status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {companies.map((c) => (
          <button
            key={c.slug}
            data-hesabfa-company={c.slug}
            onClick={() => { setFilterCompany(c.slug); setPage(1); }}
            className={'text-right bg-white rounded-xl border p-3 transition ' + (filterCompany === c.slug ? 'border-teal-500 ring-2 ring-teal-100' : 'border-gray-100 hover:border-gray-200')}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold text-gray-800">{c.name}</span>
              <span className={'w-2 h-2 rounded-full ' + (c.connected ? 'bg-emerald-500' : 'bg-gray-300')} />
            </div>
            <p className="text-[11px] text-gray-400">
              {c.connected ? (c.lastSyncAt ? `آخرین همگام‌سازی: ${fmt(c.lastSyncAt)}` : 'متصل — همگام‌سازی نشده') : 'متصل نیست'}
            </p>
            {c.stale && (
              <p className="text-[11px] text-amber-600 flex items-center gap-1 mt-1"><AlertTriangle size={11} /> اطلاعات موجودی قدیمی است</p>
            )}
          </button>
        ))}
      </div>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-52">
          <Search size={14} className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            data-hesabfa-search
            value={qInput}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={subView === 'invoices' ? 'جستجوی شماره فاکتور یا مشتری…' : subView === 'contacts' ? 'جستجوی نام یا کد مخاطب…' : subView === 'serials' ? 'جستجوی سریال یا فاکتور…' : 'جستجوی کالا یا کد…'}
            className="h-9 rounded-lg text-xs ps-3 pe-9"
          />
        </div>
        {subView === 'invoices' && (
          <select
            data-hesabfa-invoice-type
            value={String(invoiceType)}
            onChange={(e) => {
              const v = e.target.value;
              setInvoiceType(v === 'all' ? 'all' : (Number(v) === 1 ? 1 : 0));
              setPage(1);
            }}
            className="h-9 rounded-lg border border-gray-200 text-xs px-2 bg-white"
          >
            <option value="all">همهٔ فاکتورها</option>
            <option value="0">فروش</option>
            <option value="1">خرید</option>
          </select>
        )}
        {canSync && (
          <>
            {isAdmin && (
              <select
                data-hesabfa-company-filter
                value={filterCompany}
                onChange={(e) => { setFilterCompany(e.target.value); setPage(1); }}
                className="h-9 rounded-lg border border-gray-200 text-xs px-2 bg-white"
              >
                <option value="">همهٔ شرکت‌های من (تجمیعی)</option>
                {companies.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
              </select>
            )}
            <Button
              onClick={() => syncNow(subView === 'items' ? 'items' : subView === 'contacts' ? 'contacts' : subView === 'invoices' ? 'invoices' : 'inventory')}
              disabled={syncing !== null || !anyConnected}
              className="h-9 gap-1.5 text-white text-xs rounded-lg px-4" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
              data-hesabfa-sync
            >
              {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {syncing ? 'در حال همگام‌سازی…' : `همگام‌سازی ${subView === 'items' ? 'کالاها' : subView === 'contacts' ? 'مشتریان' : subView === 'invoices' ? 'فاکتورها و سریال‌ها' : 'موجودی'} اکنون`}
            </Button>
          </>
        )}
      </div>

      {notice && <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 text-[11px] text-emerald-700">{notice}</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[11px] text-red-600">{error}</div>}

      {/* warehouse chips (stock view only) */}
      {subView === 'stock' && warehouses.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => { setWarehouse(''); setPage(1); }}
            className={'text-[11px] px-2.5 py-1 rounded-full border ' + (!warehouse ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500')}
          >همهٔ انبارها</button>
          {warehouses.map(([code, name]) => (
            <button
              key={code}
              onClick={() => { setWarehouse(code); setPage(1); }}
              className={'text-[11px] px-2.5 py-1 rounded-full border flex items-center gap-1 ' + (warehouse === code ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500 hover:border-gray-300')}
            ><Warehouse size={11} /> {name}</button>
          ))}
        </div>
      )}

      {/* ── STOCK view ── */}
      {subView === 'stock' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" data-hesabfa-view="stock">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500">
                  <th className="text-right font-medium py-2.5 px-3">کد کالا</th>
                  <th className="text-right font-medium py-2.5 px-3">نام کالا</th>
                  <th className="text-right font-medium py-2.5 px-3">انبار</th>
                  <th className="text-right font-medium py-2.5 px-3">موجودی</th>
                  <th className="text-right font-medium py-2.5 px-3">رزرو</th>
                  <th className="text-right font-medium py-2.5 px-3">قابل فروش</th>
                  <th className="text-right font-medium py-2.5 px-3">واحد</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400">
                    <div className="inline-block w-5 h-5 border-2 border-teal-600 border-t-transparent rounded-full animate-spin align-middle me-2" />
                    در حال بارگذاری…
                  </td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400">
                    <Package size={18} className="inline-block align-middle me-1.5 text-gray-300" />
                    {anyConnected ? 'موجودی‌ای ثبت نشده — ابتدا همگام‌سازی کنید' : 'اتصال حسابفا برای هیچ‌یک از شرکت‌های شما فعال نیست'}
                  </td></tr>
                ) : rows.map((r) => (
                  <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50/50" data-hesabfa-row={`${r.itemCode}|${r.warehouseCode}`}>
                    <td className="py-2 px-3 font-mono text-gray-500 text-right" dir="ltr">{r.itemCode}</td>
                    <td className="py-2 px-3 text-gray-800 font-medium">{r.itemName}</td>
                    <td className="py-2 px-3">
                      <span className={'px-2 py-0.5 rounded-full text-[11px] ' + (r.warehouseCode === '0' ? 'bg-teal-50 text-teal-700 font-bold' : 'bg-gray-100 text-gray-600')}>
                        {r.warehouseName}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-bold text-gray-800 text-right" dir="ltr">{fa(r.quantity)}</td>
                    <td className="py-2 px-3">
                      {r.reservedCount ? <span className="text-indigo-600 font-bold" dir="ltr">{fa(r.reservedCount)}</span> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="py-2 px-3">
                      {r.availableForSale === null || r.availableForSale === undefined
                        ? <span className="text-gray-300">—</span>
                        : <span className="font-bold text-emerald-700" dir="ltr">{fa(r.availableForSale)}</span>}
                    </td>
                    <td className="py-2 px-3 text-gray-500">{r.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && <Pager page={page} totalPages={totalPages} total={total} onPage={(p) => setPage(p)} />}
          <p className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">
            قابل فروش = موجودی کل حسابفا − رزروهای فعال (سریال‌های رزروشدهٔ منقضی‌نشده) · منبع: حسابفا (فقط خواندن)
          </p>
        </div>
      )}

      {/* ── ITEMS view ── */}
      {subView === 'items' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" data-hesabfa-view="items">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500">
                  <th className="text-right font-medium py-2.5 px-3">کد</th>
                  <th className="text-right font-medium py-2.5 px-3">نام کالا</th>
                  <th className="text-right font-medium py-2.5 px-3">واحد</th>
                  <th className="text-right font-medium py-2.5 px-3">قیمت خرید</th>
                  <th className="text-right font-medium py-2.5 px-3">قیمت فروش</th>
                  <th className="text-right font-medium py-2.5 px-3">دسته</th>
                  <th className="text-right font-medium py-2.5 px-3">وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400">در حال بارگذاری…</td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-10 text-gray-400">کالایی ثبت نشده — ابتدا «همگام‌سازی کالاها» را اجرا کنید</td></tr>
                ) : items.map((r) => (
                  <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50/50" data-hesabfa-item={r.itemCode}>
                    <td className="py-2 px-3 font-mono text-gray-500 text-right" dir="ltr">{r.itemCode}</td>
                    <td className="py-2 px-3 text-gray-800 font-medium">{r.name}</td>
                    <td className="py-2 px-3 text-gray-500">{r.unit}</td>
                    <td className="py-2 px-3 text-gray-600 text-right" dir="ltr">{r.buyPrice ? fa(r.buyPrice) : '—'}</td>
                    <td className="py-2 px-3 font-bold text-gray-800 text-right" dir="ltr">{r.sellPrice ? fa(r.sellPrice) : '—'}</td>
                    <td className="py-2 px-3 text-gray-500">{r.categoryPath || '—'}</td>
                    <td className="py-2 px-3">
                      <span className={'px-2 py-0.5 rounded-full text-[11px] ' + (r.active ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400')}>
                        {r.active ? 'فعال' : 'غیرفعال'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && <Pager page={page} totalPages={totalPages} total={total} onPage={(p) => setPage(p)} />}
        </div>
      )}

      {/* ── INVOICES view ── */}
      {subView === 'invoices' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" data-hesabfa-view="invoices">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500">
                  <th className="text-right font-medium py-2.5 px-3">نوع</th>
                  <th className="text-right font-medium py-2.5 px-3">شماره فاکتور</th>
                  <th className="text-right font-medium py-2.5 px-3">تاریخ</th>
                  <th className="text-right font-medium py-2.5 px-3">طرف حساب</th>
                  <th className="text-right font-medium py-2.5 px-3">مبلغ کل</th>
                  <th className="text-right font-medium py-2.5 px-3">سریال‌های شناسایی‌شده</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400">در حال بارگذاری…</td></tr>
                ) : invoices.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-10 text-gray-400">فاکتوری ثبت نشده — ابتدا «همگام‌سازی فاکتورها» را اجرا کنید</td></tr>
                ) : invoices.map((r) => (
                  <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50/50" data-hesabfa-invoice={r.number}>
                    <td className="py-2 px-3">
                      <span className={'px-2 py-0.5 rounded-full text-[11px] font-bold ' + (r.invoiceType === 1 ? 'bg-amber-50 text-amber-700' : 'bg-teal-50 text-teal-700')}>
                        {r.invoiceType === 1 ? 'خرید' : 'فروش'}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono text-gray-700 text-right" dir="ltr">{r.number || '—'}</td>
                    <td className="py-2 px-3 text-gray-600 text-right" dir="ltr">{r.date || '—'}</td>
                    <td className="py-2 px-3 text-gray-800 font-medium">{r.contactName || '—'}</td>
                    <td className="py-2 px-3 font-bold text-gray-800 text-right" dir="ltr">{r.totalAmount ? fa(r.totalAmount) : '—'}</td>
                    <td className="py-2 px-3">
                      {r.serials.length === 0 ? <span className="text-gray-300">—</span> : (
                        <div className="flex flex-wrap gap-1">
                          {r.serials.slice(0, 4).map((s) => (
                            <span key={s} className="text-[10px] font-mono bg-indigo-50 text-indigo-600 rounded px-1.5 py-0.5" dir="ltr">{s}</span>
                          ))}
                          {r.serials.length > 4 && <span className="text-[10px] text-gray-400">+{fa(r.serials.length - 4)}</span>}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && <Pager page={page} totalPages={totalPages} total={total} onPage={(p) => setPage(p)} />}
          <p className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">فاکتورهای حسابفا (فقط خواندن) — ایجاد یا ویرایش فاکتور در حسابفا غیرفعال است.</p>
        </div>
      )}

      {/* ── CONTACTS view ── */}
      {subView === 'contacts' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" data-hesabfa-view="contacts">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500">
                  <th className="text-right font-medium py-2.5 px-3">کد</th>
                  <th className="text-right font-medium py-2.5 px-3">نام مخاطب</th>
                  <th className="text-right font-medium py-2.5 px-3">موبایل</th>
                  <th className="text-right font-medium py-2.5 px-3">شهر</th>
                  <th className="text-right font-medium py-2.5 px-3">بدهکاری / بستانکاری</th>
                  <th className="text-right font-medium py-2.5 px-3">مرکز CRM متصل</th>
                  {isAdmin && <th className="text-right font-medium py-2.5 px-3">اتصال</th>}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={isAdmin ? 7 : 6} className="text-center py-10 text-gray-400">در حال بارگذاری…</td></tr>
                ) : contacts.length === 0 ? (
                  <tr><td colSpan={isAdmin ? 7 : 6} className="text-center py-10 text-gray-400">مخاطبی ثبت نشده — ابتدا «همگام‌سازی مشتریان» را اجرا کنید</td></tr>
                ) : contacts.map((r) => (
                  <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50/50" data-hesabfa-contact={r.code}>
                    <td className="py-2 px-3 font-mono text-gray-500 text-right" dir="ltr">{r.code || '—'}</td>
                    <td className="py-2 px-3 text-gray-800 font-medium">{r.name}</td>
                    <td className="py-2 px-3 text-gray-600 text-right" dir="ltr">{r.mobile || r.phone || '—'}</td>
                    <td className="py-2 px-3 text-gray-500">{r.city || '—'}</td>
                    <td className="py-2 px-3">
                      {r.balance > 0 ? (
                        <span className="font-bold text-red-600" dir="ltr">{fa(r.balance)} بدهکار</span>
                      ) : r.balance < 0 ? (
                        <span className="font-bold text-emerald-600" dir="ltr">{fa(Math.abs(r.balance))} بستانکار</span>
                      ) : (
                        <span className="text-gray-400">تسویه</span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      {r.linkedCenterName ? (
                        <span className="px-2 py-0.5 rounded-full text-[11px] bg-teal-50 text-teal-700 font-medium">{r.linkedCenterName}</span>
                      ) : (
                        <span className="text-[11px] text-gray-300">متصل نیست</span>
                      )}
                    </td>
                    {isAdmin && (
                      <td className="py-2 px-3">
                        <Button variant="outline" size="sm" onClick={() => setLinkTarget(r)} className="h-7 gap-1 text-[11px] px-2.5" data-hesabfa-link-btn={r.code}>
                          <Link2 size={11} /> {r.linkedCenterName ? 'تغییر' : 'اتصال'}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > PAGE && <Pager page={page} totalPages={totalPages} total={total} onPage={(p) => setPage(p)} />}
          <p className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">مپینگ دستی مخاطب↔مرکز با همگام‌سازی هرگز حذف یا ریست نمی‌شود.</p>
        </div>
      )}

      {/* ── SERIALS view ── */}
      {subView === 'serials' && (
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden" data-hesabfa-view="serials">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/80 text-gray-500">
                  <th className="text-right font-medium py-2.5 px-3">شماره سریال</th>
                  <th className="text-right font-medium py-2.5 px-3">وضعیت</th>
                  <th className="text-right font-medium py-2.5 px-3">کد کالای حسابفا</th>
                  <th className="text-right font-medium py-2.5 px-3">فاکتور مرجع</th>
                  <th className="text-right font-medium py-2.5 px-3">تاریخ فروش</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5} className="text-center py-10 text-gray-400">در حال بارگذاری…</td></tr>
                ) : serials.length === 0 ? (
                  <tr><td colSpan={5} className="text-center py-10 text-gray-400">سریالی از حسابفا ثبت نشده — «همگام‌سازی فاکتورها» را اجرا کنید</td></tr>
                ) : serials.map((r) => {
                  const cfg = SERIAL_STATUS[r.status] || { label: r.status, color: '#6b7280', bg: '#f3f4f6' };
                  return (
                    <tr key={r.id} className="border-t border-gray-50 hover:bg-gray-50/50" data-hesabfa-serial={r.serialNumber}>
                      <td className="py-2 px-3 font-mono font-bold text-gray-800 text-right" dir="ltr">{r.serialNumber}</td>
                      <td className="py-2 px-3">
                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold" style={{ color: cfg.color, background: cfg.bg }}>{cfg.label}</span>
                      </td>
                      <td className="py-2 px-3 font-mono text-gray-500 text-right" dir="ltr">{r.hesabfaItemCode || r.productCode || '—'}</td>
                      <td className="py-2 px-3 font-mono text-gray-600 text-right" dir="ltr">{r.hesabfaInvoiceNumber || '—'}</td>
                      <td className="py-2 px-3 text-gray-500">{r.soldAt ? fmt(r.soldAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > PAGE && <Pager page={page} totalPages={totalPages} total={total} onPage={(p) => setPage(p)} />}
          <p className="px-3 py-2 border-t border-gray-100 text-[10px] text-gray-400">
            سریال‌های شناسایی‌شده از فاکتورهای حسابفا (پیشوندهای OXP / OX / SC) — وضعیت‌های عملیاتی (دمو / رزرو / نزد کارشناس) هرگز با سینک بازنویسی نمی‌شوند.
          </p>
        </div>
      )}

      <p className="text-[11px] text-gray-400">منبع: حسابفا (فقط خواندن) — هیچ داده‌ای به حسابفا ارسال نمی‌شود.</p>

      {/* contact ↔ center link dialog (admin) */}
      <ContactLinkDialog
        contact={linkTarget}
        onClose={() => setLinkTarget(null)}
        onLinked={async (msg) => { setLinkTarget(null); setNotice(msg); await load(); }}
        call={call}
      />
    </div>
  );
}

function Pager({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (p: number) => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-t border-gray-100 text-[11px] text-gray-500">
      <span>صفحهٔ {fa(page)} از {fa(totalPages)} — {fa(total)} ردیف</span>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)} className="h-7 text-[11px] px-3">قبلی</Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPage(page + 1)} className="h-7 text-[11px] px-3">بعدی</Button>
      </div>
    </div>
  );
}

/** Search + pick a CRM center and link it to the hesabfa contact CODE. */
function ContactLinkDialog({ contact, onClose, onLinked, call }: {
  contact: ContactRow | null;
  onClose: () => void;
  onLinked: (msg: string) => void;
  call: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
}) {
  const [centers, setCenters] = useState<Array<{ id: string; name: string }>>([]);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!contact) { queueMicrotask(() => { setSearch(''); setCenters([]); }); return; }
    queueMicrotask(() => {
      void (async () => {
        try {
          const res = await fetch('/api/centers', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'list', pageSize: 200, q: '' }),
          });
          const d = await res.json();
          setCenters((d.data || d.items || []) as Array<{ id: string; name: string }>);
        } catch { setErr('خطا در دریافت مراکز'); }
      })();
    });
  }, [contact]);

  const filtered = centers.filter((c) => !search.trim() || c.name.includes(search.trim()));

  const link = async (centerId: string, centerName: string) => {
    if (!contact) return;
    setBusy(true); setErr(null);
    try {
      const r = await call({ action: 'link-contact', centerId, hesabfaCode: contact.code });
      onLinked(`${String(r.message ?? 'متصل شد')} — «${contact.name}» ↔ «${centerName}»`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'خطای اتصال');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!contact} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[min(26rem,calc(100vw-2rem))]" dir="rtl" data-hesabfa-link-dialog>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Link2 size={15} className="text-teal-600" />
            اتصال «{contact?.name ?? ''}» به مرکز CRM
          </DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-gray-400">کد مخاطب حسابفا: <span className="font-mono" dir="ltr">{contact?.code}</span> — این اتصال دستی است و با همگام‌سازی ریست نمی‌شود.</p>
        <div className="relative mt-1">
          <Search size={13} className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجوی مرکز…" className="h-9 rounded-lg text-xs ps-3 pe-9" />
        </div>
        {err && <p className="text-[11px] text-red-600 bg-red-50 rounded-lg p-2">{err}</p>}
        <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
          {filtered.length === 0 ? (
            <p className="text-[11px] text-gray-400 text-center py-6">مرکزی یافت نشد</p>
          ) : filtered.slice(0, 60).map((c) => (
            <button
              key={c.id}
              onClick={() => link(c.id, c.name)}
              disabled={busy}
              className="w-full text-right px-3 py-2.5 hover:bg-teal-50/50 transition text-xs font-medium text-gray-700 flex items-center justify-between disabled:opacity-50"
            >
              <span className="truncate">{c.name}</span>
              <Link2 size={13} className="text-teal-500 shrink-0" />
            </button>
          ))}
        </div>
        <Button variant="outline" onClick={onClose} className="h-9 text-xs rounded-lg gap-1.5">
          <X size={13} /> انصراف
        </Button>
      </DialogContent>
    </Dialog>
  );
}
