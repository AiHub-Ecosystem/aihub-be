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
  runDisableUserAccountCommand,
  runRestoreUserAccountCommand,
  runRevokeAllRefreshSessionsCommand,
} from './user-account-status';

class UserAccountStatusFake implements UserAccountStatusPort {
  disableCalls: DisableUserAccountInput[] = [];
  restoreCalls: RestoreUserAccountInput[] = [];
  revokeAllCalls: RevokeAllRefreshSessionsInput[] = [];
  closed = false;

  constructor(
    private readonly disableResult: DisableUserAccountResult = {
      kind: 'disabled',
      userId: 'usr_target',
      username: 'targetuser',
      revokedSessions: {
        refreshTokens: 2,
        webSessions: 1,
        verificationTokens: 1,
        passwordResetTokens: 1,
      },
    },
    private readonly restoreResult: RestoreUserAccountResult = {
      kind: 'restored',
      userId: 'usr_target',
      username: 'targetuser',
    },
    private readonly revokeAllResult: RevokeAllRefreshSessionsResult = {
      kind: 'revoked',
      revokedCount: 15,
    },
  ) {}

  async disableUserAccount(
    input: DisableUserAccountInput,
  ): Promise<DisableUserAccountResult> {
    this.disableCalls.push(input);
    return this.disableResult;
  }

  async restoreUserAccount(
    input: RestoreUserAccountInput,
  ): Promise<RestoreUserAccountResult> {
    this.restoreCalls.push(input);
    return this.restoreResult;
  }

  async revokeAllRefreshSessions(
    input: RevokeAllRefreshSessionsInput,
  ): Promise<RevokeAllRefreshSessionsResult> {
    this.revokeAllCalls.push(input);
    return this.revokeAllResult;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe('runDisableUserAccountCommand', () => {
  it('disables user account, emits revoked counts and request ID, and closes repository', async () => {
    const repository = new UserAccountStatusFake();
    const lines: string[] = [];
    const outcome = await runDisableUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'targetuser',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
      now: () => new Date('2026-11-08T10:00:00.000Z'),
    });

    expect(outcome).toBe('disabled');
    expect(repository.disableCalls).toHaveLength(1);
    expect(repository.disableCalls[0]?.user).toBe('targetuser');
    expect(repository.disableCalls[0]?.actorUsername).toBe('operator_alice');
    expect(repository.closed).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /Disabled User Account targetuser \(usr_target\) and revoked 2 refresh sessions, 1 web sessions, 1 verification tokens, and 1 password reset tokens; recorded as req_/,
    );
    const requestId = repository.disableCalls[0]?.requestId;
    expect(requestId).toMatch(/^req_/);
    const securityEvent: unknown = JSON.parse(lines[1] ?? 'null');
    expect(securityEvent).toEqual({
      event: 'web_session_revoked',
      request_id: requestId,
      occurred_at: '2026-11-08T10:00:00.000Z',
      user_account_id: 'usr_target',
      trigger: 'account_disabled',
      sessions_revoked: 1,
    });
    expect(lines[1]).not.toContain('targetuser');
    expect(lines[1]).not.toContain('operator_alice');
  });

  it('handles user_not_found', async () => {
    const repository = new UserAccountStatusFake({ kind: 'user_not_found' });
    const lines: string[] = [];
    const outcome = await runDisableUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'unknown_user',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('user_not_found');
    expect(lines).toEqual(['User Account unknown_user was not found.']);
    expect(repository.closed).toBe(true);
  });

  it('handles actor_invalid', async () => {
    const repository = new UserAccountStatusFake({ kind: 'actor_invalid' });
    const lines: string[] = [];
    const outcome = await runDisableUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'targetuser',
      actorUsername: 'bad_operator',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('actor_invalid');
    expect(lines).toEqual([
      'bad_operator is not an active AIHUB User Account.',
    ]);
    expect(repository.closed).toBe(true);
  });

  it('handles unchanged when already disabled', async () => {
    const repository = new UserAccountStatusFake({
      kind: 'unchanged',
      userId: 'usr_target',
      username: 'targetuser',
    });
    const lines: string[] = [];
    const outcome = await runDisableUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'targetuser',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('unchanged');
    expect(lines).toEqual([
      'User Account targetuser (usr_target) is already disabled; nothing was recorded.',
    ]);
  });
});

describe('runRestoreUserAccountCommand', () => {
  it('restores user account to active, reports request ID, and closes repository', async () => {
    const repository = new UserAccountStatusFake();
    const lines: string[] = [];
    const outcome = await runRestoreUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'targetuser',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('restored');
    expect(repository.restoreCalls).toHaveLength(1);
    expect(repository.closed).toBe(true);
    expect(lines[0]).toMatch(
      /Restored User Account targetuser \(usr_target\) to active without restoring revoked sessions; recorded as req_/,
    );
  });

  it('handles user_not_found', async () => {
    const repository = new UserAccountStatusFake(undefined, {
      kind: 'user_not_found',
    });
    const lines: string[] = [];
    const outcome = await runRestoreUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'unknown_user',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('user_not_found');
    expect(lines[0]).toBe('User Account unknown_user was not found.');
  });

  it('handles unchanged when already active', async () => {
    const repository = new UserAccountStatusFake(undefined, {
      kind: 'unchanged',
      userId: 'usr_target',
      username: 'targetuser',
    });
    const lines: string[] = [];
    const outcome = await runRestoreUserAccountCommand({
      databaseUrl: 'postgres://unused',
      user: 'targetuser',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('unchanged');
    expect(lines[0]).toBe(
      'User Account targetuser (usr_target) is already active; nothing was recorded.',
    );
  });
});

describe('runRevokeAllRefreshSessionsCommand', () => {
  it('revokes all refresh sessions across all accounts', async () => {
    const repository = new UserAccountStatusFake();
    const lines: string[] = [];
    const outcome = await runRevokeAllRefreshSessionsCommand({
      databaseUrl: 'postgres://unused',
      actorUsername: 'operator_alice',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('revoked');
    expect(repository.revokeAllCalls).toHaveLength(1);
    expect(repository.closed).toBe(true);
    expect(lines[0]).toMatch(
      /Revoked 15 refresh sessions across all accounts; recorded as req_/,
    );
  });

  it('handles actor_invalid', async () => {
    const repository = new UserAccountStatusFake(undefined, undefined, {
      kind: 'actor_invalid',
    });
    const lines: string[] = [];
    const outcome = await runRevokeAllRefreshSessionsCommand({
      databaseUrl: 'postgres://unused',
      actorUsername: 'bad_operator',
      repository,
      emit: (l) => lines.push(l),
    });

    expect(outcome).toBe('actor_invalid');
    expect(lines[0]).toBe('bad_operator is not an active AIHUB User Account.');
  });
});
