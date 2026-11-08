import { AppError } from '@/common/errors/app-error';
import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import type {
  DisableUserAccountInput,
  DisableUserAccountResult,
  RestoreUserAccountInput,
  RestoreUserAccountResult,
  RevokeAllRefreshSessionsInput,
  RevokeAllRefreshSessionsResult,
  UserAccountStatusPort,
} from '@/modules/auth/shared/application/user-account-status.port';
import {
  type AuthRepositoryClient,
  type AuthSqlClient,
  type AuthTransactionClient,
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { ulid } from 'ulid';

const FIND_ACTIVE_ACTOR_SQL = `
  SELECT id
  FROM user_accounts
  WHERE username = $1 AND status = 'active'
`;

const LOCK_USER_ACCOUNT_SQL = `
  SELECT id, username, status
  FROM user_accounts
  WHERE id = $1 OR username = $1
  FOR UPDATE
`;

function rethrowDatabaseFailure(error: unknown): never {
  if (error instanceof AppError) {
    throw error;
  }
  if (isPostgresUnavailable(error)) {
    throw databaseUnavailableError(error);
  }
  throw error;
}

async function findActiveActorId(
  transaction: AuthSqlClient,
  username: string,
): Promise<string | undefined> {
  const actorRows = await authQueryRows<{ id: string }>(
    transaction,
    FIND_ACTIVE_ACTOR_SQL,
    [username],
  );
  return actorRows[0]?.id;
}

async function recordStatusAudit(
  transaction: AuthTransactionClient,
  input: {
    readonly userAccountId: string | null;
    readonly actorUserAccountId: string;
    readonly action:
      | 'user_account.disabled'
      | 'user_account.restored'
      | 'refresh_session.revoked_all';
    readonly requestId: string;
    readonly occurredAt: Date;
  },
): Promise<void> {
  const auditId = `uasa_${ulid()}`;
  await transaction.userAccountStatusAudit.create({
    data: {
      id: auditId,
      userAccountId: input.userAccountId,
      actorUserAccountId: input.actorUserAccountId,
      actorSource: 'self_declared_operator',
      action: input.action,
      requestId: input.requestId,
      occurredAt: input.occurredAt,
    },
  });
}

export class PostgresUserAccountStatusRepository
  implements UserAccountStatusPort
{
  constructor(
    private readonly client: AuthRepositoryClient & {
      close?(): Promise<void>;
    },
  ) {}

  async disableUserAccount(
    input: DisableUserAccountInput,
  ): Promise<DisableUserAccountResult> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const actorId = await findActiveActorId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) {
          return { kind: 'actor_invalid' };
        }

        const targetRows = await authQueryRows<{
          id: string;
          username: string;
          status: string;
        }>(transaction, LOCK_USER_ACCOUNT_SQL, [input.user]);
        const target = targetRows[0];
        if (target === undefined) {
          return { kind: 'user_not_found' };
        }

        if (target.status === 'disabled') {
          return {
            kind: 'unchanged',
            userId: target.id,
            username: target.username,
          };
        }

        await transaction.userAccount.update({
          where: { id: target.id },
          data: { status: 'disabled', updatedAt: input.occurredAt },
        });

        const refreshResult = await transaction.refreshToken.updateMany({
          where: { userAccountId: target.id, revokedAt: null },
          data: { revokedAt: input.occurredAt },
        });

        const webSessionResult = await transaction.webSession.updateMany({
          where: { userAccountId: target.id, revokedAt: null },
          data: { revokedAt: input.occurredAt },
        });

        const verificationResult =
          await transaction.emailVerificationToken.updateMany({
            where: { userAccountId: target.id, consumedAt: null },
            data: {
              consumedAt: input.occurredAt,
              consumedReason: 'superseded',
            },
          });

        const passwordResetResult =
          await transaction.passwordResetToken.updateMany({
            where: { userAccountId: target.id, consumedAt: null },
            data: { consumedAt: input.occurredAt },
          });

        await recordStatusAudit(transaction, {
          userAccountId: target.id,
          actorUserAccountId: actorId,
          action: 'user_account.disabled',
          requestId: input.requestId,
          occurredAt: input.occurredAt,
        });

        return {
          kind: 'disabled',
          userId: target.id,
          username: target.username,
          revokedSessions: {
            refreshTokens: refreshResult.count,
            webSessions: webSessionResult.count,
            verificationTokens: verificationResult.count,
            passwordResetTokens: passwordResetResult.count,
          },
        };
      });
    } catch (error) {
      rethrowDatabaseFailure(error);
    }
  }

  async restoreUserAccount(
    input: RestoreUserAccountInput,
  ): Promise<RestoreUserAccountResult> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const actorId = await findActiveActorId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) {
          return { kind: 'actor_invalid' };
        }

        const targetRows = await authQueryRows<{
          id: string;
          username: string;
          status: string;
        }>(transaction, LOCK_USER_ACCOUNT_SQL, [input.user]);
        const target = targetRows[0];
        if (target === undefined) {
          return { kind: 'user_not_found' };
        }

        if (target.status === 'active') {
          return {
            kind: 'unchanged',
            userId: target.id,
            username: target.username,
          };
        }

        await transaction.userAccount.update({
          where: { id: target.id },
          data: { status: 'active', updatedAt: input.occurredAt },
        });

        await recordStatusAudit(transaction, {
          userAccountId: target.id,
          actorUserAccountId: actorId,
          action: 'user_account.restored',
          requestId: input.requestId,
          occurredAt: input.occurredAt,
        });

        return {
          kind: 'restored',
          userId: target.id,
          username: target.username,
        };
      });
    } catch (error) {
      rethrowDatabaseFailure(error);
    }
  }

  async revokeAllRefreshSessions(
    input: RevokeAllRefreshSessionsInput,
  ): Promise<RevokeAllRefreshSessionsResult> {
    try {
      return await authTransaction(this.client, async (transaction) => {
        const actorId = await findActiveActorId(
          transaction,
          input.actorUsername,
        );
        if (actorId === undefined) {
          return { kind: 'actor_invalid' };
        }

        const refreshResult = await transaction.refreshToken.updateMany({
          where: { revokedAt: null },
          data: { revokedAt: input.occurredAt },
        });

        await recordStatusAudit(transaction, {
          userAccountId: null,
          actorUserAccountId: actorId,
          action: 'refresh_session.revoked_all',
          requestId: input.requestId,
          occurredAt: input.occurredAt,
        });

        return {
          kind: 'revoked',
          revokedCount: refreshResult.count,
        };
      });
    } catch (error) {
      rethrowDatabaseFailure(error);
    }
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
