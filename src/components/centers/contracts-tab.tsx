'use client';

import React, { useMemo, useState } from 'react';
import { Handshake, Search, Percent, UserCheck, Building2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Center, toPersianNum, STATUS_CFG } from './types';
// v2.35.1 (round 61) — keyboard-layout auto-fix (client-side filter twins)
import { searchVariants } from '@/lib/keyboard-layout';

// ═══════════════════════════════════════════════════════════
// CONTRACTS TAB (v2.26.0) — the «قراردادها» menu item previously fell
// through to the plain centers list. This view surfaces the REAL
// cooperation terms that already live on every center row (segment,
// commission percent, payment behavior, customer type) so contracts
// have a home without inventing new backend models.
// ═══════════════════════════════════════════════════════════

const SEGMENT_LABELS: Record<string, string> = {
  government: 'دولتی',
  private: 'خصوصی',
  partner: 'همکار / نماینده',
};

const PAYMENT_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  good_payer: { label: 'پرداخت منظم', color: '#059669', bg: '#ecfdf5' },
  bad_payer: { label: 'پرداخت با تأخیر', color: '#dc2626', bg: '#fef2f2' },
  unknown: { label: 'نامشخص', color: '#6b7280', bg: '#f3f4f6' },
};

export function ContractsTab({ centers }: { centers: Center[] }) {
  const [search, setSearch] = useState('');

  const rows = useMemo(() => {
    const qs = searchVariants(search).map((v) => v.toLowerCase());
    return centers
      .filter((c) => (qs.length && search.trim()
        // v2.35.1 (round 61) — Latin-typed queries also match their Persian twins
        ? qs.some((v) => [c.name, c.city, c.province].join(' ').toLowerCase().includes(v))
        : true))
      .sort((a, b) => b.commissionPercent - a.commissionPercent || a.name.localeCompare(b.name, 'fa'));
  }, [centers, search]);

  const partnerCount = rows.filter((c) => c.segment === 'partner').length;
  const withCommission = rows.filter((c) => c.commissionPercent > 0).length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-1 text-teal-700"><Handshake size={15} /><span className="text-xs">مجموع قراردادها</span></div>
          <p className="text-2xl font-bold text-gray-900">{toPersianNum(rows.length)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-1 text-indigo-600"><UserCheck size={15} /><span className="text-xs">همکاران / نمایندگان</span></div>
          <p className="text-2xl font-bold text-gray-900">{toPersianNum(partnerCount)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-1 text-amber-600"><Percent size={15} /><span className="text-xs">دارای کمیسیون</span></div>
          <p className="text-2xl font-bold text-gray-900">{toPersianNum(withCommission)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 p-4">
          <div className="flex items-center gap-2 mb-1 text-emerald-600"><Building2 size={15} /><span className="text-xs">مراکز فعال</span></div>
          <p className="text-2xl font-bold text-gray-900">{toPersianNum(rows.filter((c) => c.status === 'active').length)}</p>
        </div>
      </div>

      {/* Search */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="relative max-w-[min(24rem,calc(100vw-2rem))]">
          <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جستجوی قرارداد بر اساس نام مرکز یا شهر..."
            aria-label="جستجوی قراردادها"
            className="pr-8 h-9 rounded-lg text-xs border-gray-200"
          />
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="bg-gray-50 text-gray-500">
                <th className="text-right font-medium px-4 py-3">مرکز / مشتری</th>
                <th className="text-right font-medium px-4 py-3">نوع همکاری</th>
                <th className="text-right font-medium px-4 py-3">کمیسیون</th>
                <th className="text-right font-medium px-4 py-3">وضعیت پرداخت</th>
                <th className="text-right font-medium px-4 py-3">استان / شهر</th>
                <th className="text-right font-medium px-4 py-3">وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-gray-400">
                    <Handshake size={32} className="mx-auto mb-2 opacity-40" />
                    <p className="text-sm">قراردادی برای نمایش وجود ندارد.</p>
                  </td>
                </tr>
              ) : (
                rows.slice(0, 200).map((c) => {
                  const pay = PAYMENT_LABELS[c.paymentBehavior] || PAYMENT_LABELS.unknown;
                  const status = STATUS_CFG[c.status as keyof typeof STATUS_CFG];
                  return (
                    <tr key={c.id} className="border-t border-gray-50 hover:bg-gray-50/60 transition-colors">
                      <td className="px-4 py-3">
                        <p className="font-bold text-gray-900 truncate max-w-[220px]">{c.name}</p>
                        <p className="text-[11px] text-gray-400 mt-0.5">
                          {c.customerType === 'end_user' ? 'مشتری نهایی' : 'سازمانی'}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{SEGMENT_LABELS[c.segment] || '—'}</td>
                      <td className="px-4 py-3">
                        {c.commissionPercent > 0 ? (
                          <span className="font-bold text-teal-700">{toPersianNum(c.commissionPercent)}٪</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-1 rounded-full text-[11px] font-medium" style={{ background: pay.bg, color: pay.color }}>
                          {pay.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{[c.province, c.city].filter((x) => x && x !== '—').join(' / ') || '—'}</td>
                      <td className="px-4 py-3">
                        {status ? (
                          <span className="px-2 py-1 rounded-full text-[11px] font-medium" style={{ background: status.bg, color: status.color }}>
                            {status.label}
                          </span>
                        ) : c.status}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 200 && (
          <p className="text-[11px] text-gray-400 text-center py-2 border-t border-gray-50">
            نمایش ۲۰۰ نتیجهٔ اول از {toPersianNum(rows.length)} قرارداد — برای محدودکردن، جستجو کنید.
          </p>
        )}
      </div>
    </div>
  );
}
