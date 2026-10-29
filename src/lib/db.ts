import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Query logging is enabled only in development. In production it hurts
// performance and can leak record data into server logs.
const isDev = process.env.NODE_ENV !== 'production'

// v2.13.0 — harden the SQLite connection string against lock storms.
// SQLite allows exactly ONE writer at a time. With Prisma's default pool the
// engine opens several connections, and under bursts of parallel requests the
// cross-connection lock handoff surfaced as "database is locked" (SQLITE_BUSY)
// even though every individual statement was safe. Pinning connection_limit=1
// serialises all queries through a single connection at the pool level —
// writers queue in Prisma instead of fighting over the file lock.
function sqliteDatasourceUrl(): string | undefined {
  const url = process.env.DATABASE_URL
  if (!url || !url.startsWith('file:')) return undefined
  if (url.includes('connection_limit=')) return url
  return `${url}?connection_limit=1&socket_timeout=90000`
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isDev ? ['query', 'error', 'warn'] : ['error', 'warn'],
    ...(sqliteDatasourceUrl()
      ? { datasources: { db: { url: sqliteDatasourceUrl()! } } }
      : {}),
  })

// v2.13.0 — switch the SQLite database to WAL journaling once per process.
// The default rollback-journal ("delete") mode serialises readers against
// writers; WAL lets reads proceed while the single writer works. The mode is
// persistent in the database file header, so this is a cheap no-op read
// after the first run.
if (!globalForPrisma.prisma) {
  db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
    .then(() => undefined)
    .catch(() => undefined) // never block app startup on a pragma
}
if (isDev) globalForPrisma.prisma = db
