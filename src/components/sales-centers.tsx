'use client';

import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Search, Plus, Building2, MapPin, Filter, Grid3X3, List, X, Contact2, Tag, UserRound, Handshake, Keyboard,
} from 'lucide-react';
// v2.35.1 (round 61) — keyboard-layout auto-fix: a Latin-only query is
// also searched with its Persian-layout twin server-side; the hint below
// tells the user the mistyped layout was caught, and searchVariants makes
// the client-side list filter match the same twins.
import { detectLayoutFix, searchVariants } from '@/lib/keyboard-layout';
import {
  CATEGORY_CFG, Center, CentersTab, GRADE_CFG, STATUS_CFG, ViewMode, toPersianNum,
} from './centers/types';
import { ApiCenter, adaptCenter } from './centers/api';
import { CategoriesTab } from './centers/categories-tab';
import { CenterCard } from './centers/center-card';
import { CenterDetailDialog } from './centers/center-detail-dialog';
import { CenterTableRow } from './centers/center-table-row';
import { CentersStats } from './centers/stats-bar';
import { ContactsTab } from './centers/contacts-tab';
import { ContractsTab } from './centers/contracts-tab';
import { IndividualsTab } from './centers/individuals-tab';
import { NewCenterForm } from './centers/new-center-form';
import { ProvinceMapTab } from './centers/province-map-tab';
import { useTabAccess } from '@/components/access-context';
import { toast } from 'sonner';

// Internal tab ↔ sidebar menu key (single source of truth alignment, v2.26.0):
// a tab renders only when the sidebar would show its menu item.
const TAB_MENU_KEYS: Record<CentersTab, string> = {
  list: 'centers-list',
  individuals: 'centers-individuals',
  contacts: 'centers-contacts',
  categories: 'centers-cats',
  map: 'centers-map',
  contracts: 'centers-contracts',
};

// ==================== MAIN COMPONENT ====================
export default function SalesCenters({ activeTab: propTab, focusEntityId, focusPersonId, onOpenDossier }: { activeTab?: string; focusEntityId?: string; focusPersonId?: string; /** v2.34.8 — opens the center's DEDICATED dossier page (پروندهٔ مرکز) instead of the old popup */ onOpenDossier?: (id: string, name: string) => void }) {
  const [centers, setCenters] = useState<Center[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<CentersTab>(
    propTab === 'contacts' ? 'contacts'
      : propTab === 'individuals' ? 'individuals'
      : propTab === 'categories' ? 'categories'
      : propTab === 'map' ? 'map'
      : propTab === 'contracts' ? 'contracts'
      : 'list'
  );
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterGrade, setFilterGrade] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [companiesList, setCompaniesList] = useState<Array<{ id: string; slug: string }>>([]);
  const [showNewCenter, setShowNewCenter] = useState(false);
  const [sortBy, setSortBy] = useState<string>('name');
  const [showFilters, setShowFilters] = useState(false);

  // v2.26.0 — internal tabs are now access-gated with the SAME resolution
  // the sidebar uses (company catalog × job-title matrix). A tab that the
  // sidebar would hide is neither rendered nor reachable via a direct
  // nav key; if the active tab loses access the view falls back to the
  // first allowed tab.

  // ── Load real centers from the API ──
  // `loading` starts true and is only cleared after the fetch resolves
  // (no synchronous setState in the mount effect).
  // v2.21.0 — takes the companies list as an explicit argument: the mount
  // effect now loads companies FIRST and passes them down (see below);
  // event-driven re-loads fall back to the current state value.
  const loadCenters = async (companies?: Array<{ id: string; slug: string }>) => {
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', page: 1, pageSize: 100, includeArchived: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت مراکز');
      // company slug for followups: default to first active company (single-tenant list view)
      const companyId = (companies ?? companiesList)[0]?.id || '';
      // API returns { success, data: [...], pagination } — but older routes used `items`.
      const pageItems: ApiCenter[] = data.data || data.items || [];
      // With 1,499+ centers and pageSize capped at 100 by the server, we must
      // walk through every page once on first load so search/filter operate
      // over the full set (filters are client-side today). Cap at 2,000 to
      // bound the worst-case payload on a single-tenant LAN deployment.
      let allItems: ApiCenter[] = pageItems;
      const totalPages: number = data.pagination?.totalPages || 1;
      for (let p = 2; p <= totalPages && allItems.length < 2000; p++) {
        const pageRes = await fetch('/api/centers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list', page: p, pageSize: 100, includeArchived: false }),
        });
        if (!pageRes.ok) break;
        const pageJson = await pageRes.json();
        const slice: ApiCenter[] = pageJson.data || pageJson.items || [];
        allItems = allItems.concat(slice);
      }
      setCenters(allItems.map((a: ApiCenter) => ({ ...adaptCenter(a), followupCompanyId: companyId })));
      setLoadError(null); // clear stale error only after a successful load
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت مراکز');
      setCenters([]);
    } finally {
      setLoading(false);
    }
  };

  // v2.21.0 — two fixes in one:
  // 1. COMPANIES FIRST. The old mount effect fired the centers load before
  //    /api/companies resolved, and `loadCenters` captured the EMPTY
  //    companiesList in its closure — so every center got
  //    followupCompanyId='' and creating a followup from a center card was
  //    ALWAYS rejected with 400 (the followups API requires a companyId).
  //    Companies now load first and are passed explicitly into loadCenters.
  // 2. latest-ref pattern — `loadCenters` is a plain function recreated every
  //    render; the ref keeps the effect dep array honest (mount-only) while
  //    always invoking the freshest closure.
  const loadCentersRef = useRef(loadCenters);
  useEffect(() => { loadCentersRef.current = loadCenters; });

  useEffect(() => {
    void (async () => {
      let list: Array<{ id: string; slug: string }> = [];
      try {
        const r = await fetch('/api/companies');
        const d = await r.json();
        if (Array.isArray(d)) list = d;
        setCompaniesList(list);
      } catch { /* centers must still load even if companies fail */ }
      await loadCentersRef.current(list);
    })();
  }, []);

  // v2.23.0 — the heart button used to be client-only state (the fill and
  // the «مورد علاقه» KPI evaporated on reload — nothing was persisted).
  // It now toggles isFavorite inside customFields via the real `favorite`
  // API action: optimistic flip, revert + Persian error on failure.
  const toggleFavorite = (id: string) => {
    // Compute the next value from the CURRENT render's list BEFORE any
    // setState: React defers the updater callback, so reading it inside
    // the updater would race the request (the v2.23.0 calendar bug).
    const target = centers.find(c => c.id === id);
    if (!target) return;
    const next = !target.isFavorite;
    setCenters(prev => prev.map(c => c.id === id ? { ...c, isFavorite: next } : c));
    void (async () => {
      try {
        const res = await fetch('/api/centers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'favorite', id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'خطا در به‌روزرسانی وضعیت نشان‌کردن');
        // The server is the referee — snap to the persisted flag (covers
        // the pathological case of a concurrent toggle landing first).
        const persisted = Boolean(data.isFavorite);
        if (persisted !== next) {
          setCenters(prev => prev.map(c => c.id === id ? { ...c, isFavorite: persisted } : c));
        }
      } catch (e) {
        setCenters(prev => prev.map(c => c.id === id ? { ...c, isFavorite: !next } : c));
        toast.error(e instanceof Error ? e.message : 'خطا در به‌روزرسانی وضعیت نشان‌کردن');
      }
    })();
  };

  // v2.34.8 — «مشاهده» now navigates to the center's DEDICATED PAGE
  // (پروندهٔ مرکز — ?module=center-dossier&focus=center:ID). The old
  // detail POPUP is retired per user request («به صورت یک پاپ‌آپ باز نشه
  // و یه صفحهٔ اختصاصی داشته باشه»); the dialog import stays ONLY as a
  // defensive fallback for isolated mounts without a nav handler.
  const [detailCenter, setDetailCenter] = useState<Center | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const handleView = (center: Center) => {
    if (onOpenDossier) {
      onOpenDossier(center.id, center.name);
      return;
    }
    setDetailCenter(center);
    setShowDetail(true);
  };

  // v2.26.0 — global-search deep link: once the list has loaded, open the
  // center's dedicated dossier page (v2.34.8 — previously the popup).
  useEffect(() => {
    if (!focusEntityId || loading || centers.length === 0) return;
    queueMicrotask(() => {
      const target = centers.find((c) => c.id === focusEntityId);
      if (target) onOpenDossier?.(target.id, target.name);
    });
    // one-shot: the effect only reacts to the focus id / loaded data.
    // onOpenDossier is intentionally excluded — it is an inline arrow from
    // the app shell (new identity every render); including it would re-fire
    // this navigation on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusEntityId, loading, centers]);

  const filteredCenters = useMemo(() => {
    const result = centers.filter(c => {
      if (search.trim()) {
        // v2.21.0 — the query is lowercased but the fields were not, so any
        // Latin-letter name (ZZ codes, English company names) never matched
        // a typed search: the card just vanished. Both sides are now
        // case-insensitive.
        // v2.35.1 (round 61) — this filter is CLIENT-side (the API loads all
        // rows), so the layout twins must join HERE too: «shk» matches «سان»
        // while the raw text keeps matching Latin names/codes.
        const qs = searchVariants(search).map((v) => v.toLowerCase());
        const hay = [c.name, c.city, c.province, ...c.contacts.map(ct => ct.fullName), ...c.tags].join(' ').toLowerCase();
        if (!qs.some((v) => hay.includes(v))) return false;
      }
      if (filterCategory !== 'all' && c.category !== filterCategory) return false;
      if (filterStatus !== 'all' && c.status !== filterStatus) return false;
      if (filterGrade !== 'all' && c.grade !== filterGrade) return false;
      return true;
    });

    // Sort
    result.sort((a, b) => {
      switch (sortBy) {
        case 'name': return a.name.localeCompare(b.name, 'fa');
        case 'sales': return b.totalSales - a.totalSales;
        case 'orders': return b.orderCount - a.orderCount;
        case 'date': return b.lastOrderDate.localeCompare(a.lastOrderDate, 'fa');
        default: return 0;
      }
    });

    return result;
  }, [centers, search, filterCategory, filterStatus, filterGrade, sortBy]);

  const allTabs: { key: CentersTab; label: string; icon: React.ReactNode; count: number }[] = [
    { key: 'list', label: 'لیست مراکز', icon: <Building2 size={14} />, count: centers.length },
    { key: 'individuals', label: 'مشتریان نهایی', icon: <UserRound size={14} />, count: centers.filter(c => c.customerType === 'end_user').length },
    { key: 'contacts', label: 'اشخاص تماس', icon: <Contact2 size={14} />, count: centers.reduce((s, c) => s + c.contacts.length, 0) },
    { key: 'categories', label: 'دسته‌بندی', icon: <Tag size={14} />, count: Object.keys(CATEGORY_CFG).length },
    { key: 'map', label: 'نقشه (استان‌ها)', icon: <MapPin size={14} />, count: [...new Set(centers.map(c => c.province).filter(p => p !== '—'))].length },
    { key: 'contracts', label: 'قراردادها', icon: <Handshake size={14} />, count: centers.length },
  ];
  // Access-gated tabs + guarded active tab (menu-key based).
  const { isTabAllowed } = useTabAccess();
  const tabs = allTabs.filter((t) => {
    // The geographic view is named «نقشه» (centers-map) in the holding
    // catalog and «منطقه‌بندی» (centers-territory) in aria's — it is the
    // SAME view, so either key grants it.
    if (t.key === 'map') return isTabAllowed('centers-map') || isTabAllowed('centers-territory');
    return isTabAllowed(TAB_MENU_KEYS[t.key]);
  });
  const currentTab: CentersTab = tabs.some((t) => t.key === activeTab) ? activeTab : (tabs[0]?.key ?? 'list');

  // v2.26.0 — active filter count badge (فیلترها (۳)) for discoverability.
  const activeFilterCount = [filterCategory !== 'all', filterStatus !== 'all', filterGrade !== 'all', Boolean(search.trim())].filter(Boolean).length;

  return (
    <div className="space-y-4">
      <CentersStats centers={centers} />

      {/* Tab bar — always visible so users can switch views without the sidebar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 flex-wrap" role="tablist" aria-label="نماهای مراکز">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={currentTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${
                  currentTab === tab.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.icon}
                {tab.label}
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${currentTab === tab.key ? 'bg-teal-100 text-teal-700' : 'bg-gray-200 text-gray-500'}`}>
                  {toPersianNum(tab.count)}
                </span>
              </button>
            ))}
          </div>
          {currentTab === 'individuals' ? (
            <Button onClick={() => setShowNewCenter(true)} className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
              <Plus size={13} /> مشتری نهایی جدید
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} className={`h-9 px-3 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors ${showFilters ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                <Filter size={13} />
                {activeFilterCount > 0 ? `فیلترها (${toPersianNum(activeFilterCount)})` : 'فیلتر'}
              </button>
              <Dialog open={showNewCenter} onOpenChange={setShowNewCenter}>
                <DialogTrigger asChild>
                  <Button className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                    <Plus size={13} /> مرکز / مشتری جدید
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))]" dir="rtl">
                  <DialogHeader><DialogTitle>ثبت مرکز / مشتری جدید</DialogTitle></DialogHeader>
                  <NewCenterForm
                    onDone={() => {
                      setShowNewCenter(false);
                      loadCenters();
                    }}
                  />
                </DialogContent>
              </Dialog>
            </div>
          )}
        </div>
      </div>

      {currentTab === 'contacts' ? (
        <ContactsTab centers={centers} onChanged={loadCenters} focusPersonId={focusPersonId} />
      ) : currentTab === 'individuals' ? (
        <IndividualsTab
          centers={centers}
          onOpenNew={() => setShowNewCenter(true)}
        />
      ) : currentTab === 'categories' ? (
        <CategoriesTab centers={centers} />
      ) : currentTab === 'map' ? (
        <ProvinceMapTab centers={centers} onOpenList={() => setActiveTab('list')} />
      ) : currentTab === 'contracts' ? (
        <ContractsTab centers={centers} />
      ) : (
        <>
          {/* Search + View toggle + Sort */}
          <div className="bg-white rounded-xl border border-gray-100 p-3 space-y-3">
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <div className="relative flex-1">
                  <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو نام، شهر، برچسب..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
                  {detectLayoutFix(search) && (
                    <p className="text-[11px] text-teal-600 flex items-center gap-1 mt-1.5 pr-1" data-layout-hint>
                      <Keyboard size={11} className="shrink-0" aria-hidden="true" />
                      چیدمان انگلیسی تشخیص داده شد — با «{detectLayoutFix(search)}» هم جستجو می‌شود
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600">
                    <option value="name">مرتب‌سازی: نام</option>
                    <option value="sales">مرتب‌سازی: فروش</option>
                    <option value="orders">مرتب‌سازی: سفارش</option>
                    <option value="date">مرتب‌سازی: تاریخ</option>
                  </select>
                  <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
                    <button onClick={() => setViewMode('grid')} className={`p-2 rounded-md transition-colors ${viewMode === 'grid' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'}`}>
                      <Grid3X3 size={14} />
                    </button>
                    <button onClick={() => setViewMode('table')} className={`p-2 rounded-md transition-colors ${viewMode === 'table' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-400'}`}>
                      <List size={14} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Filters panel */}
              {showFilters && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 bg-gray-50 rounded-xl animate-fade-in">
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salescenters-f348-1">دسته‌بندی</label>
                    <select id="salescenters-f348-1" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="w-full h-8 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                      <option value="all">همه</option>
                      {Object.entries(CATEGORY_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salescenters-f355-2">وضعیت</label>
                    <select id="salescenters-f355-2" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="w-full h-8 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                      <option value="all">همه</option>
                      {Object.entries(STATUS_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1" htmlFor="salescenters-f362-3">رتبه</label>
                    <select id="salescenters-f362-3" value={filterGrade} onChange={(e) => setFilterGrade(e.target.value)} className="w-full h-8 rounded-lg border border-gray-200 px-2 text-xs bg-white">
                      <option value="all">همه</option>
                      {Object.entries(GRADE_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </div>

          {/* Results count */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">{toPersianNum(filteredCenters.length)} مرکز</p>
            {(filterCategory !== 'all' || filterStatus !== 'all' || filterGrade !== 'all') && (
              <button onClick={() => { setFilterCategory('all'); setFilterStatus('all'); setFilterGrade('all'); }} className="text-[11px] text-red-500 hover:text-red-600 flex items-center gap-1">
                <X size={11} /> حذف فیلترها
              </button>
            )}
          </div>

          {/* Centers Grid / Table */}
          {loading ? (
            // v2.26.0 — skeleton grid instead of a full-panel spinner.
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" aria-label="در حال دریافت مراکز">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="bg-white rounded-xl border border-gray-100 p-4 animate-pulse">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-gray-200" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/4 rounded bg-gray-200" />
                      <div className="h-3 w-1/2 rounded bg-gray-100" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="h-3 w-full rounded bg-gray-100" />
                    <div className="h-3 w-2/3 rounded bg-gray-100" />
                    <div className="h-8 w-24 rounded-lg bg-gray-100 mt-3" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            <div className="bg-white rounded-xl border border-red-100 p-10 text-center" role="alert">
              <p className="text-sm text-red-600 mb-3">{loadError}</p>
              <button onClick={() => loadCenters()} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
            </div>
          ) : filteredCenters.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
              <Building2 size={36} className="mx-auto mb-3 text-gray-300" />
              <p className="text-sm font-bold text-gray-700 mb-1">هنوز مرکزی ثبت نشده است</p>
              <p className="text-xs text-gray-400 mb-4">برای شروع، اولین مرکز درمانی یا مشتری را ثبت کنید.</p>
              <Button onClick={() => setShowNewCenter(true)} className="h-9 gap-1.5 text-white text-xs rounded-lg px-4" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                <Plus size={13} /> ثبت مرکز جدید
              </Button>
            </div>
          ) : viewMode === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredCenters.map((center) => (
                <CenterCard key={center.id} center={center} onToggleFav={toggleFavorite} onView={handleView} onEdited={loadCenters} />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredCenters.map(center => (
                <CenterTableRow key={center.id} center={center} onToggleFav={toggleFavorite} onView={handleView} />
              ))}
            </div>
          )}

          {/* Detail popup — v2.34.8 FALLBACK ONLY: the app shell always
              wires onOpenDossier, so centers open their DEDICATED PAGE; this
              dialog renders solely for isolated mounts without the handler */}
          <CenterDetailDialog center={detailCenter} open={showDetail} onClose={() => setShowDetail(false)} onUpdated={loadCenters} />
        </>
      )}
    </div>
  );
}
