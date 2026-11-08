import { createHash, randomBytes } from 'node:crypto';
import type { ExecutionContext } from '@nestjs/common';
import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';
import type { EmailOutboxPort } from '@/modules/auth/email-delivery/application/email-outbox.port';
import { PostgresUserAccountStatusRepository } from '@/modules/auth/shared/infrastructure/postgres-user-account-status.repository';
import { PostgresUserAccessTokenRevocationRepository } from '@/modules/auth/user-access-tokens/infrastructure/postgres-user-access-token-revocation.repository';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import type {
  UserAccessTokenVerifierPort,
  VerifiedUserAccessToken,
} from '@/modules/auth/web-sessions/application/user-access-token.port';
import { PostgresRefreshSessionRepository } from '@/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository';
import { UserAccessJwtGuard } from '@/modules/auth/web-sessions/presentation/user-access-jwt.guard';
import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './postgres-auth.client';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function stubEmailOutbox(): EmailOutboxPort {
  return {
    withAdmission: async (_kind, op) => op(),
    reserveAuthenticationEmailRecipient: async () => true,
    queue: async () => undefined,
    withdraw: async () => undefined,
  };
}

function executionContext(
  request: Record<string, unknown>,
  response: { header: jest.Mock } = { header: jest.fn() },
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function newRefreshToken(familyId = `rfs_${ulid()}`): IssuedRefreshToken {
  const raw = randomBytes(32).toString('base64url');
  return {
    id: `rft_${ulid()}`,
    familyId,
    raw,
    hash: createHash('sha256').update(raw, 'utf8').digest('hex'),
    expiresAt: new Date(NOW.getTime() + 30 * DAY),
  };
}

let pool: Pool;
let client: PostgresAuthClient;
let statusRepository: PostgresUserAccountStatusRepository;
let userAccountRepository: PostgresUserAccountRepository;
let refreshSessionRepository: PostgresRefreshSessionRepository;
let tokenRevocations: PostgresUserAccessTokenRevocationRepository;

beforeAll(async () => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  statusRepository = new PostgresUserAccountStatusRepository(client);
  userAccountRepository = new PostgresUserAccountRepository(
    client,
    stubEmailOutbox(),
  );
  refreshSessionRepository = new PostgresRefreshSessionRepository(client);
  tokenRevocations = new PostgresUserAccessTokenRevocationRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query(
    'TRUNCATE TABLE refresh_tokens, user_access_token_revocations CASCADE',
  );
});

describe('User Account status and session revocation against PostgreSQL (Issue #367)', () => {
  async function seedAccount(
    username: string,
    status: 'active' | 'disabled' = 'active',
  ): Promise<string> {
    const id = `usr_${ulid()}`;
    await pool.query(
      `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4)`,
      [id, username, status, NOW],
    );
    return id;
  }

  it('disables account, revokes all sessions/tokens in 1 tx, refuses next Bearer and refresh, records audit, and preserves residual window on restore', async () => {
    const operatorId = await seedAccount('operator_alice', 'active');
    const targetUserId = await seedAccount('target_bob', 'active');

    // Seed Refresh Session
    const refresh = newRefreshToken();
    await pool.query(
      `INSERT INTO refresh_tokens (id, family_id, user_account_id, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        refresh.id,
        refresh.familyId,
        targetUserId,
        refresh.hash,
        NOW,
        refresh.expiresAt,
      ],
    );

    // Seed Web Session
    const webSessionId = `wbs_${ulid()}`;
    const webSessionHash = createHash('sha256')
      .update(randomBytes(32))
      .digest('hex');
    await pool.query(
      `INSERT INTO web_sessions (id, user_account_id, token_hash, created_at, expires_at, last_renewed_at)
       VALUES ($1, $2, $3, $4, $5, $4)`,
      [
        webSessionId,
        targetUserId,
        webSessionHash,
        NOW,
        new Date(NOW.getTime() + 30 * DAY),
      ],
    );

    // Seed Email Verification Token
    const verificationId = `evt_${ulid()}`;
    const verificationHash = createHash('sha256')
      .update(randomBytes(32))
      .digest('hex');
    await pool.query(
      `INSERT INTO email_verification_tokens (id, user_account_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        verificationId,
        targetUserId,
        verificationHash,
        new Date(NOW.getTime() + DAY),
        NOW,
      ],
    );

    // Seed Password Reset Token
    const passwordResetId = `prt_${ulid()}`;
    const passwordResetHash = createHash('sha256')
      .update(randomBytes(32))
      .digest('hex');
    await pool.query(
      `INSERT INTO password_reset_tokens (id, user_account_id, token_hash, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        passwordResetId,
        targetUserId,
        passwordResetHash,
        new Date(NOW.getTime() + DAY),
        NOW,
      ],
    );

    // Pre-disable checks: Bearer guard accepts, Refresh token is ready to rotate
    const preDisableVerified: VerifiedUserAccessToken = {
      userId: targetUserId,
      issuer: 'https://api.test.aihub.example.com',
      jti: 'jti_predisable_01',
      validUntil: new Date(NOW.getTime() + 900_000),
    };
    const verifier: UserAccessTokenVerifierPort = {
      verify: async () => preDisableVerified,
    };
    const guard = new UserAccessJwtGuard(
      verifier,
      userAccountRepository,
      tokenRevocations,
    );

    const bearerRequest = {
      headers: { authorization: 'Bearer compact.jwt.token' },
    };
    await expect(
      guard.canActivate(executionContext(bearerRequest)),
    ).resolves.toBe(true);

    // Now Operator disables target_bob
    const disableResult = await statusRepository.disableUserAccount({
      user: 'target_bob',
      actorUsername: 'operator_alice',
      requestId: 'req_disable_01',
      occurredAt: NOW,
    });

    expect(disableResult).toEqual({
      kind: 'disabled',
      userId: targetUserId,
      username: 'target_bob',
      revokedSessions: {
        refreshTokens: 1,
        webSessions: 1,
        verificationTokens: 1,
        passwordResetTokens: 1,
      },
    });

    // 1. In DB: user account status is disabled
    const userRow = (
      await pool.query<{ status: string }>(
        'SELECT status FROM user_accounts WHERE id = $1',
        [targetUserId],
      )
    ).rows[0];
    expect(userRow?.status).toBe('disabled');

    // 2. In DB: refresh_tokens revoked_at is set
    const refreshRow = (
      await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM refresh_tokens WHERE id = $1',
        [refresh.id],
      )
    ).rows[0];
    expect(refreshRow?.revoked_at).toEqual(NOW);

    // 3. In DB: web_sessions revoked_at is set
    const webSessionRow = (
      await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM web_sessions WHERE id = $1',
        [webSessionId],
      )
    ).rows[0];
    expect(webSessionRow?.revoked_at).toEqual(NOW);

    // 4. In DB: email_verification_tokens consumed_at and consumed_reason is superseded
    const verificationRow = (
      await pool.query<{
        consumed_at: Date | null;
        consumed_reason: string | null;
      }>(
        'SELECT consumed_at, consumed_reason FROM email_verification_tokens WHERE id = $1',
        [verificationId],
      )
    ).rows[0];
    expect(verificationRow?.consumed_at).toEqual(NOW);
    expect(verificationRow?.consumed_reason).toBe('superseded');

    // 5. In DB: password_reset_tokens consumed_at is set
    const passwordResetRow = (
      await pool.query<{ consumed_at: Date | null }>(
        'SELECT consumed_at FROM password_reset_tokens WHERE id = $1',
        [passwordResetId],
      )
    ).rows[0];
    expect(passwordResetRow?.consumed_at).toEqual(NOW);

    // 6. In DB: durable audit record created in user_account_status_audits
    const auditRows = (
      await pool.query<{
        id: string;
        user_account_id: string;
        actor_user_account_id: string;
        actor_source: string;
        action: string;
        request_id: string;
        occurred_at: Date;
      }>(
        'SELECT * FROM user_account_status_audits WHERE user_account_id = $1',
        [targetUserId],
      )
    ).rows;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      user_account_id: targetUserId,
      actor_user_account_id: operatorId,
      actor_source: 'self_declared_operator',
      action: 'user_account.disabled',
      request_id: 'req_disable_01',
      occurred_at: NOW,
    });

    // 7. Next Bearer request is REFUSED
    await expect(
      guard.canActivate(executionContext(bearerRequest)),
    ).rejects.toThrow('User access token is invalid');

    // 8. Next refresh request is REFUSED
    const successor = newRefreshToken(refresh.familyId);
    const rotationResult = await refreshSessionRepository.rotateRefreshToken({
      tokenId: refresh.id,
      tokenHash: refresh.hash,
      successor,
      now: new Date(NOW.getTime() + 1000),
    });
    expect(rotationResult.kind).toBe('invalid');
    expect(['inactive', 'revoked']).toContain(
      (rotationResult as { reason: string }).reason,
    );

    // 9. Operator restores account to active
    const restoreResult = await statusRepository.restoreUserAccount({
      user: 'target_bob',
      actorUsername: 'operator_alice',
      requestId: 'req_restore_01',
      occurredAt: new Date(NOW.getTime() + 5000),
    });
    expect(restoreResult).toEqual({
      kind: 'restored',
      userId: targetUserId,
      username: 'target_bob',
    });

    // Revoked refresh tokens remain revoked and STILL refused
    const rotationAfterRestore =
      await refreshSessionRepository.rotateRefreshToken({
        tokenId: refresh.id,
        tokenHash: refresh.hash,
        successor: newRefreshToken(refresh.familyId),
        now: new Date(NOW.getTime() + 6000),
      });
    expect(rotationAfterRestore).toEqual({
      kind: 'invalid',
      reason: 'revoked',
    });

    // Residual window test (ADR-0158): Pre-disable JWT whose exp has not passed is accepted again
    await expect(
      guard.canActivate(executionContext(bearerRequest)),
    ).resolves.toBe(true);

    // Second audit record created
    const restoreAuditRows = (
      await pool.query<{ action: string; request_id: string }>(
        "SELECT action, request_id FROM user_account_status_audits WHERE user_account_id = $1 AND action = 'user_account.restored'",
        [targetUserId],
      )
    ).rows;
    expect(restoreAuditRows).toHaveLength(1);
    expect(restoreAuditRows[0]?.request_id).toBe('req_restore_01');
  });

  it('revokes all refresh sessions across all accounts for incident key rotation', async () => {
    const operatorId = await seedAccount('operator_alice', 'active');
    const user1 = await seedAccount('user_1', 'active');
    const user2 = await seedAccount('user_2', 'active');

    const token1 = newRefreshToken();
    const token2 = newRefreshToken();
    await pool.query(
      `INSERT INTO refresh_tokens (id, family_id, user_account_id, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $5, $6)`,
      [
        token1.id,
        token1.familyId,
        user1,
        token1.hash,
        NOW,
        token1.expiresAt,
        token2.id,
        token2.familyId,
        user2,
        token2.hash,
      ],
    );

    const result = await statusRepository.revokeAllRefreshSessions({
      actorUsername: 'operator_alice',
      requestId: 'req_rotation_01',
      occurredAt: NOW,
    });

    expect(result).toEqual({
      kind: 'revoked',
      revokedCount: 2,
    });

    // Check all refresh tokens revoked
    const unrevokedCount = (
      await pool.query<{ count: string }>(
        'SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NULL',
      )
    ).rows[0]?.count;
    expect(Number(unrevokedCount)).toBe(0);

    // Audit row exists with user_account_id = null
    const audit = (
      await pool.query<{
        user_account_id: string | null;
        actor_user_account_id: string;
        action: string;
      }>(
        "SELECT * FROM user_account_status_audits WHERE action = 'refresh_session.revoked_all'",
      )
    ).rows[0];
    expect(audit).toBeDefined();
    expect(audit?.user_account_id).toBeNull();
    expect(audit?.actor_user_account_id).toBe(operatorId);
  });
});
