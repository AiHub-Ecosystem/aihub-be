import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import type { PasswordChangeRepositoryPort } from '@/modules/auth/local-credentials/application/password-change-repository.port';
import {
  type AuthRepositoryClient,
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { insertEmailDelivery } from '@/modules/auth/shared/infrastructure/local-auth-statements';
import { revokeUserWebSessions } from '@/modules/auth/shared/infrastructure/web-session-statements';

interface PasswordIdentityRow {
  readonly passwordHash: string;
}

interface AccountRow {
  readonly status: string;
}

const LOCK_ACCOUNT_SQL =
  'SELECT status FROM user_accounts WHERE id = $1 FOR UPDATE';
const LOCK_PASSWORD_IDENTITY_SQL = `
  SELECT password_hash AS "passwordHash"
  FROM auth_identities
  WHERE user_account_id = $1 AND provider = 'password'
  FOR UPDATE
`;

export class PostgresPasswordChangeRepository
  implements PasswordChangeRepositoryPort
{
  constructor(
    private readonly client: AuthRepositoryClient,
    private readonly emailOutbox: EmailOutboxPort,
  ) {}

  async changePassword(
    input: Parameters<PasswordChangeRepositoryPort['changePassword']>[0],
  ): Promise<boolean> {
    return authTransaction(this.client, async (transaction) => {
      const accountRows = await authQueryRows<AccountRow>(
        transaction,
        LOCK_ACCOUNT_SQL,
        [input.userId],
      );
      if (accountRows[0]?.status !== 'active') return false;

      const identities = await authQueryRows<PasswordIdentityRow>(
        transaction,
        LOCK_PASSWORD_IDENTITY_SQL,
        [input.userId],
      );
      const identity = identities[0];
      if (
        identity === undefined ||
        identity.passwordHash !== input.expectedPasswordHash
      ) {
        return false;
      }

      const updated = await transaction.authIdentity.updateMany({
        where: {
          userAccountId: input.userId,
          provider: 'password',
          passwordHash: input.expectedPasswordHash,
        },
        data: { passwordHash: input.passwordHash, updatedAt: input.now },
      });
      if (updated.count === 0) return false;
      await transaction.passwordResetToken.updateMany({
        where: { userAccountId: input.userId, consumedAt: null },
        data: { consumedAt: input.now },
      });
      await transaction.refreshToken.updateMany({
        where: {
          userAccountId: input.userId,
          revokedAt: null,
          ...(input.session.kind === 'refresh'
            ? { familyId: { not: input.session.id } }
            : {}),
        },
        data: { revokedAt: input.now },
      });
      await revokeUserWebSessions(
        transaction,
        input.userId,
        input.now,
        input.session.kind === 'web' ? input.session.id : undefined,
      );
      await insertEmailDelivery(
        transaction,
        this.emailOutbox,
        input.emailDelivery,
      );
      return true;
    });
  }
}
