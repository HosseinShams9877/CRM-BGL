import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { hesabfaCall, loadCompanyConnection, maskSecret, HesabfaBusinessInfo } from '@/lib/hesabfa-client';
import { runInventorySync, resolveCompanyScope, isStale } from '@/lib/hesabfa-sync';
import { runItemsSync, runContactsSync, runInvoicesSync, SYNC_ALREADY_RUNNING as SECTION_SYNC_RUNNING } from '@/lib/hesabfa-sync2';
import { maskedEnvCredentials, ensureEnvConnections, COMPANY_SLUG_UNIT } from '@/lib/hesabfa-env';

// v2.15.0 (sixth-round audit): the Hesabfa integration is admin-only —
// link/unlink actions change where a center's financial documents are
// synced, and the jobs/webhook/review listings expose tenant-wide sync
// data. Previously ANY authenticated user could relink a center or product
// to a different Hesabfa account.
function adminOnly(user: AuthUser): NextResponse | null {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم' }, { status: 403 });
  }
  return null;
}

const META_KEYS = {
  API_TOKEN: 'hesabfa.api_token',
  BASE_URL: 'hesabfa.base_url',
  WEBHOOK_SECRET: 'hesabfa.webhook_secret',
  SYNC_INTERVAL: 'hesabfa.sync_interval_minutes',
  MATCH_FIELD: 'hesabfa.match_field',
  UNMATCHED_POLICY: 'hesabfa.unmatched_policy',
} as const;

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
    const body = await req.json();
    const { action } = body;
    switch (action) {
      // ── v2.32.0/v2.33.0 — per-company read-only integration ──
      case 'connections':      return await handleConnections(user);
      case 'connection-set':   return await handleConnectionSet(body, user);
      case 'connection-delete': return await handleConnectionDelete(body, user);
      case 'test-connection':  return await handleTestConnection(body, user);
      case 'sync-inventory':   return await handleSyncInventory(body, user);
      case 'inventory':        return await handleInventory(body, user);
      // ── v2.57.0 (round 83) — env credentials + full read/sync sections ──
      case 'env-credentials':  return await handleEnvCredentials();
      case 'env-import':       return await handleEnvImport(body, user);
      case 'sync-items':       return await handleSectionSync(body, user, 'items');
      case 'sync-contacts':    return await handleSectionSync(body, user, 'contacts');
      case 'sync-invoices':    return await handleSectionSync(body, user, 'invoices');
      case 'items':            return await handleItems(body, user);
      case 'contacts':         return await handleContacts(body, user);
      case 'invoices':         return await handleInvoices(body, user);
      case 'serials':          return await handleSerials(body, user);
      case 'link-contact':     return await handleLinkContactCenter(body, user);
      // ── legacy (v2.28-era) center/product link actions — kept intact ──
      case 'settings':       return await handleSettings(body, user);
      case 'sync-centers':   return await handleSyncCenters(user);
      case 'link-center':    return await handleLinkCenter(body, user);
      case 'unlink-center':  return await handleUnlinkCenter(body, user);
      case 'sync-products':  return await handleSyncProducts(user);
      case 'link-product':   return await handleLinkProduct(body, user);
      case 'jobs':           return await handleJobs(body, user);
      case 'webhook-events': return await handleWebhookEvents(body, user);
      case 'review-items':   return await handleReviewItems(body, user);
      case 'process-review': return await handleProcessReview(body, user);
      default: return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

// ════════════════════════════════════════════════════════════
// v2.33.0 — Company → Hesabfa Connection (independent warehouses)
// ════════════════════════════════════════════════════════════

/**
 * v2.35.0 — per-company management gate (was: plain adminOnly).
 * Group companies keep the historical admin-only rule; ISOLATED companies
 * (یاس طب) are managed by their own assigned users — group admins are
 * walled out of the isolated tenant's credentials and sync engine.
 */
async function resolveManagedCompany(body: Record<string, unknown>, user: AuthUser): Promise<string | null> {
  const { companySlug } = body as { companySlug?: string };
  if (!companySlug) return null;
  const company = await db.company.findUnique({
    where: { slug: companySlug },
    select: { id: true, slug: true, isIsolated: true },
  });
  if (!company) return null;
  if (company.isIsolated) {
    if (getCanonicalRole(user.role) === 'admin') return null;
    return user.companyIds.includes(company.slug) ? company.id : null;
  }
  return getCanonicalRole(user.role) === 'admin' ? company.id : null;
}

const MANAGE_DENIED = 'شما اجازهٔ مدیریت اتصال حسابفا این شرکت را ندارید.';

/** Status of every company's connection (+ warehouses). Secrets NEVER leave the server. */
// v2.58.0 (audit 85-a #6) — clamped pagination pair (NaN used to throw a
// Prisma 500; huge pageSize dumped whole tables in one response).
function clampPage(rawPage: unknown, rawPageSize: unknown, defPs = 50): { page: number; pageSize: number } {
  const page = Math.max(1, Math.min(Number.isFinite(Number(rawPage)) ? Number(rawPage) : 1, 500));
  const pageSize = Math.max(1, Math.min(Number.isFinite(Number(rawPageSize)) ? Number(rawPageSize) : defPs, 100));
  return { page, pageSize };
}

async function handleConnections(user: AuthUser) {
  // v2.57.0 (round 83) — env credentials for the two unit companies
  // (production→bgl, trading→bazargani) are mirrored into connection rows
  // on every list call, so a rotated .env lands without any UI step.
  await ensureEnvConnections().catch(() => 0);
  // v2.35.0 — admins list GROUP companies only; isolated companies never
  // surface in any group view (their own users see them via userSlugs).
  const companies = await db.company.findMany({
    where: getCanonicalRole(user.role) === 'admin' ? { isIsolated: false } : {},
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true, name: true },
  });
  const userSlugs = getCanonicalRole(user.role) === 'admin' ? null : new Set(user.companyIds);
  const out: Record<string, unknown>[] = [];
  // v2.58.0 (audit 85-c N+1): the sync interval Meta key was re-queried
  // PER COMPANY inside the loop, and connections/warehouses were fetched
  // one findUnique/findMany per company. Now: interval read once,
  // connections + warehouses batched in two queries, joined via maps.
  const visible = companies.filter((c) => !userSlugs || userSlugs.has(c.slug));
  const intervalMinutes = Number((await db.meta.findUnique({ where: { key: META_KEYS.SYNC_INTERVAL } }))?.value ?? 0) || 60;
  const visibleIds = visible.map((c) => c.id);
  const [conns, warehousesAll] = visibleIds.length
    ? await Promise.all([
        db.hesabfaConnection.findMany({ where: { companyId: { in: visibleIds } } }),
        db.hesabfaWarehouseLink.findMany({
          where: { companyId: { in: visibleIds } },
          orderBy: { warehouseCode: 'asc' },
        }),
      ])
    : [[], []];
  const connByCompany = new Map(conns.map((c) => [c.companyId, c]));
  const warehousesByCompany = new Map<string, typeof warehousesAll>();
  for (const w of warehousesAll) {
    const arr = warehousesByCompany.get(w.companyId) ?? [];
    arr.push(w);
    warehousesByCompany.set(w.companyId, arr);
  }
  for (const c of visible) {
    const conn = connByCompany.get(c.id);
    const warehouses = conn ? (warehousesByCompany.get(c.id) ?? []) : [];
    out.push({
      companySlug: c.slug, companyName: c.name,
      unit: COMPANY_SLUG_UNIT[c.slug] ?? null, // production | trading | null
      connected: !!conn && conn.active,
      apiKeyMasked: conn ? maskSecret(conn.apiKey) : '',
      loginTokenMasked: conn ? maskSecret(conn.loginToken) : '',
      baseUrl: conn?.baseUrl ?? 'https://api.hesabfa.com/v1',
      businessName: conn?.businessName ?? null,
      lastTestAt: conn?.lastTestAt ?? null, lastTestOk: conn?.lastTestOk ?? null, lastTestMsg: conn?.lastTestMsg ?? null,
      lastSyncAt: conn?.lastSyncAt ?? null, lastSyncStats: conn ? JSON.parse(conn.lastSyncStats || '{}') : null,
      stale: conn ? isStale(conn.lastSyncAt, intervalMinutes) : false,
      warehouses: warehouses.map((w) => ({ code: w.warehouseCode, name: w.warehouseName, active: w.active })),
    });
  }
  return NextResponse.json({ connections: out });
}

/** Create/update a company connection. Empty secret fields = keep existing (masked round-trip). */
async function handleConnectionSet(body: Record<string, unknown>, user: AuthUser) {
  // v2.35.0 — group companies: admin-only (as before); isolated companies:
  // their own assigned users.
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  const { apiKey, loginToken, baseUrl } = body as { apiKey?: string; loginToken?: string; baseUrl?: string };
  if (apiKey === undefined && loginToken === undefined) {
    return NextResponse.json({ error: 'apiKey یا loginToken الزامی است' }, { status: 400 });
  }
  // v2.58.7 (stage 4 — S2): the stored baseUrl is where the server later
  // POSTs apiKey/loginToken on every sync/test. It previously accepted ANY
  // string (no URL parse, no protocol check) — a crafted value sent the
  // credentials to an attacker host (or an internal address). The same
  // http(s) URL hygiene as ai-bridge settings now applies at STORE time;
  // the SSRF-guarded transport re-verifies at CALL time (defense in depth).
  if (baseUrl !== undefined && String(baseUrl).trim()) {
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(String(baseUrl).trim());
    } catch {
      return NextResponse.json(
        { error: 'آدرس سرویس حسابفا نامعتبر است. یک URL کامل و صحیح وارد کنید.' },
        { status: 400 },
      );
    }
    if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
      return NextResponse.json(
        { error: 'آدرس سرویس حسابفا باید با http یا https شروع شود.' },
        { status: 400 },
      );
    }
    if (String(baseUrl).trim().length > 500) {
      return NextResponse.json({ error: 'آدرس سرویس حسابفا بیش از حد بلند است.' }, { status: 400 });
    }
  }
  const existing = await db.hesabfaConnection.findUnique({ where: { companyId } });
  const nextKey = apiKey && apiKey.trim() ? apiKey.trim() : existing?.apiKey;
  const nextToken = loginToken && loginToken.trim() ? loginToken.trim() : existing?.loginToken;
  if (!nextKey || !nextToken) return NextResponse.json({ error: 'apiKey و loginToken هر دو لازم است' }, { status: 400 });
  const conn = await db.hesabfaConnection.upsert({
    where: { companyId },
    create: { companyId, apiKey: nextKey, loginToken: nextToken, baseUrl: baseUrl?.trim() || 'https://api.hesabfa.com/v1' },
    update: {
      apiKey: nextKey, loginToken: nextToken,
      ...(baseUrl !== undefined ? { baseUrl: baseUrl.trim() || 'https://api.hesabfa.com/v1' } : {}),
    },
  });
  return NextResponse.json({ message: 'اطلاعات اتصال ذخیره شد', apiKeyMasked: maskSecret(conn.apiKey), loginTokenMasked: maskSecret(conn.loginToken) });
}

/** Disconnect one company: connection + its warehouses + its snapshots. */
async function handleConnectionDelete(body: Record<string, unknown>, user: AuthUser) {
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  await db.$transaction([
    db.hesabfaInventorySnapshot.deleteMany({ where: { companyId } }),
    db.hesabfaWarehouseLink.deleteMany({ where: { companyId } }),
    db.hesabfaConnection.deleteMany({ where: { companyId } }),
  ]);
  return NextResponse.json({ message: 'اتصال و داده‌های حسابفا این شرکت حذف شد' });
}

/** Per-company test-connection: setting/getBusinessInfo echoes the business name. */
async function handleTestConnection(body: Record<string, unknown>, user: AuthUser) {
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  const settings = await loadCompanyConnection(companyId);
  if (!settings) return NextResponse.json({ error: 'ابتدا اطلاعات اتصال را ذخیره کنید' }, { status: 400 });
  try {
    const info = await hesabfaCall<HesabfaBusinessInfo>('setting/getBusinessInfo', settings);
    const name = info?.Name ? String(info.Name) : 'کسب‌وکار حسابفا';
    await db.hesabfaConnection.update({ where: { companyId }, data: { lastTestAt: new Date(), lastTestOk: true, lastTestMsg: `اتصال موفق — ${name}`, businessName: name } });
    return NextResponse.json({ ok: true, message: `اتصال موفق — کسب‌وکار «${name}»`, businessName: name });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'خطای اتصال';
    await db.hesabfaConnection.update({ where: { companyId }, data: { lastTestAt: new Date(), lastTestOk: false, lastTestMsg: msg } }).catch(() => undefined);
    return NextResponse.json({ ok: false, message: msg }, { status: 200 });
  }
}

/** Manual sync. 409 when the same company is already syncing.
 * v2.35.0 — group companies: admin-only; isolated companies: assigned users. */
async function handleSyncInventory(body: Record<string, unknown>, user: AuthUser) {
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  const result = await runInventorySync(companyId);
  if (!result.ok && result.message === 'SYNC_ALREADY_RUNNING') {
    return NextResponse.json({ error: 'همگام‌سازی این شرکت در حال اجراست؛ لحظاتی بعد دوباره تلاش کنید' }, { status: 409 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

/** Inventory view — every authenticated user, scoped to own companies. */
async function handleInventory(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, warehouseCode, q, page: rawPage = 1, pageSize: rawPageSize = 50 } = body as {
    companySlug?: string; warehouseCode?: string; q?: string; page?: number; pageSize?: number;
  };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 50);
  // v2.35.0 — the admin aggregate view covers GROUP companies only; a
  // yasteb user's scope resolves to یاس طب alone (their slugs).
  const companies = await db.company.findMany({
    where: getCanonicalRole(user.role) === 'admin' ? { isIsolated: false } : {},
    select: { id: true, slug: true, name: true, isIsolated: true },
  });
  const scope = resolveCompanyScope(
    user.role, user.companyIds, companySlug ?? null, companies,
  );
  if (scope.length === 0) return NextResponse.json({ rows: [], companies: [], total: 0 });

  const where: Record<string, unknown> = { companyId: scope.length === 1 ? scope[0] : { in: scope } };
  if (warehouseCode) where.warehouseCode = warehouseCode;
  if (q) {
    const norm = String(q).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    const raw = String(q);
    where.OR = [
      { itemName: { contains: norm } }, { itemName: { contains: raw } },
      { itemCode: { contains: norm } }, { itemCode: { contains: raw } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.hesabfaInventorySnapshot.findMany({
      where, orderBy: [{ itemCode: 'asc' }, { warehouseCode: 'asc' }],
      skip: (page - 1) * pageSize, take: pageSize,
    }),
    db.hesabfaInventorySnapshot.count({ where }),
  ]);
  // v2.57.0 (round 83) — Available For Sale = Hesabfa total stock − ACTIVE
  // reservations (spec formula). Reserved serials per item, scoped to the
  // same companies; expired reservations no longer reduce availability.
  const scopeCompanyWhere = scope.length === 1 ? scope[0] : { in: scope };
  const reservedSerials = await db.inventorySerial.findMany({
    where: { status: 'reserved', companyId: scopeCompanyWhere },
    select: { productCode: true, hesabfaItemCode: true, reservationExpiresAt: true },
  });
  const now = Date.now();
  const activeReservedByItem = new Map<string, number>();
  for (const r of reservedSerials) {
    if (r.reservationExpiresAt && r.reservationExpiresAt.getTime() <= now) continue; // expired → free
    const key = r.hesabfaItemCode || r.productCode || '';
    if (!key) continue;
    activeReservedByItem.set(key, (activeReservedByItem.get(key) ?? 0) + 1);
  }
  const rowsWithAfs = rows.map((r) => {
    if (r.warehouseCode !== '0') return { ...r, reservedCount: 0, availableForSale: null as number | null };
    const reserved = activeReservedByItem.get(r.itemCode) ?? 0;
    return {
      ...r,
      reservedCount: reserved,
      availableForSale: Math.max(0, r.quantity - reserved),
    };
  });
  const connWhere = { companyId: scope.length === 1 ? scope[0] : { in: scope } };
  const conns = await db.hesabfaConnection.findMany({ where: connWhere });
  const intervalMinutes = Number((await db.meta.findUnique({ where: { key: META_KEYS.SYNC_INTERVAL } }))?.value ?? 0) || 60;
  const companyOut = companies
    .filter((c) => scope.includes(c.id))
    .map((c) => {
      const conn = conns.find((x) => x.companyId === c.id);
      return {
        slug: c.slug, name: c.name, isIsolated: c.isIsolated, connected: !!conn && conn.active,
        lastSyncAt: conn?.lastSyncAt ?? null,
        stale: conn ? isStale(conn.lastSyncAt, intervalMinutes) : false,
        lastSyncStats: conn ? JSON.parse(conn.lastSyncStats || '{}') : null,
      };
    });
  return NextResponse.json({ rows: rowsWithAfs, companies: companyOut, total, page, pageSize });
}

// ════════════════════════════════════════════════════════════
// v2.57.0 (round 83) — env credentials + items/contacts/invoices
// ════════════════════════════════════════════════════════════

/** Masked env credential status (admin) — raw values never leave the server. */
async function handleEnvCredentials() {
  return NextResponse.json({ env: maskedEnvCredentials() });
}

/** Mirror env credentials into the two unit companies' connection rows. */
async function handleEnvImport(body: Record<string, unknown>, user: AuthUser) {
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  const written = await ensureEnvConnections();
  return NextResponse.json({ message: written ? `اعتبارنامهٔ ${written} شرکت از متغیرهای محیطی وارد شد` : 'متغیرهای محیطی حسابفا تنظیم نشده‌اند', written });
}

/** Section sync dispatcher (items / contacts / invoices). */
async function handleSectionSync(body: Record<string, unknown>, user: AuthUser, section: 'items' | 'contacts' | 'invoices') {
  const companyId = await resolveManagedCompany(body, user);
  if (!companyId) return NextResponse.json({ error: MANAGE_DENIED }, { status: 403 });
  const result = section === 'items' ? await runItemsSync(companyId)
    : section === 'contacts' ? await runContactsSync(companyId)
    : await runInvoicesSync(companyId);
  if (!result.ok && result.message === SECTION_SYNC_RUNNING) {
    return NextResponse.json({ error: 'همگام‌سازی این بخش در حال اجراست؛ لحظاتی بعد دوباره تلاش کنید' }, { status: 409 });
  }
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}

/** Scope resolver for the read views (admin: group companies; user: own). */
async function readScope(user: AuthUser, companySlug?: string) {
  const companies = await db.company.findMany({
    where: getCanonicalRole(user.role) === 'admin' ? { isIsolated: false } : {},
    select: { id: true, slug: true, name: true },
  });
  const scope = resolveCompanyScope(user.role, user.companyIds, companySlug ?? null, companies);
  return { companies, scope };
}

/** Item catalog view (code/name/prices) — every scoped user. */
async function handleItems(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, q, page: rawPage = 1, pageSize: rawPageSize = 50 } = body as { companySlug?: string; q?: string; page?: number; pageSize?: number };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 50);
  const { companies, scope } = await readScope(user, companySlug);
  if (scope.length === 0) return NextResponse.json({ rows: [], companies: [], total: 0 });
  const where: Record<string, unknown> = { companyId: scope.length === 1 ? scope[0] : { in: scope } };
  if (q) {
    const norm = String(q).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    where.OR = [
      { name: { contains: norm } }, { name: { contains: String(q) } },
      { itemCode: { contains: String(q) } }, { barCode: { contains: String(q) } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.hesabfaItem.findMany({ where, orderBy: [{ active: 'desc' }, { itemCode: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.hesabfaItem.count({ where }),
  ]);
  const companyOut = companies.filter((c) => scope.includes(c.id)).map((c) => ({ slug: c.slug, name: c.name }));
  return NextResponse.json({ rows, companies: companyOut, total, page, pageSize });
}

/** Contacts view with center-link status + balance. */
async function handleContacts(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, q, page: rawPage = 1, pageSize: rawPageSize = 50 } = body as { companySlug?: string; q?: string; page?: number; pageSize?: number };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 50);
  const { companies, scope } = await readScope(user, companySlug);
  if (scope.length === 0) return NextResponse.json({ rows: [], companies: [], total: 0 });
  const where: Record<string, unknown> = { companyId: scope.length === 1 ? scope[0] : { in: scope } };
  if (q) {
    const norm = String(q).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    where.OR = [
      { name: { contains: norm } }, { name: { contains: String(q) } },
      { code: { contains: String(q) } }, { mobile: { contains: String(q) } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.hesabfaContact.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    db.hesabfaContact.count({ where }),
  ]);
  // manual mapping enrichment: HesabfaCenterLink rows are keyed by centerId
  // and hold the hesabfa contact CODE — resolved to names here (read-only).
  const links = await db.hesabfaCenterLink.findMany({ select: { centerId: true, hesabfaId: true } });
  const centerIds = [...new Set(links.map((l) => l.centerId))];
  const centers = centerIds.length
    ? await db.center.findMany({ where: { id: { in: centerIds } }, select: { id: true, name: true } })
    : [];
  const centerName = new Map(centers.map((c) => [c.id, c.name]));
  const linkByCode = new Map(links.map((l) => [String(l.hesabfaId), l.centerId]));
  const enriched = rows.map((r) => ({
    ...r,
    linkedCenterId: linkByCode.get(r.code) ?? null,
    linkedCenterName: linkByCode.get(r.code) ? centerName.get(linkByCode.get(r.code)!) ?? null : null,
  }));
  const companyOut = companies.filter((c) => scope.includes(c.id)).map((c) => ({ slug: c.slug, name: c.name }));
  return NextResponse.json({ rows: enriched, companies: companyOut, total, page, pageSize });
}

/** Link a hesabfa contact (by CODE) to a CRM center — manual mapping the
 *  syncs never reset (spec). Uses the existing HesabfaCenterLink store. */
async function handleLinkContactCenter(body: Record<string, unknown>, user: AuthUser) {
  const { centerId, hesabfaCode } = body as { centerId?: string; hesabfaCode?: string };
  if (!centerId || !hesabfaCode) return NextResponse.json({ error: 'شناسه مرکز و کد مخاطب حسابفا الزامی است' }, { status: 400 });
  const denied = adminOnly(user);
  if (denied) return denied;
  const center = await db.center.findUnique({ where: { id: centerId } });
  if (!center) return NextResponse.json({ error: 'مرکز یافت نشد' }, { status: 404 });
  const link = await db.hesabfaCenterLink.upsert({
    where: { centerId },
    update: { hesabfaId: String(hesabfaCode), syncedAt: new Date() },
    create: { centerId, hesabfaId: String(hesabfaCode) },
  });
  return NextResponse.json({ message: 'مخاطب حسابفا به مرکز متصل شد', link });
}

/** Invoices view (read-only) with type filter + search. */
async function handleInvoices(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, invoiceType, q, page: rawPage = 1, pageSize: rawPageSize = 30 } = body as { companySlug?: string; invoiceType?: number; q?: string; page?: number; pageSize?: number };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 30);
  const { companies, scope } = await readScope(user, companySlug);
  if (scope.length === 0) return NextResponse.json({ rows: [], companies: [], total: 0 });
  const where: Record<string, unknown> = { companyId: scope.length === 1 ? scope[0] : { in: scope } };
  if (invoiceType === 0 || invoiceType === 1) where.invoiceType = invoiceType;
  if (q) {
    const norm = String(q).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    where.OR = [
      { number: { contains: String(q) } }, { contactName: { contains: norm } },
      { contactName: { contains: String(q) } }, { contactCode: { contains: String(q) } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.hesabfaInvoice.findMany({ where, orderBy: [{ date: 'desc' }, { hesabfaId: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.hesabfaInvoice.count({ where }),
  ]);
  const companyOut = companies.filter((c) => scope.includes(c.id)).map((c) => ({
    slug: c.slug, name: c.name, unit: COMPANY_SLUG_UNIT[c.slug] ?? null,
  }));
  return NextResponse.json({
    rows: rows.map((r) => ({ ...r, itemsJson: undefined, serials: JSON.parse(r.serialsJson || '[]') })),
    companies: companyOut, total, page, pageSize,
  });
}

/** Serial view — Hesabfa-synced serials of the scoped companies with
 *  history rows (the serial state machine lives in /api/inventory). */
async function handleSerials(body: Record<string, unknown>, user: AuthUser) {
  const { companySlug, status, q, page: rawPage = 1, pageSize: rawPageSize = 50 } = body as { companySlug?: string; status?: string; q?: string; page?: number; pageSize?: number };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 50);
  const { companies, scope } = await readScope(user, companySlug);
  if (scope.length === 0) return NextResponse.json({ rows: [], companies: [], total: 0 });
  const where: Record<string, unknown> = { source: 'hesabfa', companyId: scope.length === 1 ? scope[0] : { in: scope } };
  if (status) where.status = status;
  if (q) {
    const norm = String(q).replace(/[يى]/g, 'ی').replace(/ك/g, 'ک');
    where.OR = [
      { serialNumber: { contains: String(q).toUpperCase() } },
      { hesabfaInvoiceNumber: { contains: String(q) } },
      { notes: { contains: norm } }, { notes: { contains: String(q) } },
    ];
  }
  const [rows, total] = await Promise.all([
    db.inventorySerial.findMany({ where, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    db.inventorySerial.count({ where }),
  ]);
  const companyOut = companies.filter((c) => scope.includes(c.id)).map((c) => ({ slug: c.slug, name: c.name }));
  return NextResponse.json({ rows, companies: companyOut, total, page, pageSize });
}


async function handleSettings(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') return NextResponse.json({ error: 'فقط مدیر سیستم' }, { status: 403 });
  const { mode } = body as { mode?: string };
  if (mode !== 'set') {
    const metas = await db.meta.findMany({ where: { key: { in: Object.values(META_KEYS) } } });
    const s: Record<string, string> = {};
    for (const m of metas) s[m.key] = m.value;
    // v2.33.0 — the global raw apiToken/webhookSecret are superseded by
    // per-company HesabfaConnection rows; only policy values ship to the
    // client. Never return raw secrets here.
    return NextResponse.json({
      settings: {
        syncIntervalMinutes: s[META_KEYS.SYNC_INTERVAL] || '60',
        matchField: s[META_KEYS.MATCH_FIELD] || 'barcode',
        unmatchedPolicy: s[META_KEYS.UNMATCHED_POLICY] || 'review',
      },
    });
  }
  const { syncIntervalMinutes, matchField, unmatchedPolicy } = body as {
    syncIntervalMinutes?: string; matchField?: string; unmatchedPolicy?: string;
  };
  const updates: [string, string | undefined][] = [
    [META_KEYS.SYNC_INTERVAL, syncIntervalMinutes],
    [META_KEYS.MATCH_FIELD, matchField],
    [META_KEYS.UNMATCHED_POLICY, unmatchedPolicy],
  ];
  for (const [key, val] of updates) {
    if (val !== undefined) await db.meta.upsert({ where: { key }, update: { value: val }, create: { key, value: val } });
  }
  return NextResponse.json({ message: 'تنظیمات ذخیره شد' });
}

async function handleSyncCenters(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') return NextResponse.json({ error: 'فقط مدیر سیستم' }, { status: 403 });
  // NOTE: HesabfaCenterLink has no `center` relation in the Prisma schema —
  // enrich manually instead of an `include` that Prisma would reject at runtime.
  const links = await db.hesabfaCenterLink.findMany({ orderBy: { createdAt: 'desc' } });
  const centers = await db.center.findMany({
    where: { id: { in: links.map((l) => l.centerId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(centers.map((c) => [c.id, c.name]));
  const enriched = links.map((l) => ({ ...l, center: { id: l.centerId, name: nameById.get(l.centerId) ?? '' } }));
  return NextResponse.json({ links: enriched });
}

async function handleLinkCenter(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { centerId, hesabfaId } = body as { centerId?: string; hesabfaId?: string };
  if (!centerId || !hesabfaId) return NextResponse.json({ error: 'شناسه مرکز و شناسه حسابفا الزامی است' }, { status: 400 });
  const center = await db.center.findUnique({ where: { id: centerId } });
  if (!center) return NextResponse.json({ error: 'مرکز یافت نشد' }, { status: 404 });
  const link = await db.hesabfaCenterLink.upsert({ where: { centerId }, update: { hesabfaId, syncedAt: new Date() }, create: { centerId, hesabfaId } });
  return NextResponse.json({ message: 'مرکز به حسابفا متصل شد', link });
}

async function handleUnlinkCenter(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { centerId } = body as { centerId?: string };
  if (!centerId) return NextResponse.json({ error: 'شناسه مرکز الزامی است' }, { status: 400 });
  await db.hesabfaCenterLink.deleteMany({ where: { centerId } });
  return NextResponse.json({ message: 'لینک حسابفا حذف شد' });
}

async function handleSyncProducts(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') return NextResponse.json({ error: 'فقط مدیر سیستم' }, { status: 403 });
  const links = await db.hesabfaProductLink.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ links });
}

async function handleLinkProduct(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { productCode, hesabfaId } = body as { productCode?: string; hesabfaId?: string };
  if (!productCode || !hesabfaId) return NextResponse.json({ error: 'کد محصول و شناسه حسابفا الزامی است' }, { status: 400 });
  const product = await db.product.findUnique({ where: { code: productCode } });
  if (!product) return NextResponse.json({ error: 'محصول یافت نشد' }, { status: 404 });
  const link = await db.hesabfaProductLink.upsert({ where: { productCode }, update: { hesabfaId, syncedAt: new Date() }, create: { productCode, hesabfaId } });
  return NextResponse.json({ message: 'محصول به حسابفا متصل شد', link });
}

async function handleJobs(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { page: rawPage = 1, pageSize: rawPageSize = 20, status } = body as { page?: number; pageSize?: number; status?: string };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 20);
  const where: Record<string, unknown> = status ? { status } : {};
  const [items, total] = await Promise.all([db.hesabfaJob.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db.hesabfaJob.count({ where })]);
  return NextResponse.json({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

async function handleWebhookEvents(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { page: rawPage = 1, pageSize: rawPageSize = 20, eventType } = body as { page?: number; pageSize?: number; eventType?: string };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 20);
  const where: Record<string, unknown> = eventType ? { eventType } : {};
  const [items, total] = await Promise.all([db.hesabfaWebhookEvent.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db.hesabfaWebhookEvent.count({ where })]);
  return NextResponse.json({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

async function handleReviewItems(body: Record<string, unknown>, user: AuthUser) {
  const denied = adminOnly(user);
  if (denied) return denied;
  const { page: rawPage = 1, pageSize: rawPageSize = 20, status } = body as { page?: number; pageSize?: number; status?: string };
  const { page, pageSize } = clampPage(rawPage, rawPageSize, 20);
  const where: Record<string, unknown> = status ? { status } : {};
  const [items, total] = await Promise.all([db.hesabfaReviewItem.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), db.hesabfaReviewItem.count({ where })]);
  return NextResponse.json({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

async function handleProcessReview(body: Record<string, unknown>, user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') return NextResponse.json({ error: 'فقط مدیر سیستم' }, { status: 403 });
  const { id, decision, reviewAction } = body as { id?: string; decision?: string; reviewAction?: string };
  // v2.15.0 (audit #6): the decision used to be read from `action`, which is
  // always 'process-review' at this point — approvals silently degraded to
  // rejections. The verdict now arrives in a dedicated `decision` field
  // (`reviewAction` accepted as an alias) and is validated explicitly.
  const verdict = String(decision ?? reviewAction ?? '').trim().toLowerCase();
  if (!id) return NextResponse.json({ error: 'شناسه الزامی است' }, { status: 400 });
  if (verdict !== 'approve' && verdict !== 'reject') {
    return NextResponse.json({ error: 'عملیات بررسی نامعتبر است. مقادیر مجاز: approve, reject' }, { status: 400 });
  }
  const existing = await db.hesabfaReviewItem.findUnique({ where: { id } });
  if (!existing || existing.status !== 'pending') return NextResponse.json({ error: 'آیتم یافت نشد یا قبلاً پردازش شده' }, { status: 400 });
  const updated = await db.hesabfaReviewItem.update({ where: { id }, data: { status: verdict === 'approve' ? 'approved' : 'rejected' } });
  return NextResponse.json({ message: verdict === 'approve' ? 'تأیید شد' : 'رد شد', item: updated });
}
