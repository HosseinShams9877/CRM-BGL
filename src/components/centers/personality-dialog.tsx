'use client';

import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Plus, MessageCircle, Trash2, FileText, Brain, Sparkles, AlertTriangle, Handshake,
} from 'lucide-react';
import {
  CenterContact,
} from './types';

// ==================== رگ خواب — PERSONALITY PROFILE (v2.6.0) ====================
// پروفایل شخصیتی افراد رابط: ویژگی‌ها، سبک ارتباط، علایق، حساسیت‌ها + تاریخچهٔ مشاهدات

export const PROFILE_CATEGORY_CFG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  trait: { label: 'ویژگی شخصیتی', color: '#7c3aed', bg: '#f5f3ff', icon: <Brain size={12} /> },
  interest: { label: 'علایق', color: '#059669', bg: '#ecfdf5', icon: <Sparkles size={12} /> },
  sensitivity: { label: 'حساسیت‌ها', color: '#dc2626', bg: '#fef2f2', icon: <AlertTriangle size={12} /> },
  communication: { label: 'سبک ارتباط', color: '#0e7490', bg: '#ecfeff', icon: <MessageCircle size={12} /> },
  general: { label: 'عمومی', color: '#6b7280', bg: '#f3f4f6', icon: <FileText size={12} /> },
};

export interface ProfileNote {
  id: string;
  contactId: string;
  category: string;
  content: string;
  createdByName: string | null;
  createdAt: string;
}

export function PersonalityDialog({ contact, open, onOpenChange }: {
  contact: (CenterContact & { centerName?: string }) | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [notes, setNotes] = useState<ProfileNote[]>([]);
  // starts true; re-armed on dialog close (see handleOpenChange) so the next
  // open shows the spinner without a synchronous setState in the effect
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState('trait');
  const [newContent, setNewContent] = useState('');
  const [busy, setBusy] = useState(false);

  const contactId = contact?.contactId || contact?.id;

  useEffect(() => {
    if (!open || !contactId) return;
    fetch('/api/centers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'profile-notes', contactId }),
    })
      .then((r) => r.json())
      .then((data) => setNotes(Array.isArray(data.data) ? data.data : []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  }, [open, contactId]);

  const handleOpenChange = (o: boolean) => {
    if (!o) setLoading(true); // re-arm spinner for the next open
    onOpenChange(o);
  };

  const addNote = async () => {
    if (!contactId || !newContent.trim()) return;
    setBusy(true);
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add-profile-note', contactId, category: newCategory, content: newContent }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در ثبت');
      setNotes((prev) => [data.data, ...prev]);
      setNewContent('');
      toast.success('مشاهدهٔ جدید در رگ خواب ثبت شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در ثبت');
    } finally {
      setBusy(false);
    }
  };

  const removeNote = async (noteId: string) => {
    try {
      const res = await fetch('/api/centers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove-profile-note', noteId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'خطا در حذف');
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success('یادداشت حذف شد');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'خطا در حذف');
    }
  };

  if (!contact) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[min(42rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
              <Brain size={22} />
            </div>
            <div>
              <DialogTitle className="text-lg flex items-center gap-2">
                رگ خواب — {contact.fullName}
                {contact.isAgent && (
                  <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700 inline-flex items-center gap-1">
                    <Handshake size={10} /> رابط شرکت
                  </span>
                )}
              </DialogTitle>
              <p className="text-xs text-gray-400 mt-0.5">
                ویژگی‌های شخصیتی، سبک ارتباط و نکات مهم دربارهٔ {contact.fullName}
                {contact.centerName ? ` — ${contact.centerName}` : ''}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* Add new observation */}
          <div className="bg-violet-50/50 border border-violet-100 rounded-xl p-3 space-y-2">
            <div className="flex items-center gap-2">
              <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                className="h-9 rounded-lg border border-gray-200 px-2 text-xs bg-white text-gray-700 min-w-[130px]">
                {Object.entries(PROFILE_CATEGORY_CFG).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
              <Input value={newContent} onChange={(e) => setNewContent(e.target.value)}
                placeholder="مثلاً: به معرفی محصول جدید علاقه نشان داد؛ تماس صبح‌ها مناسب‌تر است..."
                className="flex-1 h-9 rounded-lg text-xs border-gray-200" />
              <Button onClick={addNote} disabled={busy || !newContent.trim()} size="sm"
                className="h-9 gap-1 text-white text-xs rounded-lg px-3 shrink-0" style={{ background: 'linear-gradient(135deg, #7c3aed, #4A235A)' }}>
                <Plus size={12} /> ثبت مشاهده
              </Button>
            </div>
            <p className="text-[11px] text-gray-400">
              هر مشاهده با نام ثبت‌کننده و تاریخ ثبت می‌شود — «رگ خواب» یعنی شناخت عمیق فرد برای ارتباط مؤثرتر.
            </p>
          </div>

          {/* Notes timeline */}
          {loading ? (
            <div className="py-8 text-center text-xs text-gray-400">در حال بارگذاری...</div>
          ) : notes.length === 0 ? (
            <div className="py-10 text-center text-gray-400">
              <Brain size={36} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">هنوز مشاهده‌ای ثبت نشده است</p>
              <p className="text-[11px] mt-1">اولین نکتهٔ شخصیتی دربارهٔ {contact.fullName} را بالا ثبت کنید</p>
            </div>
          ) : (
            <div className="space-y-2">
              {notes.map((note) => {
                const cfg = PROFILE_CATEGORY_CFG[note.category] || PROFILE_CATEGORY_CFG.general;
                return (
                  <div key={note.id} className="bg-white border border-gray-100 rounded-xl p-3 flex items-start gap-3 group/note">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: cfg.bg, color: cfg.color }}>
                      {cfg.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="text-[11px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                        <span className="text-[11px] text-gray-400">{note.createdByName || '—'} · {new Date(note.createdAt).toLocaleDateString('fa-IR')}</span>
                      </div>
                      <p className="text-xs text-gray-700 leading-6">{note.content}</p>
                    </div>
                    <button onClick={() => removeNote(note.id)}
                      className="opacity-100 md:opacity-0 md:group-hover/note:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 shrink-0">
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
