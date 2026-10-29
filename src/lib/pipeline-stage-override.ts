// ════════════════════════════════════════════════════════════════
// pipeline-stage-override.ts — v2.45.0 (r70)
//
// User request: «کاریز فروش — جابه‌جایی مراحل با درگ کردن و جابه‌جایی
// با موس بین ستون‌ها باشد» — the pipeline board must support REAL
// mouse drag & drop of cards between columns.
//
// The board's stage was previously DERIVED ONLY from live document
// status + shipments (v2.16/v2.17): free-form drops were rejected with
// «جابه‌جایی آزاد مراحل غیرفعال است». From v2.45.0 a drop persists a
// MANUAL STAGE PIN (SalesDocument.pipelineStage) so the card truly
// lands in the chosen column — while every legacy row (pin = null)
// keeps the untouched derived behavior. Real workflow events clear the
// pin so the board can never contradict the underlying data for long.
//
// This module is the single source of truth for the pin contract —
// shared by the board component, the center dossier, and the API
// (move-stage action) so client and server can never disagree.
// ════════════════════════════════════════════════════════════════

/** The board's column keys (mirrors sales-pipeline.tsx STAGES + terminal). */
export const PIPELINE_STAGE_KEYS = [
  'presentation',
  'negotiation',
  'proforma',
  'proforma-followup',
  'invoice',
  'dispatch',
  'procurement',
  'cancelled',
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGE_KEYS)[number];

/** Persian labels — used by the API's log details and error messages. */
export const PIPELINE_STAGE_LABELS: Record<PipelineStageKey, string> = {
  presentation: 'تماس اولیه / پرزنت',
  negotiation: 'پیگیری مذاکرات',
  proforma: 'صدور پیش‌فاکتور',
  'proforma-followup': 'پیگیری صدور پیش‌فاکتور',
  invoice: 'فاکتور',
  dispatch: 'ارسال بار',
  procurement: 'سامانهٔ تدارکات',
  cancelled: 'لغو شده',
};

/**
 * Stages a user may PIN a card to via drag & drop. The terminal
 * «لغو شده» column is deliberately NOT pinnable: a drop there must not
 * fake-cancel a live document (cancellation reverts finances/loyalty —
 * far too destructive to hang on a mouse gesture). Dropping a card on
 * the cancelled column is intercepted client-side with guidance toward
 * the real cancel flow.
 */
export const PINNABLE_STAGE_KEYS: readonly PipelineStageKey[] = PIPELINE_STAGE_KEYS.filter(
  (k) => k !== 'cancelled',
);

/** Is `value` one of the board's stage keys? */
export function isPipelineStageKey(value: unknown): value is PipelineStageKey {
  return (
    typeof value === 'string' &&
    (PIPELINE_STAGE_KEYS as readonly string[]).includes(value)
  );
}

/** Can the user pin a card to this stage through move-stage? */
export function isPinnableStage(value: unknown): value is PipelineStageKey {
  return (
    typeof value === 'string' &&
    (PINNABLE_STAGE_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Normalize a stored/patched pin value. Junk (legacy rows, tampered
 * payloads, unknown future keys) collapses to null → derived stage —
 * the board NEVER breaks on a bad pin, it just ignores it.
 */
export function normalizePinnedStage(value: unknown): PipelineStageKey | null {
  return isPinnableStage(value) ? value : null;
}

/**
 * The board stage of a document: manual pin (when present AND the doc
 * is still alive) over the DERIVED stage. Rules:
 *  • a CANCELLED document is always terminal «لغو شده» — its pin (if
 *    any survived) is meaningless, so it is ignored;
 *  • a valid pin wins over the derived stage (that is the point of
 *    drag & drop);
 *  • null / invalid pin → derived (legacy behavior, bit-for-bit).
 */
export function effectiveStage(
  derived: PipelineStageKey,
  pin: unknown,
  liveStatus: string,
): PipelineStageKey {
  if (liveStatus === 'cancelled') return 'cancelled';
  return normalizePinnedStage(pin) ?? derived;
}

/**
 * What a card-drop onto `target` resolves to.
 *  • 'same'     → no-op (card already lives in that column);
 *  • 'pin'      → persist the manual pin (the free move);
 *  • 'rejected' → the move is not allowed — `reason` explains it in
 *                 Persian for the toast.
 * `from` is the card's CURRENT effective stage; `liveStatus` its real
 * status; `hasRealShipment` whether a non-returned shipment exists.
 */
export type StageMovePlan =
  | { kind: 'same' }
  | { kind: 'pin'; stage: PipelineStageKey }
  | { kind: 'rejected'; reason: string };

export function planStageMove(args: {
  from: PipelineStageKey;
  target: PipelineStageKey;
  liveStatus: string;
  hasRealShipment: boolean;
}): StageMovePlan {
  const { from, target, liveStatus, hasRealShipment } = args;

  if (target === from) return { kind: 'same' };

  // A cancelled card is dead — it only ever sits in the terminal column.
  if (liveStatus === 'cancelled') {
    return {
      kind: 'rejected',
      reason:
        'سند لغوشده از چرخهٔ فروش خارج است و جابه‌جایی آن در کاریز معنا ندارد.',
    };
  }

  // Dropping a LIVE card onto the terminal column ≠ cancelling it.
  if (target === 'cancelled') {
    return {
      kind: 'rejected',
      reason:
        'برای لغو سند از عملیات «لغو» در پروندهٔ سند استفاده کنید — لغو، آثار مالی را هم برمی‌گرداند و نباید با کشیدن ماوس اتفاق بیفتد.',
    };
  }

  // Everything else is a genuine free move.
  if (hasRealShipment && from === 'dispatch') {
    // Allowed, but the caller should ALSO warn: the real send survives
    // (returned via the plan's stage — the toast is the caller's job).
    return { kind: 'pin', stage: target };
  }
  return { kind: 'pin', stage: target };
}

/** Should a real workflow event clear the pin? (server-side rule) */
export function workflowEventClearsPin(event: string): boolean {
  return [
    'submit-approval',
    'approve',
    'reject',
    'cancel',
    'shipment-created',
    'shipment-returned',
    'shipment-deleted',
  ].includes(event);
}
