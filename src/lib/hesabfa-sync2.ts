// ════════════════════════════════════════════════════════════
// hesabfa-sync2.ts — v2.57.0 (round 83) items/contacts/invoices sync
//
// Extends the v2.33 inventory engine (hesabfa-sync.ts) with the three
// sections of upload/حسابفا.txt:
//   runItemsSync     — item catalog cache (HesabfaItem) with prices
//   runContactsSync  — contacts cache (HesabfaContact) incl. balance
//   runInvoicesSync  — invoices cache (HesabfaInvoice) + serial
//                      extraction & application into InventorySerial
//
// Shared rules with the inventory engine:
//   • per-company in-process + DB lock (SYNC_ALREADY_RUNNING)
//   • v2.58.0 — ONE TRANSACTION PER INVOICE: a failed write can only ever
//     lose a single invoice's cache row + serials, never a partial serial
//     state machine (the header used to claim "one transaction per
//     company" — the code never had any)
//   • re-sync is IDEMPOTENT: upserts on natural keys (companyId+code/
//     hesabfaId), no duplicates, no resets of manual mappings
//     (HesabfaCenterLink / HesabfaProductLink are never touched)
//   • serials with operational statuses (demo/reserved/expert) are
//     recorded but never overwritten
// ════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { forScope } from '@/lib/logger';
import {
  HesabfaError, fetchAllItems, fetchAllContacts, fetchInvoices,
  HesabfaConnSettings, loadCompanyConnection,
} from '@/lib/hesabfa-client';
import {
  extractSerialsFromItems, decideSerialSync, historyActionFor, historyDescriptionFor,
  HESABFA_INVOICE_SALE, HESABFA_INVOICE_PURCHASE,
} from '@/lib/hesabfa-serial';
import { jalaliStringToGregorianIso } from '@/lib/jalali';

const logger = forScope('hesabfa-sync2');

export const SYNC_ALREADY_RUNNING = 'SYNC_ALREADY_RUNNING';
const ORPHAN_LOCK_MS = 10 * 60 * 1000;

const running = new Set<string>(); // `${section}:${companyId}`

export interface SectionStats { [k: string]: number }
export interface SectionSyncResult {
  ok: boolean;
  message: string;
  stats?: SectionStats;
}

/** Generic per-section lock (in-process + DB HesabfaJob row). */
async function acquireLock(section: string, companyId: string): Promise<string | null> {
  const key = `${section}:${companyId}`;
  if (running.has(key)) return null;
  const jobType = `hesabfa-${section}`;
  const stale = await db.hesabfaJob.findFirst({
    where: { jobType, companyId, status: 'running', updatedAt: { lt: new Date(Date.now() - ORPHAN_LOCK_MS) } },
    select: { id: true },
  });
  if (stale) {
    await db.hesabfaJob.update({ where: { id: stale.id }, data: { status: 'failed', result: JSON.stringify({ error: 'orphan lock cleared' }) } }).catch(() => undefined);
  }
  const active = await db.hesabfaJob.findFirst({ where: { jobType, companyId, status: 'running' }, select: { id: true } });
  if (active) return null;
  const job = await db.hesabfaJob.create({
    data: { jobType, companyId, status: 'running', payload: JSON.stringify({ companyId, section, startedAt: new Date().toISOString() }) },
  });
  running.add(key);
  return job.id;
}

async function releaseLock(section: string, companyId: string, jobId: string | null, status: string, result: unknown) {
  running.delete(`${section}:${companyId}`);
  if (jobId) await db.hesabfaJob.update({ where: { id: jobId }, data: { status, result: JSON.stringify(result) } }).catch(() => undefined);
}

async function loadSettings(companyId: string) {
  const conn = await loadCompanyConnection(companyId);
  if (!conn) return null;
  return { apiKey: conn.apiKey, loginToken: conn.loginToken, baseUrl: conn.baseUrl } satisfies HesabfaConnSettings;
}

// ════════════════════════════════════════════════════════════
//  ITEM CATALOG SYNC (Sync کالاها)
// ════════════════════════════════════════════════════════════
export async function runItemsSync(companyId: string): Promise<SectionSyncResult> {
  const settings = await loadSettings(companyId);
  if (!settings) return { ok: false, message: 'اتصال حسابفا برای این شرکت فعال نیست' };
  const jobId = await acquireLock('items', companyId);
  if (!jobId) return { ok: false, message: SYNC_ALREADY_RUNNING };

  try {
    const items = await fetchAllItems(settings);
    const now = new Date();
    let upserts = 0;
    // batched upserts — natural key (companyId, itemCode) keeps it idempotent
    for (const it of items) {
      const code = String(it.Code ?? it.Id ?? '');
      if (!code) continue;
      await db.hesabfaItem.upsert({
        where: { companyId_itemCode: { companyId, itemCode: code } },
        create: {
          companyId, itemCode: code, hesabfaId: Number(it.Id ?? 0) || 0,
          name: String(it.Name ?? code), barCode: String(it.Barcode ?? ''),
          unit: String(it.Unit ?? ''), buyPrice: Number(it.BuyPrice ?? 0) || 0,
          sellPrice: Number(it.SellPrice ?? 0) || 0,
          categoryPath: String(it.Category?.Name ?? ''), active: it.Active !== false,
          syncedAt: now,
        },
        update: {
          hesabfaId: Number(it.Id ?? 0) || 0,
          name: String(it.Name ?? code), barCode: String(it.Barcode ?? ''),
          unit: String(it.Unit ?? ''), buyPrice: Number(it.BuyPrice ?? 0) || 0,
          sellPrice: Number(it.SellPrice ?? 0) || 0,
          categoryPath: String(it.Category?.Name ?? ''), active: it.Active !== false,
          syncedAt: now,
        },
      });
      upserts += 1;
    }
    // deactivate catalog rows the API no longer returns (kept for history,
    // flagged inactive — NOT deleted, so historical invoices keep names)
    const liveCodes = new Set(items.map((it) => String(it.Code ?? it.Id ?? '')).filter(Boolean));
    const stale = await db.hesabfaItem.findMany({ where: { companyId }, select: { itemCode: true } });
    const gone = stale.filter((s) => !liveCodes.has(s.itemCode));
    if (gone.length) {
      await db.hesabfaItem.updateMany({ where: { companyId, itemCode: { in: gone.map((g) => g.itemCode) } }, data: { active: false } });
    }
    const stats = { items: items.length, upserts, deactivated: gone.length };
    await db.hesabfaConnection.update({
      where: { companyId },
      data: { lastSyncStats: JSON.stringify({ section: 'items', ...stats }) },
    }).catch(() => undefined);
    await releaseLock('items', companyId, jobId, 'success', stats);
    logger.info(`items sync company=${companyId} items=${items.length}`);
    return { ok: true, message: `همگام‌سازی کالاها انجام شد (${items.length} کالا${gone.length ? `، ${gone.length} کالا غیرفعال شد` : ''})`, stats };
  } catch (e) {
    const msg = e instanceof HesabfaError ? e.message : 'خطای همگام‌سازی کالاها';
    await releaseLock('items', companyId, jobId, 'failed', { error: msg });
    return { ok: false, message: msg };
  }
}

// ════════════════════════════════════════════════════════════
//  CONTACTS SYNC (Sync مشتریان)
// ════════════════════════════════════════════════════════════
export async function runContactsSync(companyId: string): Promise<SectionSyncResult> {
  const settings = await loadSettings(companyId);
  if (!settings) return { ok: false, message: 'اتصال حسابفا برای این شرکت فعال نیست' };
  const jobId = await acquireLock('contacts', companyId);
  if (!jobId) return { ok: false, message: SYNC_ALREADY_RUNNING };

  try {
    const rows = await fetchAllContacts(settings);
    const now = new Date();
    let upserts = 0;
    for (const c of rows) {
      const hid = Number(c.Id ?? 0);
      if (!hid) continue;
      const payload = {
        code: String(c.Code ?? ''), name: String(c.Name ?? ((`${c.FirstName ?? ''} ${c.LastName ?? ''}`).trim() || `#${hid}`)),
        contactType: Number(c.ContactType ?? 0) || 0,
        phone: String(c.Phone ?? ''), mobile: String(c.Mobile ?? ''), email: String(c.Email ?? ''),
        city: String(c.City ?? ''), province: String(c.Province ?? ''), address: String(c.Address ?? ''),
        nationalCode: String(c.NationalCode ?? ''), balance: Number(c.Balance ?? 0) || 0,
        syncedAt: now,
      };
      await db.hesabfaContact.upsert({
        where: { companyId_hesabfaId: { companyId, hesabfaId: hid } },
        create: { companyId, hesabfaId: hid, ...payload },
        update: payload,
      });
      upserts += 1;
    }
    // link update: existing HesabfaCenterLink rows are NEVER deleted here
    // (spec: manual mappings survive syncs).
    const stats = { contacts: rows.length, upserts };
    await db.hesabfaConnection.update({
      where: { companyId },
      data: { lastSyncStats: JSON.stringify({ section: 'contacts', ...stats }) },
    }).catch(() => undefined);
    await releaseLock('contacts', companyId, jobId, 'success', stats);
    logger.info(`contacts sync company=${companyId} contacts=${rows.length}`);
    return { ok: true, message: `همگام‌سازی مشتریان انجام شد (${rows.length} مخاطب)`, stats };
  } catch (e) {
    const msg = e instanceof HesabfaError ? e.message : 'خطای همگام‌سازی مشتریان';
    await releaseLock('contacts', companyId, jobId, 'failed', { error: msg });
    return { ok: false, message: msg };
  }
}

// ════════════════════════════════════════════════════════════
//  INVOICES SYNC + SERIALS (Sync فاکتورها + سریال‌ها)
// ════════════════════════════════════════════════════════════
export interface SerialApplyOutcome {
  created: number; markedSold: number; restocked: number; metaUpdated: number;
  skippedOperational: number; skippedKept: number; conflicts: number;
}

/** contact code → CRM center id (manual mapping, never auto-reset).
 * v2.58.0 (audit 85-c): scoped to the SYNCING company's centers. The link
 * table carries no companyId column, so we resolve through the company's
 * center ids — before, ALL companies' links were loaded and a shared
 * contact code could route a serial to another company's center. */
async function centerIdByContactCode(companyId: string): Promise<Map<string, string>> {
  const centers = await db.center.findMany({ where: { companyId }, select: { id: true } });
  const links = await db.hesabfaCenterLink.findMany({
    where: { centerId: { in: centers.map((c) => c.id) } },
    select: { centerId: true, hesabfaId: true },
  });
  const byCode = new Map<string, string>();
  for (const l of links) byCode.set(String(l.hesabfaId), l.centerId);
  return byCode;
}

export async function runInvoicesSync(companyId: string): Promise<SectionSyncResult> {
  const settings = await loadSettings(companyId);
  if (!settings) return { ok: false, message: 'اتصال حسابفا برای این شرکت فعال نیست' };
  const jobId = await acquireLock('invoices', companyId);
  if (!jobId) return { ok: false, message: SYNC_ALREADY_RUNNING };

  try {
    const centerByCode = await centerIdByContactCode(companyId);
    const serialStats: SerialApplyOutcome = {
      created: 0, markedSold: 0, restocked: 0, metaUpdated: 0, skippedOperational: 0, skippedKept: 0, conflicts: 0,
    };
    let invoiceCount = 0;
    const now = new Date();

    for (const type of [HESABFA_INVOICE_SALE, HESABFA_INVOICE_PURCHASE]) {
      const invoices = await fetchInvoices(settings, type, { withItems: true });
      for (const inv of invoices) {
        const hid = Number(inv.Id ?? 0);
        if (!hid) continue;
        const items = inv.InvoiceItems ?? inv.Items ?? [];
        const serials = extractSerialsFromItems(items);
        const number = String(inv.Number ?? '');
        const contactHesabfaId = Number(inv.ContactId ?? 0) || 0;
        const contactCode = String(inv.ContactCode ?? '');
        const invDate = String(inv.Date ?? '');
        // v2.58.0 (audit 85-c HIGH): invoice upsert + its serial state
        // machine now land in ONE transaction — a mid-write failure can
        // no longer leave a half-applied serial (e.g. row flipped to sold
        // but history/orphan fields missing). Serial existence lookups
        // are batched (one findMany per invoice instead of 3-4 queries
        // per serial — ≈1,000 queries/sync on the live DB), and a serial
        // unique-collision (the same physical serial surfaced by BOTH
        // Hesabfa accounts) is counted as a conflict instead of aborting
        // the whole company's sync mid-run.
        await db.$transaction(async (tx) => {
          await tx.hesabfaInvoice.upsert({
            where: { companyId_hesabfaId: { companyId, hesabfaId: hid } },
            create: {
              companyId, hesabfaId: hid, number, invoiceType: type, date: invDate,
              contactHesabfaId, contactCode, contactName: String(inv.ContactName ?? ''),
              totalAmount: Number(inv.TotalAmount ?? 0) || 0, paidAmount: Number(inv.PaidAmount ?? 0) || 0,
              description: String(inv.Description ?? ''),
              itemsJson: JSON.stringify(items), serialsJson: JSON.stringify(serials),
              syncedAt: now,
            },
            update: {
              number, date: invDate, contactHesabfaId, contactCode,
              contactName: String(inv.ContactName ?? ''),
              totalAmount: Number(inv.TotalAmount ?? 0) || 0, paidAmount: Number(inv.PaidAmount ?? 0) || 0,
              description: String(inv.Description ?? ''),
              itemsJson: JSON.stringify(items), serialsJson: JSON.stringify(serials),
              syncedAt: now,
            },
          });

          // batched existence probe for this invoice's serials
          const existingBySerial = new Map<
            string,
            { id: string; status: string; centerId: string | null; soldAt: Date | null; hesabfaContactCode: string; notes: string }
          >();
          if (serials.length > 0) {
            const rows = await tx.inventorySerial.findMany({
              where: { serialNumber: { in: serials } },
              select: { id: true, serialNumber: true, status: true, centerId: true, soldAt: true, hesabfaContactCode: true, notes: true },
            });
            for (const r of rows) existingBySerial.set(r.serialNumber, r);
          }

          for (const serialNumber of serials) {
            const existing = existingBySerial.get(serialNumber);
            const action = decideSerialSync(type, existing?.status ?? null);
            const centerId = contactCode ? centerByCode.get(contactCode) ?? null : null;
            const soldAt = invDate ? jalaliToDate(invDate) : null;
            if (action.kind === 'create-available') {
              try {
                const created = await tx.inventorySerial.create({
                  data: {
                    serialNumber, status: 'available', companyId, source: 'hesabfa',
                    hesabfaInvoiceNumber: number, hesabfaInvoiceId: hid,
                    hesabfaContactCode: contactCode,
                    notes: `ورود از فاکتور خرید حسابفا ${number}`,
                    ...(await itemCodeForSerial(serialNumber, companyId, items)),
                  },
                  select: { id: true },
                });
                await appendHistory(tx, created.id, action, type, number);
                serialStats.created += 1;
              } catch (e) {
                if (isUniqueConflict(e)) { serialStats.conflicts += 1; continue; }
                throw e;
              }
            } else if (action.kind === 'create-sold') {
              try {
                const created = await tx.inventorySerial.create({
                  data: {
                    serialNumber, status: 'sold', companyId, source: 'hesabfa',
                    hesabfaInvoiceNumber: number, hesabfaInvoiceId: hid,
                    hesabfaContactCode: contactCode,
                    soldAt: soldAt ?? now, centerId,
                    notes: `فروش از فاکتور حسابفا ${number}`,
                    ...(await itemCodeForSerial(serialNumber, companyId, items)),
                  },
                  select: { id: true },
                });
                await appendHistory(tx, created.id, action, type, number);
                serialStats.created += 1;
              } catch (e) {
                if (isUniqueConflict(e)) { serialStats.conflicts += 1; continue; }
                throw e;
              }
            } else if (action.kind === 'mark-sold' && existing) {
              await tx.inventorySerial.update({
                where: { serialNumber },
                data: {
                  status: 'sold', soldAt: soldAt ?? existing.soldAt ?? now,
                  centerId: centerId ?? existing.centerId, source: 'hesabfa',
                  hesabfaInvoiceNumber: number, hesabfaInvoiceId: hid,
                  hesabfaContactCode: contactCode || existing.hesabfaContactCode,
                },
              });
              await appendHistory(tx, existing.id, action, type, number);
              serialStats.markedSold += 1;
            } else if (action.kind === 'restock' && existing) {
              await tx.inventorySerial.update({
                where: { serialNumber },
                data: {
                  status: 'available', source: 'hesabfa',
                  hesabfaInvoiceNumber: number, hesabfaInvoiceId: hid,
                  hesabfaContactCode: contactCode || existing.hesabfaContactCode,
                  notes: existing.notes || `بازگشت به موجود — فاکتور خرید حسابفا ${number}`,
                },
              });
              await appendHistory(tx, existing.id, action, type, number);
              serialStats.restocked += 1;
            } else if (action.kind === 'update-meta' && existing) {
              // correct status already matches → provenance refresh only,
              // with a guard: never move an internal serial's company away
              await tx.inventorySerial.update({
                where: { serialNumber },
                data: {
                  hesabfaInvoiceNumber: number, hesabfaInvoiceId: hid,
                  hesabfaContactCode: contactCode || existing.hesabfaContactCode,
                  source: 'hesabfa',
                },
              });
              serialStats.metaUpdated += 1;
            } else if (action.kind === 'skip-operational') {
              serialStats.skippedOperational += 1;
            } else if (action.kind === 'skip-kept') {
              serialStats.skippedKept += 1;
            }
          }
        });
        invoiceCount += 1;
      }
    }

    const stats = { invoices: invoiceCount, ...serialStats };
    await db.hesabfaConnection.update({
      where: { companyId },
      data: { lastSyncStats: JSON.stringify({ section: 'invoices', ...stats }) },
    }).catch(() => undefined);
    await releaseLock('invoices', companyId, jobId, 'success', stats);
    logger.info(`invoices sync company=${companyId} invoices=${invoiceCount} serials=${JSON.stringify(serialStats)}`);
    return {
      ok: true,
      message: `همگام‌سازی فاکتورها انجام شد (${invoiceCount} فاکتور؛ سریال: ${serialStats.created} جدید، ${serialStats.markedSold} فروش، ${serialStats.restocked} بازگشت، ${serialStats.skippedOperational} عملیاتی محفوظ${serialStats.conflicts > 0 ? `، ${serialStats.conflicts} تعارض سریال` : ''})`,
      stats,
    };
  } catch (e) {
    const msg = e instanceof HesabfaError ? e.message : 'خطای همگام‌سازی فاکتورها';
    await releaseLock('invoices', companyId, jobId, 'failed', { error: msg });
    return { ok: false, message: msg };
  }
}

/** v2.58.0 — serial unique-conlict (P2002) detector: the same physical
 * serial can legitimately surface in BOTH Hesabfa accounts (production &
 * trading are one physical group) — that must count as a conflict, not
 * abort the company's sync. */
function isUniqueConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** v2.58.0 — takes the transaction client + the serial row id (the
 * pre-create findUnique inside was a redundant query per serial). */
async function appendHistory(
  tx: Prisma.TransactionClient,
  serialId: string | undefined,
  action: ReturnType<typeof decideSerialSync>,
  type: number,
  number: string,
) {
  if (!serialId) return;
  await tx.inventorySerialHistory.create({
    data: {
      serialId,
      action: historyActionFor(action, type),
      toStatus: action.kind === 'create-sold' || action.kind === 'mark-sold' ? 'sold'
        : action.kind === 'create-available' || action.kind === 'restock' ? 'available' : undefined,
      description: historyDescriptionFor(action, type, number),
    },
  }).catch(() => undefined);
}

/** Best-effort hesabfa item code for a serial row (searches the invoice
 * lines for the line whose text contains the serial). */
async function itemCodeForSerial(serialNumber: string, _companyId: string, items: Array<Record<string, unknown>>) {
  for (const line of items) {
    const blob = JSON.stringify(line);
    if (blob.toUpperCase().includes(serialNumber.toUpperCase())) {
      const code = String(line.ItemCode ?? line.Code ?? '');
      if (code) return { hesabfaItemCode: code, productCode: code };
    }
  }
  return {};
}

/** Jalali "1405/06/14" → Date (local-noon anchored via the shared
 * jalali bridge — display-grade only, never day-boundary logic). */
export function jalaliToDate(jalali: string): Date | null {
  const iso = jalaliStringToGregorianIso(jalali);
  if (!iso) return null;
  return new Date(`${iso}T12:00:00`);
}
