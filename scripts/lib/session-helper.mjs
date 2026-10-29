// Shared helpers for the verify-* scripts (round 86).
// The app stores session rows keyed by sha256(raw cookie token) —
// see src/lib/auth.ts (hashSessionToken). Verification scripts inject
// sessions the same way the login route does.
import { createHash } from 'node:crypto';

export function sha256Token(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
