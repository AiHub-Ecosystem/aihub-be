import { createOperatorUserAccountStatusRepository } from '@/modules/auth/public/user-account-status';
import type {
  DisableUserAccountResult,
  RestoreUserAccountResult,
  RevokeAllRefreshSessionsResult,
  UserAccountStatusPort,
} from '@/modules/auth/shared/application/user-account-status.port';
import { createOperatorAuthClient } from './operator-auth-client';
import { runOperatorCommand } from './operator-command-context';

interface OperatorStatusCommandInput {
  readonly databaseUrl: string;
  readonly actorUsername: string;
  readonly repository?: UserAccountStatusPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

/** One way to open the Auth client and choose where operator output goes. */
async function prepareStatusCommand(
  input: OperatorStatusCommandInput,
): Promise<{
  readonly repository: UserAccountStatusPort;
  readonly emit: (line: string) => void;
}> {
  return {
    emit: input.emit ?? console.log,
    repository:
      input.repository ??
      createOperatorUserAccountStatusRepository(
        await createOperatorAuthClient(input.databaseUrl),
      ),
  };
}

export interface DisableUserAccountCliInput {
  readonly databaseUrl: string;
  readonly user: string;
  readonly actorUsername: string;
  readonly repository?: UserAccountStatusPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export type DisableUserAccountCliOutcome = DisableUserAccountResult['kind'];

export async function runDisableUserAccountCommand(
  input: DisableUserAccountCliInput,
): Promise<DisableUserAccountCliOutcome> {
  const { repository, emit } = await prepareStatusCommand(input);
  const execution = await runOperatorCommand(
    repository,
    input.now,
    ({ requestId, occurredAt }) =>
      repository.disableUserAccount({
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
  const { repository, emit } = await prepareStatusCommand(input);
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
  const { repository, emit } = await prepareStatusCommand(input);
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
