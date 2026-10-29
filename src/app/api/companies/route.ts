import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';
import {
  LOGO_MAX_EDGE_PX,
  LOGO_MAX_STORED_BYTES,
  checkLogoDataUrl,
  normalizeBankAccountNumber,
  normalizeSheba,
  validateProformaNote,
  validateProfileName,
  validateProfileTagline,
} from '@/lib/company-profile';
// v2.52.0 — per-company print template registry (تفکیک قالب چاپ).
import { isPrintTemplateKey } from '@/lib/print-templates';

// v2.35.0 — writable sender-profile fields (registered ONCE per company,
// auto-pulled into every proforma/invoice print).
// v2.48.0 — name/tagline/proformaNote/logo are letterhead-printable BRAND
// fields, so they are now editable from this profile action too (a brand
// change in Settings updates every future print — the slug alone stays
// structural). bankSheba/bankAccountNumber moved to VALIDATED_FIELDS
// (checksum + digits enforcement, see src/lib/company-profile.ts).
const PROFILE_FIELDS = [
  'nationalId',
  'address',
  'phone',
  'postalCode',
  'headOfficeAddress',
  'factoryAddress',
  'bankName',
  'bankAccountHolder',
  // v2.54.0 — per-company footer website (globe icon); null → the
  // global app.website fallback at print time.
  'website',
] as const;

/** Trim + empty→null normalization (an emptied field clears the stored value). */
function cleanField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, 500);
}

// ════════════════════════════════════════════════════════════
// v2.48.0 — logo pipeline. The uploaded data-URL is re-encoded with
// sharp: metadata is stripped, the pixel edge is capped at 480px and
// the result is stored as a self-contained data-URL INSIDE the DB
// (Company.logo). Why not a public/ file: the DB snapshot/restore
// pipeline (VACUUM INTO) would not carry a loose file — a restored
// install would silently lose its brand. A data-URL survives every
// backup/restore and needs zero filesystem writes.
// ════════════════════════════════════════════════════════════
async function reencodeLogo(
  dataUrl: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const check = checkLogoDataUrl(dataUrl);
  if (!check.ok) return check;
  try {
    const input = Buffer.from(check.base64, 'base64');
    // Fail early when the bytes are not a decodable image: random bytes
    // pass the charset/size checks but cannot decode as a picture.
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) {
      return { ok: false, error: 'فایل لوگو یک تصویر معتبر نیست.' };
    }
    const resize = { width: LOGO_MAX_EDGE_PX, height: LOGO_MAX_EDGE_PX, fit: 'inside' as const, withoutEnlargement: true };
    const png = await sharp(input).resize(resize).png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= LOGO_MAX_STORED_BYTES) {
      return { ok: true, value: `data:image/png;base64,${png.toString('base64')}` };
    }
    // PNG still too big (photo-like logo) → lossy WebP fallback.
    const webp = await sharp(input).resize(resize).webp({ quality: 85 }).toBuffer();
    if (webp.length <= LOGO_MAX_STORED_BYTES) {
      return { ok: true, value: `data:image/webp;base64,${webp.toString('base64')}` };
    }
    return {
      ok: false,
      error: 'لوگو حتی پس از فشرده‌سازی از ۶۴ کیلوبایت بزرگ‌تر است — فایل ساده‌تری انتخاب کنید.',
    };
  } catch {
    return { ok: false, error: 'پردازش لوگو ناموفق بود — فایل تصویر معتبر نیست.' };
  }
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
  }

  try {
    // Non-admin users only see the companies they are assigned to.
    // Admins see the group structure. v2.35.0: isolated companies
    // (یاس طب) are excluded from the admin list — they must never surface
    // in any group view; their own users reach them via their assignment.
    const isAdmin = getCanonicalRole(user.role) === 'admin';
    const where: Record<string, unknown> = { isActive: true };
    if (isAdmin) {
      where.isIsolated = false;
    } else {
      where.slug = { in: user.companyIds };
    }

    const companies = await db.company.findMany({
      where,
      include: {
        _count: { select: { periodicFollowups: true, centers: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(
      companies.map((c) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        description: c.description,
        type: c.type,
        color: c.color,
        accentColor: c.accentColor,
        // v2.31.9 — full seller profile + bank account (Lian proforma
        // format): feeds the read-only seller card in the data-entry form
        // and the «اطلاعات حساب» print box.
        nationalId: c.nationalId,
        address: c.address,
        phone: c.phone,
        postalCode: c.postalCode,
        // v2.35.0 — two-address sender profile (دفتر مرکزی / کارخانه):
        // printed as separate labelled lines in «مشخصات فروشنده».
        headOfficeAddress: c.headOfficeAddress,
        factoryAddress: c.factoryAddress,
        bankName: c.bankName,
        bankAccountHolder: c.bankAccountHolder,
        bankAccountNumber: c.bankAccountNumber,
        bankSheba: c.bankSheba,
        // v2.48.0 — brand block + printed terms for the settings screen
        // (letterhead live preview) and the «توضیحات / شرایط» box.
        tagline: c.tagline,
        logo: c.logo,
        proformaNote: c.proformaNote,
        // v2.52.0 — the company's chosen A4 print template (null → 'bgl'
        // default); feeds the settings selector and the print sheet.
        printTemplate: c.printTemplate,
        // v2.54.0 — per-company website for the A4 footer contact band
        // (null → the global app.website at print time).
        website: c.website,
        followupCount: c._count.periodicFollowups,
        centerCount: c._count.centers,
      }))
    );
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}

export async function POST(req: Request) {
  // v2.35.0 — update-profile: admin registers/edits a company's sender
  // identity once; every future proforma/invoice pulls it automatically.
  // Mirrors the /api/settings admin gate (settings are administrative
  // data — a standard salesperson must not rewrite the printed letterhead).
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });
  }
  if (getCanonicalRole(user.role) !== 'admin') {
    return NextResponse.json(
      { error: 'ویرایش اطلاعات فرستندهٔ شرکت فقط برای مدیر سیستم ممکن است.' },
      { status: 403 },
    );
  }

  try {
    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      id?: string;
      slug?: string;
    };
    if (body.action !== 'update-profile') {
      return NextResponse.json({ error: 'عملیات ناشناخته است.' }, { status: 400 });
    }

    const where = body.id
      ? { id: body.id }
      : body.slug
        ? { slug: body.slug }
        : null;
    if (!where) {
      return NextResponse.json({ error: 'شناسه یا کد شرکت الزامی است.' }, { status: 400 });
    }
    const company = await db.company.findUnique({ where });
    if (!company) {
      return NextResponse.json({ error: 'شرکت یافت نشد.' }, { status: 404 });
    }
    // v2.55.0 (r80) — isolated companies (یاس طب) are fully independent
    // tenants: their branding/profile is migration+seed-owned. Group
    // admins must never target them (the v2.35.0 isolation promise —
    // admins are excluded from isolated data by design; the update
    // path previously bypassed the guard because it resolves the row
    // directly by id/slug. Found by the round-80 E2E battery).
    if (company.isIsolated) {
      return NextResponse.json(
        { error: 'شرکت مستقل خارج از حوزهٔ مدیریت گروه است — پروفایل و قالب چاپ آن فقط از طریق نصب/seed تغییر می‌کند.' },
        { status: 403 },
      );
    }

    const data: Record<string, string | null> = {};

    // ── plain profile fields (trim / empty→clear) ──
    for (const field of PROFILE_FIELDS) {
      if (field in (body as Record<string, unknown>)) {
        data[field] = cleanField((body as Record<string, unknown>)[field]);
      }
    }

    // ── validated brand fields (v2.48.0) ──
    const raw = body as Record<string, unknown>;

    if ('name' in raw) {
      const r = validateProfileName(raw.name);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      data.name = r.value;
    }

    if ('tagline' in raw) {
      const r = validateProfileTagline(raw.tagline);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      data.tagline = r.value === '' ? null : r.value;
    }

    if ('proformaNote' in raw) {
      const r = validateProformaNote(raw.proformaNote);
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      data.proformaNote = r.value === '' ? null : r.value;
    }

    // v2.52.0 — per-company print template: null/'' → clears (the 'bgl'
    // default); any other value must be a registered template key.
    if ('printTemplate' in raw) {
      const v = raw.printTemplate;
      if (v === null || (typeof v === 'string' && v.trim() === '')) {
        data.printTemplate = null;
      } else if (isPrintTemplateKey(v)) {
        data.printTemplate = v;
      } else {
        return NextResponse.json(
          { error: 'قالب چاپ ناشناخته است — یکی از قالب‌های ثبت‌شده را انتخاب کنید.' },
          { status: 400 },
        );
      }
    }

    if ('bankSheba' in raw) {
      const v = raw.bankSheba;
      if (v === null || (typeof v === 'string' && v.trim() === '')) {
        data.bankSheba = null;
      } else {
        // v2.48.0 — the IBAN is checksum-validated (mod-97) and stored in
        // the canonical IR+24-digits form; a typo can no longer silently
        // print on every future proforma.
        const r = normalizeSheba(v);
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
        data.bankSheba = r.value;
      }
    }

    if ('bankAccountNumber' in raw) {
      const v = raw.bankAccountNumber;
      if (v === null || (typeof v === 'string' && v.trim() === '')) {
        data.bankAccountNumber = null;
      } else {
        const r = normalizeBankAccountNumber(v);
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
        data.bankAccountNumber = r.value;
      }
    }

    let logoUpdated = false;
    if ('logo' in raw) {
      const v = raw.logo;
      if (v === null || v === '') {
        // clear → the letterhead falls back to the shipped holding logo
        data.logo = null;
        logoUpdated = true;
      } else if (typeof v === 'string') {
        const r = await reencodeLogo(v);
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
        data.logo = r.value;
        logoUpdated = true;
      } else {
        return NextResponse.json(
          { error: 'لوگو باید متن (data-URL) یا null باشد.' },
          { status: 400 },
        );
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'هیچ فیلدی برای ذخیره ارسال نشده است.' }, { status: 400 });
    }

    const updated = await db.company.update({
      where: { id: company.id },
      data,
      select: {
        id: true, slug: true, name: true, tagline: true, logo: true, proformaNote: true,
        nationalId: true, address: true, phone: true, postalCode: true,
        headOfficeAddress: true, factoryAddress: true,
        bankName: true, bankAccountHolder: true, bankAccountNumber: true, bankSheba: true,
        website: true, printTemplate: true,
      },
    });

    // v2.48.0 — audit trail: letterhead/bank data prints on every future
    // document, so every rewrite is recorded (field NAMES only — never the
    // bank values themselves).
    await db.auditEvent.create({
      data: {
        eventType: 'COMPANY_PROFILE_UPDATED',
        category: 'company',
        subject: company.slug,
        userId: user.id,
        details: `fields=${Object.keys(data).sort().join(',')}; logo=${logoUpdated ? 'updated' : 'untouched'}`,
      },
    }).catch(() => undefined);

    return NextResponse.json({
      success: true,
      message: 'اطلاعات فرستندهٔ شرکت ذخیره شد — از این پس در تمام اسناد جدید به‌صورت خودکار درج می‌شود.',
      data: updated,
    });
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
