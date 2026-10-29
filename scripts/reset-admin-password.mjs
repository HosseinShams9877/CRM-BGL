#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════
// reset-admin-password.mjs — v2.30.0 / updated v2.47.0
//
// Purpose: the seed prints the initial admin password ONCE (random, not
// stored). If it is lost, INSTALL.md documents "SEED_ADMIN_PASSWORD + re-run
// db:seed" — but the seed's upsert uses `update: {}`, which never rewrites
// the hash of an EXISTING user, so that recovery path silently did nothing.
// This script performs the actual reset directly:
//
//   node scripts/reset-admin-password.mjs [--username admin] [--password <pw>]
//
// - --username defaults to 'admin' (v2.47.0: any account can be rotated —
//   the packaging step also rotates the yasteb account with this flag).
// - Without --password, a readable random password is generated.
// - Hashing matches src/lib/auth.ts hashPassword() exactly
//   (v2.47.0: PBKDF2-SHA512, 210000 iters, versioned
//   "pbkdf2$<iter>$<salt>$<hash>" format).
// - After the reset: all of the user's sessions are revoked, login-throttle
//   attempts for the user are cleared, and the new hash is verified
//   with the same verifyPassword() derivation before exiting 0.
// ═══════════════════════════════════════════════════════════
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

// v2.47.0 — MUST stay in sync with src/lib/auth.ts (PBKDF2_ITERATIONS).
const PBKDF2_ITERATIONS = 210_000;

// ── CLI arg ──
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// Same scheme as src/lib/auth.ts → hashPassword() (v2 versioned format)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, 'sha512').toString('hex');
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

// Same derivation as src/lib/auth.ts → verifyPassword() (v2 branch)
function verifyPassword(password, stored) {
  if (!stored.startsWith('pbkdf2$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 4) return false;
  const iter = Number(parts[1]);
  if (!Number.isInteger(iter) || iter < 1 || iter > 10_000_000) return false;
  const verify = crypto.pbkdf2Sync(password, parts[2], iter, 64, 'sha512').toString('hex');
  const a = Buffer.from(parts[3], 'hex');
  const b = Buffer.from(verify, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function randomPassword() {
  // base64url, 12 bytes → 16 chars, URL/keyboard-safe
  return crypto.randomBytes(12).toString('base64url');
}

async function main() {
  const ADMIN_USERNAME = argValue('--username') || 'admin';
  const password = argValue('--password') || process.env.SEED_ADMIN_PASSWORD || randomPassword();

  if (typeof password !== 'string' || password.length < 8) {
    console.error('[reset] Password must be at least 8 characters.');
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
  if (!user) {
    console.error(`[reset] User "${ADMIN_USERNAME}" not found. Run "npm run db:seed" first.`);
    process.exit(1);
  }

  // 1) Set the new hash
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hashPassword(password) },
  });

  // 2) Revoke every active session of this user (password change = kill sessions)
  const revoked = await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  // 3) Clear login-throttle rows pointing at this user (avoid stale block)
  const cleared = await prisma.loginAttempt.deleteMany({ where: { userId: user.id } }).catch(() => ({ count: 0 }));

  // 4) Audit trail
  await prisma.auditEvent.create({
    data: {
      eventType: 'ADMIN_PASSWORD_RESET',
      category: 'authentication',
      subject: ADMIN_USERNAME,
      detail: `via scripts/reset-admin-password.mjs; sessions revoked: ${revoked.count}`,
    },
  }).catch(() => undefined); // audit optional — do not fail the reset

  // 5) Verify the new hash with the same derivation used at login
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (!fresh || !verifyPassword(password, fresh.passwordHash)) {
    console.error('[reset] VERIFICATION FAILED — the stored hash does not verify. Aborting.');
    process.exit(1);
  }

  console.log('Password reset completed successfully!');
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Account: ${ADMIN_USERNAME}`);
  console.log(`  password: ${password}`);
  console.log(`  sessions revoked: ${revoked.count} | throttle rows cleared: ${cleared.count}`);
  console.log('  (Change it from Settings after first login.)');
  console.log('═══════════════════════════════════════════════');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
