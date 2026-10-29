import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import { validateWidgets, type UserWidget } from '@/lib/dashboard-widgets';
import { validateHoldingTabs, type HoldingTab } from '@/lib/holding-dashboard-sections';

// ════════════════════════════════════════════════════════════
// DASHBOARD API — v2.43.0 per-user widget layout
// (pipeline.<userId> ownership pattern, verbatim)
//
// GET         → { widgets: UserWidget[] | null }  (null = defaults)
// POST save   → validate + persist own layout
// POST reset  → back to system defaults (deletes the key)
//
// v2.50.0 (round 75) — a SECOND scope for the holding dashboard's
// tab layout: ?scope=holding switches the Meta key to
// `holding_dashboard.<userId>` and validates HoldingTab rows
// instead of UserWidget rows. The expert scope stays the default
// so every existing caller is untouched.
// ════════════════════════════════════════════════════════════

const META_PREFIX = 'dashboard.';
const HOLDING_META_PREFIX = 'holding_dashboard.';

function metaKey(userId: string, scope: string): string {
  return (scope === 'holding' ? HOLDING_META_PREFIX : META_PREFIX) + userId;
}

function parseScope(raw: unknown): 'expert' | 'holding' {
  return raw === 'holding' ? 'holding' : 'expert';
}

export async function GET(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });
    const scope = parseScope(new URL(req.url).searchParams.get('scope'));
    const row = await db.meta.findUnique({ where: { key: metaKey(user.id, scope) } });
    if (scope === 'holding') {
      let tabs: HoldingTab[] | null = null;
      if (row) {
        try {
          tabs = JSON.parse(row.value) as HoldingTab[];
        } catch {
          tabs = null; // corrupted row → silent default (never crash the dashboard)
        }
      }
      return NextResponse.json({ tabs });
    }
    let widgets: UserWidget[] | null = null;
    if (row) {
      try {
        widgets = JSON.parse(row.value) as UserWidget[];
      } catch {
        widgets = null; // corrupted row → silent default (never crash the dashboard)
      }
    }
    return NextResponse.json({ widgets });
  } catch (e: unknown) {
    return NextResponse.json({ error: apiErrorMessage(e, 'خطای سرور') }, { status: apiErrorStatus(e) });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) return NextResponse.json({ error: 'احراز هویت نشده' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { action } = body as { action?: string };
    const scope = parseScope((body as { scope?: unknown }).scope);

    if (action === 'reset') {
      await db.meta.deleteMany({ where: { key: metaKey(user.id, scope) } });
      return scope === 'holding'
        ? NextResponse.json({ tabs: null })
        : NextResponse.json({ widgets: null });
    }

    if (action === 'save') {
      if (scope === 'holding') {
        const v = validateHoldingTabs((body as { tabs?: unknown }).tabs ?? (body as { widgets?: unknown }).widgets);
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
        const key = metaKey(user.id, scope);
        await db.meta.upsert({
          where: { key },
          create: { key, value: JSON.stringify(v.tabs) },
          update: { value: JSON.stringify(v.tabs) },
        });
        return NextResponse.json({ tabs: v.tabs });
      }
      const v = validateWidgets((body as { stages?: unknown }).stages ?? (body as { widgets?: unknown }).widgets);
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
      await db.meta.upsert({
        where: { key: metaKey(user.id, scope) },
        create: { key: metaKey(user.id, scope), value: JSON.stringify(v.widgets) },
        update: { value: JSON.stringify(v.widgets) },
      });
      return NextResponse.json({ widgets: v.widgets });
    }

    return NextResponse.json({ error: 'عملیات نامعتبر' }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json({ error: apiErrorMessage(e, 'خطای سرور') }, { status: apiErrorStatus(e) });
  }
}
