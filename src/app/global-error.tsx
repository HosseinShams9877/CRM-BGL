'use client';

// v2.58.0 (audit 85-d): ROOT error boundary — global-error.tsx replaces the
// root layout when it errors, so it must render its own <html>/<body>.
// Persian RTL + hard reload (no reset: the shell itself is broken).

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  return (
    <html lang="fa" dir="rtl">
      <body style={{ margin: 0, fontFamily: 'inherit' }}>
        <div dir="rtl" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', padding: '24px' }}>
          <div style={{ maxWidth: '420px', width: '100%', background: '#fff', borderRadius: '16px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', padding: '32px', textAlign: 'center' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <h1 style={{ fontSize: '18px', fontWeight: 700, color: '#0f172a', margin: '0 0 8px' }}>خطای بحرانی برنامه</h1>
            <p style={{ fontSize: '13px', color: '#64748b', lineHeight: '1.8', margin: '0 0 12px' }}>
              خطایی در هستهٔ برنامه رخ داد و نمایش ادامه ممکن نیست. صفحه را دوباره بارگذاری کنید؛ اگر مشکل پایدار بود، سرور را از طریق اسکریپت stop-server و start راه‌اندازی مجدد کنید.
            </p>
            {error.digest && (
              <p dir="ltr" style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 16px' }}>digest: {error.digest}</p>
            )}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ height: '40px', padding: '0 20px', borderRadius: '12px', background: '#0d9488', color: '#fff', fontSize: '14px', fontWeight: 500, border: 'none', cursor: 'pointer' }}
            >
              بارگذاری مجدد
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
