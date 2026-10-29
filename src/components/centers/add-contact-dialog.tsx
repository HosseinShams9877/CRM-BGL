'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Contact2, Handshake,
} from 'lucide-react';
import {
  Center,
} from './types';

export function AddContactDialog({ centers, open, onOpenChange, onDone }: {
  centers: Center[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [centerId, setCenterId] = useState('');
  const [person, setPerson] = useState('');
  const [title, setTitle] = useState('');
  const [phone, setPhone] = useState('');
  const [isAgent, setIsAgent] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Official React "reset state on prop change" pattern: adjust during render
  // instead of inside an effect (avoids cascading renders).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setCenterId(''); setPerson(''); setTitle(''); setPhone(''); setIsAgent(false); setNotes(''); setError(null);
    }
  }

  const submit = async () => {
    if (!centerId) { setError('مرکز/مشتری مربوطه را انتخاب کنید.'); return; }
    if (!person.trim()) { setError('نام شخص الزامی است.'); return; }
    if (!title.trim()) { setError('عنوان سمت الزامی است (مثلاً: رابط فروش، مدیر خرید).'); return; }
    if (phone.trim().replace(/[^۰-۹0-9]/g, '').length < 8) { setError('شماره تماس معتبر وارد کنید.'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-contact', centerId, person, title, phone, notes, isAgent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت شخص');
      toast.success(isAgent ? 'رابط جدید ثبت شد' : 'شخص جدید ثبت شد');
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'خطا در ثبت');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[min(28rem,calc(100vw-2rem))]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Contact2 size={18} className="text-teal-600" /> افزودن شخص / رابط جدید
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3.5 mt-2">
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">مرکز / مشتری مربوطه <span className="text-red-500">*</span></label>
            <select value={centerId} onChange={(e) => setCenterId(e.target.value)} className="w-full h-10 rounded-lg border border-gray-200 px-2 text-sm bg-white">
              <option value="">— انتخاب —</option>
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5">نام شخص <span className="text-red-500">*</span></label><Input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="نام و نام خانوادگی" className="h-10 rounded-lg" /></div>
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5">عنوان سمت <span className="text-red-500">*</span></label><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً: رابط فروش" className="h-10 rounded-lg" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3 items-end">
            <div><label className="block text-sm font-medium text-gray-700 mb-1.5">شماره تماس <span className="text-red-500">*</span></label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="۰۹۱۲..." className="h-10 rounded-lg" dir="ltr" /></div>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none h-10 pb-2">
              <input type="checkbox" checked={isAgent} onChange={(e) => setIsAgent(e.target.checked)} className="accent-amber-600 w-4 h-4" />
              <Handshake size={14} className="text-amber-600" /> رابط شرکت است
            </label>
          </div>
          <div><label className="block text-sm font-medium text-gray-700 mb-1.5">توضیح (اختیاری)</label><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="یادداشت کوتاه..." className="h-10 rounded-lg" /></div>
          <Button onClick={submit} disabled={busy} className="w-full h-10 rounded-lg text-white font-semibold" style={{ background: 'linear-gradient(135deg, #1F8B7D, #2E2A5C)' }}>
            {busy ? 'در حال ثبت...' : 'ثبت شخص'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
