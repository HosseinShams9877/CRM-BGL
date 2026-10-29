'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  MapPin, Phone, Star, Mail, Globe, Edit3, Contact2, Tag, FileText, ExternalLink,
} from 'lucide-react';
import {
  CATEGORY_CFG, Center, GRADE_CFG, STATUS_CFG, formatCurrency, toPersianNum,
} from './types';
import { BusinessBadges } from './business-badges';
import { CenterFiles } from './center-files';
import { CenterEditDialog } from './center-edit-dialog';

// ==================== CENTER DETAIL DIALOG ====================
export function CenterDetailDialog({
  center, open, onClose, onUpdated,
}: {
  center: Center | null;
  open: boolean;
  onClose: () => void;
  /** v2.19.0 — called after a successful edit so the list can reload */
  onUpdated?: () => void;
}) {
  const [showEdit, setShowEdit] = useState(false);
  if (!center) return null;
  const cat = CATEGORY_CFG[center.category];
  const st = STATUS_CFG[center.status];
  const gr = GRADE_CFG[center.grade];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: cat.bg, color: cat.color }}>
              {cat.icon}
            </div>
            <div>
              <DialogTitle className="text-lg">{center.name}</DialogTitle>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full font-medium" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                <div className="flex items-center gap-0.5">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Star key={i} size={11} className={i < gr.stars ? 'fill-amber-400 text-amber-400' : 'text-gray-200'} />
                  ))}
                  <span className="text-[11px] text-gray-500 mr-1">{gr.label}</span>
                </div>
                <BusinessBadges center={center} />
              </div>
              {center.mobile && (
                <p className="text-[11px] text-gray-500 mt-1 flex items-center gap-1" dir="ltr"><Phone size={10} /> {center.mobile}</p>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-5 mt-2">
          {/* Info Grid */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <span className="text-[11px] text-gray-400 flex items-center gap-1"><MapPin size={11} /> آدرس</span>
              <p className="text-sm text-gray-700">{center.address}</p>
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] text-gray-400 flex items-center gap-1"><Phone size={11} /> تلفن</span>
              <p className="text-sm text-gray-700" dir="ltr">{center.phone}</p>
              {center.website && (
                <a href={`https://${center.website}`} target="_blank" className="text-xs text-teal-600 flex items-center gap-1 hover:underline">
                  <Globe size={11} /> {center.website} <ExternalLink size={9} />
                </a>
              )}
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-gray-900">{formatCurrency(center.totalSales)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">فروش کل</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-gray-900">{toPersianNum(center.orderCount)}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">تعداد سفارشات</p>
            </div>
            <div className="bg-gray-50 rounded-xl p-3 text-center">
              <p className="text-lg font-bold text-gray-900">{center.lastOrderDate || '—'}</p>
              <p className="text-[11px] text-gray-400 mt-0.5">آخرین سفارش</p>
            </div>
          </div>

          {/* Contacts */}
          <div>
            <h4 className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2"><Contact2 size={15} className="text-teal-600" /> اشخاص تماس ({toPersianNum(center.contacts.length)})</h4>
            <div className="space-y-2">
              {center.contacts.map((contact) => (
                <div key={contact.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
                    {contact.fullName.charAt(0)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-gray-900">{contact.fullName}</span>
                      {contact.isPrimary && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-teal-100 text-teal-700 font-medium">اصلی</span>}
                    </div>
                    <p className="text-[11px] text-gray-500">{contact.role}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a href={`tel:${contact.mobile}`} className="w-8 h-8 rounded-lg bg-green-50 text-green-600 flex items-center justify-center hover:bg-green-100 transition-colors">
                      <Phone size={14} />
                    </a>
                    <a href={`mailto:${contact.email}`} className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center hover:bg-blue-100 transition-colors">
                      <Mail size={14} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Tags */}
          {center.tags.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2"><Tag size={15} className="text-teal-600" /> برچسب‌ها</h4>
              <div className="flex flex-wrap gap-2">
                {center.tags.map((tag, i) => (
                  <span key={i} className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 font-medium">{tag}</span>
                ))}
              </div>
            </div>
          )}

          {/* Files (v2.19.0 — real /api/files wiring; hidden without upload_files) */}
          <CenterFiles centerId={center.id} />

          {/* Notes */}
          {center.notes && (
            <div>
              <h4 className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2"><FileText size={15} className="text-teal-600" /> یادداشت</h4>
              <p className="text-sm text-gray-600 leading-7 bg-gray-50 rounded-xl p-3">{center.notes}</p>
            </div>
          )}

          {/* Actions — v2.19.0: edit opens the real form, call is a real tel: link;
              the dead planning button was removed */}
          <div className="flex items-center gap-2 pt-2">
            <Button
              onClick={() => setShowEdit(true)}
              className="flex-1 h-10 gap-2 text-white text-sm rounded-xl"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
            >
              <Edit3 size={14} /> ویرایش مرکز
            </Button>
            {center.phone ? (
              <a
                href={`tel:${center.phone}`}
                className="h-10 px-4 inline-flex items-center gap-2 rounded-xl border border-gray-200 text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Phone size={14} /> تماس
              </a>
            ) : (
              <Button variant="outline" disabled className="h-10 gap-2 text-sm rounded-xl">
                <Phone size={14} /> تماس
              </Button>
            )}
          </div>
        </div>

        {/* Edit dialog (real update via /api/centers) */}
        <CenterEditDialog
          center={center}
          open={showEdit}
          onOpenChange={setShowEdit}
          onUpdated={() => {
            setShowEdit(false);
            onUpdated?.();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
