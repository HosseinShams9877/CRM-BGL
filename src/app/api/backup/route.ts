import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, AuthUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { logApiError } from '@/lib/logger';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { toJalaliString } from '@/lib/jalali';
import { createDbSnapshot, rotateSnapshots, listSnapshots, DEFAULT_KEEP, backupDir, createBackupPackage, listPackages, rotatePackages } from '@/lib/backup-snapshot';

// ════════════════════════════════════════════════════════
//  BACKUP — v2.18.0 (ninth-round audit)
//  The settings «پشتیبان‌گیری» tab used to show three invented
//  backup rows and a dead «پشتیبان‌گیری الان» button. This route
//  provides a REAL read-only JSON snapshot of the core tables
//  (admin only) plus an honest history of past exports.
//
//  Actions:
//   • export  → builds the snapshot, records a history entry,
//               returns the JSON (client downloads it as a file)
//   • history → last 20 manual exports
// ════════════════════════════════════════════════════════

const HISTORY_KEY = 'backup.history';
const MAX_ROWS = 2000; // per table — keeps one response bounded

interface HistoryEntry {
  id: string;
  date: string;
  jalaliDate: string;
  type: 'manual';
  sizeBytes: number;
  rowCount: number;
  createdBy: string;
  truncated: boolean;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
    }

    const body = await req.json();
    const { action } = body;

    if (action === 'export') return await handleExport(user);
    if (action === 'history') return await handleHistory(user);
    // v2.47.0 — real, restorable snapshots (see src/lib/backup-snapshot.ts)
    if (action === 'snapshot') return await handleSnapshot(user);
    if (action === 'snapshots') return await handleSnapshotList(user);
    // v2.58.1 (audit F7) — FULL package: database + stored files (incl.
    // voice notes) + verified manifest. This is what the settings
    // «پشتیبان‌گیری الان» button calls.
    if (action === 'package') return await handlePackage(user);
    if (action === 'packages') return await handlePackageList(user);

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای داخلی سرور');
    logApiError('backup', msg);
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

async function handleExport(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند پشتیبان تهیه کند.' }, { status: 403 });
  }

  // ── Read-only snapshot of the core tables (most recent first) ──
  // NOTE: visits are stored as a JSON blob in Meta (visits_data), not a
  // table — the blob is exported alongside the tables.
  const [
    companies, businessUnits, centers, products,
    salesDocuments, issuedInvoices, inventorySerials,
    activities, visitsBlob, shipments, productionRequests,
    users,
  ] = await Promise.all([
    db.company.findMany({ orderBy: { id: 'asc' } }),
    db.businessUnit.findMany({ orderBy: { id: 'asc' } }),
    db.center.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    db.product.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    db.salesDocument.findMany({
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { items: true, financeRecords: true },
    }),
    db.issuedInvoice.findMany({
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { items: true, payments: true },
    }),
    db.inventorySerial.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    db.activity.findMany({ orderBy: { activityDate: 'desc' }, take: MAX_ROWS }),
    db.meta.findUnique({ where: { key: 'visits_data' } }),
    db.salesShipment.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    db.productionPurchaseRequest.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ROWS }),
    // Sanitized: NEVER export password hashes.
    db.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      select: { id: true, username: true, displayName: true, role: true, roleLabel: true, jobTitle: true, province: true, isActive: true, createdAt: true },
    }),
  ]);

  const counts = {
    companies: companies.length,
    businessUnits: businessUnits.length,
    centers: centers.length,
    products: products.length,
    salesDocuments: salesDocuments.length,
    issuedInvoices: issuedInvoices.length,
    inventorySerials: inventorySerials.length,
    activities: activities.length,
    shipments: shipments.length,
    productionRequests: productionRequests.length,
    users: users.length,
  };

  const truncated = Object.values(counts).some((c) => c >= MAX_ROWS);

  const snapshot = {
    meta: {
      format: 'bgl-crm-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      createdBy: user.displayName,
      counts,
      truncated,
      note: truncated
        ? `هر جدول حداکثر ${MAX_ROWS} ردیف اخیر را شامل می‌شود.`
        : 'پشتیبان کامل است.',
    },
    companies,
    businessUnits,
    centers,
    products,
    salesDocuments,
    issuedInvoices,
    inventorySerials,
    activities,
    visitsBlob: visitsBlob?.value ? JSON.parse(visitsBlob.value) : null,
    shipments,
    productionRequests,
    users,
  };

  const json = JSON.stringify(snapshot);
  const sizeBytes = Buffer.byteLength(json, 'utf8');
  const rowCount = Object.values(counts).reduce((a, b) => a + b, 0);

  // ── Record the export in the shared history (last 20) ──
  const history = await readHistory();
  const entry: HistoryEntry = {
    id: `bk-${Date.now()}`,
    date: new Date().toISOString(),
    jalaliDate: toJalaliString(new Date()),
    type: 'manual',
    sizeBytes,
    rowCount,
    createdBy: user.displayName,
    truncated,
  };
  history.unshift(entry);
  await db.meta.upsert({
    where: { key: HISTORY_KEY },
    update: { value: JSON.stringify(history.slice(0, 20)) },
    create: { key: HISTORY_KEY, value: JSON.stringify(history.slice(0, 20)) },
  });

  return new NextResponse(json, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="bgl-crm-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      'X-Backup-Size': String(sizeBytes),
    },
  });
}

async function handleHistory(user: AuthUser) {
  // Read requires admin too — the history reveals table sizes/counts.
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند تاریخچه پشتیبان را ببیند.' }, { status: 403 });
  }
  return NextResponse.json({ history: await readHistory(), snapshots: await listSnapshots(20) });
}

// ── v2.47.0 — REAL snapshot: VACUUM INTO + quick_check + sha256 manifest ──
async function handleSnapshot(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند پشتیبان تهیه کند.' }, { status: 403 });
  }
  try {
    const { mkdirSync } = await import('fs');
    mkdirSync(backupDir(), { recursive: true });
    const manifest = await createDbSnapshot('api');
    const removed = await rotateSnapshots(DEFAULT_KEEP);
    await db.auditEvent.create({
      data: {
        eventType: 'BACKUP_SNAPSHOT_CREATED',
        category: 'database',
        subject: user.username,
        userId: user.id,
        details: `file=${manifest.file}; bytes=${manifest.bytes}; sha256=${manifest.sha256.slice(0, 16)}…; rotated=${removed.length}`,
      },
    }).catch(() => undefined);
    return NextResponse.json({ message: 'پشتیبان کامل و تأییدشده ساخته شد.', manifest, rotated: removed });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logApiError('backup-snapshot', msg);
    return NextResponse.json({ error: `ساخت پشتیبان شکست خورد: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}

async function handleSnapshotList(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند فهرست پشتیبان‌ها را ببیند.' }, { status: 403 });
  }
  return NextResponse.json({ snapshots: await listSnapshots(20) });
}

// ── v2.58.1 — FULL package (DB + files + manifest) ──
async function handlePackage(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند پشتیبان تهیه کند.' }, { status: 403 });
  }
  try {
    const { mkdirSync } = await import('fs');
    mkdirSync(backupDir(), { recursive: true });
    const manifest = await createBackupPackage('api');
    const removedDb = await rotateSnapshots(DEFAULT_KEEP);
    const removedPkgs = await rotatePackages(DEFAULT_KEEP);
    await db.auditEvent.create({
      data: {
        eventType: 'BACKUP_PACKAGE_CREATED',
        category: 'database',
        subject: user.username,
        userId: user.id,
        details: `dbBytes=${manifest.database.bytes}; files=${manifest.files.count}; missingContent=${manifest.files.missingContent.length}; sha256=${manifest.database.sha256.slice(0, 16)}…; rotated=${removedDb.length + removedPkgs.length}`,
      },
    }).catch(() => undefined);
    return NextResponse.json({
      message: `بستهٔ پشتیبان کامل ساخته شد: دیتابیس (${(manifest.database.bytes / 1_048_576).toFixed(1)} مگابایت) و ${manifest.files.count} فایل پیوست.` + (manifest.files.missingContent.length > 0 ? ` توجه: ${manifest.files.missingContent.length} رکورد فایل از قبل محتوای فیزیکی نداشت (در گزارش سلامت ثبت شد).` : ''),
      manifest,
      rotated: removedDb.length + removedPkgs.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logApiError('backup-package', msg);
    return NextResponse.json({ error: `ساخت بستهٔ پشتیبان شکست خورد: ${msg.slice(0, 200)}` }, { status: 500 });
  }
}

async function handlePackageList(user: AuthUser) {
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json({ error: 'فقط مدیر سیستم می‌تواند فهرست پشتیبان‌ها را ببیند.' }, { status: 403 });
  }
  return NextResponse.json({ packages: await listPackages(20) });
}

async function readHistory(): Promise<HistoryEntry[]> {
  const row = await db.meta.findUnique({ where: { key: HISTORY_KEY } });
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
