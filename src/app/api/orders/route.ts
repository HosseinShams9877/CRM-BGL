import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser, getRolePermissions } from '@/lib/auth';
import { getCanonicalRole } from '@/lib/roles';
import { assertCanAccessCompanySlug, nonIsolatedCompanyIds } from '@/lib/company-scope';
import { docOwnershipTerritoryWhere, resolveTerritoryScope } from '@/lib/territory-scope';
import { apiErrorMessage, apiErrorStatus } from '@/lib/api-error';

const UNAUTHORIZED = NextResponse.json({ error: 'احراز هویت نشده است. لطفاً وارد شوید.' }, { status: 401 });

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return UNAUTHORIZED;

  const { searchParams } = new URL(req.url);
  const company = searchParams.get('company') || 'holding';
  const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10) || 10, 50);

  try {
    const perms = getRolePermissions(user.role);

    // 'holding' is the group-wide aggregate view — admin only
    if (company === 'holding' && getCanonicalRole(user.role) !== 'admin') {
      return NextResponse.json({ error: 'نمای هلدینگ فقط برای مدیر سیستم در دسترس است.' }, { status: 403 });
    }

    // v2.58.4 (external audit F02) — ONE document-visibility policy, byte
    // for byte the handleList contract of /api/sales-documents:
    //   • business unit (the route's own tenant boundary);
    //   • the DOCUMENT'S OWN companyId stamp — never "all centers of the
    //     company" (a document is ISSUED by a company; a center sitting
    //     inside a company must not widen that company's boundary — a
    //     cross-stamped row is filtered by its own stamp);
    //   • ownership + territory for standard experts (docOwnership-
    //     TerritoryWhere): own documents only, restricted to the
    //     territory's centers (own centerless documents stay visible;
    //     «همه کشور» removes only the geography limit).
    // Previously this route filtered only businessUnit + company centers:
    // a Tehran-restricted expert received numbers, amounts and creator
    // names of every colleague's proforma in every province.
    const where: Record<string, unknown> = {
      documentType: 'proforma',
      businessUnitId: user.businessUnitId,
    };

    if (company === 'holding') {
      // admin holding view: NON-isolated companies only, by document stamp.
      where.companyId = { in: await nonIsolatedCompanyIds() };
    } else {
      // shared company gate: isolated companies resolve for their assigned
      // users only; admins are walled out of یاس طب. Controlled 403/404.
      const comp = await assertCanAccessCompanySlug(user, company);
      where.companyId = comp.id;

      // Only show own documents unless the user holds the explicit
      // view_other_sales_documents permission (finance/admin), mirroring
      // the sales-documents list exactly.
      if (!perms.view_other_sales_documents) {
        const ownership = docOwnershipTerritoryWhere(resolveTerritoryScope(user), user.id);
        if (ownership) where.AND = [ownership];
      }
    }

    const docs = await db.salesDocument.findMany({
      where,
      include: {
        center: { select: { name: true, city: true } },
        creator: { select: { displayName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    const orders = docs.map((d) => ({
      id: d.id,
      number: d.documentNumber || '-',
      centerName: d.center?.name || 'نامشخص',
      city: d.center?.city || '-',
      amount: d.finalAmount,
      status: d.status,
      statusLabel:
        d.status === 'approved'
          ? 'تایید شده'
          : d.status === 'pending_approval'
            ? 'در انتظار تایید'
            : d.status === 'rejected'
              ? 'رد شده'
              : d.status === 'cancelled'
                ? 'لغو شده'
                : 'پیش‌نویس',
      createdBy: d.creator?.displayName || '-',
      createdAt: d.createdAt.toISOString().slice(0, 10),
    }));

    return NextResponse.json(orders);
  } catch (e: unknown) {
    const msg = apiErrorMessage(e, 'خطای سرور');
    return NextResponse.json({ error: msg }, { status: apiErrorStatus(e) });
  }
}
