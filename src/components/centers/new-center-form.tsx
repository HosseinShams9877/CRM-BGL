'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Building2, UserRound,
} from 'lucide-react';
import { SEGMENT_LABELS } from '@/lib/business-model';
import {
  CATEGORY_CFG,
} from './types';

// ==================== NEW CENTER FORM (live) ====================
export function NewCenterForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('other');
  const [city, setCity] = useState('');
  const [province, setProvince] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [mobile, setMobile] = useState('');
  const [website, setWebsite] = useState('');
  const [notes, setNotes] = useState('');
  // مدل کسب‌وکار (v2.6.0)
  const [customerType, setCustomerType] = useState<'organization' | 'end_user'>('organization');
  const [segment, setSegment] = useState('');
  const [paymentBehavior, setPaymentBehavior] = useState('unknown');
  const [commissionPercent, setCommissionPercent] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEndUser = customerType === 'end_user';

  const submit = async () => {
    if (!name.trim()) {
      setError(isEndUser ? 'نام و نام خانوادگی مشتری الزامی است.' : 'نام مرکز الزامی است.');
      return;
    }
    if (isEndUser && mobile.trim() && !/^[۰-۹0-9\s+-]{10,}$/.test(mobile.trim())) {
      setError('شماره موبایل معتبر وارد کنید (حداقل ۱۰ رقم).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // v2.14.0 — customFields (category/website/notes) travels in the SAME
      // create call as a plain object; the server encodes it exactly once.
      // (The old flow sent a pre-stringified payload in a second update
      // request, which the API re-encoded — double JSON — and whose failure
      // was silently swallowed.)
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          name,
          city: city || undefined,
          province: province || undefined,
          address: address || undefined,
          phone: phone || undefined,
          mobile: mobile || undefined,
          customerType,
          segment: isEndUser ? '' : segment,
          paymentBehavior,
          commissionPercent: Number(commissionPercent) || 0,
          customFields: { category, website: website.trim(), notes: notes.trim() },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت');
      toast.success(isEndUser ? 'مشتری نهایی جدید ثبت شد' : 'مرکز جدید ثبت شد');
      setName(''); setCity(''); setProvince(''); setAddress(''); setPhone(''); setMobile(''); setWebsite(''); setNotes('');
      setSegment(''); setPaymentBehavior('unknown'); setCommissionPercent('0');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 mt-2">
      {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
      <div><label className="block text-sm font-medium text-gray-700 mb-1.5">{isEndUser ? 'نام و نام خانوادگی' : 'نام مرکز / سازمان'}</label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isEndUser ? 'مثلاً: خانم رضایی' : 'نام مرکز یا شرکت'} className="h-10 rounded-lg" /></div>

      {/* نوع مشتری: سازمانی / نهایی (BGL + همه) */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">نوع مشتری</label>
        <div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setCustomerType('organization')}
            className={`h-10 rounded-lg border text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${customerType === 'organization' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>
            <Building2 size={14} /> سازمانی (B2B)
          </button>
          <button type="button" onClick={() => setCustomerType('end_user')}
            className={`h-10 rounded-lg border text-xs font-medium transition-colors flex items-center justify-center gap-1.5 ${customerType === 'end_user' ? 'border-violet-300 bg-violet-50 text-violet-700' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}>
            <UserRound size={14} /> مشتری نهایی (B2C)
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5">موبایل {isEndUser && <span className="text-red-500">*</span>}</label><Input value={mobile} onChange={(e) => setMobile(e.target.value)} placeholder="۰۹۱۲..." className="h-10 rounded-lg" dir="ltr" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5">شهر</label><Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="شهر" className="h-10 rounded-lg" /></div>
      </div>

      {/* سگمنت B2B (بازرگانی): دولتی / خصوصی / همکار */}
      {!isEndUser && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">دستهٔ B2B</label>
            <select value={segment} onChange={(e) => setSegment(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
              <option value="">— انتخاب نشده —</option>
              {Object.entries(SEGMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">خوش‌حسابی</label>
            <select value={paymentBehavior} onChange={(e) => setPaymentBehavior(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
              <option value="unknown">نامشخص</option>
              <option value="good_payer">خوش‌حساب</option>
              <option value="bad_payer">بدحساب</option>
            </select>
          </div>
        </div>
      )}

      {/* کمیسیون همکار */}
      {!isEndUser && segment === 'partner' && (
        <div><label className="block text-sm font-medium text-gray-700 mb-1.5">درصد کمیسیون همکار (۰ تا ۱۰۰)</label><Input value={commissionPercent} onChange={(e) => setCommissionPercent(e.target.value)} placeholder="مثلاً ۵" className="h-10 rounded-lg" dir="ltr" inputMode="decimal" /></div>
      )}

      {!isEndUser && (
        <>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5">دسته‌بندی</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-3 text-sm bg-white">
              {Object.entries(CATEGORY_CFG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5">آدرس</label><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="آدرس کامل" className="h-10 rounded-lg" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5">تلفن ثابت</label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="شماره تلفن" className="h-10 rounded-lg" dir="ltr" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5">وبسایت</label><Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" className="h-10 rounded-lg" dir="ltr" /></div>
          </div>
        </>
      )}

      <div><label className="block text-sm font-medium text-gray-700 mb-1.5">توضیحات</label><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="توضیحات اختیاری..." className="rounded-lg resize-none" rows={3} /></div>
      <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
        {busy ? 'در حال ثبت...' : isEndUser ? 'ثبت مشتری نهایی' : 'ثبت مرکز'}
      </Button>
    </div>
  );
}
