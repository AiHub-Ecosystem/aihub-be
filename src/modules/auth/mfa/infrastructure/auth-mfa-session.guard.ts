import type { MfaSessionProof } from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import {
  type AuthSqlClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';

export async function authorizeMfaSession(
  transaction: AuthSqlClient,
  userId: string,
  proof: MfaSessionProof | undefined,
  now: Date,
): Promise<boolean> {
  const accounts = await authQueryRows(
    transaction,
    'SELECT status FROM user_accounts WHERE id = $1 FOR SHARE',
    [userId],
  );
  if (accounts[0]?.['status'] !== 'active') return false;

  const factors = await authQueryRows(
    transaction,
    `SELECT factor_id FROM user_mfa_factors
     WHERE user_account_id = $1 AND status = 'enabled' FOR SHARE`,
    [userId],
  );
  const factorId = factors[0]?.['factor_id'];
  if (factorId === undefined) return proof === undefined;
  if (typeof factorId !== 'string' || proof === undefined) return false;
  if (proof.kind === 'totp') return proof.factorId === factorId;

  const consumed = await transaction.userMfaRecoveryCode.updateMany({
    where: {
      userAccountId: userId,
      codeHash: proof.codeHash,
      consumedAt: null,
    },
    data: { consumedAt: now },
  });
  return consumed.count > 0;
}
