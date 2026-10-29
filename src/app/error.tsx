'use client';

// v2.58.0 (audit 85-d): app-level error boundary — a client crash used to
// show Next.js's default ENGLISH "Application error" page in a Persian RTL
// product. This boundary catches segment-level errors and offers a retry
// in Persian. `reset` re-renders the segment; if the error persists the
// reload path is offered explicitly.

import { useEffect } from 'react';
import { RotateCcw, RefreshCw, AlertTriangle } from 'lucide-react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the digest server-side logs can correlate with.
    console.error('[app-error]', error.message, error.digest ?? '');
  }, [error]);

  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
        <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-amber-50 flex items-center justify-center">
          <AlertTriangle size={26} className="text-amber-500" />
        </div>
        <h1 className="text-lg font-bold text-slate-900 mb-2">خطایی در نمایش این بخش رخ داد</h1>
        <p className="text-sm text-slate-500 leading-6 mb-1">
          یک مشکل غیرمنتظره هنگام بارگذاری صفحه پیش آمد. معمولاً تلاش مجدد مشکل را برطرف می‌کند.
        </p>
        {error.digest && (
          <p className="text-[11px] text-slate-400 mb-4" dir="ltr">کد پیگیری: {error.digest}</p>
        )}
        <div className="flex gap-2 justify-center mt-4">
          <button
            type="button"
            onClick={reset}
            className="h-10 px-4 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RotateCcw size={15} />
            تلاش مجدد
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-10 px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-slate-700 text-sm font-medium flex items-center gap-2 transition-colors"
          >
            <RefreshCw size={15} />
            بارگذاری صفحه
          </button>
        </div>
        <p className="text-[11px] text-slate-400 mt-5 leading-5">
          اگر خطا تکرار شد، بخش «راهنمای رفع مشکل» در فایل WINDOWS.md را ببینید.
        </p>
      </div>
    </div>
  );
}
