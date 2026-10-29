'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  MapPin, Phone, User as UserIcon, Star, Heart, Eye, Edit3, Clock, Target,
} from 'lucide-react';
import {
  CATEGORY_CFG, Center, GRADE_CFG, STATUS_CFG, formatCurrency, toPersianNum,
} from './types';
import { BusinessBadges } from './business-badges';
import { CenterEditDialog } from './center-edit-dialog';

// ==================== CENTER CARD (Grid View) ====================
// ==================== PERIODIC FOLLOWUP SETUP (on center card) ====================
export const FREQUENCY_OPTIONS = [
  { key: 'weekly', label: 'هفتگی یک‌بار', days: 7 },
  { key: 'biweekly', label: 'دوهفته‌یک‌بار', days: 14 },
  { key: 'monthly', label: 'ماهی یک‌بار', days: 30 },
  { key: 'bimonthly', label: 'دوماهه‌یک‌بار', days: 60 },
];

export function FollowupSetupDialog({ center, open, onOpenChange }: {
  center: Center | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [frequency, setFrequency] = useState('monthly');
  const [personName, setPersonName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Official React "reset state on prop change" pattern (render-phase adjust).
  const [prevOpenKey, setPrevOpenKey] = useState(`${open}:${center?.id}`);
  const currentKey = `${open}:${center?.id}`;
  if (currentKey !== prevOpenKey) {
    setPrevOpenKey(currentKey);
    if (open && center) {
      setFrequency('monthly');
      setPersonName('');
      setPhone(center.phone !== '—' ? center.phone : '');
      setError(null);
    }
  }

  const submit = async () => {
    if (!center) return;
    if (!personName.trim()) { setError('نام شخص مسئول برای تماس الزامی است.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Resolve the current company id (centers are company-scoped via the list we loaded)
      const res = await fetch('/api/followups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: center.followupCompanyId,
          centerId: center.id,
          centerName: center.name,
          city: center.city !== '—' ? center.city : undefined,
          personName: personName.trim(),
          phone: phone || undefined,
          frequency,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت پیگیری دوره‌ای');
      toast.success(`پیگیری دوره‌ای برای «${center.name}» فعال شد`);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت پیگیری دوره‌ای');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
        <DialogHeader><DialogTitle>پیگیری دوره‌ای — {center?.name || ''}</DialogTitle></DialogHeader>
        <div className="space-y-4 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}

          <div className="bg-teal-50/60 border border-teal-100 rounded-xl p-3 text-[11px] text-teal-800 leading-relaxed">
            با فعال‌سازی پیگیری دوره‌ای، این مرکز در صفحهٔ «پیگیری دوره‌ای» ظاهر می‌شود و
            با رسیدن موعد، یادآوری برای تماس دریافت می‌کنید.
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">دورهٔ تماس *</label>
            <div className="grid grid-cols-2 gap-2">
              {FREQUENCY_OPTIONS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  onClick={() => setFrequency(f.key)}
                  className={`h-10 rounded-xl border text-xs font-bold transition-all ${
                    frequency === f.key ? 'border-teal-400 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">شخص مسئول *</label>
              <Input value={personName} onChange={(e) => setPersonName(e.target.value)} placeholder="نام فرد مورد تماس" className="h-10 rounded-lg" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">شماره تماس</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="۰۹۱۲..." className="h-10 rounded-lg" dir="ltr" />
            </div>
          </div>

          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ثبت...' : 'فعال‌سازی پیگیری دوره‌ای'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function CenterCard({ center, onToggleFav, onView, onEdited }: { center: Center; onToggleFav: (id: string) => void; onView: (c: Center) => void; /** v2.19.0 — reload callback after a successful edit */ onEdited?: () => void }) {
  const cat = CATEGORY_CFG[center.category];
  const st = STATUS_CFG[center.status];
  const gr = GRADE_CFG[center.grade];
  const primary = center.contacts.find(c => c.isPrimary);
  const [showFollowupSetup, setShowFollowupSetup] = useState(false);
  const [showEdit, setShowEdit] = useState(false); // v2.19.0 — card-level edit dialog

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden hover:shadow-lg transition-all duration-300 animate-fade-in-up opacity-0 group">
      {/* Header with category color bar */}
      <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${cat.color}, ${cat.color}88)` }} />
      <div className="p-4">
        {/* Top row: name + fav */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: cat.bg, color: cat.color }}>
              {cat.icon}
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-bold text-gray-900 truncate">{center.name}</h3>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: cat.bg, color: cat.color }}>{cat.label}</span>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: st.bg, color: st.color }}>{st.label}</span>
                <BusinessBadges center={center} compact />
              </div>
            </div>
          </div>
          <button
            onClick={() => onToggleFav(center.id)}
            aria-label={center.isFavorite ? `حذف ${center.name} از نشان‌شده‌ها` : `نشان‌کردن ${center.name}`}
            aria-pressed={center.isFavorite}
            className="p-1.5 rounded-lg hover:bg-gray-50 transition-colors shrink-0"
          >
            <Heart size={16} className={center.isFavorite ? 'fill-red-400 text-red-400' : 'text-gray-300'} />
          </button>
        </div>

        {/* Grade stars */}
        <div className="flex items-center gap-1 mb-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Star key={i} size={12} className={i < gr.stars ? 'fill-amber-400 text-amber-400' : 'text-gray-200'} />
          ))}
          <span className="text-[11px] text-gray-400 mr-1">{gr.label}</span>
        </div>

        {/* Location */}
        <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-2">
          <MapPin size={12} className="shrink-0" />
          <span className="truncate">{center.city}، {center.province}</span>
        </div>

        {/* Primary contact */}
        {primary && (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-3">
            <UserIcon size={12} className="shrink-0" />
            <span className="truncate">{primary.fullName} — {primary.role}</span>
          </div>
        )}

        {/* Sales info */}
        <div className="flex items-center justify-between pt-3 border-t border-gray-50">
          <div>
            <p className="text-xs font-bold text-gray-900">{formatCurrency(center.totalSales)}</p>
            <p className="text-[11px] text-gray-400">{toPersianNum(center.orderCount)} سفارش</p>
          </div>
          <div className="flex items-center gap-1">
            {center.lastFollowup && (
              <span className="text-[11px] text-gray-400 flex items-center gap-1"><Clock size={9} /> {center.lastFollowup}</span>
            )}
          </div>
        </div>

        {/* Tags */}
        {center.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-3">
            {center.tags.slice(0, 3).map((tag, i) => (
              <span key={i} className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{tag}</span>
            ))}
            {center.tags.length > 3 && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400">+{toPersianNum(center.tags.length - 3)}</span>}
          </div>
        )}

        {/* Actions — v2.19.0: edit opens the real form, call is a real tel: link;
            the dead «ارسال پیام» button (no messaging backend) was removed */}
        <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-50 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          {/* v2.34.8 — opens the center's DEDICATED dossier page (پروندهٔ مرکز) */}
          <Button size="sm" variant="outline" className="h-9 gap-1 text-[11px] rounded-lg flex-1" onClick={() => onView(center)}>
            <Eye size={11} /> پرونده
          </Button>
          <Button size="sm" variant="outline" className="h-9 gap-1 text-[11px] rounded-lg flex-1" onClick={() => setShowEdit(true)}>
            <Edit3 size={11} /> ویرایش
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowFollowupSetup(true)}
            className="h-7 gap-1 text-[11px] rounded-lg flex-1 text-teal-700 hover:text-teal-800 hover:bg-teal-50 border-teal-200">
            <Target size={11} /> پیگیری دوره‌ای
          </Button>
          {center.phone ? (
            <a
              href={`tel:${center.phone}`}
              aria-label={`تماس با ${center.name}`}
              className="h-7 w-7 p-0 rounded-lg text-green-600 hover:text-green-700 hover:bg-green-50 border border-gray-200 inline-flex items-center justify-center"
            >
              <Phone size={11} />
            </a>
          ) : (
            <Button size="sm" variant="outline" disabled aria-label={`تماس با ${center.name}`} className="h-7 w-7 p-0 rounded-lg text-green-600 hover:text-green-700 hover:bg-green-50">
              <Phone size={11} />
            </Button>
          )}
        </div>
      </div>
      <FollowupSetupDialog center={center} open={showFollowupSetup} onOpenChange={setShowFollowupSetup} />
      {/* v2.19.0 — real edit dialog from the card's «ویرایش» button */}
      <CenterEditDialog
        center={center}
        open={showEdit}
        onOpenChange={setShowEdit}
        onUpdated={() => { setShowEdit(false); onEdited?.(); }}
      />
    </div>
  );
}
