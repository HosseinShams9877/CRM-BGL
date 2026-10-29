import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// ════════════════════════════════════════════════════════
//  HEALTH — v2.29.0 (deployment readiness)
//
//  Liveness + readiness probe for production monitors:
//  uptime tools, nginx upstream checks, load balancers,
//  systemd watchdog integrations.
//
//  Contract (v2.29.0, asserted by scripts/api-deploy-v2290.ts):
//   • 200 {status:'ok', db:'ok', latencyMs, uptimeSec} — healthy
//   • 503 {status:'degraded', db:'fail'}                — DB unreachable
//   • Exact key set, no extras: versions, table counts,
//     user names and anything tenant-specific must NEVER
//     appear here — this route is unauthenticated.
//   • Cache-Control: no-store — a cached "ok" would lie
//     about the server's current state.
//
//  Auth model: intentionally NONE. Liveness must be
//  observable by infrastructure that cannot log in. The
//  response leaks nothing beyond "the process is up and the
//  database file is reachable".
//
//  Rate limiting: the global /api middleware tier
//  (120 req/min/IP) applies — any sane monitor cadence
//  (30–60s) fits comfortably inside it.
// ════════════════════════════════════════════════════════

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const started = Date.now();
  try {
    // Cheapest possible DB round-trip — a SQLite "SELECT 1"
    // costs microseconds, yet proves the file is reachable
    // and not locked-read-only (e.g. disk-full WAL state).
    await db.$queryRawUnsafe('SELECT 1');
    return NextResponse.json(
      {
        status: 'ok',
        db: 'ok',
        latencyMs: Date.now() - started,
        uptimeSec: Math.round(process.uptime()),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { status: 'degraded', db: 'fail' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
