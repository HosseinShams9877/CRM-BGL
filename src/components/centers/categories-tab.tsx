'use client';

import React, { useState } from 'react';
import {
  LayoutGrid,
} from 'lucide-react';
import {
  CATEGORY_CFG, Category, Center, CenterCategory, STATUS_CFG, formatCurrency, toPersianNum,
} from './types';

// ==================== CATEGORIES TAB ====================
export function CategoriesTab({ centers }: { centers: Center[] }) {
  const cats: Category[] = (Object.keys(CATEGORY_CFG) as CenterCategory[]).map(key => {
    const cfg = CATEGORY_CFG[key];
    const items = centers.filter(c => c.category === key);
    return {
      id: key,
      key,
      name: cfg.label,
      icon: cfg.icon,
      color: cfg.color,
      bg: cfg.bg,
      count: items.length,
      totalSales: items.reduce((s, c) => s + c.totalSales, 0),
    };
  });

  const [selectedCat, setSelectedCat] = useState<CenterCategory | 'all'>('all');

  const filtered = selectedCat === 'all' ? centers : centers.filter(c => c.category === selectedCat);

  return (
    <div className="space-y-4">
      {/* Category Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
        <button
          onClick={() => setSelectedCat('all')}
          className={`p-4 rounded-xl border-2 transition-all text-center ${selectedCat === 'all' ? 'border-teal-500 bg-teal-50 shadow-sm' : 'border-gray-100 bg-white hover:border-gray-200'}`}
        >
          <div className="w-10 h-10 rounded-xl mx-auto mb-2 flex items-center justify-center" style={{ background: '#eef2ff', color: '#2E2A5C' }}>
            <LayoutGrid size={18} />
          </div>
          <p className="text-xs font-bold text-gray-900">همه</p>
          <p className="text-[11px] text-gray-400">{toPersianNum(centers.length)} مرکز</p>
        </button>
        {cats.map(cat => (
          <button
            key={cat.key}
            onClick={() => setSelectedCat(cat.key)}
            className={`p-4 rounded-xl border-2 transition-all text-center ${selectedCat === cat.key ? 'shadow-sm' : 'border-gray-100 bg-white hover:border-gray-200'}`}
            style={selectedCat === cat.key ? { borderColor: cat.color, background: cat.bg } : undefined}
          >
            <div className="w-10 h-10 rounded-xl mx-auto mb-2 flex items-center justify-center" style={{ background: cat.bg, color: cat.color }}>
              {cat.icon}
            </div>
            <p className="text-xs font-bold text-gray-900">{cat.name}</p>
            <p className="text-[11px] text-gray-400">{toPersianNum(cat.count)} مرکز</p>
            <p className="text-[11px] font-bold mt-1" style={{ color: cat.color }}>{formatCurrency(cat.totalSales)}</p>
          </button>
        ))}
      </div>

      {/* Filtered list (compact) */}
      <div className="space-y-2">
        {filtered.map(center => {
          const cat = CATEGORY_CFG[center.category];
          const st = STATUS_CFG[center.status];
          return (
            <div key={center.id} className="bg-white rounded-xl border border-gray-100 p-3 flex items-center gap-3 hover:shadow-sm transition-all">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: cat.bg, color: cat.color }}>{cat.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-gray-900 truncate">{center.name}</h4>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                </div>
                <p className="text-[11px] text-gray-400">{center.city} · {toPersianNum(center.orderCount)} سفارش</p>
              </div>
              <p className="text-xs font-bold text-gray-900 shrink-0">{formatCurrency(center.totalSales)}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
