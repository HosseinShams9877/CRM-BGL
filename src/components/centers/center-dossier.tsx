'use client';

// ══════════════════════════════════════════════════════════════════
//  CENTER DOSSIER — پرونده اختصاصی مرکز (v2.34.8, round 55c)
//  «هر مرکز یک پرونده داشته باشه که تماس‌ها و پیگیری‌ها و کاریزهای
//   فعالش و پیش‌فاکتورها و فاکتورها و یادداشت‌ها و همه‌چیزشو بیاره —
//   و به صورت پاپ‌آپ باز نشه و یه صفحه اختصاصی داشته باشه.»
//
//  A DEDICATED FULL PAGE per center — replaces the old detail POPUP
//  (center-detail-dialog). Reached via ?module=center-dossier&focus=
//  center:ID, so Refresh / Back / Forward / Bookmark / share-link all
//  work. Aggregates EVERY tenant-scoped record about one center:
//    • master data + contacts + buyer identity + tags + files
//    • کاریز فروش (sales pipeline stages, respects the v2.34.6
//      per-user personalized stage titles/order/visibility)
//    • پیش‌فاکتورها و فاکتورها (sales documents) + فاکتورهای صادره
//      (billing/issued invoices, when the viewer has permission)
//    • تماس‌ها و فعالیت‌ها (activities incl. phone calls + voice notes)
//    • پیگیری‌های دوره‌ای (periodic followups + history counters)
//    • مراجعات حضوری (visits)
//    • یادداشت‌ها (center notes + رگ خواب observations per contact)
//
//  Isolation: every endpoint this page calls is tenant- and
//  permission-gated SERVER-SIDE (centers/get, sales-documents/list,
//  followups?centerId=, activities/list, visits/list, billing/list,
//  files/list, shipments/list). A hand-crafted deep link for another
//  tenant's center simply renders «مرکز یافت نشد» (404 — no existence
//  leak). Permission denials degrade per-tab, never block the page.
// ══════════════════════════════════════════════════════════════════

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ArrowRight, Phone, Star, MapPin, Globe, Edit3, Contact2, Tag,
  Loader2, RefreshCw, Building2, PhoneCall, CalendarClock, Receipt,
  FileCheck, StickyNote, Handshake, Mic, CheckCircle2, Circle, XCircle,
  UserRound, ChevronDown, ExternalLink, Wallet, Briefcase, FileText,
  ClipboardList, Search, Package,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  CATEGORY_CFG, Center, GRADE_CFG, STATUS_CFG, TYPE_BADGE, SEGMENT_BADGE,
  BEHAVIOR_BADGE, toPersianNum, formatCurrency,
} from './types';
import { adaptCenter, ApiCenter } from './api';
import { BusinessBadges } from './business-badges';
import { CenterFiles } from './center-files';
import { CenterEditDialog } from './center-edit-dialog';
import { PROFORMA_STATUS, INVOICE_STATUS, jdate, formatCompact } from '../sales-docs-shared';
import { toJalaliString } from '@/lib/jalali';
import { parseActivityProducts } from '@/lib/activity-products';
// v2.45.0 — manual drag & drop stage pin resolution (mirrors the board)
import { effectiveStage } from '@/lib/pipeline-stage-override';
import { apiCall, listAllPages } from '@/hooks/use-api';

// ── Related-record shapes (subset of what the APIs return) ──
interface DossierActivity {
  id: string;
  title: string;
  description: string;
  activityDate: string;
  activityTime: string;
  status: string; // pending | done | cancelled
  isPhoneCall: boolean;
  isOnsiteVisit: boolean;
  isUnansweredCall: boolean;
  voiceNoteFileId?: string | null;
  voiceTranscript?: string;
  // v2.34.9 — optional product-tag snapshot "[{id,name}]" (round 56).
  products?: string;
  assignedUser?: { id: string; displayName: string } | null;
  creator?: { id: string; displayName: string } | null;
}

interface DocRow {
  id: string;
  documentNumber: string | null;
  documentType: 'proforma' | 'invoice' | 'return';
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
  totalAmount: number;
  finalAmount: number;
  issuedAt: string | null;
  createdAt: string;
  centerId: string | null;
  // v2.45.0 — manual drag & drop stage pin from the pipeline board
  pipelineStage?: string | null;
  center?: { id: string; name: string; customerType?: string } | null;
  creator?: { id: string; displayName: string } | null;
  _count: { items: number; approvals: number; financeRecords: number; logs: number };
}

interface FollowupRow {
  id: string;
  personName: string;
  phone: string | null;
  frequency: string;
  frequencyDays: number;
  nextFollowupDate: string | null;
  daysOverdue: number;
  totalFollowups: number;
  status: string; // derived: overdue | today | upcoming | done
  history: { method: string; result: string | null; createdAt: string }[];
  _count: { history: number; notes: number };
}

interface VisitRow {
  id: string;
  date: string;
  time: string;
  purpose: string;
  result: string;
  nextAction: string;
  assignedToName: string;
  status: 'planned' | 'done' | 'cancelled';
  createdAt: string;
}

interface IssuedInvoiceRow {
  id: string;
  invoiceNumber: string | null;
  status: string; // issued | paid | void
  totalAmount: number;
  paidAmount: number;
  issuedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  payments?: Array<{ id: string; amount: number; paymentDate: string | null }>;
}

interface ShipmentLite {
  id: string;
  salesDocumentId: string;
  status: string;
}

interface ProfileNote {
  id: string;
  contactId: string;
  category: string;
  content: string;
  createdByName: string | null;
  createdAt: string;
}

// ── Pipeline stages (mirrors sales-pipeline.tsx semantics; the titles
//    respect the v2.34.6 per-user personalization fetched from /api/pipeline) ──
type StageKey =
  | 'presentation' | 'negotiation' | 'proforma' | 'proforma-followup'
  | 'invoice' | 'dispatch' | 'procurement' | 'cancelled';

const STAGES: Array<{ key: StageKey; label: string; color: string; bg: string; border: string }> = [
  { key: 'presentation', label: 'تماس اولیه / پرزنت', color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe' },
  { key: 'negotiation', label: 'پیگیری مذاکرات', color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc' },
  { key: 'proforma', label: 'صدور پیش‌فاکتور', color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  { key: 'proforma-followup', label: 'پیگیری صدور پیش‌فاکتور', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  { key: 'invoice', label: 'فاکتور', color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
  { key: 'dispatch', label: 'ارسال بار', color: '#1F8B7D', bg: '#ecfdf5', border: '#99f6e4' },
  { key: 'procurement', label: 'سامانهٔ تدارکات', color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
];

const CANCELLED_STAGE = {
  key: 'cancelled' as StageKey,
  label: 'لغو شده',
  color: '#9ca3af',
  bg: '#f9fafb',
  border: '#e5e7eb',
};

interface UserStage { key: StageKey; title: string; visible: boolean }

/** Live status → stage mapping — same rules as the main pipeline board.
 *  v2.45.0 — plus the manual drag & drop pin: a document the user moved
 *  with the mouse on the board shows in ITS PINNED column here too
 *  (stageOfDoc below is the resolution point). */
function stageOf(doc: DocRow, dispatchStatus?: string | null): StageKey {
  const isProcurement = (doc.documentNumber || '').includes('PROC') || (doc.center?.name || '').includes('تدارکات');
  if (isProcurement) return 'procurement';
  if (doc.status === 'cancelled') return 'cancelled';
  if (doc.documentType === 'invoice') return dispatchStatus ? 'dispatch' : 'invoice';
  switch (doc.status) {
    case 'draft': return 'proforma';
    case 'pending_approval': return 'proforma-followup';
    case 'approved': return dispatchStatus ? 'dispatch' : 'invoice';
    case 'rejected': return 'negotiation';
    default: return 'proforma';
  }
}

const DISPATCH_RANK: Record<string, number> = {
  preparing: 1, ready: 2, 'in-transit': 3, delivered: 4,
};

function buildDispatchStatusMap(shipments: ShipmentLite[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of shipments) {
    if (!DISPATCH_RANK[s.status]) continue; // returned / unknown → not a dispatch
    const prev = map.get(s.salesDocumentId);
    if (!prev || DISPATCH_RANK[s.status] > DISPATCH_RANK[prev]) {
      map.set(s.salesDocumentId, s.status);
    }
  }
  return map;
}

// ── Label maps (kept local & consistent with their source modules) ──
const ACTIVITY_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: 'در انتظار', color: '#d97706', bg: '#fffbeb' },
  done: { label: 'انجام شده', color: '#059669', bg: '#ecfdf5' },
  cancelled: { label: 'لغو شده', color: '#9ca3af', bg: '#f9fafb' },
};

const FOLLOWUP_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  overdue: { label: 'سررسید گذشته', color: '#dc2626', bg: '#fef2f2' },
  today: { label: 'امروز', color: '#d97706', bg: '#fffbeb' },
  upcoming: { label: 'آینده', color: '#2563eb', bg: '#eff6ff' },
  done: { label: 'انجام شده', color: '#059669', bg: '#ecfdf5' },
};

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'هفتگی', biweekly: 'دوهفته‌یکبار', monthly: 'ماهانه', bimonthly: 'دوماهانه',
};

const METHOD_LABELS: Record<string, string> = {
  phone: 'تلفن', visit: 'مراجعه حضوری', whatsapp: 'واتساپ', email: 'ایمیل',
};

const VISIT_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  planned: { label: 'برنامه‌ریزی‌شده', color: '#2563eb', bg: '#eff6ff' },
  done: { label: 'انجام شد', color: '#059669', bg: '#ecfdf5' },
  cancelled: { label: 'لغو شد', color: '#9ca3af', bg: '#f9fafb' },
};

const ISSUED_STATUS: Record<string, { label: string; color: string; bg: string }> = {
  issued: { label: 'صادر شده', color: '#2563eb', bg: '#eff6ff' },
  paid: { label: 'پرداخت شده', color: '#059669', bg: '#ecfdf5' },
  void: { label: 'باطل‌شده', color: '#9ca3af', bg: '#f9fafb' },
};

const SHIPMENT_LABELS: Record<string, string> = {
  preparing: 'در حال آماده‌سازی', ready: 'آماده ارسال', 'in-transit': 'در مسیر', delivered: 'تحویل شد',
};

const NOTE_CATEGORY: Record<string, { label: string; color: string; bg: string }> = {
  trait: { label: 'خلق‌وخو', color: '#6366f1', bg: '#eef2ff' },
  interest: { label: 'علایق', color: '#059669', bg: '#ecfdf5' },
  sensitivity: { label: 'حساسیت‌ها', color: '#dc2626', bg: '#fef2f2' },
  communication: { label: 'سبک ارتباط', color: '#0891b2', bg: '#ecfeff' },
  general: { label: 'عمومی', color: '#6b7280', bg: '#f3f4f6' },
};

type DossierTab =
  | 'overview' | 'pipeline' | 'proformas' | 'invoices'
  | 'activities' | 'followups' | 'visits' | 'notes' | 'files';

// ── Tiny building blocks ──────────────────────────────────────
function StatusPill({ cfg }: { cfg: { label: string; color: string; bg: string } }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full font-medium shrink-0" style={{ background: cfg.bg, color: cfg.color }}>
      {cfg.label}
    </span>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="border border-dashed border-gray-200 rounded-xl py-8 text-center">
      <div className="mx-auto mb-2 w-10 h-10 rounded-full bg-gray-50 flex items-center justify-center text-gray-300">{icon}</div>
      <p className="text-xs text-gray-400">{text}</p>
    </div>
  );
}

/** A tab body whose whole data source was denied by permissions. */
function DeniedNote({ text }: { text: string }) {
  return (
    <div className="bg-amber-50 border border-amber-100 rounded-xl p-4 text-center">
      <p className="text-xs text-amber-700">{text}</p>
    </div>
  );
}

function KpiCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 min-w-0">
      <div className="w-9 h-9 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] text-gray-400 truncate">{label}</p>
        <p className="text-sm font-bold text-gray-900 truncate" title={value}>{value}</p>
        {hint && <p className="text-[10px] text-gray-400 truncate">{hint}</p>}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════
type DossierState = 'loading' | 'ready' | 'notfound' | 'error' | 'noid';

/** Raw /api/centers `get` row: the ApiCenter list shape PLUS the
 *  relation include (account, recent activities, buyer-identity columns). */
interface DossierCenter extends ApiCenter {
  nationalId?: string | null;
  economicCode?: string | null;
  postalCode?: string | null;
  contactName?: string | null;
  address?: string | null;
  accounts?: Array<{ id: string; totalSales: number; totalPaid: number; balance: number }>;
  activities?: DossierActivity[];
}

export function CenterDossier({ centerId, onBack }: { centerId?: string; onBack: () => void }) {
  const [state, setState] = useState<DossierState>('loading');
  const [loadError, setLoadError] = useState<string>('');
  const [center, setCenter] = useState<DossierCenter | null>(null);
  const [account, setAccount] = useState<{ id: string; totalSales: number; totalPaid: number; balance: number } | null>(null);
  const [recentActivities, setRecentActivities] = useState<DossierActivity[]>([]);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [docsDenied, setDocsDenied] = useState(false);
  const [followups, setFollowups] = useState<FollowupRow[]>([]);
  const [activities, setActivities] = useState<DossierActivity[] | null>(null);
  const [visits, setVisits] = useState<VisitRow[]>([]);
  const [issuedInvoices, setIssuedInvoices] = useState<IssuedInvoiceRow[] | null>(null);
  const [dispatchMap, setDispatchMap] = useState<Map<string, string>>(new Map());
  const [userStages, setUserStages] = useState<UserStage[] | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [showEdit, setShowEdit] = useState(false);
  const [activeTab, setActiveTab] = useState<DossierTab>('overview');

  // ── Load everything (failures degrade per-section, never block the page) ──
  const load = useCallback(async (id: string) => {
    setState('loading');
    setLoadError('');
    try {
      // 1) Center core — 404/403 = «not found or out of scope» (no leak)
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', id }),
      });
      if (res.status === 404 || res.status === 403) { setState('notfound'); return; }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت پرونده مرکز');
      const c = data.data as DossierCenter;
      setCenter(c);
      setAccount(c.accounts?.[0] ?? null);
      setRecentActivities(Array.isArray(c.activities) ? c.activities : []);

      // 2) Secondary sources — all parallel, each fail-safe
      const docsTask = listAllPages<DocRow>('/api/sales-documents', 'list', { centerId: id }, 10)
        .then((all) => { setDocs(all); setDocsDenied(false); })
        .catch(() => { setDocs([]); setDocsDenied(true); });

      const followupsTask = fetch(`/api/followups?centerId=${encodeURIComponent(id)}`)
        .then(async (r) => { if (!r.ok) throw new Error('denied'); return r.json(); })
        .then((rows: FollowupRow[]) => setFollowups(Array.isArray(rows) ? rows : []))
        .catch(() => setFollowups([]));

      const activitiesTask = listAllPages<DossierActivity>('/api/activities', 'list', { centerId: id, pageSize: 100 }, 10)
        .then((rows) => setActivities(rows))
        .catch(() => setActivities(null)); // null → fall back to embedded 10

      const visitsTask = apiCall<{ visits: VisitRow[] }>('/api/visits', 'list', { centerId: id })
        .then((d) => setVisits(Array.isArray(d.visits) ? d.visits : []))
        .catch(() => setVisits([]));

      const billingTask = (async () => {
        const accId = c.accounts?.[0]?.id;
        if (!accId) { setIssuedInvoices([]); return; }
        try {
          const d = await apiCall<{ items: IssuedInvoiceRow[] }>('/api/billing', 'list', { centerAccountId: accId, pageSize: 100 });
          setIssuedInvoices(Array.isArray(d.items) ? d.items : []);
        } catch {
          setIssuedInvoices(null); // accounting permission missing — hide section
        }
      })();

      const shipmentsTask = listAllPages<ShipmentLite>('/api/shipments', 'list', {}, 5)
        .then((rows) => setDispatchMap(buildDispatchStatusMap(rows)))
        .catch(() => setDispatchMap(new Map()));

      const stagesTask = fetch('/api/pipeline')
        .then(async (r) => { if (!r.ok) return; const d = await r.json(); setUserStages(Array.isArray(d.stages) ? d.stages : null); })
        .catch(() => { /* system defaults */ });

      await Promise.allSettled([docsTask, followupsTask, activitiesTask, visitsTask, billingTask, shipmentsTask, stagesTask]);
      setState('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'خطا در دریافت پرونده مرکز');
      setState('error');
    }
  }, []);

  // latest-ref mount pattern (same convention as sales-centers)
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    if (!centerId) {
      // deferred setState (react-hooks/set-state-in-effect)
      queueMicrotask(() => setState('noid'));
      return;
    }
    queueMicrotask(() => { void loadRef.current(centerId); });
  }, [centerId, reloadTick]);

  // a NEW center (deep link / another پرونده) starts on the overview tab;
  // reloads keep the current tab so به‌روزرسانی doesn't reset the view
  useEffect(() => {
    queueMicrotask(() => setActiveTab('overview'));
  }, [centerId]);

  // ── Personalized stage list (same resolution as the pipeline board) ──
  const effectiveStages = useMemo(() => {
    const base = [...STAGES, CANCELLED_STAGE];
    if (!userStages) return base;
    const metaByKey = new Map(base.map((s) => [s.key, s]));
    const out: typeof base = [];
    for (const cfg of userStages) {
      const meta = metaByKey.get(cfg.key);
      if (meta) out.push({ ...meta, label: cfg.title });
    }
    for (const s of base) if (!out.some((o) => o.key === s.key)) out.push(s);
    return out;
  }, [userStages]);

  // ── Derived values ──
  const adapted: Center | null = useMemo(() => (center ? adaptCenter(center) : null), [center]);

  const docsByStage = useMemo(() => {
    const map = new Map<StageKey, DocRow[]>();
    for (const s of [...STAGES, CANCELLED_STAGE]) map.set(s.key, []);
    for (const d of docs) {
      // v2.45.0 — manual drag & drop pin wins over the derived stage, so
      // the center's pipeline view mirrors the board the user re-arranged.
      const stage = effectiveStage(stageOf(d, dispatchMap.get(d.id)), d.pipelineStage, d.status);
      map.get(stage)?.push(d);
    }
    return map;
  }, [docs, dispatchMap]);

  const proformas = useMemo(() => docs.filter((d) => d.documentType === 'proforma'), [docs]);
  const invoiceDocs = useMemo(() => docs.filter((d) => d.documentType === 'invoice'), [docs]);
  const returns = useMemo(() => docs.filter((d) => d.documentType === 'return'), [docs]);

  const openPipelineValue = useMemo(() => docs
    .filter((d) => !['cancelled', 'rejected'].includes(d.status))
    .reduce((s, d) => s + (d.finalAmount || d.totalAmount || 0), 0), [docs]);

  const totalSalesValue = useMemo(
    () => account?.totalSales || invoiceDocs
      .filter((d) => d.status === 'approved')
      .reduce((s, d) => s + (d.finalAmount || d.totalAmount || 0), 0),
    [account, invoiceDocs]
  );

  const allActivities = useMemo(() => {
    if (activities) return activities;
    return recentActivities; // permission fallback: the 10 embedded rows
  }, [activities, recentActivities]);

  const callCount = useMemo(() => allActivities.filter((a) => a.isPhoneCall).length, [allActivities]);
  const lastActivityAt = useMemo(
    () => allActivities[0]?.activityDate
      ?? center?.updatedAt
      ?? null,
    [allActivities, center]
  );

  // favorite toggle — same optimistic pattern as the centers list
  const [favBusy, setFavBusy] = useState(false);
  const toggleFavorite = () => {
    if (!adapted || !centerId) return;
    setFavBusy(true);
    void (async () => {
      try {
        const res = await fetch('/api/centers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'favorite', id: centerId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'خطا در به‌روزرسانی وضعیت نشان‌کردن');
        toast.success(data.isFavorite ? 'به موارد مورد علاقه اضافه شد' : 'از موارد مورد علاقه حذف شد');
        await loadRef.current(centerId); // re-read the persisted customFields
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'خطا در به‌روزرسانی وضعیت نشان‌کردن');
      } finally {
        setFavBusy(false);
      }
    })();
  };

  // ── Non-ready states ──
  if (state === 'noid') {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-12 text-center">
        <Building2 size={36} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm font-bold text-gray-700 mb-1">مرکزی انتخاب نشده است</p>
        <p className="text-xs text-gray-400 mb-4">از فهرست مراکز یک مرکز را برای مشاهدهٔ پروندهٔ کامل انتخاب کنید.</p>
        <Button onClick={onBack} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg"><ArrowRight size={13} /> بازگشت</Button>
      </div>
    );
  }

  if (state === 'notfound') {
    return (
      <div className="bg-white rounded-xl border border-gray-100 p-12 text-center" role="alert">
        <Search size={36} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm font-bold text-gray-700 mb-1">مرکز یافت نشد</p>
        <p className="text-xs text-gray-400 mb-4">این مرکز وجود ندارد یا در محدودهٔ دسترسی شما نیست.</p>
        <Button onClick={onBack} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg"><ArrowRight size={13} /> بازگشت به مراکز</Button>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="bg-white rounded-xl border border-red-100 p-10 text-center" role="alert">
        <p className="text-sm text-red-600 mb-3">{loadError || 'خطا در دریافت پرونده مرکز'}</p>
        <div className="flex items-center justify-center gap-2">
          <Button onClick={() => setReloadTick((t) => t + 1)} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg"><RefreshCw size={13} /> تلاش مجدد</Button>
          <Button onClick={onBack} variant="outline" className="h-9 gap-1.5 text-xs rounded-lg"><ArrowRight size={13} /> بازگشت</Button>
        </div>
      </div>
    );
  }

  if (state === 'loading' || !adapted || !center) {
    return (
      <div className="space-y-4" aria-label="در حال دریافت پرونده مرکز">
        <div className="bg-white rounded-xl border border-gray-100 p-5 animate-pulse">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-xl bg-gray-200" />
            <div className="flex-1 space-y-2"><div className="h-5 w-1/3 rounded bg-gray-200" /><div className="h-3 w-1/2 rounded bg-gray-100" /></div>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="h-16 rounded-xl bg-white border border-gray-100 animate-pulse" />)}
        </div>
        <div className="h-64 rounded-xl bg-white border border-gray-100 animate-pulse" />
      </div>
    );
  }

  const cat = CATEGORY_CFG[adapted.category];
  const st = STATUS_CFG[adapted.status];
  const gr = GRADE_CFG[adapted.grade];
  const account2 = account;

  const TABS: Array<{ key: DossierTab; label: string; icon: React.ReactNode; count?: number }> = [
    { key: 'overview', label: 'خلاصه و مشخصات', icon: <Building2 size={13} /> },
    { key: 'pipeline', label: 'کاریز فروش', icon: <Handshake size={13} />, count: docs.length },
    { key: 'proformas', label: 'پیش‌فاکتورها', icon: <FileCheck size={13} />, count: proformas.length },
    { key: 'invoices', label: 'فاکتورها', icon: <Receipt size={13} />, count: invoiceDocs.length + (issuedInvoices?.length || 0) },
    { key: 'activities', label: 'تماس‌ها و فعالیت‌ها', icon: <PhoneCall size={13} />, count: allActivities.length },
    { key: 'followups', label: 'پیگیری‌های دوره‌ای', icon: <CalendarClock size={13} />, count: followups.length },
    { key: 'visits', label: 'مراجعات حضوری', icon: <ClipboardList size={13} />, count: visits.length },
    { key: 'notes', label: 'یادداشت‌ها و رگ خواب', icon: <StickyNote size={13} /> },
    { key: 'files', label: 'فایل‌ها', icon: <FileText size={13} /> },
  ];

  return (
    <div className="space-y-4" dir="rtl">
      {/* ── Header — the center's identity card ── */}
      <div className="bg-white rounded-xl border border-gray-100 p-4 lg:p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <Button onClick={onBack} variant="outline" className="h-8 gap-1.5 text-xs rounded-lg px-3">
            <ArrowRight size={13} /> بازگشت به فهرست مراکز
          </Button>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setReloadTick((t) => t + 1)}
              variant="outline"
              className="h-8 gap-1.5 text-xs rounded-lg px-3"
              aria-label="بارگذاری مجدد پرونده"
            >
              <RefreshCw size={13} /> به‌روزرسانی
            </Button>
            <Button
              onClick={() => setShowEdit(true)}
              className="h-8 gap-1.5 text-xs rounded-lg px-4 text-white"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
            >
              <Edit3 size={13} /> ویرایش مرکز
            </Button>
          </div>
        </div>

        <div className="flex items-start gap-4 flex-wrap">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0" style={{ background: cat.bg, color: cat.color }}>
            {cat.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-black text-gray-900">{adapted.name}</h1>
              <button
                onClick={toggleFavorite}
                disabled={favBusy}
                aria-label={adapted.isFavorite ? 'حذف از موارد مورد علاقه' : 'افزودن به موارد مورد علاقه'}
                className="text-gray-300 hover:text-amber-400 transition-colors disabled:opacity-50"
              >
                {favBusy ? <Loader2 size={16} className="animate-spin" /> : <Star size={16} className={adapted.isFavorite ? 'fill-amber-400 text-amber-400' : ''} />}
              </button>
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <StatusPill cfg={{ label: cat.label, color: cat.color, bg: cat.bg }} />
              <StatusPill cfg={st} />
              <div className="flex items-center gap-0.5">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Star key={i} size={11} className={i < gr.stars ? 'fill-amber-400 text-amber-400' : 'text-gray-200'} />
                ))}
                <span className="text-[11px] text-gray-500 mr-1">رتبه {gr.label}</span>
              </div>
              <BusinessBadges center={adapted} />
            </div>
            <div className="flex items-center gap-3 mt-2 flex-wrap text-xs text-gray-500">
              {(adapted.city !== '—' || adapted.province !== '—') && (
                <span className="flex items-center gap-1"><MapPin size={12} /> {[adapted.province, adapted.city].filter((x) => x !== '—').join('، ')}</span>
              )}
              {adapted.phone !== '—' && (
                <a href={`tel:${adapted.phone}`} className="flex items-center gap-1 text-teal-600 hover:underline" dir="ltr"><Phone size={12} /> {adapted.phone}</a>
              )}
              {adapted.mobile && (
                <a href={`tel:${adapted.mobile}`} className="flex items-center gap-1 text-teal-600 hover:underline" dir="ltr"><Phone size={12} /> {adapted.mobile}</a>
              )}
              {adapted.website && (
                <a href={`https://${adapted.website}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-teal-600 hover:underline">
                  <Globe size={12} /> {adapted.website} <ExternalLink size={9} />
                </a>
              )}
              <span className="text-gray-400">آخرین به‌روزرسانی: {toJalaliString(center.updatedAt)}</span>
            </div>
          </div>
          {center.phone ? (
            <a
              href={`tel:${center.phone}`}
              className="h-10 px-4 inline-flex items-center gap-2 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors shrink-0"
            >
              <Phone size={14} /> تماس
            </a>
          ) : null}
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard icon={<Wallet size={16} />} label="فروش کل" value={formatCurrency(totalSalesValue)} />
        <KpiCard
          icon={<Receipt size={16} />}
          label="مانده حساب"
          value={account2 ? formatCurrency(account2.balance) : formatCurrency(0)}
          hint={account2 ? `پرداختی: ${formatCompact(account2.totalPaid)}` : undefined}
        />
        <KpiCard icon={<FileCheck size={16} />} label="پیش‌فاکتورهای باز" value={toPersianNum(proformas.filter((d) => !['cancelled', 'rejected'].includes(d.status)).length)} hint={`ارزش: ${formatCompact(openPipelineValue)} ریال`} />
        <KpiCard icon={<Receipt size={16} />} label="فاکتورهای فروش" value={toPersianNum(invoiceDocs.length)} />
        <KpiCard icon={<PhoneCall size={16} />} label="تماس‌های ثبت‌شده" value={toPersianNum(callCount)} />
        <KpiCard icon={<CalendarClock size={16} />} label="آخرین فعالیت" value={lastActivityAt ? toJalaliString(lastActivityAt) : '—'} />
      </div>

      {/* ── Tab bar ── */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 flex-wrap" role="tablist" aria-label="بخش‌های پرونده مرکز">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all min-h-[36px] ${
                activeTab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.icon}
              {t.label}
              {typeof t.count === 'number' && (
                <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${activeTab === t.key ? 'bg-teal-100 text-teal-700' : 'bg-gray-200 text-gray-500'}`}>
                  {toPersianNum(t.count)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ══════════ TAB: OVERVIEW ══════════ */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Master data */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2"><Building2 size={15} className="text-teal-600" /> مشخصات مرکز</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">آدرس</p>
                  <p className="text-sm text-gray-700">{center.address || (adapted.address !== '—' ? adapted.address : 'ثبت نشده')}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">تلفن ثابت</p>
                  <p className="text-sm text-gray-700" dir="ltr">{center.phone || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">استان / شهر</p>
                  <p className="text-sm text-gray-700">{[adapted.province, adapted.city].filter((x) => x !== '—').join('، ') || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">موبایل</p>
                  <p className="text-sm text-gray-700" dir="ltr">{center.mobile || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">شناسه ملی / کد ملی</p>
                  <p className="text-sm text-gray-700" dir="ltr">{center.nationalId || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">کد اقتصادی</p>
                  <p className="text-sm text-gray-700" dir="ltr">{center.economicCode || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">کد پستی</p>
                  <p className="text-sm text-gray-700" dir="ltr">{center.postalCode || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">کارشناس خرید (طرف مقابل)</p>
                  <p className="text-sm text-gray-700">{center.contactName || '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">درصد کمیسیون همکاری</p>
                  <p className="text-sm text-gray-700">{center.commissionPercent ? toPersianNum(center.commissionPercent) + '٪' : '—'}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 mb-0.5">امتیاز باشگاه مشتریان</p>
                  <p className="text-sm text-gray-700">{toPersianNum(center.loyaltyPoints || 0)}</p>
                </div>
              </div>
              {adapted.tags.length > 0 && (
                <div className="mt-4 pt-3 border-t border-gray-50">
                  <p className="text-[11px] text-gray-400 mb-1.5 flex items-center gap-1"><Tag size={11} /> برچسب‌ها</p>
                  <div className="flex flex-wrap gap-2">
                    {adapted.tags.map((tag, i) => (
                      <span key={i} className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 font-medium">{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Contacts */}
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                <Contact2 size={15} className="text-teal-600" /> اشخاص تماس ({toPersianNum(adapted.contacts.length)})
              </h3>
              {adapted.contacts.length === 0 ? (
                <EmptyState icon={<Contact2 size={16} />} text="هنوز شخص تماسی برای این مرکز ثبت نشده است" />
              ) : (
                <div className="space-y-2">
                  {adapted.contacts.map((contact) => (
                    <div key={contact.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                        {contact.fullName.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-gray-900">{contact.fullName}</span>
                          {contact.isAgent && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 font-medium">رابط</span>}
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">{contact.role}{contact.notes ? ` — ${contact.notes}` : ''}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {contact.phone && (
                          <a href={`tel:${contact.phone}`} aria-label={`تماس با ${contact.fullName}`} className="w-8 h-8 rounded-lg bg-green-50 text-green-600 flex items-center justify-center hover:bg-green-100 transition-colors">
                            <Phone size={14} />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Center notes */}
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2"><StickyNote size={15} className="text-teal-600" /> یادداشت مرکز</h3>
              {adapted.notes ? (
                <p className="text-sm text-gray-600 leading-7 bg-gray-50 rounded-xl p-3 whitespace-pre-wrap">{adapted.notes}</p>
              ) : (
                <p className="text-xs text-gray-400">یادداشتی برای این مرکز ثبت نشده است — از دکمهٔ «ویرایش مرکز» می‌توانید افزود.</p>
              )}
            </div>
          </div>

          {/* Side: business snapshot */}
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2"><Briefcase size={15} className="text-teal-600" /> وضعیت کسب‌وکار</h3>
              <div className="space-y-2.5">
                {[
                  { label: 'نوع مشتری', cfg: TYPE_BADGE[adapted.customerType] },
                  adapted.segment ? { label: 'بخش', cfg: SEGMENT_BADGE[adapted.segment] } : null,
                  { label: 'رفتار حساب', cfg: BEHAVIOR_BADGE[adapted.paymentBehavior] || BEHAVIOR_BADGE.unknown },
                ].filter(Boolean).map((row) => (
                  <div key={row!.label} className="flex items-center justify-between">
                    <span className="text-xs text-gray-500">{row!.label}</span>
                    <StatusPill cfg={row!.cfg} />
                  </div>
                ))}
                <div className="flex items-center justify-between pt-2 border-t border-gray-50">
                  <span className="text-xs text-gray-500">تاریخ ثبت مرکز</span>
                  <span className="text-xs text-gray-700">{toJalaliString(center.createdAt)}</span>
                </div>
              </div>
            </div>

            {/* v2.44.0 (round 69) — «تماسی که ثبت شد بره تو مرکز، در قسمت آخرین
                فعالیت‌هایی که اون مرکز داشته نمایش داده بشه»: the center's
                latest activities (phone calls first-class, same badges as the
                activities tab) directly on the overview, so a call logged in
                ثبت تماس with this center selected is visible here immediately
                (newest first). «مشاهدهٔ همه» jumps to the full history tab. */}
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                <CalendarClock size={15} className="text-teal-600" /> آخرین فعالیت‌ها
              </h3>
              {allActivities.length === 0 ? (
                <EmptyState icon={<PhoneCall size={16} />} text="هنوز فعالیتی برای این مرکز ثبت نشده است" />
              ) : (
                <div className="space-y-2">
                  {allActivities.slice(0, 10).map((a) => {
                    const cfg = ACTIVITY_STATUS[a.status] || ACTIVITY_STATUS.pending;
                    const StatusIcon = a.status === 'done' ? CheckCircle2 : a.status === 'cancelled' ? XCircle : Circle;
                    return (
                      <div key={a.id} className="flex items-start gap-2.5 p-2.5 bg-gray-50 rounded-xl">
                        <div className="w-7 h-7 rounded-lg bg-white border border-gray-100 flex items-center justify-center shrink-0 mt-0.5" style={{ color: cfg.color }}>
                          <StatusIcon size={13} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-xs font-bold text-gray-800 truncate" title={a.title}>{a.title}</span>
                            {a.isPhoneCall && <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-50 text-blue-600 font-medium">تماس</span>}
                            {a.isUnansweredCall && <span className="text-[10px] px-1.5 py-px rounded-full bg-red-50 text-red-600 font-medium">بی‌پاسخ</span>}
                            {a.isOnsiteVisit && <span className="text-[10px] px-1.5 py-px rounded-full bg-teal-50 text-teal-700 font-medium">حضوری</span>}
                            {a.voiceNoteFileId && <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-50 text-violet-600 font-medium flex items-center gap-0.5"><Mic size={9} /> ویس</span>}
                          </div>
                          <p className="text-[11px] text-gray-400 mt-0.5">
                            {toJalaliString(a.activityDate)}{a.activityTime ? ` ساعت ${toPersianNum(a.activityTime)}` : ''}
                            {a.assignedUser?.displayName ? ` · ${a.assignedUser.displayName}` : ''}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <Button
                onClick={() => setActiveTab('activities')}
                variant="outline"
                disabled={allActivities.length === 0}
                aria-label="رفتن به تب تماس‌ها و فعالیت‌ها"
                className="w-full h-9 gap-1.5 text-xs rounded-lg mt-3"
              >
                <PhoneCall size={13} /> مشاهدهٔ همهٔ فعالیت‌ها ({toPersianNum(allActivities.length)})
              </Button>
            </div>

            {account2 && (
              <div className="bg-white rounded-xl border border-gray-100 p-4">
                <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2"><Wallet size={15} className="text-teal-600" /> حساب مالی</h3>
                <div className="space-y-2">
                  <div className="flex items-center justify-between"><span className="text-xs text-gray-500">مجموع فروش</span><span className="text-xs font-bold text-gray-800">{formatCurrency(account2.totalSales)}</span></div>
                  <div className="flex items-center justify-between"><span className="text-xs text-gray-500">مجموع پرداختی</span><span className="text-xs font-bold text-emerald-600">{formatCurrency(account2.totalPaid)}</span></div>
                  <div className="flex items-center justify-between pt-2 border-t border-gray-50"><span className="text-xs text-gray-500">مانده حساب</span><span className={`text-xs font-black ${account2.balance > 0 ? 'text-red-600' : 'text-gray-800'}`}>{formatCurrency(account2.balance)}</span></div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════ TAB: PIPELINE (کاریز فروش) ══════════ */}
      {activeTab === 'pipeline' && (
        <div>
          {docsDenied ? (
            <DeniedNote text="شما دسترسی مشاهده اسناد فروش را ندارید." />
          ) : docs.length === 0 ? (
            <EmptyState icon={<Handshake size={16} />} text="هیچ سند فروشی برای این مرکز در کاریز ثبت نشده است" />
          ) : (
            <>
              <div className="bg-white rounded-xl border border-gray-100 p-4 mb-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-xs text-gray-500">
                    جایگاه اسناد این مرکز در کاریز فروش — {toPersianNum(docs.length)} سند
                    {userStages ? ' (عنوان مراحل بر اساس کاریز شخصی شما)' : ''}
                  </p>
                  <p className="text-xs text-gray-500">ارزش جاری کاریز: <span className="font-bold text-gray-800">{formatCurrency(openPipelineValue)}</span></p>
                </div>
              </div>
              <div className="flex gap-3 overflow-x-auto pb-2" dir="rtl">
                {effectiveStages.map((stage) => {
                  const rows = docsByStage.get(stage.key) || [];
                  return (
                    <div key={stage.key} className="min-w-[240px] flex-1" style={{ maxWidth: 300 }}>
                      <div className="rounded-xl border p-2.5 mb-2" style={{ background: stage.bg, borderColor: stage.border }}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold" style={{ color: stage.color }}>{stage.label}</span>
                          <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full bg-white/70" style={{ color: stage.color }}>{toPersianNum(rows.length)}</span>
                        </div>
                        {rows.length > 0 && (
                          <p className="text-[10px] mt-1" style={{ color: stage.color }}>{formatCompact(rows.reduce((s, d) => s + (d.finalAmount || d.totalAmount || 0), 0))} ریال</p>
                        )}
                      </div>
                      <div className="space-y-2">
                        {rows.map((doc) => (
                          <div key={doc.id} className="bg-white rounded-xl border border-gray-100 p-3">
                            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                              <span className="text-xs font-bold text-gray-900" dir="ltr">{doc.documentNumber || doc.id.slice(-8)}</span>
                              {doc.documentType === 'invoice' && <span className="text-[9px] px-1.5 py-px rounded-full bg-emerald-50 text-emerald-600 font-medium">فاکتور</span>}
                              {doc.documentType === 'return' && <span className="text-[9px] px-1.5 py-px rounded-full bg-amber-50 text-amber-600 font-medium">برگشتی</span>}
                              {dispatchMap.has(doc.id) && <span className="text-[9px] px-1.5 py-px rounded-full bg-teal-50 text-teal-700 font-medium">{SHIPMENT_LABELS[dispatchMap.get(doc.id)!] || 'ارسال'}</span>}
                            </div>
                            <p className="text-[11px] text-gray-500">{jdate(doc.createdAt)} · {toPersianNum(doc._count?.items || 0)} قلم</p>
                            <p className="text-xs font-bold text-gray-800 mt-1">{formatCurrency(doc.finalAmount || doc.totalAmount)}</p>
                          </div>
                        ))}
                        {rows.length === 0 && (
                          <div className="border border-dashed border-gray-100 rounded-xl py-4 text-center text-[11px] text-gray-300">—</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══════════ TAB: PROFORMAS ══════════ */}
      {activeTab === 'proformas' && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
            <FileCheck size={15} className="text-teal-600" /> پیش‌فاکتورها ({toPersianNum(proformas.length)})
          </h3>
          {docsDenied ? (
            <DeniedNote text="شما دسترسی مشاهده اسناد فروش را ندارید." />
          ) : proformas.length === 0 ? (
            <EmptyState icon={<FileCheck size={16} />} text="پیش‌فاکتوری برای این مرکز ثبت نشده است" />
          ) : (
            <DocTable rows={proformas} statusCfg={PROFORMA_STATUS} />
          )}
        </div>
      )}

      {/* ══════════ TAB: INVOICES ══════════ */}
      {activeTab === 'invoices' && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl border border-gray-100 p-4">
            <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
              <Receipt size={15} className="text-teal-600" /> فاکتورهای فروش ({toPersianNum(invoiceDocs.length)})
            </h3>
            {docsDenied ? (
              <DeniedNote text="شما دسترسی مشاهده اسناد فروش را ندارید." />
            ) : invoiceDocs.length === 0 ? (
              <EmptyState icon={<Receipt size={16} />} text="فاکتور فروشی برای این مرکز ثبت نشده است" />
            ) : (
              <DocTable rows={invoiceDocs} statusCfg={INVOICE_STATUS} />
            )}
            {returns.length > 0 && (
              <div className="mt-4 pt-4 border-t border-gray-50">
                <h4 className="text-xs font-bold text-gray-700 mb-2">اسناد برگشتی ({toPersianNum(returns.length)})</h4>
                <DocTable rows={returns} statusCfg={PROFORMA_STATUS} />
              </div>
            )}
          </div>

          {issuedInvoices !== null && issuedInvoices.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-100 p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
                <Receipt size={15} className="text-teal-600" /> فاکتورهای صادرهٔ حسابداری ({toPersianNum(issuedInvoices.length)})
              </h3>
              <div className="space-y-2">
                {issuedInvoices.map((inv) => {
                  const cfg = ISSUED_STATUS[inv.status] || ISSUED_STATUS.issued;
                  return (
                    <div key={inv.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl flex-wrap">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-bold text-gray-900" dir="ltr">{inv.invoiceNumber || 'بدون شماره'}</span>
                          <StatusPill cfg={cfg} />
                        </div>
                        <p className="text-[11px] text-gray-500 mt-0.5">
                          صدور: {jdate(inv.issuedAt || inv.createdAt)}
                          {inv.dueDate ? ` · سررسید: ${jdate(inv.dueDate)}` : ''}
                          {Array.isArray(inv.payments) && inv.payments.length > 0 ? ` · ${toPersianNum(inv.payments.length)} پرداخت` : ''}
                        </p>
                      </div>
                      <div className="text-left shrink-0">
                        <p className="text-sm font-bold text-gray-800">{formatCompact(inv.totalAmount)} ریال</p>
                        <p className="text-[11px] text-emerald-600">پرداختی: {formatCompact(inv.paidAmount)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════ TAB: ACTIVITIES (تماس‌ها و فعالیت‌ها) ══════════ */}
      {activeTab === 'activities' && <ActivitiesTab rows={allActivities} embeddedFallback={!activities} />}

      {/* ══════════ TAB: FOLLOWUPS ══════════ */}
      {activeTab === 'followups' && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
            <CalendarClock size={15} className="text-teal-600" /> پیگیری‌های دوره‌ای ({toPersianNum(followups.length)})
          </h3>
          {followups.length === 0 ? (
            <EmptyState icon={<CalendarClock size={16} />} text="پیگیری دوره‌ای برای این مرکز تعریف نشده است" />
          ) : (
            <div className="space-y-2">
              {followups.map((f) => {
                const cfg = FOLLOWUP_STATUS[f.status] || FOLLOWUP_STATUS.upcoming;
                const last = f.history?.[0];
                return (
                  <div key={f.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl flex-wrap">
                    <div className="w-9 h-9 rounded-full bg-white border border-gray-100 flex items-center justify-center text-teal-600 shrink-0">
                      <UserRound size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-gray-900">{f.personName}</span>
                        <StatusPill cfg={cfg} />
                        <span className="text-[11px] text-gray-500">{FREQUENCY_LABELS[f.frequency] || f.frequency}</span>
                      </div>
                      <p className="text-[11px] text-gray-500 mt-0.5">
                        {f.nextFollowupDate ? `تماس بعدی: ${toJalaliString(f.nextFollowupDate)}` : 'بدون تاریخ بعدی'}
                        {f.phone ? ` · ${f.phone}` : ''}
                        {` · ${toPersianNum(f.totalFollowups)} نوبت پیگیری`}
                        {last ? ` · آخرین تماس (${METHOD_LABELS[last.method] || last.method}): ${toJalaliString(last.createdAt)}` : ''}
                      </p>
                    </div>
                    {f.phone && (
                      <a href={`tel:${f.phone}`} aria-label={`تماس با ${f.personName}`} className="w-8 h-8 rounded-lg bg-green-50 text-green-600 flex items-center justify-center hover:bg-green-100 transition-colors shrink-0">
                        <Phone size={14} />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══════════ TAB: VISITS ══════════ */}
      {activeTab === 'visits' && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2">
            <ClipboardList size={15} className="text-teal-600" /> مراجعات حضوری ({toPersianNum(visits.length)})
          </h3>
          {visits.length === 0 ? (
            <EmptyState icon={<ClipboardList size={16} />} text="مراجعهٔ حضوری برای این مرکز ثبت نشده است" />
          ) : (
            <div className="space-y-2">
              {visits.map((v) => {
                const cfg = VISIT_STATUS[v.status] || VISIT_STATUS.planned;
                return (
                  <div key={v.id} className="p-3 bg-gray-50 rounded-xl">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-sm font-bold text-gray-900">{v.purpose || 'بازدید'}</span>
                      <StatusPill cfg={cfg} />
                    </div>
                    <p className="text-[11px] text-gray-500">
                      {toJalaliString(v.date)}{v.time ? ` ساعت ${toPersianNum(v.time)}` : ''}
                      {v.assignedToName ? ` · ${v.assignedToName}` : ''}
                    </p>
                    {v.result && <p className="text-xs text-gray-600 mt-1">نتیجه: {v.result}</p>}
                    {v.nextAction && <p className="text-xs text-teal-700 mt-0.5">اقدام بعدی: {v.nextAction}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══════════ TAB: NOTES (یادداشت‌ها و رگ خواب) ══════════ */}
      {activeTab === 'notes' && <RagKhabTab contacts={adapted.contacts} centerNotes={adapted.notes} />}

      {/* ══════════ TAB: FILES ══════════ */}
      {activeTab === 'files' && (
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <CenterFiles centerId={adapted.id} />
        </div>
      )}

      {/* Edit dialog — same real form as the list view */}
      <CenterEditDialog
        center={adapted}
        open={showEdit}
        onOpenChange={setShowEdit}
        onUpdated={() => {
          setShowEdit(false);
          if (centerId) void loadRef.current(centerId);
        }}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
//  SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════

/** Compact sales-document table shared by the proforma / invoice tabs. */
function DocTable({ rows, statusCfg }: {
  rows: DocRow[];
  statusCfg: Record<string, { label: string; color: string; bg: string }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-400 border-b border-gray-100">
            <th className="text-right font-medium py-2 px-2">شماره سند</th>
            <th className="text-right font-medium py-2 px-2">تاریخ</th>
            <th className="text-right font-medium py-2 px-2">وضعیت</th>
            <th className="text-right font-medium py-2 px-2">اقلام</th>
            <th className="text-right font-medium py-2 px-2">ایجادکننده</th>
            <th className="text-left font-medium py-2 px-2">مبلغ نهایی</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const cfg = statusCfg[d.status] || statusCfg.draft;
            return (
              <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50/60 transition-colors">
                <td className="py-2.5 px-2 font-bold text-gray-900 text-right" dir="ltr">{d.documentNumber || d.id.slice(-8)}</td>
                <td className="py-2.5 px-2 text-gray-600">{jdate(d.issuedAt || d.createdAt)}</td>
                <td className="py-2.5 px-2"><StatusPill cfg={cfg} /></td>
                <td className="py-2.5 px-2 text-gray-600">{toPersianNum(d._count?.items || 0)} قلم</td>
                <td className="py-2.5 px-2 text-gray-600">{d.creator?.displayName || '—'}</td>
                <td className="py-2.5 px-2 text-left font-bold text-gray-800 whitespace-nowrap">{formatCurrency(d.finalAmount || d.totalAmount)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Activities list with type filter chips (calls / visits / all). */
function ActivitiesTab({ rows, embeddedFallback }: { rows: DossierActivity[]; embeddedFallback: boolean }) {
  const [filter, setFilter] = useState<'all' | 'calls' | 'visits'>('all');
  const filtered = useMemo(() => {
    if (filter === 'calls') return rows.filter((a) => a.isPhoneCall);
    if (filter === 'visits') return rows.filter((a) => a.isOnsiteVisit);
    return rows;
  }, [rows, filter]);

  const chips: Array<{ key: 'all' | 'calls' | 'visits'; label: string; count: number }> = [
    { key: 'all', label: 'همه', count: rows.length },
    { key: 'calls', label: 'تماس‌ها', count: rows.filter((a) => a.isPhoneCall).length },
    { key: 'visits', label: 'حضوری', count: rows.filter((a) => a.isOnsiteVisit).length },
  ];

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
          <PhoneCall size={15} className="text-teal-600" /> تماس‌ها و فعالیت‌ها ({toPersianNum(rows.length)})
        </h3>
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
          {chips.map((c) => (
            <button
              key={c.key}
              onClick={() => setFilter(c.key)}
              aria-pressed={filter === c.key}
              className={`px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all ${
                filter === c.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {c.label} ({toPersianNum(c.count)})
            </button>
          ))}
        </div>
      </div>
      {embeddedFallback && rows.length > 0 && (
        <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg px-3 py-1.5 mb-3">
          نمایش ۱۰ فعالیت اخیر — برای تاریخچهٔ کامل، دسترسی تقویم لازم است.
        </p>
      )}
      {filtered.length === 0 ? (
        <EmptyState icon={<PhoneCall size={16} />} text="فعالیتی برای این مرکز ثبت نشده است" />
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => {
            const cfg = ACTIVITY_STATUS[a.status] || ACTIVITY_STATUS.pending;
            const StatusIcon = a.status === 'done' ? CheckCircle2 : a.status === 'cancelled' ? XCircle : Circle;
            const prods = parseActivityProducts(a.products);
            return (
              <div key={a.id} className="flex items-start gap-3 p-3 bg-gray-50 rounded-xl">
                <div className="w-8 h-8 rounded-lg bg-white border border-gray-100 flex items-center justify-center shrink-0 mt-0.5" style={{ color: cfg.color }}>
                  <StatusIcon size={14} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-sm font-bold text-gray-900">{a.title}</span>
                    {a.isPhoneCall && <span className="text-[10px] px-1.5 py-px rounded-full bg-blue-50 text-blue-600 font-medium">تماس</span>}
                    {a.isUnansweredCall && <span className="text-[10px] px-1.5 py-px rounded-full bg-red-50 text-red-600 font-medium">بی‌پاسخ</span>}
                    {a.isOnsiteVisit && <span className="text-[10px] px-1.5 py-px rounded-full bg-teal-50 text-teal-700 font-medium">حضوری</span>}
                    {a.voiceNoteFileId && <span className="text-[10px] px-1.5 py-px rounded-full bg-violet-50 text-violet-600 font-medium flex items-center gap-0.5"><Mic size={9} /> ویس</span>}
                    <StatusPill cfg={cfg} />
                  </div>
                  {/* v2.34.9 — product-tag snapshot badges (round 56) */}
                  {prods.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mt-1">
                      <Package size={10} className="text-amber-500 shrink-0" />
                      {prods.map((p) => (
                        <span key={p.id} className="text-[10px] text-amber-700 bg-amber-50 border border-amber-100 rounded-full px-1.5 py-px">{p.name}</span>
                      ))}
                    </div>
                  )}
                  {a.description && <p className="text-xs text-gray-500 mt-1 whitespace-pre-wrap">{a.description}</p>}
                  {a.voiceTranscript && (
                    <p className="text-[11px] text-violet-700 bg-violet-50 rounded-lg px-2.5 py-1.5 mt-1.5 leading-6">متن ویس: {a.voiceTranscript}</p>
                  )}
                  <p className="text-[11px] text-gray-400 mt-1">
                    {toJalaliString(a.activityDate)}{a.activityTime ? ` ساعت ${toPersianNum(a.activityTime)}` : ''}
                    {a.assignedUser?.displayName ? ` · مسئول: ${a.assignedUser.displayName}` : ''}
                    {a.creator?.displayName ? ` · ثبت: ${a.creator.displayName}` : ''}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** رگ خواب — per-contact observation notes, plus the center's own note. */
function RagKhabTab({ contacts, centerNotes }: {
  contacts: Array<{ id: string; fullName: string; role: string; isAgent: boolean }>;
  centerNotes: string;
}) {
  const [openContact, setOpenContact] = useState<string | null>(null);
  const [notesByContact, setNotesByContact] = useState<Record<string, ProfileNote[]>>({});
  const [loadingContact, setLoadingContact] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [draft, setDraft] = useState('');
  const [category, setCategory] = useState('general');
  const [busy, setBusy] = useState(false);

  const loadNotes = useCallback(async (contactId: string) => {
    setLoadingContact(contactId);
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'profile-notes', contactId }),
      });
      if (res.status === 403 || res.status === 404) {
        setDenied(true);
        setNotesByContact((prev) => ({ ...prev, [contactId]: [] }));
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در دریافت مشاهدات');
      setNotesByContact((prev) => ({ ...prev, [contactId]: Array.isArray(data.data) ? data.data : [] }));
    } catch {
      setNotesByContact((prev) => ({ ...prev, [contactId]: [] }));
    } finally {
      setLoadingContact(null);
    }
  }, []);

  const toggle = (contactId: string) => {
    if (openContact === contactId) { setOpenContact(null); return; }
    setOpenContact(contactId);
    if (!notesByContact[contactId]) void loadNotes(contactId);
  };

  const addNote = async (contactId: string) => {
    if (!draft.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-profile-note', contactId, category, content: draft.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'ثبت مشاهده ناموفق بود');
      toast.success('مشاهدهٔ جدید ثبت شد');
      setDraft('');
      await loadNotes(contactId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'ثبت مشاهده ناموفق بود');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <h3 className="text-sm font-bold text-gray-900 mb-3 flex items-center gap-2"><StickyNote size={15} className="text-teal-600" /> یادداشت مرکز</h3>
        {centerNotes ? (
          <p className="text-sm text-gray-600 leading-7 bg-gray-50 rounded-xl p-3 whitespace-pre-wrap">{centerNotes}</p>
        ) : (
          <p className="text-xs text-gray-400">یادداشتی برای این مرکز ثبت نشده است — از دکمهٔ «ویرایش مرکز» می‌توانید افزود.</p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <h3 className="text-sm font-bold text-gray-900 mb-1 flex items-center gap-2">
          <UserRound size={15} className="text-teal-600" /> رگ خواب — مشاهدات اشخاص تماس
        </h3>
        <p className="text-[11px] text-gray-400 mb-3">مشاهدات رفتاری هر شخص (خلق‌وخو، علایق، حساسیت‌ها و سبک ارتباط) برای مذاکرهٔ مؤثرتر.</p>
        {contacts.length === 0 ? (
          <EmptyState icon={<UserRound size={16} />} text="ابتدا شخص تماس این مرکز را ثبت کنید" />
        ) : denied ? (
          <DeniedNote text="شما دسترسی مشاهدهٔ مراکز را ندارید." />
        ) : (
          <div className="space-y-2">
            {contacts.map((ct) => {
              const open = openContact === ct.id;
              const notes = notesByContact[ct.id];
              return (
                <div key={ct.id} className="border border-gray-100 rounded-xl overflow-hidden">
                  <button
                    onClick={() => toggle(ct.id)}
                    aria-expanded={open}
                    className="w-full flex items-center gap-2 p-3 hover:bg-gray-50 transition-colors text-right"
                  >
                    <span className="text-sm font-bold text-gray-900 flex-1">{ct.fullName}</span>
                    {ct.isAgent && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 font-medium">رابط</span>}
                    <span className="text-[11px] text-gray-400">{ct.role}</span>
                    <ChevronDown size={14} className={`text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
                  </button>
                  {open && (
                    <div className="px-3 pb-3 border-t border-gray-50 pt-3">
                      {loadingContact === ct.id ? (
                        <div className="flex items-center justify-center gap-2 py-3 text-gray-400 text-xs"><Loader2 size={13} className="animate-spin" /> در حال دریافت…</div>
                      ) : (
                        <>
                          {!notes || notes.length === 0 ? (
                            <p className="text-xs text-gray-400 mb-2">مشاهده‌ای برای این شخص ثبت نشده است.</p>
                          ) : (
                            <div className="space-y-1.5 mb-3">
                              {notes.map((n) => {
                                const cfg = NOTE_CATEGORY[n.category] || NOTE_CATEGORY.general;
                                return (
                                  <div key={n.id} className="p-2.5 bg-gray-50 rounded-lg">
                                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                                      <StatusPill cfg={cfg} />
                                      <span className="text-[10px] text-gray-400">{n.createdByName || '—'} · {toJalaliString(n.createdAt)}</span>
                                    </div>
                                    <p className="text-xs text-gray-600 leading-6 whitespace-pre-wrap">{n.content}</p>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div className="space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                aria-label="دستهٔ مشاهده"
                                className="h-8 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-600"
                              >
                                <option value="general">عمومی</option>
                                <option value="trait">خلق‌وخو</option>
                                <option value="interest">علایق</option>
                                <option value="sensitivity">حساسیت‌ها</option>
                                <option value="communication">سبک ارتباط</option>
                              </select>
                            </div>
                            <textarea
                              value={draft}
                              onChange={(e) => setDraft(e.target.value)}
                              placeholder="مشاهدهٔ جدید دربارهٔ این شخص…"
                              aria-label="متن مشاهدهٔ جدید"
                              className="w-full min-h-[64px] rounded-lg border border-gray-200 p-2.5 text-xs outline-none focus:border-teal-300 resize-y"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <Button onClick={() => void addNote(ct.id)} disabled={busy || !draft.trim()} className="h-8 gap-1.5 text-xs rounded-lg px-4 text-white" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                                {busy ? <Loader2 size={12} className="animate-spin" /> : null} ثبت مشاهده
                              </Button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
