import type { MfaSessionProof } from '@/modules/auth/application/auth-mfa-repository.port';
import type { PostgresAuthQueryClient } from './postgres-auth.client';

export async function authorizeMfaSession(
  transaction: PostgresAuthQueryClient,
  userId: string,
  proof: MfaSessionProof | undefined,
  now: Date,
): Promise<boolean> {
  const accounts = await transaction.query(
    'SELECT status FROM user_accounts WHERE id = $1 FOR SHARE',
    [userId],
  );
  if (accounts[0]?.['status'] !== 'active') return false;

  const factors = await transaction.query(
    `SELECT factor_id FROM user_mfa_factors
     WHERE user_account_id = $1 AND status = 'enabled' FOR SHARE`,
    [userId],
  );
  const factorId = factors[0]?.['factor_id'];
  if (factorId === undefined) return proof === undefined;
  if (typeof factorId !== 'string' || proof === undefined) return false;
  if (proof.kind === 'totp') return proof.factorId === factorId;

  const consumed = await transaction.query(
    `UPDATE user_mfa_recovery_codes
     SET consumed_at = $3
     WHERE user_account_id = $1 AND code_hash = $2 AND consumed_at IS NULL
     RETURNING code_hash`,
    [userId, proof.codeHash, now],
  );
  return consumed.length > 0;
}
