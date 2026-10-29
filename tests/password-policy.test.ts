import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { changeOwnPassword } from '@/lib/password-service';
import { validatePasswordAgainstPolicy, getPasswordPolicy, resetSecurityPolicyCache } from '@/lib/security-policy';
import { hashPassword, verifyPassword, createSession, hashSessionToken } from '@/lib/auth';

// ═══════════════════════════════════════════════════════════════
// password-policy.test.ts — v2.58.3 (round 88, finding 7)
//
// «Raising the minimum length and the digit/uppercase/symbol
//  requirements must have the SAME effect on BOTH paths» — the
//  personal change-password path (changeOwnPassword — the exact
//  function /api/auth change-password runs) and the admin
//  user-management path (validatePasswordAgainstPolicy — the exact
//  function /api/users runs on create + password update).
//
// Also asserted (the acceptance contract):
//   • a policy-rejected password leaves the stored hash AND every
//     session UNCHANGED;
//   • the requirements are displayable (describePasswordPolicy);
//   • no password or hash ever appears in a response/audit line.
// ═══════════════════════════════════════════════════════════════

const db = new PrismaClient();
const TAG = `r88p-${Date.now()}`;
const KEYS = [
  'security.password_min_length',
  'security.require_upper',
  'security.require_number',
  'security.require_special',
];

async function setPolicy(len: number, upper: boolean, number: boolean, special: boolean) {
  for (const [k, v] of [
    [KEYS[0], String(len)],
    [KEYS[1], String(upper)],
    [KEYS[2], String(number)],
    [KEYS[3], String(special)],
  ] as const) {
    await db.meta.upsert({ where: { key: k }, update: { value: v }, create: { key: k, value: v } });
  }
  resetSecurityPolicyCache(); // tests change policy per-case; the 60s prod cache must not bleed across cases
}

async function clearPolicy() {
  await db.meta.deleteMany({ where: { key: { in: KEYS } } });
  resetSecurityPolicyCache();
}

const OLD_PASSWORD = 'OldPass1234';
const NEW_OK = 'Strong1234A!';
const NEW_WEAK = 'short';

let testUser: { id: string };

async function mkSession(userId: string): Promise<string> {
  return createSession(userId, 'test', 'vitest', 'deadbeef');
}

async function activeSessions(userId: string): Promise<number> {
  return db.session.count({ where: { userId, revokedAt: null } });
}

async function storedHash(userId: string): Promise<string> {
  const u = await db.user.findUnique({ where: { id: userId } });
  return u!.passwordHash;
}

beforeAll(async () => {
  await clearPolicy();
  testUser = await db.user.create({
    data: {
      username: `${TAG}-user`,
      displayName: 'Policy Test',
      passwordHash: hashPassword(OLD_PASSWORD),
      role: 'standard',
      companyIds: '["bgl"]',
      businessUnitId: 'production',
    },
  });
});

afterAll(async () => {
  await clearPolicy();
  await db.session.deleteMany({ where: { userId: testUser.id } });
  await db.auditEvent.deleteMany({ where: { subject: `${TAG}-user` } });
  await db.user.delete({ where: { id: testUser.id } }).catch(() => undefined);
  await db.$disconnect();
});

describe('policy equivalence — both paths apply the SAME rules', () => {
  it('STRICT policy (min 12 + upper + number + special): identical verdicts on both paths', async () => {
    await setPolicy(12, true, true, true);
    const weak = 'short';
    // the admin path (/api/users create + update) runs exactly this:
    const adminPath = await validatePasswordAgainstPolicy(weak);
    // the personal path (/api/auth change-password) runs changeOwnPassword:
    let personalPath: string | null = null;
    try {
      await changeOwnPassword(testUser.id, OLD_PASSWORD, weak, 'session-token');
    } catch (e) {
      personalPath = (e as { message?: string }).message ?? null;
    }
    expect(adminPath).toBeTruthy();
    expect(personalPath).toBe(adminPath); // SAME rejection, SAME message
    // the hash is untouched by the rejection
    expect(verifyPassword(OLD_PASSWORD, await storedHash(testUser.id))).toBe(true);
  });

  it('LENIENT policy (min 8, number only): the previously-weak password now passes both paths', async () => {
    await setPolicy(8, false, true, false);
    const borderline = 'abcdefg1'; // 8 chars, one digit, no upper/special
    expect(await validatePasswordAgainstPolicy(borderline)).toBeNull();
    await changeOwnPassword(testUser.id, OLD_PASSWORD, borderline, 'session-token');
    expect(verifyPassword(borderline, await storedHash(testUser.id))).toBe(true);
    // rotate back for the next test
    await changeOwnPassword(testUser.id, borderline, OLD_PASSWORD, 'session-token');
  });

  it('each requirement fires on both paths with the same message', async () => {
    await setPolicy(8, true, true, true);
    for (const [pw, fragment] of [
      ['alllowercase1!', 'حرف بزرگ'],
      ['AllUpperNoDigits!', 'عدد'],
      ['NoSymbols123', 'کاراکتر خاص'],
      ['Aa1!', 'حداقل 8'],
    ] as const) {
      const adminPath = await validatePasswordAgainstPolicy(pw);
      let personalPath: string | null = null;
      try {
        await changeOwnPassword(testUser.id, OLD_PASSWORD, pw, 'session-token');
      } catch (e) {
        personalPath = (e as { message?: string }).message ?? null;
      }
      expect(adminPath, pw).toContain(fragment);
      expect(personalPath).toBe(adminPath);
    }
    expect(verifyPassword(OLD_PASSWORD, await storedHash(testUser.id))).toBe(true);
  });
});

describe('rejection changes NOTHING (hash + sessions intact)', () => {
  it('a policy-rejected password keeps the old hash and revokes no session', async () => {
    await setPolicy(12, true, true, true);
    const s1 = await mkSession(testUser.id);
    const s2 = await mkSession(testUser.id);
    const before = await activeSessions(testUser.id);
    const hashBefore = await storedHash(testUser.id);

    await expect(
      changeOwnPassword(testUser.id, OLD_PASSWORD, NEW_WEAK, s1),
    ).rejects.toThrow();

    expect(await storedHash(testUser.id)).toBe(hashBefore);        // hash unchanged
    expect(await activeSessions(testUser.id)).toBe(before);        // sessions unchanged
    expect(verifyPassword(OLD_PASSWORD, await storedHash(testUser.id))).toBe(true);

    // cleanup sessions
    await db.session.deleteMany({ where: { id: { in: [s1, s2] } } });
  });

  it('a SUCCESSFUL change revokes every OTHER session and keeps the current one', async () => {
    await setPolicy(8, false, true, false);
    const keep = await mkSession(testUser.id);
    const other = await mkSession(testUser.id);
    await changeOwnPassword(testUser.id, OLD_PASSWORD, NEW_OK, keep);
    // current session survives; the other is revoked (session rows are
    // keyed by the token's SHA-256, never the raw token)
    const keptRow = await db.session.findFirst({ where: { id: hashSessionToken(keep) } });
    const otherRow = await db.session.findFirst({ where: { id: hashSessionToken(other) } });
    expect(keptRow?.revokedAt).toBeNull();
    expect(otherRow?.revokedAt).not.toBeNull();
    expect(verifyPassword(NEW_OK, await storedHash(testUser.id))).toBe(true);
    await db.session.deleteMany({ where: { id: { in: [keep, other] } } });
    // restore for later tests
    await db.user.update({ where: { id: testUser.id }, data: { passwordHash: hashPassword(OLD_PASSWORD) } });
  });

  it('a wrong CURRENT password is refused before any change', async () => {
    await expect(
      changeOwnPassword(testUser.id, 'wrong-current', NEW_OK, 'session-token'),
    ).rejects.toThrow('رمز عبور فعلی اشتباه است');
    expect(verifyPassword(OLD_PASSWORD, await storedHash(testUser.id))).toBe(true);
  });
});

describe('requirements are displayable; secrets never logged', () => {
  it('describePasswordPolicy renders the current rules (Persian)', async () => {
    await setPolicy(10, true, true, false);
    const policy = await getPasswordPolicy();
    const { describePasswordPolicy } = await import('@/lib/security-policy');
    const text = describePasswordPolicy(policy);
    expect(text).toContain('10');
    expect(text).toContain('حرف بزرگ');
    expect(text).toContain('عدد');
    expect(text).not.toContain('کاراکتر خاص');
  });

  it('the audit trail carries the EVENT only — no password, no hash', async () => {
    await setPolicy(8, false, true, false);
    const pw = `Secret${Date.now()}x9`;
    await changeOwnPassword(testUser.id, OLD_PASSWORD, pw, 'session-token');
    const events = await db.auditEvent.findMany({ where: { subject: `${TAG}-user`, eventType: 'PASSWORD_CHANGED' } });
    expect(events.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(pw);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(hashPassword(pw));
    // rotate back
    await db.user.update({ where: { id: testUser.id }, data: { passwordHash: hashPassword(OLD_PASSWORD) } });
  });
});
