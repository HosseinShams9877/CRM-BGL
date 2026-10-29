'use client';

import {
  Gift,
} from 'lucide-react';
import {
  BEHAVIOR_BADGE, Center, SEGMENT_BADGE, TYPE_BADGE, toPersianNum,
} from './types';

export function BusinessBadges({ center, compact = false }: { center: Center; compact?: boolean }) {
  const type = TYPE_BADGE[center.customerType] || TYPE_BADGE.organization;
  const seg = center.segment ? SEGMENT_BADGE[center.segment] : null;
  const beh = center.paymentBehavior && center.paymentBehavior !== 'unknown' ? BEHAVIOR_BADGE[center.paymentBehavior] : null;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: type.bg, color: type.color }}>{type.label}</span>
      {seg && <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: seg.bg, color: seg.color }}>{seg.label}</span>}
      {beh && <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: beh.bg, color: beh.color }}>{beh.label}</span>}
      {!compact && center.loyaltyPoints > 0 && (
        <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-0.5" style={{ background: '#fffbeb', color: '#b45309' }}>
          <Gift size={9} /> {toPersianNum(center.loyaltyPoints)} امتیاز
        </span>
      )}
    </span>
  );
}
