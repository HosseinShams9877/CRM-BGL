// v2.58.0 (audit 85-d): root loading fallback — replaces the blank white
// flash during the first server render of the app shell with a branded
// Persian skeleton. Kept intentionally lightweight (no client JS beyond
// the CSS animation) so it never delays the real content.

export default function Loading() {
  return (
    <div dir="rtl" className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6">
      <div className="w-10 h-10 rounded-full border-[3px] border-teal-200 border-t-teal-600 animate-spin mb-4" />
      <p className="text-sm text-slate-500">در حال بارگذاری سامانه…</p>
    </div>
  );
}
