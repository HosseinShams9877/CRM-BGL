// Unit tests — session-token hashing (v2.31.3, round 31).
// Real-world bug this guards: /api/sessions returned each row's raw id,
// which was bit-for-bit the cookie value — anyone who could list sessions
// could set the cookie and BE any user. Now the row id is the SHA-256 of
// the cookie token: a digest safe to expose, useless as a credential.
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  hashSessionToken,
  createSession,
  validateSession,
  revokeAllUserSessions,
} from '@/lib/auth';

const db = new PrismaClient();
const TAG = 'r31-test';

describe('hashSessionToken (pure)', () => {
  it('produces a 64-char lowercase hex digest', () => {
    expect(hashSessionToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashSessionToken('token-1')).toEqual(hashSessionToken('token-1'));
  });

  it('never equals its input (the row id must not be the credential)', () => {
    const token = 'a'.repeat(64);
    expect(hashSessionToken(token)).not.toEqual(token);
  });

  it('distinct tokens hash to distinct ids', () => {
    expect(hashSessionToken('token-a')).not.toEqual(hashSessionToken('token-b'));
  });

  it('matches the pinned reference vector (sha256, utf8)', () => {
    // sha256("pin-me") — pin the algorithm so a future refactor cannot
    // silently weaken it (or accidentally switch encodings)
    expect(hashSessionToken('pin-me'))
      .toEqual('8b7d586b6ae7c2b2feddc484d5522a18c6a814a3bd14e609885cf035d3e517a8');
  });
});

describe('createSession / validateSession (DB round-trip)', () => {
  it('stores the hash as the row id and authenticates the raw token', async () => {
    const user = await db.user.create({
      data: { username: `${TAG}-u1`, displayName: `${TAG} کاربر`, role: 'standard', passwordHash: 'x:y' },
    });
    const token = await createSession(user.id, user.displayName, 'vitest', 'iphash');

    // raw token: 64-hex; row id: its sha256 — never the token itself
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const row = await db.session.findUnique({ where: { id: hashSessionToken(token) } });
    expect(row).not.toBeNull();
    expect(row!.id).not.toEqual(token);

    // the raw token authenticates
    const auth = await validateSession(token);
    expect(auth?.username).toBe(`${TAG}-u1`);

    // the LEAKED ROW ID does NOT authenticate (sha256(hash) matches no row)
    expect(await validateSession(row!.id)).toBeNull();

    // revoke → token dies
    await db.session.update({ where: { id: row!.id }, data: { revokedAt: new Date() } });
    expect(await validateSession(token)).toBeNull();
  });

  it('revokeAllUserSessions keeps the excepted RAW token alive', async () => {
    const user = await db.user.create({
      data: { username: `${TAG}-u2`, displayName: `${TAG} دوم`, role: 'standard', passwordHash: 'x:y' },
    });
    const keep = await createSession(user.id, user.displayName, 'vitest', 'iphash');
    const kill = await createSession(user.id, user.displayName, 'vitest', 'iphash');

    await revokeAllUserSessions(user.id, keep); // keep = RAW cookie token

    expect(await validateSession(keep)).not.toBeNull();
    expect(await validateSession(kill)).toBeNull();
  });

  it('revocation via the logout path (hash lookup) works', async () => {
    const user = await db.user.create({
      data: { username: `${TAG}-u3`, displayName: `${TAG} سوم`, role: 'standard', passwordHash: 'x:y' },
    });
    const token = await createSession(user.id, user.displayName, 'vitest', 'iphash');
    // same shape as handleLogout after v2.31.3
    await db.session.updateMany({
      where: { id: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    expect(await validateSession(token)).toBeNull();
  });
});

afterAll(async () => {
  // tagged cleanup — never touch real users/sessions
  const users = await db.user.findMany({ where: { username: { startsWith: TAG } }, select: { id: true } });
  for (const u of users) {
    await db.session.deleteMany({ where: { userId: u.id } });
    await db.user.delete({ where: { id: u.id } });
  }
  await db.$disconnect();
});
