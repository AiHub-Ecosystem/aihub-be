import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import {
  type AuthRepositoryClient,
  authQueryRows,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import type { UserAccessTokenRevocationRecordPort } from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';

const REVOKE_SQL = `
  INSERT INTO user_access_token_revocations (
    issuer, jti, effective_expires_at
  ) VALUES ($1, $2, $3)
  ON CONFLICT (issuer, jti) DO UPDATE
    SET effective_expires_at = GREATEST(
      user_access_token_revocations.effective_expires_at,
      EXCLUDED.effective_expires_at
    )
`;

const IS_REVOKED_SQL = `
  SELECT EXISTS (
    SELECT 1
    FROM user_access_token_revocations
    WHERE issuer = $1 AND jti = $2 AND effective_expires_at >= $3
  ) AS revoked
`;

function rethrowDatabaseFailure(error: unknown): never {
  if (isPostgresUnavailable(error)) {
    throw databaseUnavailableError(error);
  }
  throw error;
}

export class PostgresUserAccessTokenRevocationRepository
  implements UserAccessTokenRevocationRecordPort
{
  constructor(private readonly client: AuthRepositoryClient) {}

  async revoke(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly effectiveExpiresAt: Date;
  }): Promise<void> {
    try {
      await authQueryRows(this.client, REVOKE_SQL, [
        input.issuer,
        input.jti,
        input.effectiveExpiresAt,
      ]);
    } catch (error) {
      rethrowDatabaseFailure(error);
    }
  }

  async isRevoked(input: {
    readonly issuer: string;
    readonly jti: string;
    readonly now: Date;
  }): Promise<boolean> {
    try {
      const rows = await authQueryRows<{ readonly revoked: boolean }>(
        this.client,
        IS_REVOKED_SQL,
        [input.issuer, input.jti, input.now],
      );
      return rows[0]?.revoked === true;
    } catch (error) {
      rethrowDatabaseFailure(error);
    }
  }
}
