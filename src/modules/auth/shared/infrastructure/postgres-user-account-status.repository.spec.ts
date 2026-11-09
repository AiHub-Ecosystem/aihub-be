import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { PostgresUserAccountStatusRepository } from './postgres-user-account-status.repository';

const ACTOR_USERNAME = 'operator_alice';
const ACTOR_ID = 'usr_actor_01';
const TARGET_USER_ID = 'usr_target_01';
const TARGET_USERNAME = 'target_user';
const NOW = new Date('2026-11-08T12:00:00.000Z');
const REQUEST_ID = 'req_test_01';

describe('PostgresUserAccountStatusRepository', () => {
  describe('disableUserAccount', () => {
    it('refuses when actor is not an active account', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [], // FIND_ACTIVE_ACTOR_SQL returns empty
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.disableUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({ kind: 'actor_invalid' });
      expect(script.statements).toHaveLength(1);
    });

    it('refuses when target user is not found', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }], // actor found
        [], // target user not found
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.disableUserAccount({
        user: 'unknown_user',
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({ kind: 'user_not_found' });
      expect(script.statements).toHaveLength(2);
    });

    it('returns unchanged without modifying sessions when user is already disabled', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }],
        [{ id: TARGET_USER_ID, username: TARGET_USERNAME, status: 'disabled' }],
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.disableUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({
        kind: 'unchanged',
        userId: TARGET_USER_ID,
        username: TARGET_USERNAME,
      });
      // No mutation statements
      expect(script.statements).toHaveLength(2);
    });

    it('disables user and revokes all sessions and tokens in one atomic transaction', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }],
        [{ id: TARGET_USER_ID, username: TARGET_USERNAME, status: 'active' }],
        { id: TARGET_USER_ID, status: 'disabled' }, // userAccount.update
        { count: 3 }, // refreshToken.updateMany
        { count: 2 }, // webSession.updateMany
        { count: 1 }, // emailVerificationToken.updateMany
        { count: 1 }, // passwordResetToken.updateMany
        { id: 'uasa_123' }, // userAccountStatusAudit.create
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.disableUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({
        kind: 'disabled',
        userId: TARGET_USER_ID,
        username: TARGET_USERNAME,
        revokedSessions: {
          refreshTokens: 3,
          webSessions: 2,
          verificationTokens: 1,
          passwordResetTokens: 1,
        },
      });

      expect(script.opened).toBe(1);
      expect(
        script.statements.every(({ transaction }) => transaction === 1),
      ).toBe(true);

      const statementNames = script.statements.map((s) => s.name);
      expect(statementNames).toContain('userAccount.update');
      expect(statementNames).toContain('refreshToken.updateMany');
      expect(statementNames).toContain('webSession.updateMany');
      expect(statementNames).toContain('emailVerificationToken.updateMany');
      expect(statementNames).toContain('passwordResetToken.updateMany');
      expect(statementNames).toContain('userAccountStatusAudit.create');

      // Verify audit event properties
      const auditCreate = script.statements.find(
        (s) => s.name === 'userAccountStatusAudit.create',
      );
      expect(auditCreate).toBeDefined();
      if (auditCreate === undefined) throw new Error('auditCreate expected');
      const auditData = (
        auditCreate.args[0] as { data: Record<string, unknown> }
      ).data;
      expect(auditData['userAccountId']).toBe(TARGET_USER_ID);
      expect(auditData['actorUserAccountId']).toBe(ACTOR_ID);
      expect(auditData['action']).toBe('user_account.disabled');
      expect(auditData['actorSource']).toBe('self_declared_operator');
      expect(auditData['requestId']).toBe(REQUEST_ID);
      expect(auditData['occurredAt']).toBe(NOW);

      // Verify email verification token consumed_reason is superseded
      const tokenUpdate = script.statements.find(
        (s) => s.name === 'emailVerificationToken.updateMany',
      );
      if (tokenUpdate === undefined) throw new Error('tokenUpdate expected');
      const tokenData = (
        tokenUpdate.args[0] as { data: Record<string, unknown> }
      ).data;
      expect(tokenData['consumedReason']).toBe('superseded');
    });
  });

  describe('restoreUserAccount', () => {
    it('refuses when actor is not an active account', async () => {
      const script = new ScriptedPrisma();
      script.inside = [[]];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.restoreUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({ kind: 'actor_invalid' });
    });

    it('refuses when target user is not found', async () => {
      const script = new ScriptedPrisma();
      script.inside = [[{ id: ACTOR_ID }], []];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.restoreUserAccount({
        user: 'unknown_user',
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({ kind: 'user_not_found' });
    });

    it('returns unchanged when user is already active', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }],
        [{ id: TARGET_USER_ID, username: TARGET_USERNAME, status: 'active' }],
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.restoreUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({
        kind: 'unchanged',
        userId: TARGET_USER_ID,
        username: TARGET_USERNAME,
      });
      expect(script.statements).toHaveLength(2);
    });

    it('restores user to active without reviving any session, in one transaction', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }],
        [{ id: TARGET_USER_ID, username: TARGET_USERNAME, status: 'disabled' }],
        { id: TARGET_USER_ID, status: 'active' }, // userAccount.update
        { id: 'uasa_456' }, // userAccountStatusAudit.create
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.restoreUserAccount({
        user: TARGET_USERNAME,
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({
        kind: 'restored',
        userId: TARGET_USER_ID,
        username: TARGET_USERNAME,
      });

      expect(script.opened).toBe(1);
      const statementNames = script.statements.map((s) => s.name);
      expect(statementNames).toEqual([
        expect.stringContaining('SELECT id'),
        expect.stringContaining('SELECT id, username, status'),
        'userAccount.update',
        'userAccountStatusAudit.create',
      ]);

      const auditCreate = script.statements.find(
        (s) => s.name === 'userAccountStatusAudit.create',
      );
      if (auditCreate === undefined) throw new Error('auditCreate expected');
      const auditData = (
        auditCreate.args[0] as { data: Record<string, unknown> }
      ).data;
      expect(auditData['userAccountId']).toBe(TARGET_USER_ID);
      expect(auditData['actorUserAccountId']).toBe(ACTOR_ID);
      expect(auditData['action']).toBe('user_account.restored');
    });
  });

  describe('revokeAllRefreshSessions', () => {
    it('refuses when actor is not an active account', async () => {
      const script = new ScriptedPrisma();
      script.inside = [[]];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.revokeAllRefreshSessions({
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({ kind: 'actor_invalid' });
    });

    it('revokes all open refresh sessions across all accounts and creates global audit record', async () => {
      const script = new ScriptedPrisma();
      script.inside = [
        [{ id: ACTOR_ID }],
        { count: 42 }, // refreshToken.updateMany
        { id: 'uasa_789' }, // userAccountStatusAudit.create
      ];
      const repository = new PostgresUserAccountStatusRepository(
        script.client(),
      );

      const result = await repository.revokeAllRefreshSessions({
        actorUsername: ACTOR_USERNAME,
        requestId: REQUEST_ID,
        occurredAt: NOW,
      });

      expect(result).toEqual({
        kind: 'revoked',
        revokedCount: 42,
      });

      expect(script.opened).toBe(1);
      const auditCreate = script.statements.find(
        (s) => s.name === 'userAccountStatusAudit.create',
      );
      if (auditCreate === undefined) throw new Error('auditCreate expected');
      const auditData = (
        auditCreate.args[0] as { data: Record<string, unknown> }
      ).data;
      expect(auditData['userAccountId']).toBeNull();
      expect(auditData['actorUserAccountId']).toBe(ACTOR_ID);
      expect(auditData['action']).toBe('refresh_session.revoked_all');
    });
  });
});
