// ════════════════════════════════════════════════════════════════
// dispatch-issue.ts — v2.39.0 (round 65) SERVER-side helpers for the
// «سند ارسال مراسلات» (dispatch document) that is issued
// AUTOMATICALLY the moment a sales invoice is issued.
//
// User request: «سند ارسال مراسلات کالاها بعد از صدور فاکتور به
// صورت اتوماتیک برای درج در روی کارتون‌ها صادر شود» — the goods
// dispatch document must be issued automatically after the invoice,
// ready to print and stick on the cartons (label print dialog opens
// right after issuance; see src/components/shipping-label.tsx).
//
// Server-only module (Prisma imports) — the PURE label helpers live
// in src/lib/dispatch-label.ts which client code may import.
// ════════════════════════════════════════════════════════════════
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { buildItemsSummary } from '@/lib/dispatch-label';

/** The invoice rows an auto-issued dispatch is built from. */
export interface DispatchDocShape {
  id: string;
  documentNumber: string | null;
}

/** Atomic sequential shipment number: SHP-YYMMDD-NNNN (v2.13.0 pattern).
 *  v2.39.0 — moved here from /api/shipments so the sales-documents
 *  issuance paths and the shipments route share ONE counter (previously
 *  the pattern was duplicated; both must race the same Meta row). */
export async function generateShipmentNumber(tx?: Prisma.TransactionClient): Promise<string> {
  const client = tx ?? db;
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayKey = `${y}${m}${d}`;
  const metaKey = `shipseq.SHP.${dayKey}`;

  const rows = await client.$queryRaw<Array<{ value: string }>>`
    INSERT INTO Meta (key, value, updatedAt) VALUES (${metaKey}, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(Meta.value AS INTEGER) + 1 AS TEXT),
      updatedAt = datetime('now')
    RETURNING value
  `;
  const seq = Number(rows[0]?.value);
  if (!Number.isFinite(seq) || seq < 1) {
    throw new Error('خطا در تولید شماره ارسال (شمارندهٔ اتمیک).');
  }
  return `SHP-${dayKey}-${String(seq).padStart(4, '0')}`;
}

/**
 * AUTO-ISSUE the dispatch document (سند ارسال مراسلات) for an invoice
 * that has just been issued. Runs INSIDE the caller's transaction so
 * the invoice and its dispatch row commit (or roll back) atomically —
 * the سند ارسال genuinely «به صورت اتوماتیک صادر می‌شود» with the
 * invoice, not as a best-effort follow-up.
 *
 * Status starts at «در حال آماده‌سازی» (preparing): the carton label
 * prints immediately; the warehouse then walks the shipment through
 * the existing ready → in-transit → delivered flow.
 */
export async function autoIssueDispatch(
  tx: Prisma.TransactionClient,
  doc: DispatchDocShape,
  userId: string,
  items: Array<{ productName: string | null; quantity: number | null }>,
): Promise<{ id: string; shipmentNumber: string | null; status: string; itemsSummary: string }> {
  const itemsSummary = buildItemsSummary(items);
  const shipmentNumber = await generateShipmentNumber(tx);
  const shipment = await tx.salesShipment.create({
    data: {
      shipmentNumber,
      salesDocumentId: doc.id,
      status: 'preparing',
      carrierName: '',
      trackingCode: '',
      itemsSummary,
      weight: '',
      notes: `سند ارسال خودکار پس از صدور فاکتور ${doc.documentNumber ?? ''}`.trim(),
      createdById: userId,
    },
    select: { id: true, shipmentNumber: true, status: true, itemsSummary: true },
  });
  await tx.salesDocumentLog.create({
    data: {
      salesDocumentId: doc.id,
      userId,
      action: 'shipment-auto-created',
      details: JSON.stringify({
        shipmentId: shipment.id,
        shipmentNumber: shipment.shipmentNumber,
        status: shipment.status,
        autoIssued: true,
      }),
    },
  });
  return shipment;
}

/**
 * v2.46.0 (round 71) — atomic sequential CARTON-LABEL serial:
 * LBL-YYMMDD-NNNN, issued per printed carton sheet («شماره سریال هم
 * صادر شود»). Races its own Meta counter row — same proven pattern as
 * generateShipmentNumber so parallel print runs never collide.
 */
export async function generateLabelSerial(tx?: Prisma.TransactionClient): Promise<string> {
  const client = tx ?? db;
  const now = new Date();
  const y = now.getFullYear().toString().slice(-2);
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayKey = `${y}${m}${d}`;
  const metaKey = `lblseq.LBL.${dayKey}`;

  const rows = await client.$queryRaw<Array<{ value: string }>>`
    INSERT INTO Meta (key, value, updatedAt) VALUES (${metaKey}, '1', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = CAST(CAST(Meta.value AS INTEGER) + 1 AS TEXT),
      updatedAt = datetime('now')
    RETURNING value
  `;
  const seq = Number(rows[0]?.value);
  if (!Number.isFinite(seq) || seq < 1) {
    throw new Error('خطا در تولید شماره سریال برچسب (شمارندهٔ اتمیک).');
  }
  return `LBL-${dayKey}-${String(seq).padStart(4, '0')}`;
}

/** Carton-label rows as returned by the shipments API. */
export interface CartonLabelRow {
  id: string;
  serial: string;
  cartonIndex: number;
  cartonTotal: number;
}

/**
 * v2.46.0 (round 71) — ISSUE carton-label serials for a dispatch
 * («شماره سریال هم صادر شود»). Idempotent + append-only:
 *  • cartonCount ≤ existing → returns the existing rows untouched
 *    (serials are the paper trail; a smaller re-request changes nothing)
 *  • cartonCount > existing → appends rows for indices existing+1 … N
 *    and updates cartonTotal on ALL rows to the new total
 * Runs INSIDE the caller's transaction; never deletes anything.
 */
export async function issueCartonLabels(
  tx: Prisma.TransactionClient,
  args: {
    shipmentId: string;
    salesDocumentId: string;
    cartonCount: number;
    userId: string;
  },
): Promise<CartonLabelRow[]> {
  const { shipmentId, salesDocumentId, cartonCount, userId } = args;
  const existing = await tx.cartonLabel.findMany({
    where: { shipmentId },
    orderBy: { cartonIndex: 'asc' },
    select: { id: true, serial: true, cartonIndex: true, cartonTotal: true },
  });

  let rows = existing;
  if (cartonCount > existing.length) {
    for (let i = existing.length + 1; i <= cartonCount; i++) {
      const serial = await generateLabelSerial(tx);
      const created = await tx.cartonLabel.create({
        data: {
          serial,
          shipmentId,
          salesDocumentId,
          cartonIndex: i,
          cartonTotal: cartonCount,
          createdById: userId,
        },
        select: { id: true, serial: true, cartonIndex: true, cartonTotal: true },
      });
      rows = [...rows, created];
    }
    // keep «X از N» honest on every older row too
    await tx.cartonLabel.updateMany({
      where: { shipmentId, cartonTotal: { lt: cartonCount } },
      data: { cartonTotal: cartonCount },
    });
    rows = rows.map((r) => ({ ...r, cartonTotal: Math.max(r.cartonTotal, cartonCount) }));
  }
  return rows;
}

/**
 * Cancel-time cleanup: delete an invoice's dispatch rows that never
 * left the warehouse (status «در حال آماده‌سازی») so a cancelled
 * invoice leaves no orphan سند ارسال. Shipments that already moved
 * (ready / in-transit / delivered / returned) are HISTORY and stay.
 * Returns the removed shipment numbers for the audit log.
 */
export async function removePreparingShipments(
  tx: Prisma.TransactionClient,
  salesDocumentId: string,
  userId: string,
): Promise<Array<string | null>> {
  const stale = await tx.salesShipment.findMany({
    where: { salesDocumentId, status: 'preparing' },
    select: { id: true, shipmentNumber: true },
  });
  if (stale.length === 0) return [];
  await tx.salesShipment.deleteMany({
    where: { id: { in: stale.map((s) => s.id) } },
  });
  await tx.salesDocumentLog.create({
    data: {
      salesDocumentId,
      userId,
      action: 'shipment-auto-removed',
      details: JSON.stringify({
        removed: stale.map((s) => s.shipmentNumber),
        reason: 'document-cancelled',
      }),
    },
  });
  return stale.map((s) => s.shipmentNumber);
}
