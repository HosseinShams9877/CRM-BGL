// ════════════════════════════════════════════════════════════
// hesabfa-client.ts — v2.32.0/v2.33.0 read-only Hesabfa API client
// One-way: Hesabfa → CRM. Structural read-only guarantee:
// every request path must pass the READ_ONLY_PATHS whitelist —
// any save/update/delete path is rejected BEFORE a network call.
// Per-company credentials (HesabfaConnection row). Global 240 req/min
// cap is shared across ALL companies (Hesabfa limits by IP), enforced
// with a 300ms serialized throttle + exponential-backoff retry.
// API shape per official docs (hesabfa.com/help/api):
//   POST {baseUrl}/{path}  body { apiKey, loginToken, ...params }
//   response { Success, ErrorCode, ErrorMessage, Result }
// ════════════════════════════════════════════════════════════
import { db } from '@/lib/db';
import { forScope } from '@/lib/logger';
// v2.58.7 (stage 4 — S1): every outbound Hesabfa request now rides the
// SSRF-guarded transport (DNS pinning, no redirects, private-range
// blocklist, deadline + size cap). This was the LAST unguarded outbound
// door of the app: settings.baseUrl is user-influenced (connection-set)
// and the raw fetch followed redirects straight to internal targets.
import {
  safeOutboundFetch,
  SafeOutboundTimeoutError,
  SafeOutboundNetworkError,
} from '@/lib/safe-outbound';
import { SsrfGuardError } from '@/lib/ssrf-guard';

const logger = forScope('hesabfa');

export const HESABFA_READ_ONLY_PATHS = new Set<string>([
  'item/getItems',            // paginated item list (queryInfo: skip/take/top — default returns only 10!)
  'item/getItem',             // single item by id/code
  'item/GetQuantity2',        // total + per-warehouse quantity for one item
  'setting/getWarehouses',    // warehouse list
  'setting/getBusinessInfo',  // used by test-connection (echoes business name)
  'contact/getContacts',      // contacts sync (read)
  'contact/getContact',
  'invoice/getInvoices',      // read-only invoice list (v2.57.0 sync)
  'invoice/getInvoiceById',
  'invoice/get',
  'setting/getDefaultPriceList', // v2.57.0 — default price list id
  'setting/getFiscalYear',       // v2.57.0 — active fiscal year
]);

const REQUEST_TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 300; // ≤ 200 req/min from this process (global cap 240)
const RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
// v2.58.7 — Hesabfa page payloads (contacts/invoices) are bounded by the
// request paging; 4 MiB is a generous ceiling that still stops a rogue
// endpoint from streaming forever.
const HESABFA_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HesabfaError extends Error {
  status: number;   // HTTP status (0 = network)
  code: number;     // Hesabfa ErrorCode
  retryable: boolean;
  constructor(message: string, opts: { status?: number; code?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'HesabfaError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? 0;
    this.retryable = opts.retryable ?? false;
  }
}

// ── serialized global throttle (shared across companies) ──────────────────
let lastCallAt = 0;
let chain: Promise<void> = Promise.resolve();
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
  });
  chain = run.then(() => undefined, () => undefined);
  return run.then(fn);
}

export interface HesabfaConnSettings {
  apiKey: string;
  loginToken: string;
  baseUrl: string;
}

/** Raw call — enforce whitelist, throttle, timeout, Hesabfa envelope, retry. */
export async function hesabfaCall<T = unknown>(
  path: string,
  settings: HesabfaConnSettings,
  params: Record<string, unknown> = {},
): Promise<T> {
  if (!HESABFA_READ_ONLY_PATHS.has(path)) {
    throw new HesabfaError(`مسیر حسابفا مجاز نیست (فقط‌خواندنی): ${path}`, { status: 403 });
  }
  if (!settings.apiKey || !settings.loginToken) {
    throw new HesabfaError('اطلاعات اتصال حسابفا کامل نیست (apiKey / loginToken)', { status: 400 });
  }
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/${path}`;
  let attempt = 0;
  while (true) {
    try {
      // v2.58.7 (stage 4 — S1): guarded transport replaces the raw fetch.
      // The guard resolves DNS once, validates EVERY answer against the
      // private/link-local blocklists (IPv4 + IPv6 + mapped v4), then PINS
      // the socket to the verified address (rebinding impossible) and
      // NEVER follows redirects (3xx is a plain status). Credentials ride
      // the body exactly as before — to a verified target only.
      return await throttled(() =>
        safeOutboundFetch(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey: settings.apiKey, loginToken: settings.loginToken, ...params }),
          },
          { timeoutMs: REQUEST_TIMEOUT_MS, maxResponseBytes: HESABFA_MAX_RESPONSE_BYTES },
        ),
      ).then(async (res) => {
        const text = await res.text();
        let json: { Success?: boolean; ErrorCode?: number; ErrorMessage?: string; Result?: T } | null = null;
        try { json = JSON.parse(text); } catch { /* non-JSON below */ }
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          if (retryable && attempt < RETRY_DELAYS_MS.length) throw new HesabfaError(`HTTP ${res.status}`, { status: res.status, retryable: true });
          throw new HesabfaError(
            json?.ErrorMessage || `خطای حسابفا (HTTP ${res.status})`,
            { status: res.status, code: json?.ErrorCode ?? 0 },
          );
        }
        if (!json) throw new HesabfaError('پاسخ حسابفا قابل خواندن نبود', { retryable: true });
        if (json.Success === false) {
          const msg = json.ErrorMessage || `خطای حسابفا (کد ${json.ErrorCode ?? '?'})`;
          // auth/config errors are never retried; transient ones are
          const noRetry = [1, 2, 3, 11, 12, 13, 20, 21].includes(json.ErrorCode ?? 0);
          throw new HesabfaError(msg, { status: 200, code: json.ErrorCode ?? 0, retryable: !noRetry });
        }
        return (json.Result ?? null) as T;
      });
    } catch (e) {
      // v2.58.7 (stage 4): guard-error mapping. Timeout/network keep the
      // OLD retryable contract (the previous Promise.race threw the exact
      // same message as retryable). An SSRF-guard refusal is NOT retryable
      // — the target simply is not allowed; three delayed retries cannot
      // fix that, and the refusal must surface immediately with the
      // guard's client-safe Persian message.
      if (e instanceof SsrfGuardError) {
        throw new HesabfaError(e.message, { status: e.status, retryable: false });
      }
      if (e instanceof SafeOutboundTimeoutError) {
        throw new HesabfaError('پاسخی از حسابفا دریافت نشد (Timeout)', { status: 502, retryable: true });
      }
      if (e instanceof SafeOutboundNetworkError) {
        throw new HesabfaError('ارتباط با حسابفا برقرار نشد (خطای شبکه)', { status: 0, retryable: true });
      }
      const retryable = e instanceof HesabfaError ? e.retryable : true; // network errors
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt];
        attempt += 1;
        logger.info(`retry ${attempt} after ${delay}ms on ${path}`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e instanceof HesabfaError ? e : new HesabfaError('ارتباط با حسابفا برقرار نشد (خطای شبکه)', { retryable: false });
    }
  }
}

/** Load + validate a company's active connection (server-side only). */
export async function loadCompanyConnection(companyId: string): Promise<(HesabfaConnSettings & { businessName: string | null }) | null> {
  const conn = await db.hesabfaConnection.findUnique({ where: { companyId } });
  if (!conn || !conn.active) return null;
  return { apiKey: conn.apiKey, loginToken: conn.loginToken, baseUrl: conn.baseUrl, businessName: conn.businessName };
}

/** Never ship raw secrets to the client — mask to last 4 chars. */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  const tail = secret.slice(-4);
  return `••••••••${tail}`;
}

// ── typed Hesabfa payloads (docs-verified shapes) ─────────────────────────
export interface HesabfaItem {
  Id?: number; Code?: string; Name?: string; Barcode?: string;
  ItemCode?: string; ItemType?: number; Unit?: string;
  BuyPrice?: number; SellPrice?: number; Active?: boolean;
  Category?: { Name?: string } | null; NodeId?: number;
  [k: string]: unknown;
}
export interface HesabfaWarehouse {
  Id?: number; Code?: number; Name?: string; [k: string]: unknown;
}
export interface HesabfaQuantityWarehouseRow {
  WarehouseCode?: number; WarehouseName?: string; Quantity?: number;
  [k: string]: unknown;
}
export interface HesabfaQuantity2Result {
  /** flat-array shape (module-inactive accounts): the item code this row belongs to */
  Code?: string;
  Quantity?: number;
  Warehouse?: HesabfaQuantityWarehouseRow[];
  [k: string]: unknown;
}
export interface HesabfaBusinessInfo {
  Name?: string; [k: string]: unknown;
}
export interface HesabfaPagedResult<T> {
  Items?: T[]; List?: T[]; Total?: number;
  [k: string]: unknown;
}

/** Full pagination over item/getItems (queryInfo: {skip, take, top}). */
export async function fetchAllItems(settings: HesabfaConnSettings, onPage?: (page: number) => void): Promise<HesabfaItem[]> {
  const PAGE = 100;
  const all: HesabfaItem[] = [];
  let skip = 0;
  for (let page = 1; page <= 100; page++) { // hard cap — never loop unbounded
    const res = await hesabfaCall<HesabfaPagedResult<HesabfaItem> | HesabfaItem[]>(
      'item/getItems', settings,
      { queryInfo: { Skip: skip, Take: PAGE, Filters: null, OrderBy: '', OrderDesc: false } },
    );
    const items = Array.isArray(res) ? res : (res.Items ?? res.List ?? []);
    onPage?.(page);
    all.push(...items);
    if (items.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

// ── v2.57.0 (round 83) — contacts & invoices paged fetchers ────────────────
export interface HesabfaContactRow {
  Id?: number; Code?: string; Name?: string; FirstName?: string; LastName?: string;
  ContactType?: number; Phone?: string; Mobile?: string; Email?: string;
  City?: string; Province?: string; Address?: string; NationalCode?: string;
  Balance?: number; [k: string]: unknown;
}

/** Full pagination over contact/getContacts (same queryInfo envelope). */
export async function fetchAllContacts(settings: HesabfaConnSettings, onPage?: (page: number) => void): Promise<HesabfaContactRow[]> {
  const PAGE = 100;
  const all: HesabfaContactRow[] = [];
  let skip = 0;
  for (let page = 1; page <= 200; page++) { // hard cap
    const res = await hesabfaCall<HesabfaPagedResult<HesabfaContactRow> | HesabfaContactRow[]>(
      'contact/getContacts', settings,
      { queryInfo: { Skip: skip, Take: PAGE, Filters: null, OrderBy: '', OrderDesc: false } },
    );
    const rows = Array.isArray(res) ? res : (res.Items ?? res.List ?? []);
    onPage?.(page);
    all.push(...rows);
    if (rows.length < PAGE) break;
    skip += PAGE;
  }
  return all;
}

export interface HesabfaInvoiceRow {
  Id?: number; Number?: string; InvoiceType?: number; Date?: string;
  ContactId?: number; ContactCode?: string; ContactName?: string;
  TotalAmount?: number; PaidAmount?: number; Description?: string;
  InvoiceItems?: Array<Record<string, unknown>>; Items?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

/**
 * Full pagination over invoice/getInvoices for ONE invoice type at a
 * time (Hesabfa filters server-side by `type`). Type 0 = فروش,
 * 1 = خرید (legacy mapping). The list endpoint returns invoice headers
 * WITHOUT line items — itemsJson stays '[]' unless the caller asks for
 * `withItems`, which pulls each invoice once via invoice/getInvoiceById.
 */
export async function fetchInvoices(
  settings: HesabfaConnSettings,
  invoiceType: number,
  opts: { withItems?: boolean; onPage?: (page: number) => void } = {},
): Promise<HesabfaInvoiceRow[]> {
  const PAGE = 100;
  const all: HesabfaInvoiceRow[] = [];
  let skip = 0;
  for (let page = 1; page <= 200; page++) { // hard cap
    const res = await hesabfaCall<HesabfaPagedResult<HesabfaInvoiceRow> | HesabfaInvoiceRow[]>(
      'invoice/getInvoices', settings,
      { type: invoiceType, queryInfo: { Skip: skip, Take: PAGE, Filters: null, OrderBy: '', OrderDesc: false } },
    );
    const rows = Array.isArray(res) ? res : (res.Items ?? res.List ?? []);
    opts.onPage?.(page);
    all.push(...rows);
    if (rows.length < PAGE) break;
    skip += PAGE;
  }
  if (opts.withItems) {
    for (const inv of all) {
      if (!inv.Id) continue;
      try {
        const full = await hesabfaCall<HesabfaInvoiceRow>('invoice/getInvoiceById', settings, { id: inv.Id });
        if (full) {
          inv.InvoiceItems = full.InvoiceItems ?? full.Items ?? inv.InvoiceItems;
          inv.Description = full.Description ?? inv.Description;
        }
      } catch { /* one bad invoice never aborts the sync */ }
    }
  }
  return all;
}
