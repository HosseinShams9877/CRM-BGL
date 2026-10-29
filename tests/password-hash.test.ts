import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword, needsRehash, PBKDF2_ITERATIONS } from '@/lib/auth';

// ── helpers ──
/** Build a legacy v1 (≤2.46) `salt:hash` string exactly like the old code. */
function v1Hash(password: string, saltHex = crypto.randomBytes(16).toString('hex')): string {
  const hash = crypto.pbkdf2Sync(password, saltHex, 10_000, 64, 'sha512').toString('hex');
  return `${saltHex}:${hash}`;
}

describe('hashPassword (v2.47.0 — versioned PBKDF2-210k)', () => {
  it('produces the versioned pbkdf2$iter$salt$hash format', () => {
    const stored = hashPassword('S3cret!123');
    const parts = stored.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(Number(parts[1])).toBe(PBKDF2_ITERATIONS);
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);   // 16-byte hex salt
    expect(parts[3]).toMatch(/^[0-9a-f]{128}$/);  // 64-byte hex hash
  });

  it('salts every call (no rainbow-table reuse)', () => {
    expect(hashPassword('same-password').split('$')[2]).not.toBe(
      hashPassword('same-password').split('$')[2],
    );
  });

  it('round-trips through verifyPassword', () => {
    const stored = hashPassword('S3cret!123');
    expect(verifyPassword('S3cret!123', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });
});

describe('verifyPassword — legacy formats keep working (imported users)', () => {
  it('v1 salt:hash (10k iterations) verifies and rejects correctly', () => {
    const stored = v1Hash('LegacyPass1');
    expect(verifyPassword('LegacyPass1', stored)).toBe(true);
    expect(verifyPassword('nope', stored)).toBe(false);
  });

  it('bcrypt $2a/$2b/$2y hashes verify via bcryptjs', () => {
    const pw = 'BcryptImport9';
    for (const hash of [
      bcrypt.hashSync(pw, 10),
      bcrypt.hashSync(pw, 10).replace(/^\$2a\$/, '$2b$'),
      bcrypt.hashSync(pw, 10).replace(/^\$2a\$/, '$2y$'),
    ]) {
      expect(hash).toMatch(/^\$2[aby]\$/);
      expect(verifyPassword(pw, hash)).toBe(true);
      expect(verifyPassword('wrong', hash)).toBe(false);
    }
  });

  it('a v2 hash with a LOWER iteration count still verifies (format wins)', () => {
    // simulated future upgrade leftover: 100k iterations stored
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync('pw-upgrade', salt, 100_000, 64, 'sha512').toString('hex');
    const stored = `pbkdf2$100000$${salt}$${hash}`;
    expect(verifyPassword('pw-upgrade', stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
  });
});

describe('verifyPassword — malformed / adversarial stored values must FAIL, not crash', () => {
  it('junk inputs return false (never throw)', () => {
    const junk = [
      '', 'plaintext', 'salt', ':', '::', 'zz:zz',
      'pbkdf2$', 'pbkdf2$210000', 'pbkdf2$abc$aa$bb',            // non-numeric iterations
      'pbkdf2$0$aa$bb', 'pbkdf2$-5$aa$bb',                       // non-positive
      `pbkdf2$999999999999$${'a'.repeat(32)}$${'b'.repeat(128)}`, // absurd cost (>10M guard)
      'pbkdf2$210000$NOTHEX$alsobad',                             // non-hex salt/hash
      'pbkdf2$210000$aa$bb$cc',                                   // extra segment
      'x'.repeat(500),
    ];
    for (const stored of junk) {
      let result: boolean;
      try { result = verifyPassword('anything', stored); } catch { result = undefined as never; }
      expect(result, `stored=${stored.slice(0, 40)}`).toBe(false);
    }
  });

  it('length-mismatched hash buffers fail cleanly (timingSafeEqual guard)', () => {
    const salt = crypto.randomBytes(16).toString('hex');
    const short = crypto.pbkdf2Sync('pw', salt, 100, 20, 'sha512').toString('hex'); // 20 bytes ≠ 64
    expect(verifyPassword('pw', `pbkdf2$100$${salt}$${short}`)).toBe(false);
    expect(verifyPassword('pw', `${salt}:${short}`)).toBe(false);
  });
});

describe('needsRehash — upgrade matrix', () => {
  it('current-scheme hashes do NOT need a rehash', () => {
    expect(needsRehash(hashPassword('x'))).toBe(false);
  });

  it('legacy v1 / bcrypt / lower-iteration hashes DO need a rehash', () => {
    expect(needsRehash(v1Hash('x'))).toBe(true);
    expect(needsRehash(bcrypt.hashSync('x', 10))).toBe(true);
    const salt = 'ab'.repeat(16);
    const h = 'cd'.repeat(64);
    expect(needsRehash(`pbkdf2$100000$${salt}$${h}`)).toBe(true);
    expect(needsRehash(`pbkdf2$notanumber$${salt}$${h}`)).toBe(true);
  });

  it('empty/unknown values need a rehash (fail-closed upgrade path)', () => {
    expect(needsRehash('')).toBe(true);
    expect(needsRehash('???')).toBe(true);
  });
});

describe('PBKDF2_ITERATIONS constant', () => {
  it('meets the OWASP floor for PBKDF2-HMAC-SHA512 (≥210,000)', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(210_000);
  });
});
