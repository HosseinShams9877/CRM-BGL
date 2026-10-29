// ════════════════════════════════════════════════════════════
// PASSWORD CHANGE SERVICE (v2.58.3 — round 88, user finding 7)
//
// WHY: the admin user-management route enforced the CONFIGURABLE
// central policy (security.password_min_length / require_upper /
// require_number / require_special) on every password it set, while
// the personal change-password path only had the schema's hardcoded
// min-8 — raising the policy did NOT affect personal changes. Both
// paths now run through validatePasswordAgainstPolicy, so a policy
// change has the SAME effect everywhere.
//
// Guarantees on REJECTION (nothing changes):
//   • the stored hash is untouched,
//   • sessions are NOT revoked,
//   • the password/hash never appears in any response or log.
// ════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { hashPassword, verifyPassword, revokeAllUserSessions } from '@/lib/auth';
import { validatePasswordAgainstPolicy, describePasswordPolicy, type PasswordPolicy } from '@/lib/security-policy';
import { ApiError } from '@/lib/api-error';

export { describePasswordPolicy, type PasswordPolicy };

/**
 * Change the acting user's OWN password.
 * @param userId authenticated user id (session already validated by the route)
 * @param currentPassword the current password (re-verified)
 * @param newPassword the new password — validated against BOTH the input
 *        schema (call site) and the CONFIGURED central policy
 * @param currentSessionToken the raw cookie token to KEEP alive (all other
 *        sessions are revoked on success)
 */
export async function changeOwnPassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionToken: string,
): Promise<void> {
  // 1) central configurable policy — SAME rules the admin user-management
  //    route applies (finding 7). On rejection: hash + sessions untouched.
  const policyError = await validatePasswordAgainstPolicy(newPassword);
  if (policyError) {
    throw new ApiError(400, policyError);
  }

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
    throw new ApiError(401, 'رمز عبور فعلی اشتباه است');
  }

  // 2) only after every check passes do the hash change + session
  //    revocation land (a rejected password changes NOTHING).
  await db.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(newPassword) } });

  // Security: invalidate every OTHER active session so stolen cookies
  // cannot outlive a password change. The current session survives.
  await revokeAllUserSessions(user.id, currentSessionToken);

  await db.auditEvent.create({
    data: {
      eventType: 'PASSWORD_CHANGED',
      category: 'security',
      subject: user.username,
      userId: user.id,
      details: 'همه نشست‌های دیگر باطل شدند',
      // NOTE: neither the old nor the new password (nor the hash) is ever
      // recorded here — audit carries the event, never the secret.
    },
  });
}
