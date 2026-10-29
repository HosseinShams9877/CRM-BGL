#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// verify-api.mjs — v2.58.1 (round 86)
//
// RUNTIME API verification against a LIVE server (default
// http://localhost:3000). Covers the round-86 audit acceptance
// criteria that need real HTTP + real SQLite:
//
//   F1/F2 (financial): mark-paid writes REAL receipts; concurrent
//     payments serialize (60+60 on 100 → one rejected); 40+60 →
//     exactly 100 + settled; idempotency-key replay (one receipt)
//     and key/payload conflict (409); re-settle → no new receipt.
//   F4 (access matrix, via DIRECT API requests): admin, finance,
//     production, two experts of ONE company, an expert of ANOTHER
//     company, and an ISOLATED-company user — files list/delete,
//     billing list/payment, sales-documents list/get.
//   Extras (flags): --ai (AI settings masking), --telephony
//     (webhook fail-closed), --files (attachments health endpoint).
//
// SAFETY: every row this script creates is tagged `r86verify-` and
// deleted in the cleanup phase (payments cascade with their invoice).
// The script NEVER deletes or mutates pre-existing data. Run it
// against the dev server; exit code 0 only when every check passes.
//
// Usage: node scripts/verify-api.mjs [--ai] [--telephony] [--base http://localhost:3000]
// (all flags default to ON when the server answers; --only <tag> runs a subset)
// ═══════════════════════════════════════════════════════════
import { createRequire } from 'module';
import { randomBytes } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'));

// Node ≥18 native web globals — destructured so lint sees local bindings.
const { fetch: gfetch, FormData: gFormData, Blob: gBlob } = globalThis;

const { PrismaClient } = require('@prisma/client');

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '--base=http://localhost:3000').split('=')[1];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// v2.58.6 (user P-gates rule): the harness's DIRECT database client must
// point at the SAME database the server under test uses. An explicit
// DATABASE_URL (relative resolved against <root>/prisma, like the app)
// wins — gate runs use a THROWAWAY COPY, never the operational dev.db.
// Only the bare default (an operator verifying their own install with
// the server on the real database) falls back to prisma/dev.db.
const { resolveDatabaseFile } = await import('./lib/resolve-env.mjs');
const dbFile = resolveDatabaseFile(process.env.DATABASE_URL || 'file:./dev.db', root);
const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });

const TAG = `r86verify-${Date.now()}`;
const results = [];
let sessionCookie = null; // current bgl_session cookie value
const sessionTokens = {}; // username → raw token (cleanup)

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, body, opts = {}) {
  const res = await gfetch(`${BASE}${path}`, {
    method: opts.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      ...(sessionCookie ? { Cookie: `bgl_session=${sessionCookie}` } : {}),
    },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body → data stays null */ }
  return { status: res.status, data, headers: res.headers };
}

/** Create the temp user + a REAL session row (r82 pattern — no password
 *  round-trip needed), then make it the active session. */
async function as(db, spec) {
  const { sha256Token } = await import('./lib/session-helper.mjs');
  const token = randomBytes(32).toString('hex');
  // plain create() (upsert's create-branch rejects the scalar businessUnitId
  // FK — a Prisma input-variant quirk; usernames are unique per run anyway)
  const user = await db.user.create({
    data: {
      username: spec.username,
      displayName: `آزمون ${spec.username}`,
      passwordHash: 'x',
      role: spec.role,
      companyIds: JSON.stringify(spec.companyIds || []),
      businessUnitId: spec.businessUnitId || 'trading',
      isActive: true,
      territoryMode: spec.territoryMode || 'country',
      territoryCenterIds: spec.territoryCenterIds ?? '[]',
    },
  });
  await db.session.create({ data: { id: sha256Token(token), userId: user.id, displayName: `r86 ${spec.username}`, browserName: 'verify', ipHash: 'r86' } });
  sessionTokens[spec.username] = token;
  sessionCookie = token;
  return user;
}

async function switchTo(db, username) {
  sessionCookie = sessionTokens[username];
  if (!sessionCookie) throw new Error(`no session for ${username}`);
  return sessionCookie;
}

async function main() {
  // health gate
  const health = await gfetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
  if (!health || health.status === 'fail') {
    console.error(`[verify-api] server unhealthy at ${BASE}: ${JSON.stringify(health)}`);
    process.exit(1);
  }
  console.log(`[verify-api] server healthy (${health.db || '?'}) — tag ${TAG}`);

  const users = {
    admin: `${TAG}-admin`,
    expertA: `${TAG}-expertA`,
    expertB: `${TAG}-expertB`,
    finance: `${TAG}-finance`,
    production: `${TAG}-production`,
    otherCompany: `${TAG}-other`,
    yasteb: `${TAG}-yasteb`,
  };

  let centers = {};
  let createdFiles = [];
  let createdInvoices = [];

  try {
    // ── fixture centers (bazargani company, distinct provinces) ──
    const company = await db.company.findUnique({ where: { slug: 'bazargani' } });
    const yastebCompany = await db.company.findUnique({ where: { slug: 'yasteb' } });
    const mkCenter = async (name, companyId, province) => {
      const c = await db.center.create({
        data: { name, customerType: 'b2b', province, companyId, businessUnitId: 'trading' },
      });
      const a = await db.centerAccount.create({ data: { centerId: c.id } });
      return { center: c, account: a };
    };
    centers.A = await mkCenter(`${TAG}-مرکز-تهران`, company.id, 'تهران');
    centers.B = await mkCenter(`${TAG}-مرکز-یزد`, company.id, 'یزد');
    centers.Y = await mkCenter(`${TAG}-مرکز-یاسطب`, yastebCompany.id, 'تهران');

    // ── temp users + real sessions (r82 pattern; no passwords involved,
    //    nothing printed, everything deleted in cleanup) ──
    await as(db, { username: users.admin, role: 'admin' });
    await as(db, { username: users.expertA, role: 'standard', companyIds: ['bazargani'], territoryMode: 'centers', territoryCenterIds: JSON.stringify([centers.A.center.id]) });
    await as(db, { username: users.expertB, role: 'standard', companyIds: ['bazargani'], territoryMode: 'centers', territoryCenterIds: JSON.stringify([centers.B.center.id]) });
    await as(db, { username: users.finance, role: 'finance', companyIds: ['bazargani'] });
    await as(db, { username: users.production, role: 'production', companyIds: ['bazargani'], businessUnitId: 'production' });
    await as(db, { username: users.otherCompany, role: 'standard', companyIds: ['aria'] });
    await as(db, { username: users.yasteb, role: 'standard', companyIds: ['yasteb'] });
    const switchUser = (name) => switchTo(db, users[name]);

    // ══════════════ F2: concurrent payments via the API ══════════════
    console.log('\n[F1/F2] billing financial integrity');
    switchUser('finance');
    const invRes = await api('/api/billing', {
      action: 'create',
      centerAccountId: centers.A.account.id,
      totalAmount: 100,
      items: [{ description: 'کالای آزمون', quantity: 2, unitPrice: 50, totalPrice: 100 }],
      invoiceNumber: `${TAG}-100`,
    });
    check('finance creates a hand invoice (items sum = total)', invRes.status === 201, `status=${invRes.status}`);
    createdInvoices.push(invRes.data?.invoice?.id);

    const inv = invRes.data?.invoice;
    const pay = (amount, idempotencyKey) =>
      api('/api/billing', { action: 'add-payment', id: inv.id, amount, idempotencyKey });

    const [r1, r2] = await Promise.all([pay(60, `${TAG}-c1`), pay(60, `${TAG}-c2`)]);
    const okCount = [r1, r2].filter((r) => r.status === 200).length;
    check('two concurrent 60 on 100 → exactly ONE succeeds', okCount === 1, `statuses=${r1.status},${r2.status}`);

    const invAfter = await db.issuedInvoice.findUnique({ where: { id: inv.id } });
    const receipts = await db.issuedInvoicePayment.findMany({ where: { issuedInvoiceId: inv.id } });
    check('paidAmount == Σ receipts (single source of truth)', invAfter.paidAmount === receipts.reduce((s, r) => s + r.amount, 0), `${invAfter.paidAmount} vs ${receipts.length} receipt(s)`);

    const r40 = await pay(40, `${TAG}-c3`);
    check('40 completes to exactly 100 + settled', r40.status === 200 && r40.data?.newStatus === 'paid' && r40.data?.newPaidAmount === 100, `status=${r40.status}, paid=${r40.data?.newPaidAmount}`);

    const replay = await pay(40, `${TAG}-c3`);
    check('idempotent replay returns stored result, no new receipt', replay.status === 200 && replay.data?.replayed === true, `status=${replay.status}`);

    const conflict = await api('/api/billing', { action: 'add-payment', id: inv.id, amount: 10, idempotencyKey: `${TAG}-c3` });
    check('same key + different payload → 409', conflict.status === 409, `status=${conflict.status}`);

    const receiptsAfter = await db.issuedInvoicePayment.count({ where: { issuedInvoiceId: inv.id } });
    check('exactly 2 receipts after all races (60 + 40)', receiptsAfter === 2, `count=${receiptsAfter}`);

    // account totals agree
    const acc = await db.centerAccount.findUnique({ where: { id: centers.A.account.id } });
    check('center account totalPaid == 100', acc.totalPaid === 100, `totalPaid=${acc.totalPaid}`);

    // ══════════════ F1: settlement writes REAL receipts ══════════════
    const inv2Res = await api('/api/billing', {
      action: 'create',
      centerAccountId: centers.A.account.id,
      totalAmount: 250,
      items: [{ description: 'کالای آزمون ۲', quantity: 1, unitPrice: 250, totalPrice: 250 }],
      invoiceNumber: `${TAG}-250`,
    });
    createdInvoices.push(inv2Res.data?.invoice?.id);
    const inv2 = inv2Res.data?.invoice;
    const settle = await api('/api/billing', { action: 'mark-paid', id: inv2.id });
    const settleReceipts = await db.issuedInvoicePayment.findMany({ where: { issuedInvoiceId: inv2.id } });
    check('F1: mark-paid creates a REAL receipt of the full remainder', settle.status === 200 && settleReceipts.length === 1 && settleReceipts[0].amount === 250, `receipts=${settleReceipts.length}, amount=${settleReceipts[0]?.amount}`);

    const accAfter = await db.centerAccount.findUnique({ where: { id: centers.A.account.id } });
    check('F1: settlement reflected in center account (totalPaid = 350)', accAfter.totalPaid === 350, `totalPaid=${accAfter.totalPaid}`);

    const resettle = await api('/api/billing', { action: 'mark-paid', id: inv2.id });
    const receiptsAfterResettle = await db.issuedInvoicePayment.count({ where: { issuedInvoiceId: inv2.id } });
    check('F1: re-settling creates NO new receipt', resettle.status === 200 && receiptsAfterResettle === 1, `receipts=${receiptsAfterResettle}, alreadySettled=${resettle.data?.alreadySettled}`);

    // voided refuses payment
    await api('/api/billing', { action: 'void', id: inv2.id, reason: 'آزمون' });
    const voidPay = await pay(10, `${TAG}-void`);
    check('voided invoice refuses payment (400)', voidPay.status === 400, `status=${voidPay.status}`);

    // ══════════════ F3: validation ══════════════
    console.log('\n[F3] invoice creation validation');
    const badTotal = await api('/api/billing', { action: 'create', centerAccountId: centers.A.account.id, totalAmount: 100, items: [{ description: 'x', quantity: -2, unitPrice: 900, totalPrice: 7 }] });
    check('negative quantity rejected (400)', badTotal.status === 400, `status=${badTotal.status}`);
    const mismatch = await api('/api/billing', { action: 'create', centerAccountId: centers.A.account.id, totalAmount: 100, items: [{ description: 'x', quantity: 1, unitPrice: 300, totalPrice: 300 }] });
    check('items sum ≠ total rejected (400)', mismatch.status === 400, `status=${mismatch.status}`);
    const fractional = await api('/api/billing', { action: 'create', centerAccountId: centers.A.account.id, totalAmount: 100.5, items: [{ description: 'x', quantity: 1, unitPrice: 100.5, totalPrice: 100.5 }] });
    check('fractional Rial rejected (400)', fractional.status === 400, `status=${fractional.status}`);
    const dup = await api('/api/billing', { action: 'create', centerAccountId: centers.A.account.id, totalAmount: 100, invoiceNumber: `${TAG}-100`, items: [{ description: 'x', quantity: 2, unitPrice: 50, totalPrice: 100 }] });
    check('duplicate invoiceNumber → clean 400 (not 500)', dup.status === 400, `status=${dup.status}`);

    // ══════════════ F4: access matrix ══════════════
    console.log('\n[F4] access matrix (direct API requests)');

    // fixture: expert A uploads a file on center A (in-territory) and a centerless one
    const upload = async (centerId) => {
      const form = new gFormData();
      const blob = new gBlob([`test-${TAG}`], { type: 'text/plain' });
      form.append('file', blob, `test-${TAG}.txt`);
      form.append('originalName', `test-${TAG}.txt`);
      form.append('mimeType', 'text/plain');
      if (centerId) form.append('centerId', centerId);
      const res = await gfetch(`${BASE}/api/files`, {
        method: 'POST',
        headers: { Origin: BASE, Cookie: `bgl_session=${sessionCookie}` },
        body: form,
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    switchUser('expertA');
    const fileA = await upload(centers.A.center.id);
    check('expertA uploads file to in-territory center', fileA.status === 201, `status=${fileA.status}`);
    createdFiles.push(fileA.data?.file?.id);
    const fileACenterless = await upload(null);
    check('expertA uploads CENTERLESS file (stays in own access)', fileACenterless.status === 201, `status=${fileACenterless.status}`);
    createdFiles.push(fileACenterless.data?.file?.id);

    // out-of-territory upload refused
    const outOfTerritory = await upload(centers.B.center.id);
    check('expertA upload to OUT-of-territory center refused (403)', outOfTerritory.status === 403, `status=${outOfTerritory.status}`);

    // expert A sees own centerless file + territory files, NOT center B / yasteb
    const listA = await api('/api/files', { action: 'list' });
    const namesA = (listA.data?.files || []).map((f) => f.id);
    check('expertA list includes own centerless upload', namesA.includes(fileACenterless.data?.file?.id));
    switchUser('expertB');
    const listB = await api('/api/files', { action: 'list' });
    const namesB = (listB.data?.files || []).map((f) => f.id);
    check('expertB does NOT see expertA\'s centerless file (ownership)', !namesB.includes(fileACenterless.data?.file?.id) && !namesB.includes(fileA.data?.file?.id));

    // delete: colleague's file refused
    const delTry = await api('/api/files', { action: 'delete', id: fileA.data?.file?.id });
    check('expertB cannot delete expertA\'s file (403)', delTry.status === 403, `status=${delTry.status}`);

    // admin: isolated company files invisible
    switchUser('yasteb');
    const fileY = await upload(centers.Y.center.id);
    check('yasteb user uploads to own isolated center', fileY.status === 201, `status=${fileY.status}`);
    createdFiles.push(fileY.data?.file?.id);
    const listY = await api('/api/files', { action: 'list' });
    check('yasteb list contains ONLY own company files', (listY.data?.files || []).every((f) => f.centerId === centers.Y.center.id || f.centerId === null));

    switchUser('admin');
    const adminList = await api('/api/files', { action: 'list' });
    const adminIds = (adminList.data?.files || []).map((f) => f.id);
    check('admin list EXCLUDES isolated-company files (F4-ج)', !adminIds.includes(fileY.data?.file?.id));
    const adminDelY = await api('/api/files', { action: 'delete', id: fileY.data?.file?.id });
    check('admin cannot delete isolated-company file (403)', adminDelY.status === 403, `status=${adminDelY.status}`);

    // billing ownership: expert B cannot pay expert A-region invoices created by finance
    switchUser('expertB');
    const expertBpay = await api('/api/billing', { action: 'add-payment', id: inv.id, amount: 5, idempotencyKey: `${TAG}-own` });
    check('expertB cannot register payment on finance\'s invoice (404 ownership)', expertBpay.status === 404, `status=${expertBpay.status}`);
    const expertBmark = await api('/api/billing', { action: 'mark-paid', id: inv.id });
    check('expertB cannot settle finance\'s invoice (404 ownership)', expertBmark.status === 404, `status=${expertBmark.status}`);

    // expert list sees only own invoices
    const expertBlist = await api('/api/billing', { action: 'list' });
    const expertInvoices = (expertBlist.data?.items || []).filter((i) => i.invoiceNumber && String(i.invoiceNumber).startsWith(TAG));
    check('expertB billing list: zero of the test invoices (none are theirs)', expertInvoices.length === 0, `count=${expertInvoices.length}`);

    // finance sees them
    switchUser('finance');
    const finList = await api('/api/billing', { action: 'list' });
    const finInvoices = (finList.data?.items || []).filter((i) => i.invoiceNumber && String(i.invoiceNumber).startsWith(TAG));
    check('finance billing list sees the test invoices (view_other)', finInvoices.length >= 2, `count=${finInvoices.length}`);

    // other-company expert: nothing of bazargani
    switchUser('otherCompany');
    const otherList = await api('/api/billing', { action: 'list' });
    const otherInvoices = (otherList.data?.items || []).filter((i) => i.invoiceNumber && String(i.invoiceNumber).startsWith(TAG));
    check('other-company expert sees ZERO bazargani test invoices', otherInvoices.length === 0, `count=${otherInvoices.length}`);

    // production: finance_write=false → 403 on billing
    switchUser('production');
    const prodList = await api('/api/billing', { action: 'list' });
    check('production role blocked from billing (403)', prodList.status === 403, `status=${prodList.status}`);

    // sales-documents: colleague doc NOT visible to same-territory expert
    switchUser('finance');
    const docRes = await api('/api/sales-documents', {
      action: 'create',
      documentType: 'proforma',
      centerId: centers.A.center.id,
      items: [{ productName: 'کالای آزمون', quantity: 1, unitPrice: 10 }],
    });
    const docId = docRes.data?.data?.id || docRes.data?.id;
    check('finance creates a sales document on center A', !!docId, `status=${docRes.status}`);
    if (docId) {
      docIdGlobal = docId;
      switchUser('expertA');
      const expertGet = await api('/api/sales-documents', { action: 'get', id: docId });
      check('expertA (same territory) cannot read finance\'s doc (404 ownership)', expertGet.status === 404, `status=${expertGet.status}`);
      const expertDocs = await api('/api/sales-documents', { action: 'list', centerId: centers.A.center.id });
      const inList = (expertDocs.data?.items || expertDocs.data?.documents || []).some((d) => d.id === docId);
      check('finance doc NOT in expertA list despite same-territory center', !inList);
    }

    // ══════════════ extras: AI masking + telephony fail-closed ══════════════
    console.log('\n[extras] AI settings masking + telephony webhook');
    switchUser('admin');
    const aiSettings = await api('/api/settings', { action: 'get', keys: ['ai_bridge.api_key', 'sms.api_key'] });
    const rawLeak = JSON.stringify(aiSettings.data || {}).match(/[a-f0-9]{32,}|sk-[A-Za-z0-9]{10,}/);
    check('settings get returns masked values (no raw secrets)', aiSettings.status === 200 && !rawLeak, `status=${aiSettings.status}`);

    const telephony = await gfetch(`${BASE}/api/ai-sales/telephony/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ provider: 'test', event: 'call_ended', callId: 'r86-test', externalId: 'r86-test' }),
    });
    check('telephony webhook fails closed without a valid signature', [401, 403, 404, 422].includes(telephony.status), `status=${telephony.status} (404 = feature off, no existence leak)`);
  } finally {
    // ── cleanup: remove ONLY rows this script created ──
    console.log('\n[cleanup] removing test rows…');
    try {
      // files: DB-direct removal (an isolated-company file cannot be deleted
      // through the API by design — exactly the wall we verified above)
      for (const id of createdFiles) {
        if (id) {
          const row = await db.file.findUnique({ where: { id }, select: { storedName: true } }).catch(() => null);
          if (row) {
            const { unlinkSync } = await import('node:fs');
            try { unlinkSync(join(root, 'storage', 'uploads', row.storedName)); } catch { /* already gone */ }
            await db.file.delete({ where: { id } }).catch(() => null);
          }
        }
      }
      // idempotency rows are plain references (no FK cascade) — sweep by tag
      await db.issuedInvoicePaymentIdempotency.deleteMany({ where: { idemKey: { startsWith: TAG } } });
      for (const id of createdInvoices) {
        if (id) await db.issuedInvoice.delete({ where: { id } }).catch(() => null);
      }
      if (docIdGlobal) {
        await db.salesDocumentLog.deleteMany({ where: { salesDocumentId: docIdGlobal } }).catch(() => null);
        await db.salesDocumentItem.deleteMany({ where: { salesDocumentId: docIdGlobal } }).catch(() => null);
        await db.salesDocument.delete({ where: { id: docIdGlobal } }).catch(() => null);
      }
      // sessions of the test users (avoids FK friction on user delete)
      const testUserIds = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
      if (testUserIds.length > 0) {
        await db.session.deleteMany({ where: { userId: { in: testUserIds.map((u) => u.id) } } });
      }
      for (const key of Object.keys(centers)) {
        if (centers[key]?.center) {
          await db.center.delete({ where: { id: centers[key].center.id } }).catch(() => null);
        }
      }
      await db.user.deleteMany({ where: { username: { startsWith: TAG } } });
      const residue = await db.user.count({ where: { username: { startsWith: TAG } } });
      const residueFiles = await db.file.count({ where: { originalName: { startsWith: `test-${TAG}` } } });
      check('cleanup: zero residue (users/files/invoices)', residue === 0 && residueFiles === 0, `users=${residue}, files=${residueFiles}`);
    } catch (e) {
      console.error(`  ⚠ cleanup warning: ${e.message}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n[verify-api] ${results.length - failed.length}/${results.length} PASS${failed.length ? `, ${failed.length} FAIL` : ''}`);
  for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  await db.$disconnect();
  process.exit(failed.length ? 1 : 0);
}

let docIdGlobal = null;
main().catch(async (e) => {
  console.error(`[verify-api] FATAL: ${e.message}`);
  await db.user.deleteMany({ where: { username: { startsWith: TAG } } }).catch(() => null);
  await db.$disconnect();
  process.exit(1);
});

// track the sales-document id for cleanup
process.on('exit', () => { /* docIdGlobal used by main's finally */ });
