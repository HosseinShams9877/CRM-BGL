/**
 * v2.17.0 — shared shipment vocabulary (ارسال بار).
 *
 * Single source of truth for shipment statuses, their Persian labels and
 * the legal transition graph. Both the API route (/api/shipments) and the
 * frontend (sales-pipeline + sales-production) read from here so the
 * dispatch column, the shipments tab and the status buttons can never
 * drift apart.
 *
 * Statuses (kebab-case, matching SalesDocument's pending_approval style):
 *  preparing  در حال آماده‌سازی — ثبت اولیهٔ ارسال
 *  ready      آماده بارگیری — بسته‌بندی/بارگیری تمام شده
 *  in-transit در راه — از انبار خارج شده (dispatchedAt ثبت می‌شود)
 *  delivered  تحویل داده — مشتری دریافت کرده (deliveredAt ثبت می‌شود)
 *  returned   برگشتی — مرسوله برگشت خورده
 */

export const SHIPMENT_STATUSES = [
  'preparing',
  'ready',
  'in-transit',
  'delivered',
  'returned',
] as const;

export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Persian label + presentation colors (same palette language as the UI). */
export const SHIPMENT_STATUS_INFO: Record<
  ShipmentStatus,
  { label: string; color: string; bg: string }
> = {
  preparing: { label: 'در حال آماده‌سازی', color: '#d97706', bg: '#fffbeb' },
  ready: { label: 'آماده بارگیری', color: '#6366f1', bg: '#eef2ff' },
  'in-transit': { label: 'در راه', color: '#0891b2', bg: '#ecfeff' },
  delivered: { label: 'تحویل داده', color: '#059669', bg: '#ecfdf5' },
  returned: { label: 'برگشتی', color: '#dc2626', bg: '#fef2f2' },
};

/** Legal forward/side transitions. Keys missing from the map are terminal. */
export const SHIPMENT_TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  preparing: ['ready', 'in-transit', 'returned'],
  ready: ['in-transit', 'returned'],
  'in-transit': ['delivered', 'returned'],
  delivered: [],
  returned: [],
};

export function isShipmentStatus(v: unknown): v is ShipmentStatus {
  return typeof v === 'string' && (SHIPMENT_STATUSES as readonly string[]).includes(v);
}

export function canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return SHIPMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that keep a document in the pipeline's «ارسال بار» column. */
export const DISPATCH_ACTIVE_STATUSES: readonly ShipmentStatus[] = [
  'preparing',
  'ready',
  'in-transit',
  'delivered',
];

/**
 * A document sits in the dispatch column while it has at least one
 * shipment that has not come back. A returned parcel un-ships the
 * document (it is back on the shelf → فاکتور stage again).
 */
export function docHasActiveDispatch(shipmentStatuses: string[]): boolean {
  return shipmentStatuses.some((s) => DISPATCH_ACTIVE_STATUSES.includes(s as ShipmentStatus));
}
