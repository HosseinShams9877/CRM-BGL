'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { SkeletonList, listAllPages } from '@/hooks/use-api';
import { toast } from 'sonner';
import {
  NewShipmentDialog,
  ShipmentStatusBadge,
  ShipmentRow,
} from '@/components/shipment-dialogs';
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors, useDroppable,
  type DragStartEvent, type DragOverEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// v2.45.0 (r70) — drag & drop stage pinning: shared contract (keys,
// labels, effective stage, move planning) between board + API.
import {
  effectiveStage,
  normalizePinnedStage,
  planStageMove,
  PIPELINE_STAGE_LABELS,
  type PipelineStageKey,
} from '@/lib/pipeline-stage-override';
import {
  Phone, Handshake, FileCheck, Clock, Receipt, Truck, ShoppingBag,
  Search, RefreshCw, LayoutGrid, List, ChevronLeft, User as UserIcon,
  Building2, CircleDollarSign, Layers, GripVertical, Filter, XCircle,
  Settings2, ArrowUp, ArrowDown, RotateCcw, Pin, PinOff,
} from 'lucide-react';

// ═══════════════════════════════════════════════════════════
// THE unified sales pipeline — single board replacing both the
// old 6-column demo kanban and the stages board.
//
// Standard of leading Iranian CRMs (Didar / Payamgostar / Sarv):
//  • drag & drop cards between stages
//  • board / list dual view
//  • per-stage counters + rial value
//  • search & filters, quick stage actions
// Stages follow the org's real flow (presentation → dispatch)
// with a dedicated procurement column, all driven by live
// sales-document status — no fabricated stage data.
// ═══════════════════════════════════════════════════════════

interface DocRow {
  id: string;
  documentNumber: string | null;
  documentType: 'proforma' | 'invoice' | 'return';
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'cancelled';
  totalAmount: number;
  finalAmount: number;
  createdAt: string;
  centerId: string | null;
  // v2.45.0 — manual drag & drop stage pin (null = derived stage)
  pipelineStage: string | null;
  center: { id: string; name: string; customerType?: string } | null;
  creator: { id: string; displayName: string } | null;
  _count: { items: number; approvals: number; financeRecords: number };
}

type StageKey =
  | 'presentation' | 'negotiation' | 'proforma' | 'proforma-followup'
  | 'invoice' | 'dispatch' | 'procurement' | 'cancelled';

const STAGES: Array<{
  key: StageKey; label: string; short: string;
  icon: React.ReactNode; color: string; bg: string; border: string; hint: string;
}> = [
  { key: 'presentation', label: 'تماس اولیه / پرزنت', short: 'پرزنت', icon: <Phone size={14} />, color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe', hint: 'اولین تماس و معرفی' },
  { key: 'negotiation', label: 'پیگیری مذاکرات', short: 'مذاکره', icon: <Handshake size={14} />, color: '#0891b2', bg: '#ecfeff', border: '#a5f3fc', hint: 'بررسی قیمت و شرایط' },
  { key: 'proforma', label: 'صدور پیش‌فاکتور', short: 'پیش‌فاکتور', icon: <FileCheck size={14} />, color: '#d97706', bg: '#fffbeb', border: '#fde68a', hint: 'پیش‌نویس صادر شده' },
  { key: 'proforma-followup', label: 'پیگیری صدور پیش‌فاکتور', short: 'پیگیری تأیید', icon: <Clock size={14} />, color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe', hint: 'در انتظار تأیید مدیر' },
  { key: 'invoice', label: 'فاکتور', short: 'فاکتور', icon: <Receipt size={14} />, color: '#059669', bg: '#ecfdf5', border: '#a7f3d0', hint: 'تأییدشده و فاکتورشده' },
  { key: 'dispatch', label: 'ارسال بار', short: 'ارسال', icon: <Truck size={14} />, color: '#1F8B7D', bg: '#ecfdf5', border: '#99f6e4', hint: 'فقط با ثبت ارسال واقعی' },
  { key: 'procurement', label: 'سامانهٔ تدارکات', short: 'تدارکات', icon: <ShoppingBag size={14} />, color: '#dc2626', bg: '#fef2f2', border: '#fecaca', hint: 'پیش‌فاکتورهای تدارکات' },
];

/** v2.16.0 — dedicated terminal column for cancelled documents. Shown
 *  only when the user opts in; a cancelled proforma used to be dumped into
 *  «تماس اولیه», resurrecting dead deals as fresh leads. */
const CANCELLED_STAGE = {
  key: 'cancelled' as StageKey,
  label: 'لغو شده',
  short: 'لغو',
  icon: <XCircle size={14} />,
  color: '#9ca3af',
  bg: '#f9fafb',
  border: '#e5e7eb',
  hint: 'خارج از چرخهٔ فروش',
};

const STAGE_KEYS = STAGES.map((s) => s.key);

// v2.34.6 — per-user personalization payload (fetched from /api/pipeline)
interface UserStage {
  key: StageKey;
  title: string;
  visible: boolean;
}

/** Live status → stage mapping (single source of truth).
 *  v2.16.0: an APPROVED INVOICE stays in the فاکتور stage — it used to
 *  land in «ارسال بار» automatically even though no send/dispatch was
 *  ever registered. Cancelled docs map to their own terminal stage
 *  instead of «تماس اولیه».
 *  v2.17.0: the dispatch column finally gets REAL data — a document
 *  moves to «ارسال بار» only while it has a registered shipment that
 *  has not come back (returned parcels un-ship the document). */
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

/** Most advanced non-returned shipment status per document (v2.17.0). */
const DISPATCH_RANK: Record<string, number> = {
  preparing: 1, ready: 2, 'in-transit': 3, delivered: 4,
};
function buildDispatchStatusMap(shipments: ShipmentRow[]): Map<string, string> {
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

/** Can a real send be registered for this document right now? */
function isShippable(doc: DocRow, dispatchMap: Map<string, string>): boolean {
  if (doc.status !== 'approved') return false;
  if (doc.documentType === 'return') return false;
  if (doc.documentType !== 'invoice' && doc.documentType !== 'proforma') return false;
  return !dispatchMap.has(doc.id);
}

/** Stage → allowed workflow action (persisted via API). */
function stageAction(doc: DocRow): null | { action: 'submit-approval' | 'approve' | 'reject'; label: string; target: StageKey } {
  if (doc.status === 'draft') return { action: 'submit-approval', label: 'ارسال به تأیید', target: 'proforma-followup' };
  if (doc.status === 'pending_approval') return { action: 'approve', label: 'تأیید', target: 'invoice' };
  return null;
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

async function apiCall(action: string, payload: Record<string, unknown> = {}) {
  const res = await fetch('/api/sales-documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطای سرور'), { status: res.status });
  return data;
}

// ── sortable card ──────────────────────────────────────────
// v2.45.0 (r70) — «جابه‌جایی مراحل با درگ کردن و جابه‌جایی با موس بین
// ستون‌ها»: the WHOLE card is the drag handle now (the tiny grip button
// was easy to miss and made dragging feel broken). The 8px activation
// distance keeps every inner button (تأیید / ثبت ارسال / سنجاق) a normal
// click — only a real mouse drag starts the move.
function SortableCard({ doc, stage, onAction, onShip, onResetStage, shipStatus, dragging }: {
  doc: DocRow;
  stage: { key: string; color: string; bg: string };
  onAction: (doc: DocRow, action: 'submit-approval' | 'approve' | 'reject') => void;
  onShip: (doc: DocRow) => void;
  onResetStage: (doc: DocRow) => void;
  shipStatus?: string | null;
  dragging: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.id,
    data: { stage: stage.key },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const act = stageAction(doc);
  // v2.45.0 — a manual drag & drop pin is live on this card
  const pinnedStage = normalizePinnedStage(doc.pipelineStage);

  return (
    <div ref={setNodeRef} style={style} className={dragging ? 'rotate-2' : ''}>
      <div
        {...attributes}
        {...listeners}
        className="bg-white rounded-xl border border-gray-100 p-3 hover:shadow-md transition-all group cursor-grab active:cursor-grabbing select-none"
        title="با ماوس بکشید و روی ستون دلخواه رها کنید"
      >
        <div className="flex items-start gap-1.5">
          <span className="text-gray-200 group-hover:text-gray-400 pt-0.5 shrink-0 transition-colors" aria-hidden>
            <GripVertical size={13} />
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-1">
              <h5 className="text-xs font-bold text-gray-900 truncate" dir="ltr">
                {doc.documentNumber || doc.id.slice(-8)}
              </h5>
              {doc.documentType === 'invoice' && (
                <Badge className="bg-emerald-50 text-emerald-600 hover:bg-emerald-50 text-[8px] shrink-0">فاکتور</Badge>
              )}
              {shipStatus && <ShipmentStatusBadge status={shipStatus as ShipmentRow['status']} />}
              {pinnedStage && (
                <button
                  onClick={(e) => { e.stopPropagation(); onResetStage(doc); }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-0.5 text-[8px] px-1.5 py-px rounded-full bg-amber-50 text-amber-600 font-bold border border-amber-200 hover:bg-amber-100 transition-colors shrink-0"
                  title={`مرحلهٔ دستی: ${PIPELINE_STAGE_LABELS[pinnedStage]} — کلیک کنید تا جای سند دوباره از وضعیت واقعی آن تعیین شود`}
                >
                  <Pin size={8} /> دستی
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 text-[11px] text-gray-500 mb-0.5">
              <Building2 size={10} className="shrink-0" />
              <span className="truncate">{doc.center?.name || 'بدون مرکز'}</span>
              {doc.center?.customerType === 'end_user' ? (
                <span className="text-[8px] px-1 py-px rounded-full bg-violet-100 text-violet-600 font-medium shrink-0">نهایی</span>
              ) : doc.center ? (
                <span className="text-[8px] px-1 py-px rounded-full bg-blue-50 text-blue-600 font-medium shrink-0">سازمانی</span>
              ) : null}
            </div>
            <div className="flex items-center gap-1 text-[11px] text-gray-400">
              <UserIcon size={10} className="shrink-0" />
              <span className="truncate">{doc.creator?.displayName || '—'}</span>
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50">
              <span className="text-[11px] font-extrabold" style={{ color: '#1F8B7D' }}>
                {formatCompact(doc.finalAmount)}
              </span>
              <span className="text-[11px] text-gray-400">{toPersianNum(doc._count.items)} قلم</span>
            </div>
            {/* v2.17.0 — real send registration for approved documents */}
            {act && (
              <button
                onClick={() => onAction(doc, act.action)}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full h-6 mt-2 rounded-md text-[11px] font-bold transition-colors"
                style={{ background: act.action === 'approve' ? '#ecfdf5' : `${stage.bg}`, color: act.action === 'approve' ? '#059669' : stage.color }}
              >
                {act.label} →
              </button>
            )}
            {!act && onShipEligible(doc, shipStatus) && (
              <button
                onClick={() => onShip(doc)}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full h-6 mt-2 rounded-md text-[11px] font-bold transition-colors"
                style={{ background: '#ecfdf5', color: '#1F8B7D' }}
              >
                <span className="inline-flex items-center gap-1"><Truck size={10} /> ثبت ارسال</span>
              </button>
            )}
            {!act && !onShipEligible(doc, shipStatus) && pinnedStage && (
              <button
                onClick={() => onResetStage(doc)}
                onPointerDown={(e) => e.stopPropagation()}
                className="w-full h-6 mt-2 rounded-md text-[11px] font-bold transition-colors bg-gray-50 text-gray-500 hover:bg-gray-100 inline-flex items-center justify-center gap-1"
                title="جای سند دوباره از وضعیت واقعی آن تعیین می‌شود"
              >
                <PinOff size={10} /> بازگشت به مرحلهٔ خودکار
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Approved invoice without an active send → show «ثبت ارسال» (v2.17.0). */
function onShipEligible(doc: DocRow, shipStatus?: string | null): boolean {
  return doc.status === 'approved'
    && (doc.documentType === 'invoice' || doc.documentType === 'proforma')
    && !shipStatus;
}

/** v2.27.2 — REAL droppable columns. The board's columns were never
 *  registered with dnd-kit, so `over` could only ever resolve to another
 *  CARD: dropping onto an EMPTY column (an empty dispatch column, an empty
 *  approval queue — the common case) was a silent no-op, and the
 *  `column-*` branch of handleDragEnd was dead code. Registering every
 *  column as a droppable makes empty columns real drop targets and lights
 *  the column up while a card hovers over it. */
function DroppableColumn({ stage, children }: {
  stage: { key: string; bg: string; color: string };
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column-${stage.key}` });
  return (
    <div
      ref={setNodeRef}
      data-stage={stage.key}
      className="flex-shrink-0 w-64 rounded-2xl flex flex-col"
      style={{
        background: `${stage.bg}40`,
        ...(isOver ? { boxShadow: `inset 0 0 0 2px ${stage.color}` } : {}),
      }}
    >
      {children}
    </div>
  );
}

// ── main component ─────────────────────────────────────────
export default function SalesPipeline() {
  const [docs, setDocs] = useState<DocRow[]>([]);
  // v2.17.0 — real shipment records power the dispatch column
  const [shipments, setShipments] = useState<ShipmentRow[]>([]);
  const [showShipDialog, setShowShipDialog] = useState(false);
  const [shipPresetDoc, setShipPresetDoc] = useState<DocRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState<'board' | 'list'>('board');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // v2.16.0 — cancelled documents are dead pipeline items; they're hidden
  // from the funnel by default and can be surfaced via this toggle.
  const [showCancelled, setShowCancelled] = useState(false);
  // v2.34.6 — per-user pipeline personalization (titles / order / visibility)
  const [userStages, setUserStages] = useState<UserStage[] | null>(null);
  const [showCustomize, setShowCustomize] = useState(false);

  const sensors = useSensors(
    // v2.45.0 — 8px activation: the whole card is the drag handle now,
    // so a slightly longer travel keeps plain clicks on the card's own
    // buttons (تأیید / ثبت ارسال / سنجاق) perfectly ordinary clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // v2.16.0 — walk EVERY page. The server caps pageSize at 100 and this
      // route ignores pageSize>100, so the old single call ({pageSize: 200})
      // fetched only the first 100 documents — a 150-document tenant never
      // saw 50 of them on the board.
      const [all, ships] = await Promise.all([
        listAllPages<DocRow>('/api/sales-documents', 'list', {}, 20),
        // v2.17.0 — shipment reads follow the same everyone-who-sees-the-
        // pipeline permission; failure only empties the dispatch column.
        listAllPages<ShipmentRow>('/api/shipments', 'list', {}, 20)
          .catch(() => [] as ShipmentRow[]),
      ]);
      setDocs(all);
      setShipments(ships);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در دریافت اسناد');
      setDocs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Schedule on the microtask queue — keeps the synchronous setLoading(true)
  // at the top of `load` asynchronous (react-hooks/set-state-in-effect).
  // v2.21.0 — `load` is a useCallback with [] deps (stable identity), so it
  // now sits honestly in the dep array: the effect still fires exactly once.
  useEffect(() => {
    queueMicrotask(load);
  }, [load]);

  // v2.34.6 — load MY pipeline personalization (null = system defaults).
  const loadStages = useCallback(async () => {
    try {
      const res = await fetch('/api/pipeline');
      if (!res.ok) return;
      const data = await res.json();
      setUserStages(Array.isArray(data.stages) ? data.stages : null);
    } catch { /* defaults */ }
  }, []);
  useEffect(() => { queueMicrotask(loadStages); }, [loadStages]);

  // Effective stage list: system meta (icon/colors/hint) + personal layer
  // (custom title, order, visibility). Cancelled stays terminal-last but its
  // title is personalizable too.
  const ALL_SYSTEM_STAGES = useMemo(() => [...STAGES, CANCELLED_STAGE], []);
  const effectiveStages = useMemo(() => {
    const base = ALL_SYSTEM_STAGES.map((s) => ({ ...s }));
    if (!userStages) return base;
    const metaByKey = new Map(base.map((s) => [s.key, s]));
    const out: typeof base = [];
    for (const cfg of userStages) {
      const meta = metaByKey.get(cfg.key);
      if (!meta) continue;
      out.push({ ...meta, label: cfg.title, short: cfg.title.length <= 12 ? cfg.title : cfg.title.slice(0, 11) + '…' });
    }
    // personalization rows missing a system key → append default (defensive)
    for (const s of base) if (!out.some((o) => o.key === s.key)) out.push(s);
    return out;
  }, [userStages, ALL_SYSTEM_STAGES]);

  const visibleStages = useMemo(() => {
    // board columns: user-ordered visible non-cancelled stages (+cancelled via its toggle)
    if (!userStages) return STAGES;
    const visibleKeys = new Set(userStages.filter((s) => s.visible && s.key !== 'cancelled').map((s) => s.key));
    const ordered = effectiveStages.filter((s) => s.key !== 'cancelled' && visibleKeys.has(s.key as StageKey));
    return ordered.length ? ordered : STAGES;
  }, [userStages, effectiveStages]);

  const cancelledStage = useMemo(() => {
    const c = effectiveStages.find((s) => s.key === 'cancelled');
    return c ?? CANCELLED_STAGE;
  }, [effectiveStages]);

  const doAction = async (doc: DocRow, action: 'submit-approval' | 'approve' | 'reject') => {
    setBusyId(doc.id);
    const labels: Record<string, string> = {
      'submit-approval': 'سند به مرحلهٔ پیگیری تأیید منتقل شد',
      'approve': 'سند تأیید شد — آمادهٔ صدور فاکتور',
      'reject': 'سند رد شد — به مرحلهٔ مذاکره بازگشت',
    };
    try {
      await apiCall(action, { id: doc.id });
      toast.success(labels[action]);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در انجام عملیات');
    } finally {
      setBusyId(null);
    }
  };

  // v2.45.0 — persist a drag & drop stage pin (or clear it), then apply
  // the change OPTIMISTICALLY to the loaded rows: the card jumps to its
  // new column instantly, without the full-board skeleton flash that
  // `load()` would cause (the pin is the ONLY field that changed).
  const applyStageLocally = useCallback((docId: string, stage: string | null) => {
    setDocs((prev) => prev.map((d) => (d.id === docId ? { ...d, pipelineStage: stage } : d)));
  }, []);

  const moveStage = useCallback(async (doc: DocRow, stage: PipelineStageKey | null) => {
    setBusyId(doc.id);
    try {
      await apiCall('move-stage', { id: doc.id, stage });
      applyStageLocally(doc.id, stage);
      toast.success(
        stage
          ? `سند به مرحلهٔ «${PIPELINE_STAGE_LABELS[stage]}» منتقل شد.`
          : 'مرحلهٔ دستی برداشته شد — جای سند از وضعیت واقعی آن تعیین می‌شود.',
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در جابه‌جایی سند');
    } finally {
      setBusyId(null);
    }
  }, [applyStageLocally]);

  const filtered = useMemo(() => docs.filter((d) => {
    // Cancelled docs leave the funnel unless explicitly requested.
    if (!showCancelled && d.status === 'cancelled') return false;
    if (!search.trim()) return true;
    const q = search.trim();
    return (d.documentNumber || '').includes(q) || (d.center?.name || '').includes(q) || (d.creator?.displayName || '').includes(q);
  }), [docs, search, showCancelled]);

  // v2.17.0 — documentId → most advanced live shipment status
  const dispatchMap = useMemo(() => buildDispatchStatusMap(shipments), [shipments]);
  const shipStatusOf = useCallback(
    (doc: DocRow) => dispatchMap.get(doc.id) || null,
    [dispatchMap],
  );

  // v2.45.0 — the board stage of a document: manual drag & drop pin
  // (when present) over the DERIVED stage. Cancelled docs are always
  // terminal. This is the single resolution point for board columns,
  // the list view's stage chip, and the drop targets.
  const stageOfDoc = useCallback(
    (doc: DocRow): StageKey =>
      effectiveStage(stageOf(doc, dispatchMap.get(doc.id)), doc.pipelineStage, doc.status),
    [dispatchMap],
  );

  const byStage = useMemo(() => {
    const map = Object.fromEntries(
      [...STAGE_KEYS, 'cancelled'].map((k) => [k, [] as DocRow[]])
    ) as Record<StageKey, DocRow[]>;
    for (const d of filtered) map[stageOfDoc(d)].push(d);
    return map;
  }, [filtered, stageOfDoc]);

  const activeDoc = activeId ? docs.find((d) => d.id === activeId) : null;

  // v2.17.0 — open the real send-registration dialog (card button / drop)
  const openShipDialog = useCallback((doc: DocRow | null) => {
    setShipPresetDoc(doc);
    setShowShipDialog(true);
  }, []);

  // ── DnD handlers ─────────────────────────────────────────
  // v2.45.0 (r70) — drops now REAL moves: the card is dragged with the
  // mouse between columns and the chosen stage is pinned via the
  // move-stage API (SalesDocument.pipelineStage). Workflow-valid moves
  // still get their real action toast; every other move is a manual pin
  // (marked on the card + revertible in one click).
  const handleDragStart = (event: DragStartEvent) => setActiveId(event.active.id as string);

  const handleDragOver = (event: DragOverEvent) => {
    // (visual affordance only; persistence happens on drop)
    void event;
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over) return;

    const doc = docs.find((d) => d.id === (active.id as string));
    if (!doc) return;

    const overId = over.id as string;
    let targetStage: StageKey | null = null;
    if (overId.startsWith('column-')) {
      targetStage = overId.replace('column-', '') as StageKey;
    } else {
      const overDoc = docs.find((d) => d.id === overId);
      if (overDoc) targetStage = stageOfDoc(overDoc);
    }
    if (!targetStage) return;

    const fromStage = stageOfDoc(doc);
    const plan = planStageMove({
      from: fromStage,
      target: targetStage,
      liveStatus: doc.status,
      hasRealShipment: dispatchMap.has(doc.id),
    });
    if (plan.kind === 'same') return;
    if (plan.kind === 'rejected') {
      toast.info(plan.reason);
      return;
    }

    // Workflow-valid drop → run the REAL action (submit-approval /
    // approve) exactly like the card button does; the pin follows the
    // actual status transition and the log trail stays canonical.
    const act = stageAction(doc);
    const allowed: Partial<Record<StageKey, 'submit-approval' | 'approve'>> = {
      'proforma-followup': 'submit-approval',
      'invoice': 'approve',
    };
    if (act && allowed[targetStage] === act.action) {
      await doAction(doc, act.action);
      return;
    }

    // v2.45.0 — otherwise this is a genuine FREE move: pin the card to
    // the dropped column (persisted, board + center dossier agree).
    await moveStage(doc, targetStage);

    // Contextual guidance after the free move lands:
    if (targetStage === 'dispatch' && isShippable(doc, dispatchMap)) {
      toast.info('کارت منتقل شد. برای ثبت ارسال واقعی (بارنامه و کد رهگیری) از دکمهٔ «ثبت ارسال» روی کارت استفاده کنید.');
    } else if (fromStage === 'dispatch' && dispatchMap.has(doc.id)) {
      toast.info('کارت منتقل شد — ارسال واقعی این سند همچنان ثبت است و با جابه‌جایی کارت حذف نمی‌شود؛ برای خارج‌کردن واقعی سند از ارسال، وضعیت مرسوله را در تب «ارسال و بارنامه» به برگشتی تغییر دهید یا ارسال را حذف کنید.');
    }
  };

  const totalValue = filtered.reduce((s, d) => s + d.finalAmount, 0);
  const openCount = filtered.filter((d) => d.status === 'draft' || d.status === 'pending_approval').length;

  const stats = [
    { label: 'کل اسناد', value: toPersianNum(filtered.length), icon: <Layers size={15} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'در جریان تأیید', value: toPersianNum(openCount), icon: <Clock size={15} />, color: '#7c3aed', bg: '#f5f3ff' },
    { label: 'فاکتورشده', value: toPersianNum(byStage.invoice.length), icon: <Receipt size={15} />, color: '#059669', bg: '#ecfdf5' },
    // v2.17.0 — dispatch is now real data, so it earns its own stat
    { label: 'در ارسال', value: toPersianNum(byStage.dispatch.length), icon: <Truck size={15} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'ارزش کل', value: formatCompact(totalValue) + ' ریال', icon: <CircleDollarSign size={15} />, color: '#2E2A5C', bg: '#eef2ff' },
  ];

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {stats.map((s, i) => (
          <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
              <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
            </div>
            <p className="text-sm lg:text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
        <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 shrink-0">
          <button onClick={() => setViewMode('board')} className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${viewMode === 'board' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
            <LayoutGrid size={13} /> بورد
          </button>
          <button onClick={() => setViewMode('list')} className={`flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium transition-all ${viewMode === 'list' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}>
            <List size={13} /> لیست
          </button>
        </div>
        <div className="relative flex-1">
          <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو شماره سند، مرکز یا کارشناس..."
            className="w-full h-9 rounded-lg bg-gray-50 border border-gray-200 focus:border-teal-300 focus:bg-white pr-9 pl-3 text-xs text-gray-700 outline-none transition-all" />
        </div>
        <button onClick={load} disabled={loading} className="h-9 px-3 rounded-lg border border-gray-200 text-gray-600 text-xs font-medium hover:bg-gray-50 flex items-center gap-1.5 shrink-0">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> به‌روزرسانی
        </button>
        {/* v2.16.0 — cancelled documents are out of the funnel by default */}
        <button
          onClick={() => setShowCancelled((v) => !v)}
          className={`h-9 px-3 rounded-lg border text-xs font-medium flex items-center gap-1.5 shrink-0 transition-colors ${
            showCancelled ? 'border-gray-300 bg-gray-100 text-gray-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
          }`}
          title="اسناد لغوشده به‌طور پیش‌فرض در کاریز نمایش داده نمی‌شوند"
        >
          <XCircle size={13} /> لغوشده‌ها {showCancelled ? 'مخفی' : 'نمایش'}
        </button>
        {/* v2.34.6 — per-user pipeline personalization */}
        <button
          onClick={() => setShowCustomize(true)}
          className={`h-9 px-3 rounded-lg border text-xs font-medium flex items-center gap-1.5 shrink-0 transition-colors ${
            userStages ? 'border-teal-300 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'
          }`}
          title="عنوان، ترتیب و نمایش مراحل کاریز — شخصی برای شما"
        >
          <Settings2 size={13} /> شخصی‌سازی کاریز {userStages ? '★' : ''}
        </button>
      </div>

      {/* Board / List */}
      {loading ? (
        <SkeletonList count={3} />
      ) : error ? (
        <div className="bg-white rounded-xl border border-red-100 p-10 text-center">
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={load} className="text-xs text-teal-700 hover:underline">تلاش مجدد</button>
        </div>
      ) : viewMode === 'list' ? (
        /* ── List view (Payamgostar-style table) ── */
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[720px]">
              <thead>
                <tr className="bg-gray-50 text-gray-500 border-b border-gray-100">
                  <th className="py-3 px-3 text-right font-bold">شماره سند</th>
                  <th className="py-3 px-3 text-right font-bold">مرکز</th>
                  <th className="py-3 px-3 text-right font-bold">کارشناس</th>
                  <th className="py-3 px-3 text-right font-bold">مرحله</th>
                  <th className="py-3 px-3 text-right font-bold">مبلغ</th>
                  <th className="py-3 px-3 text-center font-bold">اقلام</th>
                  <th className="py-3 px-3 text-center font-bold">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={7} className="py-10 text-center text-gray-400 text-xs">سندی یافت نشد</td></tr>
                ) : filtered.map((d, i) => {
                  const st = effectiveStages.find((s) => s.key === stageOfDoc(d)) ?? STAGES[0];
                  const act = stageAction(d);
                  const shippable = isShippable(d, dispatchMap);
                  const pinned = normalizePinnedStage(d.pipelineStage);
                  return (
                    <tr key={d.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${i % 2 ? 'bg-gray-50/30' : ''}`}>
                      <td className="py-3 px-3 font-mono text-gray-800 text-right" dir="ltr">{d.documentNumber || d.id.slice(-8)}</td>
                      <td className="py-3 px-3 text-gray-800 font-bold">{d.center?.name || '—'}</td>
                      <td className="py-3 px-3 text-gray-600">{d.creator?.displayName || '—'}</td>
                      <td className="py-3 px-3">
                        <span className="text-[11px] font-bold px-2 py-1 rounded-lg inline-flex items-center gap-1" style={{ background: st.bg, color: st.color }}>
                          {st.icon} {st.short}
                        </span>
                        {pinned && (
                          <button
                            onClick={() => moveStage(d, null)}
                            className="text-[9px] font-bold px-1.5 py-0.5 mr-1 rounded-full bg-amber-50 text-amber-600 border border-amber-200 hover:bg-amber-100 inline-flex items-center gap-0.5"
                            title={`مرحلهٔ دستی: ${PIPELINE_STAGE_LABELS[pinned]} — کلیک کنید تا از وضعیت واقعی سند تعیین شود`}
                          >
                            <Pin size={8} /> دستی
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-3 font-extrabold text-gray-800">{formatCompact(d.finalAmount)}</td>
                      <td className="py-3 px-3 text-center text-gray-500">{toPersianNum(d._count.items)}</td>
                      <td className="py-3 px-3 text-center">
                        {act ? (
                          <button onClick={() => doAction(d, act.action)} className="h-6 px-3 rounded-md bg-teal-50 text-teal-700 text-[11px] font-bold hover:bg-teal-100 transition-colors">
                            {act.label}
                          </button>
                        ) : shippable ? (
                          <button onClick={() => openShipDialog(d)} className="h-6 px-3 rounded-md bg-teal-50 text-teal-700 text-[11px] font-bold hover:bg-teal-100 transition-colors inline-flex items-center gap-1">
                            <Truck size={10} /> ثبت ارسال
                          </button>
                        ) : <span className="text-gray-300 text-[11px]">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* ── Board view (Didar-style DnD columns) ── */
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
          <div className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1">
            {(showCancelled ? [...visibleStages, cancelledStage] : visibleStages).map((stage) => {
              const items = byStage[stage.key] || [];
              const stageValue = items.reduce((s, d) => s + d.finalAmount, 0);
              return (
                <DroppableColumn key={stage.key} stage={stage}>
                  {/* Header */}
                  <div id={`column-${stage.key}`} className="p-3 rounded-t-2xl border-b" style={{ borderColor: stage.border, background: stage.bg }}>
                    <div className="flex items-center gap-2 mb-1">
                      {/* v2.26.2 — was inline background:'white' (a dark-mode
                          light leak the v2.26.1 sweep missed in pipeline); now
                          a utility that flips to the dark surface palette. */}
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-white dark:bg-slate-800" style={{ color: stage.color }}>
                        {stage.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="text-xs font-extrabold" style={{ color: stage.color }}>{stage.label}</h4>
                        <p className="text-[11px] text-gray-400 truncate">{stage.hint}</p>
                      </div>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 bg-white dark:bg-slate-800" style={{ color: stage.color }}>
                        {toPersianNum(items.length)}
                      </span>
                    </div>
                    {items.length > 0 && (
                      <p className="text-[11px] text-gray-500 font-bold">{formatCompact(stageValue)} ریال</p>
                    )}
                  </div>

                  {/* Cards */}
                  <SortableContext items={items.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                    <div className="p-2 space-y-2 flex-1 min-h-[200px] max-h-[calc(100vh-320px)] overflow-y-auto">
                      {items.length === 0 ? (
                        <div className="text-center py-8">
                          <div className="w-10 h-10 rounded-xl mx-auto mb-2 flex items-center justify-center bg-white dark:bg-slate-800">
                            <span style={{ color: stage.color, opacity: 0.35 }}>{stage.icon}</span>
                          </div>
                          <p className="text-[11px] text-gray-400">سندی در این مرحله نیست</p>
                        </div>
                      ) : (
                        items.map((doc) => (
                          <div key={doc.id} style={{ opacity: busyId === doc.id ? 0.5 : 1, transition: 'opacity .2s' }}>
                            <SortableCard
                              doc={doc}
                              stage={stage}
                              onAction={doAction}
                              onShip={openShipDialog}
                              onResetStage={(d) => moveStage(d, null)}
                              shipStatus={shipStatusOf(doc)}
                              dragging={activeId === doc.id}
                            />
                          </div>
                        ))
                      )}
                    </div>
                  </SortableContext>
                </DroppableColumn>
              );
            })}
          </div>

          {/* Drag ghost */}
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
            {activeDoc ? (
              <div className="w-60 rotate-2 scale-105">
                <div className="bg-white rounded-xl border-2 border-teal-300 shadow-xl p-3">
                  <h5 className="text-xs font-bold text-gray-900" dir="ltr">{activeDoc.documentNumber || activeDoc.id.slice(-8)}</h5>
                  <p className="text-[11px] text-gray-500 mt-1 truncate">{activeDoc.center?.name || '—'}</p>
                  <p className="text-[11px] font-extrabold mt-1" style={{ color: '#1F8B7D' }}>{formatCompact(activeDoc.finalAmount)}</p>
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Legend */}
      <div className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 flex-wrap">
        <span className="text-[11px] font-bold text-gray-500 flex items-center gap-1"><Filter size={11} /> گردش:</span>
        {visibleStages.slice(0, 6).map((s, i) => (
          <span key={s.key} className="flex items-center gap-1 text-[11px] text-gray-600">
            <span className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</span>
            {s.short}
            {i < 5 && <ChevronLeft size={10} className="text-gray-300 mr-1" />}
          </span>
        ))}
        <span className="text-[11px] text-gray-400 mr-auto">
          کارت را با ماوس بکشید و روی هر ستون رها کنید = جابه‌جایی دستی (نشان «دستی» روی کارت، با یک کلیک قابل برگشت است) · عملیات واقعی (تأیید / ارسال / لغو) همچنان از دکمه‌های کارت · ورود به «ارسال» واقعی فقط با ثبت ارسال
        </span>
      </div>

      {/* v2.17.0 — real send registration (card button / drag-to-dispatch) */}
      <Dialog open={showShipDialog} onOpenChange={setShowShipDialog}>
        <NewShipmentDialog
          open={showShipDialog}
          onOpenChange={setShowShipDialog}
          onSaved={load}
          presetDoc={shipPresetDoc ? {
            id: shipPresetDoc.id,
            documentNumber: shipPresetDoc.documentNumber,
            centerName: shipPresetDoc.center?.name || null,
          } : null}
        />
      </Dialog>

      {/* v2.34.6 — per-user pipeline personalization dialog */}
      <PipelineCustomizeDialog
        open={showCustomize}
        onOpenChange={setShowCustomize}
        saved={userStages}
        onSaved={setUserStages}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════
// v2.34.6 — PIPELINE PERSONALIZATION DIALOG
// Each user owns their pipeline view: rename stages, reorder them,
// hide/show columns. Cancelled is terminal (always last when toggled
// on) but its title is editable. Placement of documents is NEVER
// affected — stages stay derived from live document status.
// ══════════════════════════════════════════════════════════
function PipelineCustomizeDialog({ open, onOpenChange, saved, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  saved: UserStage[] | null;
  onSaved: (stages: UserStage[] | null) => void;
}) {
  // v2.34.6 — build the editable draft lazily on open (no sync setState in effect)
  const [draft, setDraft] = useState<UserStage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const openDraft = (): UserStage[] =>
    saved
      ? saved.map((s) => ({ ...s }))
      : [...STAGES, CANCELLED_STAGE].map((s) => ({ key: s.key, title: s.label, visible: s.key !== 'cancelled' }));

  const handleOpenChange = (v: boolean) => {
    if (v) { setErr(null); setDraft(openDraft()); }
    onOpenChange(true);
  };
  const ensureDraft = () => { if (!draft) setDraft(openDraft()); return draft ?? openDraft(); };

  const move = (idx: number, dir: -1 | 1) => {
    setDraft((prev) => {
      const next = [...(prev ?? openDraft())];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      // cancelled is pinned last
      if (next[idx].key === 'cancelled' || next[j].key === 'cancelled') return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const save = async (reset = false) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reset ? { action: 'reset' } : { action: 'save', stages: draft ?? openDraft() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ذخیره');
      onSaved(reset ? null : data.stages);
      toast.success(reset ? 'کاریز به حالت پیش‌فرض بازگشت' : 'کاریز شخصی شما ذخیره شد');
      onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'خطا در ذخیره');
    } finally {
      setBusy(false);
    }
  };

  const rows: UserStage[] = draft ?? openDraft();
  const visibleCount = rows.filter((s) => s.visible && s.key !== 'cancelled').length;

  // v2.43.0 FIX (backported) — Radix <Dialog> renders raw children even when
  // open=false: this overlay stayed permanently mounted over the pipeline
  // page since v2.34.6, darkening it and swallowing clicks. Gate on open.
  if (!open) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) handleOpenChange(true); else onOpenChange(false); }}>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={() => onOpenChange(false)}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} onFocus={ensureDraft}>
          <div className="p-5 border-b border-gray-100">
            <h3 className="text-sm font-extrabold text-gray-900 flex items-center gap-2">
              <Settings2 size={16} className="text-teal-700" /> شخصی‌سازی کاریز فروش
            </h3>
            <p className="text-[11px] text-gray-400 mt-1">
              عنوان، ترتیب و نمایش مراحل — فقط برای خودتان. جای اسناد از وضعیت واقعی آن‌ها تعیین می‌شود و تغییر نمی‌کند.
            </p>
          </div>
          <div className="p-4 space-y-2">
            {rows.map((s, i) => {
              const meta = [...STAGES, CANCELLED_STAGE].find((m) => m.key === s.key);
              const pinned = s.key === 'cancelled';
              return (
                <div key={s.key} className="flex items-center gap-2 bg-gray-50 rounded-xl p-2.5 border border-gray-100">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => move(i, -1)} disabled={pinned || i === 0}
                      className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-20">
                      <ArrowUp size={11} />
                    </button>
                    <button onClick={() => move(i, 1)} disabled={pinned || i === rows.length - 1}
                      className="w-5 h-5 rounded flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-200 disabled:opacity-20">
                      <ArrowDown size={11} />
                    </button>
                  </div>
                  <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 bg-white border border-gray-100" style={{ color: meta?.color }}>
                    {meta?.icon}
                  </span>
                  <input
                    value={s.title}
                    onChange={(e) => setDraft((prev) => (prev ?? openDraft()).map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
                    maxLength={60}
                    className="flex-1 h-8 rounded-lg border border-gray-200 bg-white px-2.5 text-xs text-gray-800 outline-none focus:border-teal-300"
                  />
                  <label className="flex items-center gap-1 text-[11px] text-gray-500 shrink-0 cursor-pointer">
                    <input type="checkbox" checked={s.visible} disabled={pinned}
                      onChange={(e) => setDraft((prev) => (prev ?? openDraft()).map((x, j) => j === i ? { ...x, visible: e.target.checked } : x))}
                      className="accent-teal-600" />
                    نمایش
                  </label>
                  {pinned && <span className="text-[10px] text-gray-400 shrink-0">آخرین ستون</span>}
                </div>
              );
            })}
            {visibleCount === 0 && (
              <p className="text-[11px] text-amber-600 bg-amber-50 border border-amber-100 rounded-lg p-2">
                همه مراحل مخفی شده‌اند — کاریز با حالت پیش‌فرض نمایش داده می‌شود.
              </p>
            )}
            {err && <p className="text-[11px] text-red-600 bg-red-50 border border-red-100 rounded-lg p-2">{err}</p>}
          </div>
          <div className="p-4 border-t border-gray-100 flex items-center gap-2">
            <button onClick={() => save(false)} disabled={busy || visibleCount === 0}
              className="h-9 px-4 rounded-lg bg-teal-600 text-white text-xs font-bold hover:bg-teal-700 disabled:opacity-40">
              ذخیره کاریز من
            </button>
            <button onClick={() => save(true)} disabled={busy || !saved}
              className="h-9 px-3 rounded-lg border border-gray-200 text-gray-500 text-xs font-medium hover:bg-gray-50 flex items-center gap-1.5 disabled:opacity-40">
              <RotateCcw size={12} /> بازنشانی به پیش‌فرض
            </button>
            <button onClick={() => onOpenChange(false)} disabled={busy}
              className="h-9 px-3 rounded-lg text-gray-500 text-xs font-medium hover:bg-gray-50 mr-auto">انصراف</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
