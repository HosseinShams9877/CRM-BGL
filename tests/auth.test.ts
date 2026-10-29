// Unit tests — authentication primitives (PBKDF2 + legacy bcrypt verification).
// Part of the v2.8.0 test foundation (audit P1-7).
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '@/lib/auth';

describe('hashPassword / verifyPassword (PBKDF2)', () => {
  it('round-trips a new password', () => {
    const stored = hashPassword('S3cret!پسورد');
    // v2.47.0 — versioned format: pbkdf2$<iter>$<salt32>$<hash128>
    expect(stored).toMatch(/^pbkdf2\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(verifyPassword('S3cret!پسورد', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct-horse');
    expect(verifyPassword('battery-staple', stored)).toBe(false);
  });

  it('produces a unique salt per call', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    expect(a).not.toEqual(b); // different salts → different hashes
    expect(verifyPassword('same', a)).toBe(true);
    expect(verifyPassword('same', b)).toBe(true);
  });

  it('rejects malformed stored hashes', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', 'onlysalt:')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});

describe('verifyPassword — legacy bcrypt hashes (PHP import)', () => {
  // Real bcrypt hash of 'pass1234' ($2b$ form; $2y$/$2a$ verified below via prefix swap)
  const legacy = '$2b$04$w/WIdzKJ4swEf3RSVrNqtu0Rs3mPpcWTIYTwLBDUUZeVnW3GIktYW';
  const legacy2y = legacy.replace('$2b$', '$2y$');
  const legacy2a = legacy.replace('$2b$', '$2a$');

  it('verifies a $2b$ hash with the correct password', () => {
    expect(verifyPassword('pass1234', legacy)).toBe(true);
  });

  it('verifies a $2y$ (PHP) hash with the correct password', () => {
    expect(verifyPassword('pass1234', legacy2y)).toBe(true);
  });

  it('verifies a $2a$ hash with the correct password', () => {
    expect(verifyPassword('pass1234', legacy2a)).toBe(true);
  });

  it('rejects a wrong password against a bcrypt hash', () => {
    expect(verifyPassword('wrong', legacy)).toBe(false);
  });
});
