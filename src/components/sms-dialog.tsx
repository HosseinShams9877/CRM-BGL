'use client';

// ════════════════════════════════════════════════════════════
// SMS SEND DIALOG — v2.43.0 shared by:
//   • sales-collections (payment reminder per invoice row)
//   • followups module (customer reminder per overdue followup)
//   • SMS settings (admin test send)
//
// The dialog validates locally (phone format, length), sends via
// POST /api/sms action=send and shows the real server verdict —
// including the provider-side failure reasons (never silent).
// ════════════════════════════════════════════════════════════

import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { MessageCircle, Loader2, Send, CheckCircle2, XCircle } from 'lucide-react';
import { toast } from 'sonner';

export interface SmsDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** pre-filled phone (editable — the contact record may be stale) */
  presetPhone?: string | null;
  /** pre-filled message body (editable) */
  presetText?: string;
  /** audit context: 'collection' | 'followup' | 'manual' */
  contextType?: string;
  /** center name for the log row */
  centerName?: string | null;
  /** label under the title, e.g. «فاکتور INV-... — بیمارستان ...» */
  contextLabel?: string;
  onSent?: () => void;
}

const MAX_CHARS = 459;

function toPersianNum(n: number | string): string {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

export default function SmsDialog({
  open, onOpenChange, presetPhone, presetText, contextType, centerName, contextLabel, onSent,
}: SmsDialogProps) {
  const [phone, setPhone] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // v2.34.6 dialog pattern — reset state asynchronously on open
  // (no sync setState inside the effect body).
  useEffect(() => {
    if (open) {
      queueMicrotask(() => {
        setPhone(presetPhone || '');
        setText(presetText || '');
        setResult(null);
      });
    }
  }, [open, presetPhone, presetText]);

  const send = async () => {
    const p = phone.trim();
    if (!p) {
      setResult({ ok: false, msg: 'شمارهٔ موبایل را وارد کنید' });
      return;
    }
    if (!/^(\+98|0098|98|0)?9[0-9]{9}$/.test(p.replace(/[\s\-()]/g, ''))) {
      setResult({ ok: false, msg: 'شمارهٔ موبایل معتبر نیست (فرمت: 09xxxxxxxxx)' });
      return;
    }
    if (!text.trim()) {
      setResult({ ok: false, msg: 'متن پیامک خالی است' });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          to: p,
          text: text.trim(),
          contextType: contextType || 'manual',
          centerName: centerName || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // real provider verdicts arrive here (e.g. «کلید API نامعتبر است»)
        setResult({ ok: false, msg: data.error || `ارسال ناموفق بود (${res.status})` });
        return;
      }
      setResult({ ok: true, msg: 'پیامک با موفقیت ارسال شد' });
      toast.success('پیامک ارسال شد');
      onSent?.();
      onOpenChange(false);
    } catch (e: unknown) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : 'خطای شبکه' });
    } finally {
      setBusy(false);
    }
  };

  const remaining = MAX_CHARS - text.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MessageCircle size={16} className="text-indigo-600" /> ارسال پیامک
          </DialogTitle>
          {contextLabel && <p className="text-[11px] text-gray-400 mt-1">{contextLabel}</p>}
        </DialogHeader>
        <div className="space-y-3 mt-1">
          {result && (
            <div className={`flex items-center gap-2 rounded-lg p-2.5 text-xs ${result.ok ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' : 'bg-red-50 text-red-700 border border-red-100'}`}>
              {result.ok ? <CheckCircle2 size={14} className="shrink-0" /> : <XCircle size={14} className="shrink-0" />}
              <span>{result.msg}</span>
            </div>
          )}
          <div>
            <label htmlFor="smsdialog-phone" className="block text-xs font-medium text-gray-600 mb-1">شمارهٔ موبایل گیرنده</label>
            <Input
              id="smsdialog-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="09xxxxxxxxx"
              dir="ltr"
              className="h-10 rounded-lg text-left"
              disabled={busy}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="smsdialog-text" className="block text-xs font-medium text-gray-600">متن پیامک</label>
              <span className={`text-[10px] ${remaining < 40 ? 'text-amber-600' : 'text-gray-400'}`}>
                {toPersianNum(text.length)} / {toPersianNum(MAX_CHARS)} نویسه
              </span>
            </div>
            <Textarea
              id="smsdialog-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
              rows={5}
              className="rounded-lg resize-none text-xs leading-6"
              disabled={busy}
            />
          </div>
          <Button
            onClick={send}
            disabled={busy}
            className="w-full h-10 rounded-lg text-white text-xs font-bold gap-2"
            style={{ background: 'linear-gradient(135deg, #6366f1, #4f46e5)' }}
          >
            {busy ? <><Loader2 size={14} className="animate-spin" /> در حال ارسال...</> : <><Send size={14} /> ارسال پیامک</>}
          </Button>
          <p className="text-[10px] text-gray-400 leading-5">
            اگر ارسال با خطا مواجه شد، تنظیمات پیامک (کلید API / شمارهٔ فرستنده) را با مدیر سیستم بررسی کنید. هر ارسال در تاریخچهٔ پیامک‌ها ثبت می‌شود.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
