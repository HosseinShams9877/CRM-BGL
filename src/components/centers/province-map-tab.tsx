'use client';

import React, { useMemo } from 'react';
import {
  MapPin,
} from 'lucide-react';
import {
  Center, toPersianNum,
} from './types';

// ==================== PROVINCE MAP TAB (grouped by province) ====================
export function ProvinceMapTab({ centers, onOpenList }: { centers: Center[]; onOpenList: () => void }) {
  const byProvince = useMemo(() => {
    const map = new Map<string, Center[]>();
    for (const c of centers) {
      const prov = c.province && c.province !== '—' ? c.province : 'نامشخص';
      if (!map.has(prov)) map.set(prov, []);
      map.get(prov)!.push(c);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [centers]);

  const maxCount = Math.max(...byProvince.map(([, list]) => list.length), 1);
  const provinceColors = ['#1F8B7D', '#2980B9', '#8E44AD', '#d97706', '#dc2626', '#0891b2', '#6366f1'];

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
            <MapPin size={16} className="text-teal-600" /> پراکندگی جغرافیایی مراکز
          </h3>
          <span className="text-xs text-gray-400">{toPersianNum(byProvince.length)} استان</span>
        </div>
        <p className="text-[11px] text-gray-400 mb-4">مراکز بر اساس استان گروه‌بندی شده‌اند — پررنگ‌ترین استان بیشترین مرکز را دارد</p>

        {/* Province bars */}
        <div className="space-y-2.5 mb-5">
          {byProvince.map(([prov, list], i) => {
            const pct = Math.round((list.length / maxCount) * 100);
            const color = provinceColors[i % provinceColors.length];
            return (
              <div key={prov} className="flex items-center gap-3">
                <span className="text-xs font-bold text-gray-700 w-20 text-left shrink-0">{prov}</span>
                <div className="flex-1 h-7 bg-gray-50 rounded-lg overflow-hidden relative">
                  <div className="h-full rounded-lg transition-all duration-700 flex items-center justify-end px-2"
                    style={{ width: `${Math.max(pct, 12)}%`, background: `linear-gradient(90deg, ${color}25, ${color}70)` }}>
                    <span className="text-[11px] font-bold" style={{ color }}>{toPersianNum(list.length)}</span>
                  </div>
                </div>
                <span className="text-[11px] text-gray-400 w-24 shrink-0">
                  {list.filter((c) => c.status === 'active').length > 0 ? `${toPersianNum(list.filter((c) => c.status === 'active').length)} فعال` : 'بدون فعال'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Province cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {byProvince.map(([prov, list], i) => (
            <div key={prov} className="border border-gray-100 rounded-xl p-3 hover:shadow-sm transition-all">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                  style={{ background: provinceColors[i % provinceColors.length] }}>
                  {toPersianNum(list.length)}
                </div>
                <div>
                  <p className="text-xs font-bold text-gray-900">{prov}</p>
                  <p className="text-[11px] text-gray-400">{list.filter((c) => c.status === 'active').length} فعال از {toPersianNum(list.length)}</p>
                </div>
              </div>
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {list.slice(0, 5).map((c) => (
                  <div key={c.id} className="flex items-center gap-1.5 text-[11px] text-gray-600">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.status === 'active' ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="truncate">{c.name}</span>
                  </div>
                ))}
                {list.length > 5 && (
                  <p className="text-[11px] text-gray-300">+ {toPersianNum(list.length - 5)} مرکز دیگر</p>
                )}
              </div>
            </div>
          ))}
        </div>

        <button onClick={onOpenList} className="mt-4 w-full h-9 rounded-lg border border-teal-200 text-teal-700 text-xs font-medium hover:bg-teal-50 transition-colors">
          مشاهدهٔ لیست کامل مراکز
        </button>
      </div>
    </div>
  );
}
