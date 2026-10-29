'use client';

import { useEffect, useState, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Edit3, Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import type { Center } from './types';

// ==================== CENTER EDIT DIALOG (v2.19.0) ====================
// The detail dialog's «ویرایش مرکز» button was dead — no edit form existed
// anywhere. This dialog wires it to the real /api/centers update action
// (edit_centers permission enforced server-side, 403 shown as Persian error).
// v2.23.0 — sends the optimistic-concurrency token (v2.27.1: the exact
// numeric CAS `expectedVersion`; the old updatedAt fallback is gone): if
// another user saved the center in the meantime, the server answers 409
// and the user is offered a reload of the latest version instead of overwriting.

interface Props {
  center: Center | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
}

export function CenterEditDialog({ center, open, onOpenChange, onUpdated }: Props) {
  // v2.31.9 — nationalId/economicCode/postalCode/contactName join the form:
  // the buyer identity block (مشخصات خریدار) that pre-fills the Lian
  // proforma format's data-entry form.
  const [form, setForm] = useState({ name: '', province: '', city: '', address: '', phone: '', mobile: '', tags: '', nationalId: '', economicCode: '', postalCode: '', contactName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v2.23.0 — 409 conflict banner state (reload offered, no silent overwrite)
  const [conflict, setConflict] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // v2.23.0 — the concurrency token: captured when the dialog opens for a
  // given center, and refreshed by reloadLatest() after a 409. The
  // lastSyncedId guard keeps the effect from clobbering the fresh token
  // with the stale prop when reloadKey bumps (the prop object never changes).
  const latestRef = useRef<string | null>(null); // display/debug copy of updatedAt
  // v2.25.0 — numeric CAS token (exact compare on the server).
  const versionRef = useRef<number | null>(null);
  const lastSyncedId = useRef<string | null>(null);
  // reloadLatest() already wrote the fresh form values + token directly;
  // this flag stops the reloadKey-triggered effect run from resetting the
  // form back to the stale `center` prop.
  const justReloadedRef = useRef(false);

  useEffect(() => {
    if (!open || !center) return;
    if (justReloadedRef.current) {
      justReloadedRef.current = false;
      return; // reloadLatest() owns the form + token on this run
    }
    if (lastSyncedId.current !== center.id) {
      lastSyncedId.current = center.id;
      latestRef.current = center.updatedAt || null;
      versionRef.current = typeof center.version === 'number' ? center.version : null;
    }
    // Deferred via microtask — keeps the synchronous setState out of the
    // effect body (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      setForm({
        name: center.name || '',
        province: center.province || '',
        city: center.city || '',
        address: center.address || '',
        phone: center.phone || '',
        mobile: center.mobile || '',
        tags: (center.tags || []).join('، '),
        nationalId: center.nationalId || '',
        economicCode: center.economicCode || '',
        postalCode: center.postalCode || '',
        contactName: center.contactName || '',
      });
      setError(null);
      setConflict(false);
    });
  }, [open, center, reloadKey]);

  const reloadLatest = async () => {
    // 409 recovery — re-fetch the server's current row so the form (and
    // the expectedVersion token) start from the latest version.
    if (!center) return;
    setBusy(true);
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get', id: center.id }),
      });
      const data = await res.json();
      // v2.24.0 — the centers `get` action answers { data: center }; the
      // old code read `data.center`, which is ALWAYS undefined → the 409
      // recovery button threw «بارگذاری مجدد ناموفق بود» on every click.
      // Dead recovery path since v2.23.0, caught by the first browser
      // scene that ever exercised this dialog's conflict flow.
      const fresh = data.data || data.center;
      if (!res.ok || !fresh) throw new Error(data.error || 'مرکز یافت نشد.');
      queueMicrotask(() => {
        setForm({
          name: fresh.name || '',
          province: fresh.province || '',
          city: fresh.city || '',
          address: fresh.address || '',
          phone: fresh.phone || '',
          mobile: fresh.mobile || '',
          tags: (() => { try { return JSON.parse(fresh.tags || '[]'); } catch { return []; } })().join('، '),
          nationalId: fresh.nationalId || '',
          economicCode: fresh.economicCode || '',
          postalCode: fresh.postalCode || '',
          contactName: fresh.contactName || '',
        });
        setError(null);
        setConflict(false);
      });
      // Bump so the effect re-runs — but the fresh form values and token
      // were written directly above and must NOT be clobbered.
      justReloadedRef.current = true;
      latestRef.current = fresh.updatedAt || null;
      versionRef.current = typeof fresh.version === 'number' ? fresh.version : null;
      setReloadKey((k) => k + 1);
      toast.success('آخرین نسخهٔ مرکز بارگذاری شد');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'بارگذاری مجدد ناموفق بود.');
    } finally {
      setBusy(false);
    }
  };

  if (!center) return null;

  const submit = async () => {
    if (!form.name.trim()) { setError('نام مرکز الزامی است.'); return; }
    setBusy(true);
    setError(null);
    try {
      const tags = form.tags.split(/[،,]/).map((t) => t.trim()).filter(Boolean);
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'update',
          id: center.id,
          name: form.name.trim(),
          province: form.province.trim() || null,
          city: form.city.trim() || null,
          address: form.address.trim() || null,
          phone: form.phone.trim() || null,
          mobile: form.mobile.trim() || null,
          nationalId: form.nationalId.trim() || null,
          economicCode: form.economicCode.trim() || null,
          postalCode: form.postalCode.trim() || null,
          contactName: form.contactName.trim() || null,
          tags,
          expectedVersion: versionRef.current ?? undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          // Optimistic-concurrency conflict — offer a reload of the server
          // state instead of overwriting the other user's changes.
          setConflict(true);
          setError(data.error || 'مرکز هم‌زمان توسط کاربر دیگری ویرایش شده است.');
        } else {
          setError(data.error || 'ویرایش مرکز ناموفق بود.');
        }
        return;
      }
      toast.success('مرکز به‌روزرسانی شد');
      onOpenChange(false);
      onUpdated();
    } catch {
      setError('ویرایش مرکز ناموفق بود.');
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, key: keyof typeof form, placeholder?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1.5">{label}</label>
      <Input
        value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder || label.replace(' *', '')}
        aria-label={label}
        className="h-10 rounded-xl border-gray-200 text-sm"
      />
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(32rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Edit3 size={16} className="text-teal-600" /> ویرایش مرکز: {center.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3">
            {field('نام مرکز *', 'name')}
            {field('استان', 'province')}
            {field('شهر', 'city')}
            {field('تلفن', 'phone', '021-...')}
            {field('موبایل', 'mobile', '0912-...')}
          </div>
          {field('آدرس', 'address')}
          {/* v2.31.9 — buyer identity block (Lian proforma format) */}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-[11px] font-bold text-gray-500 mb-2">مشخصات شناسنامه‌ای (برای پیش‌فاکتور و فاکتور)</p>
            <div className="grid grid-cols-2 gap-3">
              {field('شناسه ملی / کد ملی', 'nationalId')}
              {field('کد اقتصادی', 'economicCode')}
              {field('کد پستی', 'postalCode')}
              {field('کارشناس خرید (رابط)', 'contactName')}
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1.5">برچسب‌ها (با «،» جدا کنید)</label>
            <Input
              value={form.tags}
              onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
              placeholder="VIP، تخفیف‌دار"
              className="h-10 rounded-xl border-gray-200 text-sm"
            />
          </div>

          {conflict && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="font-bold">تغییر همزمان شناسایی شد</p>
              <p>{error}</p>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 text-xs rounded-lg border-amber-300 text-amber-800 hover:bg-amber-100"
                disabled={busy}
                onClick={() => { void reloadLatest(); }}
              >
                <Undo2 size={12} /> بارگذاری آخرین نسخه مرکز
              </Button>
              <p className="text-[11px] text-amber-700">با بارگذاری مجدد، آخرین تغییرات ذخیره‌شدهٔ مرکز جایگزین فرم فعلی می‌شود.</p>
            </div>
          )}
          {!conflict && error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2.5">خطا: {error}</p>}

          <div className="flex gap-2 pt-1">
            <Button
              onClick={submit}
              disabled={busy}
              className="flex-1 h-10 gap-2 text-white text-sm rounded-xl"
              style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Edit3 size={14} />}
              ذخیره تغییرات
            </Button>
            <Button variant="outline" onClick={() => onOpenChange(false)} className="h-10 text-sm rounded-xl">
              انصراف
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
