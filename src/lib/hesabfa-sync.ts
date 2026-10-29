// ════════════════════════════════════════════════════════════
// hesabfa-sync.ts — v2.33.0 per-company inventory sync engine
// runInventorySync(companyId):
//   1. item/getItems (full pagination)      → item catalog
//   2. setting/getWarehouses                → warehouse notebook (per-company)
//   3. item/GetQuantity2 per item           → total + per-warehouse qty
//   4. ONE transaction rewrites ONLY this company's snapshots + warehouses
// Locking: SYNC_ALREADY_RUNNING — in-process Set + HesabfaJob 'running' row
// in DB (orphan > 10 min is ignored so a crash never deadlocks a company).
// Staleness rule: data older than max(interval, 60 min) is flagged stale.
// ════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import { forScope } from '@/lib/logger';
import { getCanonicalRole } from '@/lib/roles';
import {
  HesabfaError, HesabfaQuantity2Result, HesabfaWarehouse,
  fetchAllItems, hesabfaCall, loadCompanyConnection,
} from '@/lib/hesabfa-client';

const logger = forScope('hesabfa-sync');

export const SYNC_ALREADY_RUNNING = 'SYNC_ALREADY_RUNNING';
const ORPHAN_LOCK_MS = 10 * 60 * 1000;

const runningCompanies = new Set<string>();

export interface SyncStats {
  items: number; warehouses: number; rows: number;
  failedQuantities: number; pages: number;
}
export interface SyncResult {
  ok: boolean;
  message: string;
  stats?: SyncStats;
}

/** Is the snapshot for a company stale relative to its sync interval? */
export function isStale(lastSyncAt: Date | null, intervalMinutes: number): boolean {
  if (!lastSyncAt) return true;
  const age = Date.now() - lastSyncAt.getTime();
  return age > Math.max(intervalMinutes, 60) * 60 * 1000;
}

async function createJob(companyId: string): Promise<string | null> {
  // in-process lock
  if (runningCompanies.has(companyId)) return null;
  // DB lock (cross-request) — an old 'running' row (>10 min) is an orphan crash
  const stale = await db.hesabfaJob.findFirst({
    where: { jobType: 'inventory-sync', companyId, status: 'running', updatedAt: { lt: new Date(Date.now() - ORPHAN_LOCK_MS) } },
    select: { id: true },
  });
  if (stale) {
    await db.hesabfaJob.update({ where: { id: stale.id }, data: { status: 'failed', result: JSON.stringify({ error: 'orphan lock cleared' }) } });
  }
  const active = await db.hesabfaJob.findFirst({
    where: { jobType: 'inventory-sync', companyId, status: 'running' },
    select: { id: true },
  });
  if (active) return null;
  const job = await db.hesabfaJob.create({
    data: { jobType: 'inventory-sync', companyId, status: 'running', payload: JSON.stringify({ companyId, startedAt: new Date().toISOString() }) },
  });
  runningCompanies.add(companyId);
  return job.id;
}

async function finishJob(jobId: string, status: string, result: unknown) {
  await db.hesabfaJob.update({ where: { id: jobId }, data: { status, result: JSON.stringify(result) } }).catch(() => undefined);
}

export async function runInventorySync(companyId: string): Promise<SyncResult> {
  const conn = await loadCompanyConnection(companyId);
  if (!conn) return { ok: false, message: 'اتصال حسابفا برای این شرکت فعال نیست' };

  const jobId = await createJob(companyId);
  if (!jobId) return { ok: false, message: SYNC_ALREADY_RUNNING };

  try {
    const settings = { apiKey: conn.apiKey, loginToken: conn.loginToken, baseUrl: conn.baseUrl };

    // 1. warehouses — v2.57.0: an account without the warehouse module
    // («سیستم انبار فعال نیست») degrades to quantity-only rows instead of
    // failing the whole sync; the per-warehouse split simply stays empty
    // until the business activates the module.
    let whList: HesabfaWarehouse[] = [];
    let warehouseNote = '';
    try {
      const warehouses = (await hesabfaCall<HesabfaWarehouse[] | { Items?: HesabfaWarehouse[] }>('setting/getWarehouses', settings)) ?? [];
      whList = Array.isArray(warehouses) ? warehouses : (warehouses.Items ?? []);
    } catch (e) {
      warehouseNote = e instanceof HesabfaError ? e.message : 'انبارها دریافت نشد';
    }

    // 2. items (full pagination)
    let pages = 0;
    const items = await fetchAllItems(settings, () => { pages += 1; });

    // 3. quantities — v2.57.0: ONE GetQuantity2 call returns the flat
    // array {Code, Quantity, …} for EVERY item (the legacy per-item loop
    // misread this shape and made N calls). Accounts WITH the warehouse
    // module answer per item with {Quantity, Warehouse:[…]} instead —
    // both shapes are handled below.
    const failedQuantities: string[] = [];
    type Row = { itemCode: string; itemName: string; unit: string; warehouseCode: string; warehouseName: string; quantity: number };
    const rows: Row[] = [];
    const whName = new Map<string, string>(whList.map((w) => [String(w.Code ?? w.Id ?? ''), String(w.Name ?? '')]));

    // 3a. single bulk call (module-inactive accounts)
    const flatByCode = new Map<string, number>();
    try {
      const bulk = await hesabfaCall<HesabfaQuantity2Result[] | HesabfaQuantity2Result>('item/GetQuantity2', settings);
      if (Array.isArray(bulk)) {
        for (const r of bulk) {
          const c = String(r.Code ?? '');
          if (c) flatByCode.set(c, Number(r.Quantity ?? 0));
        }
      }
    } catch { /* fall back to per-item calls below */ }

    for (const it of items) {
      const code = String(it.Code ?? it.Id ?? '');
      if (!code) continue;
      const itemStock = flatByCode.get(code);
      if (itemStock !== undefined) {
        rows.push({ itemCode: code, itemName: String(it.Name ?? code), unit: String(it.Unit ?? ''), warehouseCode: '0', warehouseName: 'موجودی کل', quantity: itemStock });
        continue;
      }
      // 3b. per-item call (warehouse-module accounts: per-warehouse split)
      try {
        const q = await hesabfaCall<HesabfaQuantity2Result>('item/GetQuantity2', settings, { code: it.Code ?? it.Id });
        if (!q) continue;
        const total = Number(q.Quantity ?? 0);
        rows.push({ itemCode: code, itemName: String(it.Name ?? code), unit: String(it.Unit ?? ''), warehouseCode: '0', warehouseName: 'موجودی کل', quantity: total });
        for (const w of q.Warehouse ?? []) {
          const wc = String(w.WarehouseCode ?? '');
          if (!wc) continue;
          rows.push({
            itemCode: code, itemName: String(it.Name ?? code), unit: String(it.Unit ?? ''),
            warehouseCode: wc, warehouseName: String(w.WarehouseName ?? whName.get(wc) ?? wc),
            quantity: Number(w.Quantity ?? 0),
          });
        }
      } catch (e) {
        // last-resort fallback — the item list itself carries a Stock
        // field; a GetQuantity2 failure never drops the row.
        const stock = Number((it as { Stock?: number }).Stock ?? 0) || 0;
        if (stock > 0) {
          rows.push({ itemCode: code, itemName: String(it.Name ?? code), unit: String(it.Unit ?? ''), warehouseCode: '0', warehouseName: 'موجودی کل', quantity: stock });
        } else {
          failedQuantities.push(code + ':' + (e instanceof HesabfaError ? e.message : 'error'));
        }
      }
    }

    // 4. transactional rewrite of THIS company only
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.hesabfaInventorySnapshot.deleteMany({ where: { companyId } });
      const seen = new Set<string>();
      const deduped = rows.filter((r) => {
        const k = `${r.itemCode}|${r.warehouseCode}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      for (let i = 0; i < deduped.length; i += 200) {
        await tx.hesabfaInventorySnapshot.createMany({
          data: deduped.slice(i, i + 200).map((r) => ({ ...r, companyId, fetchedAt: now })),
        });
      }
      for (const w of whList) {
        const code = String(w.Code ?? w.Id ?? '');
        if (!code) continue;
        await tx.hesabfaWarehouseLink.upsert({
          where: { companyId_warehouseCode: { companyId, warehouseCode: code } },
          create: { companyId, warehouseCode: code, warehouseName: String(w.Name ?? code) },
          update: { warehouseName: String(w.Name ?? code), active: true },
        });
      }
      await tx.hesabfaConnection.update({
        where: { companyId },
        data: { lastSyncAt: now, lastSyncStats: JSON.stringify({ items: items.length, warehouses: whList.length, rows: deduped.length, failedQuantities: failedQuantities.length }) },
      });
    });

    const stats: SyncStats = { items: items.length, warehouses: whList.length, rows: rows.length, failedQuantities: failedQuantities.length, pages };
    await finishJob(jobId, failedQuantities.length === 0 ? 'success' : 'partial_success', stats);
    logger.info(`sync ok company=${companyId} items=${stats.items} rows=${stats.rows}`);
    const suffix = warehouseNote ? ` (تفکیک انباری فعال نیست: ${warehouseNote})` : '';
    return {
      ok: true,
      message: failedQuantities.length
        ? `همگام‌سازی انجام شد (${stats.items} کالا، ${stats.rows} ردیف موجودی؛ ${failedQuantities.length} کالا بدون موجودی)${suffix}`
        : `همگام‌سازی کامل انجام شد (${stats.items} کالا، ${stats.warehouses} انبار، ${stats.rows} ردیف موجودی)${suffix}`,
      stats,
    };
  } catch (e) {
    const msg = e instanceof HesabfaError ? e.message : 'خطای همگام‌سازی حسابفا';
    await finishJob(jobId, 'failed', { error: msg });
    logger.error(`sync failed company=${companyId}: ${msg}`);
    return { ok: false, message: msg };
  } finally {
    runningCompanies.delete(companyId);
  }
}

/** Pure scope resolver — admin sees all/selected, user sees intersection of
 *  own companies, unauthorized → empty (IDOR-safe), invalid slugs ignored. */
export function resolveCompanyScope(
  role: string,
  userCompanyIds: string[],
  requestedSlug: string | null,
  allCompanies: { id: string; slug: string }[],
): string[] {
  const bySlug = new Map(allCompanies.map((c) => [c.slug, c.id]));
  // v2.58.4 (issue 4) — canonical role check (legacy 'administrator' row
  // behaves like 'admin').
  if (getCanonicalRole(role) === 'admin') {
    if (!requestedSlug) return allCompanies.map((c) => c.id);
    const id = bySlug.get(requestedSlug);
    return id ? [id] : [];
  }
  // NB: userCompanyIds carries company SLUGS (User.companyIds JSON), not row ids.
  const allowedSlugs = new Set(userCompanyIds);
  if (!requestedSlug) return allCompanies.filter((c) => allowedSlugs.has(c.slug)).map((c) => c.id);
  const id = bySlug.get(requestedSlug);
  const slugAllowed = allowedSlugs.has(requestedSlug);
  return id && slugAllowed ? [id] : [];
}
