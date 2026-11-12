import type {
  DisableUserAccountResult,
  RestoreUserAccountResult,
  RevokeAllRefreshSessionsResult,
  UserAccountStatusPort,
} from '@/modules/auth/shared/application/user-account-status.port';
import { PostgresUserAccountStatusRepository } from '@/modules/auth/shared/infrastructure/postgres-user-account-status.repository';
import { createOperatorAuthClient } from './operator-auth-client';
import { runOperatorCommand } from './operator-command-context';

export interface DisableUserAccountCliInput {
  readonly databaseUrl: string;
  readonly user: string;
  readonly actorUsername: string;
  readonly repository?: UserAccountStatusPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type DisableUserAccountCliOutcome = DisableUserAccountResult['kind'];

/**
 * Disables a User Account and emits its revocation event before cleanup.
 */
export async function runDisableUserAccountCommand(
  input: DisableUserAccountCliInput,
): Promise<DisableUserAccountCliOutcome> {
  const emit = input.emit ?? console.log;
  const repository =
    input.repository ??
    new PostgresUserAccountStatusRepository(
      await createOperatorAuthClient(input.databaseUrl),
    );
  const execution = await runOperatorCommand(
    repository,
    input.now,
    async ({ requestId, occurredAt }) => {
      const result = await repository.disableUserAccount({
        user: input.user,
        actorUsername: input.actorUsername,
        requestId,
        occurredAt,
      });
      if (result.kind === 'disabled') {
        emit(
          JSON.stringify({
            event: 'web_session_revoked',
            request_id: requestId,
            occurred_at: occurredAt.toISOString(),
            user_account_id: result.userId,
            trigger: 'account_disabled',
            sessions_revoked: result.revokedSessions.webSessions,
          }),
        );
      }
      return result;
    },
  );
  const { result, context } = execution;
  const requestId = context.requestId;

  if (result.kind === 'user_not_found') {
    emit(`User Account ${input.user} was not found.`);
    return result.kind;
  }
  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }

  if (result.kind === 'unchanged') {
    emit(
      `User Account ${result.username} (${result.userId}) is already disabled; nothing was recorded.`,
    );
    return result.kind;
  }

  const {
    refreshTokens,
    webSessions,
    verificationTokens,
    passwordResetTokens,
  } = result.revokedSessions;
  emit(
    `Disabled User Account ${result.username} (${result.userId}) and revoked ${refreshTokens} refresh sessions, ${webSessions} web sessions, ${verificationTokens} verification tokens, and ${passwordResetTokens} password reset tokens; recorded as ${requestId}.`,
  );
  return result.kind;
}

export interface RestoreUserAccountCliInput {
  readonly databaseUrl: string;
  readonly user: string;
  readonly actorUsername: string;
  readonly repository?: UserAccountStatusPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type RestoreUserAccountCliOutcome = RestoreUserAccountResult['kind'];

export async function runRestoreUserAccountCommand(
  input: RestoreUserAccountCliInput,
): Promise<RestoreUserAccountCliOutcome> {
  const emit = input.emit ?? console.log;
  const repository =
    input.repository ??
    new PostgresUserAccountStatusRepository(
      await createOperatorAuthClient(input.databaseUrl),
    );
  const execution = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.restoreUserAccount({
        user: input.user,
        actorUsername: input.actorUsername,
        requestId,
        occurredAt,
      }),
  );
  const { result, context } = execution;
  const requestId = context.requestId;

  if (result.kind === 'user_not_found') {
    emit(`User Account ${input.user} was not found.`);
    return result.kind;
  }
  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }

  if (result.kind === 'unchanged') {
    emit(
      `User Account ${result.username} (${result.userId}) is already active; nothing was recorded.`,
    );
    return result.kind;
  }

  emit(
    `Restored User Account ${result.username} (${result.userId}) to active without restoring revoked sessions; recorded as ${requestId}.`,
  );
  return result.kind;
}

export interface RevokeAllRefreshSessionsCliInput {
  readonly databaseUrl: string;
  readonly actorUsername: string;
  readonly repository?: UserAccountStatusPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type RevokeAllRefreshSessionsCliOutcome =
  RevokeAllRefreshSessionsResult['kind'];

export async function runRevokeAllRefreshSessionsCommand(
  input: RevokeAllRefreshSessionsCliInput,
): Promise<RevokeAllRefreshSessionsCliOutcome> {
  const emit = input.emit ?? console.log;
  const repository =
    input.repository ??
    new PostgresUserAccountStatusRepository(
      await createOperatorAuthClient(input.databaseUrl),
    );
  const execution = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.revokeAllRefreshSessions({
        actorUsername: input.actorUsername,
        requestId,
        occurredAt,
      }),
  );
  const { result, context } = execution;
  const requestId = context.requestId;

  if (result.kind === 'actor_invalid') {
    emit(`${input.actorUsername} is not an active AIHUB User Account.`);
    return result.kind;
  }

  emit(
    `Revoked ${result.revokedCount} refresh sessions across all accounts; recorded as ${requestId}.`,
  );
  return result.kind;
}
