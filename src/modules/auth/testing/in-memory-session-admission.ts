import type { MfaSessionProof } from '@/modules/auth/mfa/application/auth-mfa-repository.port';

import type { InMemoryAuthState } from './in-memory-auth.state';

/**
 * The admission check both in-memory session stores make before inserting a
 * row: the password hash must still be current, and an enabled factor must be
 * proved by the factor snapshot or by a recovery code consumed in this write.
 * Keeping it in one place stops the two doubles from drifting apart.
 */
export function admitsInMemorySession(
  state: InMemoryAuthState,
  input: {
    readonly userId: string;
    readonly expectedPasswordHash: string;
    readonly mfaProof?: MfaSessionProof;
  },
): boolean {
  const account = state.accounts.get(input.userId);
  if (
    account?.status !== 'active' ||
    account.passwordHash !== input.expectedPasswordHash
  ) {
    return false;
  }
  const factor = state.mfaFactors.get(input.userId);
  if (factor?.status === 'enabled') {
    if (
      input.mfaProof?.kind === 'totp' &&
      input.mfaProof.factorId === factor.factorId
    ) {
      // The application verified this factor snapshot before the transaction.
    } else if (
      input.mfaProof?.kind === 'recovery' &&
      state.recoveryCodes.get(input.userId)?.delete(input.mfaProof.codeHash)
    ) {
      // Recovery proof consumption and session creation share this write.
    } else {
      return false;
    }
  } else if (input.mfaProof !== undefined) {
    return false;
  }
  return true;
}
