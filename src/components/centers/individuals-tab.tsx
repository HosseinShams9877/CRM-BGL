'use client';

import React, { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Search, Plus, Phone, TrendingUp, UserRound, Gift,
} from 'lucide-react';
import {
  Center, toPersianNum,
} from './types';
// v2.35.1 (round 61) — keyboard-layout auto-fix (client-side filter twins)
import { searchVariants } from '@/lib/keyboard-layout';

// ==================== INDIVIDUALS TAB (مشتریان نهایی B2C) ====================
export function IndividualsTab({ centers, onOpenNew }: { centers: Center[]; onOpenNew: () => void }) {
  const [search, setSearch] = useState('');

  const individuals = useMemo(() => {
    return centers
      .filter(c => c.customerType === 'end_user')
      .filter(c => {
        if (!search.trim()) return true;
        // v2.35.1 (round 61) — Latin-typed queries also match their Persian twins
        const qs = searchVariants(search).map((v) => v.toLowerCase());
        return qs.some((v) => c.name.includes(v) || c.mobile.includes(v) || c.city.includes(v));
      })
      .sort((a, b) => b.loyaltyPoints - a.loyaltyPoints || b.orderCount - a.orderCount);
  }, [centers, search]);

  const totalPoints = individuals.reduce((s, c) => s + c.loyaltyPoints, 0);
  const withMobile = individuals.filter(c => c.mobile).length;

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-violet-100 text-violet-600"><UserRound size={16} /></div>
            <span className="text-[11px] text-gray-400">مشتریان نهایی</span>
          </div>
          <p className="text-xl font-bold text-gray-900">{toPersianNum(individuals.length)}</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-amber-100 text-amber-600"><Gift size={16} /></div>
            <span className="text-[11px] text-gray-400">مجموع امتیاز باشگاه</span>
          </div>
          <p className="text-xl font-bold text-amber-600">{toPersianNum(totalPoints)}</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-green-100 text-green-600"><Phone size={16} /></div>
            <span className="text-[11px] text-gray-400">دارای موبایل</span>
          </div>
          <p className="text-xl font-bold text-green-600">{toPersianNum(withMobile)}</p>
        </div>
        <div className="bg-white rounded-xl p-3.5 border border-gray-100">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-teal-100 text-teal-600"><TrendingUp size={16} /></div>
            <span className="text-[11px] text-gray-400">خریدکرده (فعال)</span>
          </div>
          <p className="text-xl font-bold text-teal-600">{toPersianNum(individuals.filter(c => c.orderCount > 0).length)}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-gray-100 p-3">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="جستجو نام یا موبایل..." className="pr-8 h-9 rounded-lg text-xs border-gray-200" />
          </div>
          <Button onClick={onOpenNew} className="h-9 gap-1.5 text-white text-xs rounded-lg px-3" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
            <Plus size={13} /> مشتری نهایی جدید
          </Button>
        </div>
      </div>

      {/* Individuals list */}
      {individuals.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-12 text-center text-gray-400">
          <UserRound size={36} className="mx-auto mb-2 opacity-40" />
          <p className="text-sm">هنوز مشتری نهایی (شخص حقیقی) ثبت نشده است</p>
          <p className="text-[11px] mt-1 text-gray-400">مشتریان با «فروش سریع» به‌صورت خودکار در این بخش ثبت می‌شوند</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {individuals.map(c => (
            <div key={c.id} className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
              <div className="flex items-start gap-3 mb-3">
                <div className="w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
                  {c.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold text-gray-900 truncate">{c.name}</h4>
                  <p className="text-[11px] text-gray-500 mt-0.5 flex items-center gap-1" dir="ltr">
                    <Phone size={10} /> {c.mobile || 'بدون موبایل'}
                  </p>
                </div>
                {c.loyaltyPoints > 0 && (
                  <span className="text-[11px] px-2 py-1 rounded-full font-bold bg-amber-100 text-amber-700 inline-flex items-center gap-1 shrink-0">
                    <Gift size={10} /> {toPersianNum(c.loyaltyPoints)}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-gray-50 text-[11px] text-gray-500">
                <span>{c.city !== '—' ? c.city : ''}</span>
                <span>{toPersianNum(c.orderCount)} تعامل</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
