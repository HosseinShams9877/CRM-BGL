import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { NextRequest } from 'next/server';
import { hashPassword, verifyPassword } from '@/lib/auth';

// ═══════════════════════════════════════════════════════════════
// users-self-password.test.ts — v2.58.7 (A7 — session-hijack
// hardening).
//
// THE REGRESSION (confirmed on the pre-fix v2.58.6 code): the users
// route accepted `newPassword` for the CALLER'S OWN account with only
// the session cookie as proof — a hijacked session could permanently
// lock out the real owner. The dedicated /api/auth change-password
// action always required the current password; this route did not.
//
// THE CONTRACT (through the REAL route handler):
//   • self change WITHOUT currentPassword → 400, hash unchanged
//   • self change with a WRONG currentPassword → 403, hash unchanged
//   • self change with the RIGHT currentPassword → 200, hash rotated
//   • an admin resetting ANOTHER user's password stays passwordless
// ═══════════════════════════════════════════════════════════════

let currentAuthUser: unknown = null;
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    getCurrentUser: async () => currentAuthUser as ReturnType<typeof actual.getCurrentUser>,
    // the real hash/verify implementations are re-used on purpose —
    // only the session seam is stubbed.
    hashPassword: actual.hashPassword,
    verifyPassword: actual.verifyPassword,
  };
});

import { POST as usersPost } from '@/app/api/users/route';

const db = new PrismaClient();
const TAG = `r97pw-${Date.now().toString(36)}`;

function req(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function asUser<T>(user: unknown, fn: () => Promise<T>): Promise<T> {
  currentAuthUser = user;
  return fn();
}

interface TestUser {
  id: string; username: string; displayName: string; role: string; roleLabel: string;
  businessUnitId: string; companyIds: string[]; jobTitle: string | null; isActive: boolean;
  impersonator: null; territoryMode: string; territoryProvinces: string | null; territoryCenterIds: string | null;
}

async function mkUserRow(username: string, role: string, password: string) {
  const u = await db.user.create({
    data: {
      username: `${TAG}-${username}`, displayName: username,
      passwordHash: hashPassword(password), role,
      companyIds: JSON.stringify(['bazargani']), businessUnitId: 'trading',
    },
  });
  return {
    id: u.id, username: u.username, displayName: u.displayName, role, roleLabel: '',
    businessUnitId: 'trading', companyIds: ['bazargani'], jobTitle: null, isActive: true, impersonator: null,
    territoryMode: 'country', territoryProvinces: '[]', territoryCenterIds: '[]',
  } as TestUser;
}

async function hashOf(userId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: userId } });
  return u!.passwordHash;
}

let victim: TestUser;
let admin: TestUser;
const OLD_PASSWORD = 'old-pass-123';
const NEW_PASSWORD = 'new-strong-pass-456';

beforeAll(async () => {
  victim = await mkUserRow('victim', 'standard', OLD_PASSWORD);
  admin = await mkUserRow('admin', 'admin', 'admin-pass-1');
});

afterAll(async () => {
  await db.user.deleteMany({ where: { username: { startsWith: `${TAG}-` } } });
  await db.$disconnect();
});

describe('A7 — self password change requires proof-of-identity', () => {
  it('REGRESSION GUARD: self change WITHOUT currentPassword → 400, hash byte-identical', async () => {
    const before = await hashOf(victim.id);
    const res = await asUser(victim, () =>
      usersPost(req({ action: 'update', id: victim.id, newPassword: NEW_PASSWORD })));
    expect(res.status).toBe(400);
    expect(await hashOf(victim.id)).toBe(before);
  });

  it('WRONG currentPassword → 403, hash unchanged', async () => {
    const before = await hashOf(victim.id);
    const res = await asUser(victim, () =>
      usersPost(req({ action: 'update', id: victim.id, currentPassword: 'wrong-password', newPassword: NEW_PASSWORD })));
    expect(res.status).toBe(403);
    expect(await hashOf(victim.id)).toBe(before);
  });

  it('CORRECT currentPassword → 200, the hash rotates to the new password', async () => {
    const before = await hashOf(victim.id);
    const res = await asUser(victim, () =>
      usersPost(req({ action: 'update', id: victim.id, currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD })));
    expect(res.status).toBe(200);
    const after = await hashOf(victim.id);
    expect(after).not.toBe(before);
    expect(verifyPassword(NEW_PASSWORD, after)).toBe(true);
    expect(verifyPassword(OLD_PASSWORD, after)).toBe(false);
  });
});

describe('A7 — the admin reset path is unaffected', () => {
  it('an admin resets ANOTHER user\'s password with NO currentPassword (manage_users authority)', async () => {
    const res = await asUser(admin, () =>
      usersPost(req({ action: 'update', id: victim.id, newPassword: 'admin-reset-789' })));
    expect(res.status).toBe(200);
    expect(verifyPassword('admin-reset-789', await hashOf(victim.id))).toBe(true);
  });
});
