import Link from 'next/link';

// v2.58.0 (audit 85-d): Persian 404 — the default English Next.js page is
// replaced with a localized one that routes the user back to the app root.

export default function NotFound() {
  return (
    <div dir="rtl" className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="max-w-md w-full bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center">
        <p className="text-5xl font-black text-teal-600 mb-2">۴۰۴</p>
        <h1 className="text-lg font-bold text-slate-900 mb-2">صفحهٔ موردنظر یافت نشد</h1>
        <p className="text-sm text-slate-500 leading-6 mb-6">
          نشانی واردشده در سامانه وجود ندارد یا جابه‌جا شده است.
        </p>
        <Link
          href="/"
          className="inline-flex h-10 items-center px-6 rounded-xl bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors"
        >
          بازگشت به صفحهٔ اصلی
        </Link>
      </div>
    </div>
  );
}
