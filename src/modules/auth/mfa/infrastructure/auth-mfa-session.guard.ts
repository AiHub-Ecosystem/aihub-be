import type { MfaSessionProof } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';

declare const admitted: unique symbol;

/**
 * Proof that a new session may be stored for one account: it was active, and its
 * second factor, if it has one, was proved. Every statement that stores a
 * Refresh Session or a Web Session takes one for the account it stores for, so
 * a path that forgets the check does not compile, and an admission for another
 * account is refused when the row is written. The two ways to obtain one are
 * `authorizeMfaSession` and `admitSessionContinuation`; a review looks for the
 * second by name.
 */
export interface SessionAdmission {
  readonly userId: string;
  readonly [admitted]: true;
}

function admit(userId: string): SessionAdmission {
  return { userId } as SessionAdmission;
}

/**
 * Admission for the successor of a session that already exists. The presented
 * token and its account were checked by the caller, and a factor enrolled after
 * that session began is #586's, so this names the one place that skips the
 * factor check rather than leaving it implicit.
 */
export function admitSessionContinuation(userId: string): SessionAdmission {
  return admit(userId);
}

/** Refuses an admission minted for a different account than the row's. */
export function assertAdmitted(
  admission: SessionAdmission,
  userId: string,
): void {
  if (admission.userId !== userId) {
    throw new Error('session admission belongs to another account');
  }
}

/**
 * Admits a new session for an active account. An account with an enabled factor
 * needs its proof; with no proof, as in Verification Sign-in (ADR-0054), only an
 * account with no factor is admitted.
 */
export async function authorizeMfaSession(
  transaction: AuthSqlClient,
  userId: string,
  proof: MfaSessionProof | undefined,
  now: Date,
): Promise<SessionAdmission | undefined> {
  const accounts = await authQueryRows(
    transaction,
    'SELECT status FROM user_accounts WHERE id = $1 FOR SHARE',
    [userId],
  );
  if (accounts[0]?.['status'] !== 'active') return undefined;

  const factors = await authQueryRows(
    transaction,
    `SELECT factor_id FROM user_mfa_factors
     WHERE user_account_id = $1 AND status = 'enabled' FOR SHARE`,
    [userId],
  );
  const factorId = factors[0]?.['factor_id'];
  if (factorId === undefined) {
    return proof === undefined ? admit(userId) : undefined;
  }
  if (typeof factorId !== 'string' || proof === undefined) return undefined;
  if (proof.kind === 'totp') {
    return proof.factorId === factorId ? admit(userId) : undefined;
  }

  const consumed = await transaction.userMfaRecoveryCode.updateMany({
    where: {
      userAccountId: userId,
      codeHash: proof.codeHash,
      consumedAt: null,
    },
    data: { consumedAt: now },
  });
  return consumed.count > 0 ? admit(userId) : undefined;
}
