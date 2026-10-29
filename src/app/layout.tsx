import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "سامانه جامع مدیریت فروش هلدینگ BGL",
  description: "سامانه CRM هلدینگ BGL - مدیریت مراکز، فروش، انبارداری و تولید",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground font-sans">
        {/* v2.26.0 — next-themes was installed but never wired up.
            attribute="class" drives the `.dark` palette/remaps in globals.css.
            defaultTheme="light" keeps the existing Enterprise look as shipped. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
          <SonnerToaster position="bottom-left" richColors closeButton dir="rtl" />
        </ThemeProvider>
      </body>
    </html>
  );
}
