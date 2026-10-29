'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Bell, LogOut, ChevronDown, KeyRound, Building2, Package, FileText, Clock, AlertTriangle, CheckCircle2, Loader2, Mail, Sun, Moon, Monitor, Contact2, Keyboard } from 'lucide-react';
import { useTheme } from 'next-themes';
// v2.35.1 (round 61) — keyboard-layout auto-fix hint: when the query is
// Latin-script only, the backend also searches its Persian-layout twin;
// the chip below tells the user the system caught the mistyped layout.
import { detectLayoutFix } from '@/lib/keyboard-layout';

// ═══════════════════════════════════════════════════════════
// Professional top navbar — global search, notifications,
// user menu. Mirrors the UX standard of Didar / Payamgostar.
// ═══════════════════════════════════════════════════════════

interface TopNavbarProps {
  companyLabel: string;
  companyType: string;
  /** v2.31.8 — active-company logo for the identity chip (null → generic
   *  building icon). */
  companyLogo?: string | null;
  user: { displayName: string; roleLabel: string; username?: string } | null;
  onLogout: () => void;
  onNavigate?: (navKey: string, focus?: { type: 'center' | 'product' | 'document' | 'person'; id: string; label?: string }) => void;
  /** Mobile hamburger — opens the sidebar drawer */
  onMenuClick?: () => void;
  /** v2.26.0 — shared unread mail count (single poller lives in the shell) */
  unreadCount?: number;
}

/** Mail indicator — presentational; the count is polled once in the shell. */
function UnreadMailIndicator({ unread, onNavigate }: { unread: number; onNavigate?: TopNavbarProps['onNavigate'] }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative text-gray-500 hover:text-gray-700 p-2.5 rounded-xl hover:bg-gray-100 transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center"
        title="مراسلات داخلی"
        aria-label={`مراسلات داخلی${unread > 0 ? ` — ${unread} نامهٔ خوانده‌نشده` : ''}`}
        aria-expanded={open}
      >
        <Mail size={18} />
        {unread > 0 && (
          <span className="absolute top-1 left-1 min-w-[16px] h-4 px-1 bg-teal-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
            {toPersianNum(unread)}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-12 left-0 w-56 max-w-[calc(100vw-1.5rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 p-2 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <button
            onClick={() => { setOpen(false); onNavigate?.('mailbox'); }}
            className="w-full flex items-start gap-3 p-3 rounded-xl hover:bg-gray-50 text-right transition-colors"
          >
            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              style={{ background: unread > 0 ? '#dc262615' : '#94a3b815', color: unread > 0 ? '#dc2626' : '#94a3b8' }}>
              <Mail size={15} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-gray-800">
                {unread > 0 ? `${toPersianNum(unread)} نامهٔ خوانده‌نشده` : 'صندوق مراسلات'}
              </p>
              <p className="text-[11px] text-gray-400 mt-0.5">مشاهدهٔ صندوق ورودی</p>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}

interface SearchResults {
  centers: Array<{ id: string; name: string; city?: string | null }>;
  products: Array<{ id: string; code: string; name: string }>;
  documents: Array<{ id: string; documentNumber: string | null; documentType?: string; center?: { name: string } | null; finalAmount: number }>;
  /** v2.34.0 — global person search (spec §9: click → that person in contacts) */
  persons: Array<{ id: string; centerId: string; title: string; person: string | null; phone: string; centerName: string }>;
}

interface Notification {
  id: string;
  type: 'approval' | 'followup';
  title: string;
  detail: string;
  color: string;
  icon: React.ReactNode;
}

function toPersianNum(n: number | string): string {
  const d = '۰۱۲۳۴۵۶۷۸۹';
  return String(n).replace(/[0-9]/g, (c) => d[parseInt(c)]);
}

function formatCompact(amount: number): string {
  if (amount >= 1_000_000_000) return toPersianNum((amount / 1_000_000_000).toFixed(1)) + ' میلیارد';
  if (amount >= 1_000_000) return toPersianNum((amount / 1_000_000).toFixed(0)) + ' میلیون';
  return toPersianNum(Math.round(amount).toLocaleString('en-US'));
}

// ── Global search ──────────────────────────────────────────
// v2.26.0 — clicking a result now opens the EXACT entity (center detail
// dialog / product detail / the document's own tab pre-filtered by its
// number), instead of just landing on the module's list.
function GlobalSearch({ onNavigate }: { onNavigate?: TopNavbarProps['onNavigate'] }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResults>({ centers: [], products: [], documents: [], persons: [] });
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // All state updates (including the "too short" reset and setLoading) live
    // inside the debounced callback — an async context — so the effect body
    // stays free of synchronous setState (react-hooks/set-state-in-effect).
    const t = setTimeout(async () => {
      if (query.trim().length < 2) {
        if (!cancelled) {
          setResults({ centers: [], products: [], documents: [], persons: [] });
          setLoading(false);
        }
        return;
      }
      if (!cancelled) setLoading(true);
      try {
        const post = (route: string, body: Record<string, unknown>) =>
          fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then((r) => r.json())
            .catch(() => ({}));

        const [centersRes, productsRes, docsRes, personsRes] = await Promise.all([
          post('/api/centers', { action: 'list', search: query.trim(), pageSize: 4 }),
          post('/api/products', { action: 'list', search: query.trim(), pageSize: 4 }),
          post('/api/sales-documents', { action: 'list', search: query.trim(), pageSize: 4 }),
          post('/api/centers', { action: 'contacts-search', q: query.trim(), pageSize: 4 }),
        ]);

        if (!cancelled) {
          setResults({
            centers: centersRes.data || centersRes.items || [],
            products: productsRes.data || productsRes.items || [],
            documents: docsRes.data || docsRes.items || [],
            persons: personsRes.contacts || [],
          });
          setOpen(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350); // debounce
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  const total = results.centers.length + results.products.length + results.documents.length + results.persons.length;
  // v2.35.1 (round 61) — the Persian twin of a mistyped Latin query
  // («shk» → «سان»); rendered as an informative chip, never as a
  // replacement — the original text keeps searching too.
  const layoutFix = detectLayoutFix(query);
  const openPerson = (p: SearchResults['persons'][number]) => {
    setOpen(false);
    // spec §9 — clicking a person opens contacts filtered to THAT person
    onNavigate?.('centers-contacts', { type: 'person', id: p.id, label: p.person ?? '' });
  };

  const openCenter = (id: string) => {
    setOpen(false);
    onNavigate?.('centers-list', { type: 'center', id });
  };
  const openProduct = (id: string) => {
    setOpen(false);
    onNavigate?.('products-list', { type: 'product', id });
  };
  const openDocument = (d: SearchResults['documents'][number]) => {
    setOpen(false);
    // Route to the document's OWN tab (invoice / return / proforma) and
    // pre-fill the module's search with its number so the row is front
    // and center — previously every document opened the proforma list.
    const key = d.documentType === 'invoice' ? 'sales-invoices' : d.documentType === 'return' ? 'sales-returns' : 'sales-proformas';
    onNavigate?.(key, { type: 'document', id: d.id, label: d.documentNumber || '' });
  };

  return (
    <div ref={boxRef} className="relative flex-1 max-w-[min(28rem,calc(100vw-2rem))] min-w-0">
      <Search size={15} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => query.trim().length >= 2 && setOpen(true)}
        placeholder="جستجوی سراسری: شخص، مرکز، محصول، سند..."
        aria-label="جستجوی سراسری"
        className="w-full min-w-0 h-9 rounded-xl bg-gray-100/80 border border-transparent focus:border-teal-300 focus:bg-white focus:ring-2 focus:ring-teal-100 pr-9 pl-3 text-xs text-gray-700 placeholder:text-gray-400 transition-all outline-none"
      />
      {loading && <Loader2 size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 animate-spin" aria-label="در حال جستجو" />}

      {open && query.trim().length >= 2 && (
        <div className="absolute top-11 right-0 left-0 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150" role="listbox" aria-label="نتایج جستجو">
          {layoutFix && (
            <div className="mx-2 mt-2 px-2.5 py-1.5 rounded-lg bg-teal-50/80 border border-teal-100 text-[11px] text-teal-700 flex items-center gap-1.5">
              <Keyboard size={12} className="shrink-0" aria-hidden="true" />
              <span>چیدمان انگلیسی تشخیص داده شد — با «{layoutFix}» هم جستجو شد</span>
            </div>
          )}
          {total === 0 && !loading && (
            <p className="text-xs text-gray-400 text-center py-6">نتیجه‌ای یافت نشد</p>
          )}
          {results.persons.length > 0 && (
            <div className="p-2 border-b border-gray-50" data-search-persons>
              <p className="text-[11px] font-bold text-gray-400 px-2 py-1 flex items-center gap-1"><Contact2 size={11} /> اشخاص تماس</p>
              {results.persons.map((p) => (
                <button key={p.id} onClick={() => openPerson(p)} data-person-option={p.id}
                  className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-gray-50 text-xs min-h-[36px]">
                  <span className="font-bold text-gray-800 truncate">{p.person || p.title}</span>
                  <span className="text-[11px] text-gray-400 shrink-0 mr-2 truncate max-w-40">{p.centerName}</span>
                </button>
              ))}
            </div>
          )}
          {results.centers.length > 0 && (
            <div className="p-2 border-b border-gray-50">
              <p className="text-[11px] font-bold text-gray-400 px-2 py-1 flex items-center gap-1"><Building2 size={11} /> مراکز</p>
              {results.centers.map((c) => (
                <button key={c.id} onClick={() => openCenter(c.id)}
                  className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-gray-50 text-xs min-h-[36px]">
                  <span className="font-bold text-gray-800 truncate">{c.name}</span>
                  {c.city && <span className="text-[11px] text-gray-400 shrink-0 mr-2">{c.city}</span>}
                </button>
              ))}
            </div>
          )}
          {results.products.length > 0 && (
            <div className="p-2 border-b border-gray-50">
              <p className="text-[11px] font-bold text-gray-400 px-2 py-1 flex items-center gap-1"><Package size={11} /> محصولات</p>
              {results.products.map((p) => (
                <button key={p.id} onClick={() => openProduct(p.id)}
                  className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-gray-50 text-xs min-h-[36px]">
                  <span className="font-bold text-gray-800 truncate">{p.name}</span>
                  <span className="text-[11px] text-gray-400 font-mono shrink-0 mr-2" dir="ltr">{p.code}</span>
                </button>
              ))}
            </div>
          )}
          {results.documents.length > 0 && (
            <div className="p-2">
              <p className="text-[11px] font-bold text-gray-400 px-2 py-1 flex items-center gap-1"><FileText size={11} /> اسناد فروش</p>
              {results.documents.map((d) => (
                <button key={d.id} onClick={() => openDocument(d)}
                  className="w-full flex items-center justify-between px-2 py-2 rounded-lg hover:bg-gray-50 text-xs min-h-[36px]">
                  <span className="font-bold text-gray-800 truncate" dir="ltr">{d.documentNumber || d.id.slice(-8)}</span>
                  <span className="text-[11px] text-gray-500 shrink-0 mr-2">{formatCompact(d.finalAmount)} ریال</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Notifications ──────────────────────────────────────────
function NotificationsBell({ onNavigate }: { onNavigate?: TopNavbarProps['onNavigate'] }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [docsRes, followupsRes] = await Promise.all([
        fetch('/api/sales-documents', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'list', status: 'pending_approval', pageSize: 5 }),
        }).then((r) => r.json()).catch(() => ({})),
        fetch('/api/followups?status=overdue').then((r) => r.json()).catch(() => []),
      ]);

      const notifs: Notification[] = [];
      const pendingDocs = docsRes.data || [];
      if (pendingDocs.length > 0) {
        notifs.push({
          id: 'approvals',
          type: 'approval',
          title: `${toPersianNum(pendingDocs.length)} سند در انتظار تأیید`,
          detail: 'اسناد فروش آمادهٔ بررسی و تأیید شما هستند',
          color: '#6366f1',
          icon: <Clock size={15} />,
        });
      }
      const overdue = Array.isArray(followupsRes) ? followupsRes : [];
      if (overdue.length > 0) {
        const names = overdue.slice(0, 2).map((f: { centerName?: string }) => f.centerName || '').filter(Boolean);
        const more = overdue.length > 2 ? ` و ${toPersianNum(overdue.length - 2)} مرکز دیگر` : '';
        notifs.push({
          id: 'followups',
          type: 'followup',
          title: `${toPersianNum(overdue.length)} پیگیری سررسید گذشته`,
          detail: names.length > 0 ? `${names.join('، ')}${more} — موعد تماس رسیده است` : 'نیاز به تماس یا اقدام فوری دارد',
          color: '#dc2626',
          icon: <AlertTriangle size={15} />,
        });
      }
      setNotifications(notifs);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, []);

  // v2.26.0 — the SUMMARY (and therefore the unread badge) loads on mount;
  // before, the count only appeared after the user opened the bell once.
  // The full list still refreshes lazily on every open.
  useEffect(() => {
    // Deferred via microtask — keeps the synchronous setLoading at the top
    // of load() out of the effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => { void load(); });
  }, [load]);

  const toggle = () => {
    if (!open) void load();
    setOpen(!open);
  };

  const count = notifications.length;

  return (
    <div ref={boxRef} className="relative">
      <button onClick={toggle} className="relative text-gray-500 hover:text-gray-700 p-2.5 rounded-xl hover:bg-gray-100 transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center" title="اعلان‌ها" aria-label={`اعلان‌ها${count > 0 ? ` — ${count} اعلان فعال` : ''}`} aria-expanded={open}>
        <Bell size={18} />
        {count > 0 && (
          <span className="absolute top-1 left-1 min-w-[16px] h-4 px-1 bg-red-500 text-white text-[11px] font-bold rounded-full flex items-center justify-center">
            {toPersianNum(count)}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute top-12 left-0 w-80 max-w-[calc(100vw-1.5rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between">
            <p className="text-xs font-bold text-gray-800">مرکز اعلان‌ها</p>
            {loading && <Loader2 size={12} className="text-gray-400 animate-spin" aria-label="در حال دریافت" />}
          </div>
          {loading && !loadedOnce ? (
            <div className="py-8 text-center" aria-label="در حال دریافت اطلاعات">
              <Loader2 size={22} className="mx-auto mb-2 text-gray-300 animate-spin" />
              <p className="text-xs text-gray-400">در حال دریافت اطلاعات...</p>
            </div>
          ) : notifications.length === 0 ? (
            <div className="py-8 text-center">
              <CheckCircle2 size={24} className="mx-auto mb-2 text-emerald-400" />
              <p className="text-xs text-gray-400">همه‌چیز مرتب است — اعلان جدیدی ندارید</p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    onNavigate?.(n.type === 'approval' ? 'sales-proformas' : 'followup');
                  }}
                  className="w-full flex items-start gap-3 p-3 rounded-xl hover:bg-gray-50 text-right transition-colors"
                >
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: `${n.color}15`, color: n.color }}>
                    {n.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold text-gray-800">{n.title}</p>
                    <p className="text-[11px] text-gray-400 mt-0.5">{n.detail}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Theme switcher (v2.26.0 — next-themes was installed, never wired) ──
function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // Hydration-safe theme read (next-themes), deferred per lint policy.
    queueMicrotask(() => setMounted(true));
  }, []);

  const options: { key: string; label: string; icon: React.ReactNode }[] = [
    { key: 'light', label: 'روشن', icon: <Sun size={13} /> },
    { key: 'dark', label: 'تاریک', icon: <Moon size={13} /> },
    { key: 'system', label: 'سیستم', icon: <Monitor size={13} /> },
  ];

  return (
    <div className="flex items-center gap-0.5 p-1 rounded-xl bg-gray-100 dark:bg-white/5" role="radiogroup" aria-label="حالت نمایش">
      {options.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={mounted ? theme === o.key : o.key === 'light'}
          onClick={() => setTheme(o.key)}
          title={`حالت ${o.label}`}
          className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-[11px] font-medium transition-colors min-h-[28px] ${
            mounted && theme === o.key ? 'bg-white shadow-sm text-gray-900 dark:bg-white/15 dark:text-gray-100' : 'text-gray-500 hover:text-gray-700 dark:text-gray-400'
          }`}
        >
          {o.icon}
          <span className="hidden sm:inline">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ── User menu ──────────────────────────────────────────────
function UserMenu({ user, onLogout }: { user: TopNavbarProps['user']; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const changePassword = async () => {
    if (newPassword.length < 6) {
      setError('رمز جدید باید حداقل ۶ کاراکتر باشد');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'change-password', currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در تغییر رمز');
      setMessage('رمز عبور با موفقیت تغییر کرد');
      setCurrentPassword('');
      setNewPassword('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در تغییر رمز');
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;

  return (
    <div ref={boxRef} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2 p-1.5 rounded-xl hover:bg-gray-100 transition-colors min-h-[40px]" aria-label="منوی کاربر" aria-expanded={open}>
        <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0"
          style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
          {user.displayName.slice(0, 1)}
        </div>
        <div className="hidden sm:block text-right">
          <p className="text-xs font-bold text-gray-800 leading-tight">{user.displayName}</p>
          <p className="text-[11px] text-gray-400">{user.roleLabel}</p>
        </div>
        <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-12 left-0 w-64 max-w-[calc(100vw-1.5rem)] bg-white rounded-2xl shadow-xl border border-gray-100 z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="p-4 bg-gradient-to-l from-teal-50 to-white border-b border-gray-50">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold"
                style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                {user.displayName.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-900 truncate">{user.displayName}</p>
                <p className="text-[11px] text-gray-500 truncate">{user.roleLabel}{user.username ? ` — ${user.username}` : ''}</p>
              </div>
            </div>
          </div>

          {showChangePassword ? (
            <div className="p-3 space-y-2">
              {message && <p className="text-[11px] text-emerald-600 bg-emerald-50 rounded-lg p-2">{message}</p>}
              {error && <p className="text-[11px] text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
              <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="رمز فعلی" aria-label="رمز فعلی" className="w-full h-9 rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-teal-300" dir="ltr" />
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                placeholder="رمز جدید (حداقل ۶ کاراکتر)" aria-label="رمز جدید" className="w-full h-9 rounded-lg border border-gray-200 px-3 text-xs outline-none focus:border-teal-300" dir="ltr" />
              <div className="flex gap-2">
                <button onClick={changePassword} disabled={busy}
                  className="flex-1 h-9 rounded-lg text-white text-xs font-bold disabled:opacity-60" style={{ background: '#1F8B7D' }}>
                  {busy ? '...' : 'ثبت'}
                </button>
                <button onClick={() => { setShowChangePassword(false); setMessage(null); setError(null); }}
                  className="flex-1 h-9 rounded-lg border border-gray-200 text-gray-600 text-xs">بازگشت</button>
              </div>
            </div>
          ) : (
            <div className="p-2">
              <button onClick={() => setShowChangePassword(true)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-gray-50 text-xs text-gray-700 transition-colors">
                <KeyRound size={14} className="text-gray-400" /> تغییر رمز عبور
              </button>
              <button onClick={onLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-red-50 text-xs text-red-600 transition-colors">
                <LogOut size={14} /> خروج از حساب
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main navbar ────────────────────────────────────────────
export default function TopNavbar({ companyLabel, companyType, companyLogo, user, onLogout, onNavigate, onMenuClick, unreadCount = 0 }: TopNavbarProps) {
  return (
    <div className="flex items-center justify-between gap-3 h-14 px-3 sm:px-4 lg:px-6 bg-white border-b border-gray-100 sticky top-0 z-40">
      {/* Hamburger (mobile only) + company identity */}
      <div className="flex items-center gap-2 min-w-0">
        {onMenuClick && (
          <button onClick={onMenuClick} className="lg:hidden text-gray-600 hover:text-gray-800 p-2 rounded-xl hover:bg-gray-100 transition-colors min-w-[40px] min-h-[40px] flex items-center justify-center" title="منو" aria-label="باز کردن منوی اصلی">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        {/* v2.31.8 — active-company brand mark: official logo when the
            company has one (white tile + border so it reads on white),
            otherwise the generic building icon. */}
        {companyLogo ? (
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 bg-white border border-gray-200 overflow-hidden">
            <img src={companyLogo} alt="" className="w-full h-full object-contain p-[2.5px]" />
          </div>
        ) : (
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: 'linear-gradient(135deg, #1F8B7D22, #2E2A5C22)' }}>
            <Building2 size={15} className="text-teal-700" />
          </div>
        )}
        {/* v2.26.0 — the ACTIVE COMPANY is the single most important piece of
            multi-tenant context; it is now visible on every viewport (it was
            hidden below md, exactly where mistakes get made on the go). */}
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-900 leading-tight truncate">{companyLabel}</h2>
          <p className="text-[11px] text-gray-400 truncate hidden sm:block">{companyType}</p>
        </div>
      </div>

      {/* Global search */}
      <GlobalSearch onNavigate={onNavigate} />

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <UnreadMailIndicator unread={unreadCount} onNavigate={onNavigate} />
        <NotificationsBell onNavigate={onNavigate} />
        <div className="w-px h-6 bg-gray-100 mx-1 hidden sm:block" />
        <div className="hidden md:block"><ThemeSwitcher /></div>
        <UserMenu user={user} onLogout={onLogout} />
      </div>
    </div>
  );
}
