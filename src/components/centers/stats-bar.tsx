'use client';

import {
  Building2, Star, Heart, Check, TrendingUp,
} from 'lucide-react';
import {
  Center, formatCurrency, toPersianNum,
} from './types';

// ==================== STATS BAR ====================
export function CentersStats({ centers }: { centers: Center[] }) {
  const active = centers.filter(c => c.status === 'active').length;
  const prospects = centers.filter(c => c.status === 'prospect').length;
  const totalSales = centers.reduce((s, c) => s + c.totalSales, 0);
  const avgSales = centers.filter(c => c.totalSales > 0).length > 0 ? totalSales / centers.filter(c => c.totalSales > 0).length : 0;
  const favs = centers.filter(c => c.isFavorite).length;

  const stats = [
    { label: 'کل مراکز', value: toPersianNum(centers.length), icon: <Building2 size={16} />, color: '#2E2A5C', bg: '#eef2ff' },
    { label: 'فعال', value: toPersianNum(active), icon: <Check size={16} />, color: '#059669', bg: '#ecfdf5' },
    { label: 'سرنخ‌ها', value: toPersianNum(prospects), icon: <Star size={16} />, color: '#6366f1', bg: '#eef2ff' },
    { label: 'فروش کل', value: formatCurrency(totalSales), icon: <TrendingUp size={16} />, color: '#1F8B7D', bg: '#ecfdf5' },
    { label: 'میانگین فروش', value: formatCurrency(avgSales), icon: <TrendingUp size={16} />, color: '#d97706', bg: '#fffbeb' },
    { label: 'مورد علاقه', value: toPersianNum(favs), icon: <Heart size={16} />, color: '#dc2626', bg: '#fef2f2' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
      {stats.map((s, i) => (
        <div key={i} className="bg-white rounded-xl p-3.5 border border-gray-100 animate-fade-in-up opacity-0" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: s.bg, color: s.color }}>{s.icon}</div>
            <span className="text-[11px] text-gray-400 hidden lg:block">{s.label}</span>
          </div>
          <p className="text-lg lg:text-xl font-bold" style={{ color: s.color }}>{s.value}</p>
          <p className="text-[11px] text-gray-400 lg:hidden mt-0.5">{s.label}</p>
        </div>
      ))}
    </div>
  );
}
