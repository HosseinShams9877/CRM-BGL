// Round 31 — one-time migration: Session.id from RAW token → SHA-256(token).
//
// v2.31.3 changed the session model: the cookie carries a raw 64-hex token,
// the row is keyed by its SHA-256. Existing rows still hold the RAW token as
// their id. This script rewrites every row's id to sha256(old id):
//
//   cookie (raw, unchanged in browsers) → sha256 → matches the new row id
//
// so already-logged-in users keep their sessions — no forced re-login.
//
// Run ONCE per database, right after deploying v2.31.3:
//   npm run migrate:session-hashes
//
// Ordering note: sessions created BETWEEN the code deploy and this script
// already have hashed ids and would get double-hashed (those few users
// simply re-login — an annoyance, not a vulnerability). A Meta flag makes
// the script itself idempotent against accidental double-runs.
import { PrismaClient } from '@prisma/client';
import crypto from 'node:crypto';

const db = new PrismaClient();
const FLAG = 'session_hash_migration_v1';
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const done = await db.meta.findUnique({ where: { key: FLAG } });
if (done) {
  console.log(`[migrate-sessions] already done at ${done.value} — nothing to do`);
  await db.$disconnect();
  process.exit(0);
}

const sessions = await db.session.findMany({ select: { id: true } });
let migrated = 0;
for (const s of sessions) {
  await db.session.update({ where: { id: s.id }, data: { id: sha256(s.id) } });
  migrated++;
}

await db.meta.upsert({
  where: { key: FLAG },
  create: { key: FLAG, value: new Date().toISOString() },
  update: { value: new Date().toISOString() },
});

console.log(`[migrate-sessions] rewrote ${migrated} session id(s) to sha256 — existing cookies keep working`);
await db.$disconnect();
