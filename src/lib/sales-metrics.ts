import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════════════
//  SALES METRICS — purchase double-count guard (v2.14.0)
//
//  Background: approving a proforma DERIVES an approved invoice
//  document (same amounts, description `صادر شده از … شماره PF-…`)
//  which carries the financial effects (linked accounting invoice,
//  center account). Purchase/sales aggregations that simply count
//  approved documents of BOTH types therefore count the same
//  purchase twice — the customer-club report showed totalAmount and
//  purchaseCount up to 2× reality.
//
//  Rule: a purchase is represented by an approved `invoice`
//  document (quick-sale, directly-approved, or derived from a
//  proforma). An approved `proforma` counts ONLY when no derived
//  invoice exists (legacy rows approved before derivation).
// ════════════════════════════════════════════════════════════════

type DbClient = Prisma.TransactionClient | typeof db;

/** Marker prefix of derived invoice documents (legacy-compatible —
 *  the cancel flow locates derived docs by the same convention). */
const DERIVED_MARKER = 'صادر شده از';
const NUMBER_MARKER = 'شماره';

/**
 * Document numbers of proformas whose invoice has been derived.
 *
 * Derived invoice documents carry the source proforma's number after
 * the LAST `شماره` marker in their description
 * (`صادر شده از پیش‌فاکتور شماره PF-1234`). Any status counts —
 * if the derived invoice was cancelled the purchase was rolled back,
 * so the proforma must not re-enter the totals either.
 */
export async function proformaNumbersWithDerivedInvoice(
  client: DbClient = db,
): Promise<Set<string>> {
  const derived = await client.salesDocument.findMany({
    where: {
      documentType: 'invoice',
      description: { contains: DERIVED_MARKER },
    },
    select: { description: true },
  });
  const numbers = new Set<string>();
  for (const row of derived) {
    const desc = row.description || '';
    const marker = desc.lastIndexOf(NUMBER_MARKER);
    if (marker >= 0) {
      const num = desc.slice(marker + NUMBER_MARKER.length).trim();
      if (num) numbers.add(num);
    }
  }
  return numbers;
}

/**
 * True when this document represents a distinct purchase for
 * aggregation purposes (call after the approved filter).
 */
export function countsAsPurchase(
  doc: { documentType: string; documentNumber: string | null },
  proformasWithInvoice: Set<string>,
): boolean {
  if (doc.documentType === 'invoice') return true;
  if (doc.documentType === 'proforma') {
    // legacy proforma without a derived invoice — still the only
    // record of the purchase
    return !(doc.documentNumber && proformasWithInvoice.has(doc.documentNumber));
  }
  return false; // returns and anything else are not purchases
}
