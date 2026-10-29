'use client';

import {
  MapPin, Star, Heart, Eye,
} from 'lucide-react';
import {
  CATEGORY_CFG, Center, GRADE_CFG, STATUS_CFG, formatCurrency, toPersianNum,
} from './types';
import { BusinessBadges } from './business-badges';

// ==================== CENTER TABLE ROW ====================
export function CenterTableRow({ center, onToggleFav, onView }: { center: Center; onToggleFav: (id: string) => void; onView: (c: Center) => void }) {
  const cat = CATEGORY_CFG[center.category];
  const st = STATUS_CFG[center.status];
  const gr = GRADE_CFG[center.grade];
  const primary = center.contacts.find(c => c.isPrimary);

  return (
    <div className="bg-white rounded-xl border border-gray-100 hover:shadow-sm transition-all animate-fade-in-up opacity-0">
      <div className="flex items-center gap-3 p-3 cursor-pointer" onClick={() => onView(center)}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: cat.bg, color: cat.color }}>
          {cat.icon}
        </div>
        <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-12 gap-1 md:gap-3 items-center">
          <div className="md:col-span-3 min-w-0">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-gray-900 truncate">{center.name}</h4>
              <button onClick={(e) => { e.stopPropagation(); onToggleFav(center.id); }} aria-label={center.isFavorite ? `حذف ${center.name} از نشان‌شده‌ها` : `نشان‌کردن ${center.name}`} aria-pressed={center.isFavorite}>
                <Heart size={13} className={center.isFavorite ? 'fill-red-400 text-red-400' : 'text-gray-300'} />
              </button>
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
              <span className="text-[11px] px-1.5 py-0.5 rounded-full" style={{ background: st.bg, color: st.color }}>{st.label}</span>
              <BusinessBadges center={center} compact />
            </div>
          </div>
          <div className="md:col-span-2 hidden md:flex items-center gap-1 text-[11px] text-gray-500">
            <MapPin size={11} /> {center.city}
          </div>
          <div className="md:col-span-2 hidden md:block text-[11px] text-gray-600 truncate">
            {primary ? primary.fullName : '—'}
          </div>
          <div className="md:col-span-2 hidden md:flex items-center gap-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Star key={i} size={10} className={i < gr.stars ? 'fill-amber-400 text-amber-400' : 'text-gray-200'} />
            ))}
          </div>
          <div className="md:col-span-2 text-left">
            <p className="text-xs font-bold text-gray-900">{formatCurrency(center.totalSales)}</p>
            <p className="text-[11px] text-gray-400">{toPersianNum(center.orderCount)} سفارش</p>
          </div>
          <div className="md:col-span-1 hidden md:flex items-center justify-end">
            <Eye size={14} className="text-gray-300" />
          </div>
        </div>
      </div>
    </div>
  );
}
