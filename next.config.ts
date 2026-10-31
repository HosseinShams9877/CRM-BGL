import type { NextConfig } from "next";

// ═══ v2.47.0 — security response headers ═══
// Served on every route (API + UI). CSP notes:
//  • 'unsafe-inline'/'unsafe-eval' on script-src are required by the Next.js
//    runtime (inline bootstrap + HMR); the still-valuable part is that ONLY
//    same-origin script/style/font/media sources load — external exfil
//    hosts are blocked by default-src/connect-src 'self'.
//  • img-src data:/blob: for chart renderings and object-URL previews;
//    media-src blob: for call-audio playback.
//  • frame-ancestors 'self' locks the app out of third-party iframes.
//  • HSTS is ignored by browsers on plain HTTP, so local/HTTP-LAN
//    deployments are unaffected; it activates on any HTTPS host.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // v2.58.1 (audit F8): microphone=(self) — quick-activity's voice note
  // recorder calls getUserMedia({audio:true}); the old `microphone=()`
  // hard-DENIED the permission policy in Chromium, so the recorder could
  // never open a stream. Scoped to same-origin only; camera/geolocation/
  // payment stay denied.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // v2.58.11 (Vercel deployment fix) — `output: "standalone"` is ONLY for
  // the self-hosted package (scripts/start.mjs runs .next/standalone/server.js).
  // On Vercel it breaks the build: with Turbopack, producing the standalone
  // bundle skips writing `.next/next-server.js.nft.json`, which Vercel's
  // onBuildComplete step then reads → `ENOENT ... next-server.js.nft.json`
  // and the deployment fails AFTER `next build` itself succeeded. Vercel
  // builds its own optimized output for the Next.js framework, so we opt out
  // of the standalone tracing there. postbuild.mjs skips its standalone
  // packaging step accordingly (same condition).
  output: process.env.VERCEL ? undefined : "standalone",
  // v2.58.10 (final-review P0-2): the standalone trace used to drag the
  // WHOLE project in (dynamic fs access to prisma/, scripts/, src/ made
  // the tracer conservative) — a build run from a tree that happened to
  // hold prisma/dev.db, FIRST-LOGIN.txt or logs/ shipped them inside
  // .next/standalone. These excludes pin the runtime boundary: the
  // server resolves DATABASE_URL/STORAGE_DIR at RUNTIME (scripts/lib/
  // resolve-env.mjs), so none of these files belong in the server
  // bundle. postbuild.mjs re-verifies and fails closed on any leak.
  outputFileTracingExcludes: {
    "*": [
      "tests/**",
      "prisma/**/*.db",
      "prisma/.test-runs/**",
      "prisma/legacy-doubled-*/**",
      "logs/**",
      "storage/**",
      "FIRST-LOGIN*.txt",
      ".env",
      ".env.local",
      "scripts/**",
      "deploy/**",
      // pure bloat the conservative tracer used to drag in (docs, tool
      // configs, build info) — none of it is read by the server at runtime
      "*.md",
      "tsconfig.json",
      "tsconfig.tsbuildinfo",
      "vitest.config.ts",
      "eslint.config.mjs",
      "setup.bat",
      "setup.sh",
      "package-lock.json",
    ],
  },
  /* config options here */
  typescript: {
    // v2.10.0: TS errors reached ZERO — build gate now ENFORCED.
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  // Allow the space-z.ai preview proxy to load dev assets (HMR chunks, etc.)
  allowedDevOrigins: ["*.space-z.ai"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
