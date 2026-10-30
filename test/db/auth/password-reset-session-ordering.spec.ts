import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { Argon2PasswordHasher } from '@/modules/auth/local-credentials/infrastructure/argon2-password.hasher';
import { PostgresAuthMfaRepository } from '@/modules/auth/mfa/infrastructure/postgres-auth-mfa.repository';
import { PostgresPasswordResetTokenRepository } from '@/modules/auth/password-reset/infrastructure/postgres-password-reset-token.repository';
import { UNUSED_EMAIL_OUTBOX } from '@/modules/auth/testing/email-outbox.stub';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { PostgresRefreshSessionRepository } from '@/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository';
import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from '../shared/database';
import { pauseAtStatement, racePausedFirst } from './pause-before-commit';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './postgres-auth.client';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const RESET_AT = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);
const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'ordering@example.com';
/** The credential a sign-in verified before any reset ran. */
const STORED_PASSWORD_HASH = ARGON2ID_DUMMY_HASH;

let pool: Pool;
let client: PostgresAuthClient;
let refreshSessions: PostgresRefreshSessionRepository;
let passwordResets: PostgresPasswordResetTokenRepository;
let firstPasswordHash: string;
let secondPasswordHash: string;

beforeAll(async () => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  refreshSessions = new PostgresRefreshSessionRepository(client);
  passwordResets = new PostgresPasswordResetTokenRepository(
    client,
    UNUSED_EMAIL_OUTBOX,
  );
  const hasher = new Argon2PasswordHasher();
  firstPasswordHash = await hasher.hash('the first new passphrase');
  secondPasswordHash = await hasher.hash('the second new passphrase');
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function newRefreshToken(): IssuedRefreshToken {
  const raw = randomBytes(32).toString('base64url');
  return {
    id: `rft_${ulid()}`,
    familyId: `rfs_${ulid()}`,
    raw,
    hash: sha256(raw),
    expiresAt: new Date(NOW.getTime() + 30 * DAY),
  };
}

/** An active account with one open Refresh Token and one open reset token. */
async function seedTarget(): Promise<{
  readonly userId: string;
  readonly resetHash: string;
  readonly refresh: IssuedRefreshToken;
}> {
  const userId = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [userId, `user-${userId.slice(4, 16).toLowerCase()}`, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [`auth_${ulid()}`, userId, EMAIL, STORED_PASSWORD_HASH, NOW],
  );
  const refresh = newRefreshToken();
  await pool.query(
    `INSERT INTO refresh_tokens (
       id, family_id, user_account_id, token_hash, issued_at, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      refresh.id,
      refresh.familyId,
      userId,
      refresh.hash,
      NOW,
      refresh.expiresAt,
    ],
  );
  const resetHash = sha256(randomBytes(32).toString('base64url'));
  await passwordResets.issuePasswordResetToken({
    email: EMAIL,
    tokenId: `prt_${ulid()}`,
    tokenHash: resetHash,
    tokenExpiresAt: new Date(NOW.getTime() + DAY),
    now: NOW,
  });
  return { userId, resetHash, refresh };
}

async function durableState(userId: string): Promise<{
  readonly openRefreshTokens: number;
  readonly totalRefreshTokens: number;
  readonly passwordHash: string;
}> {
  const refresh = await pool.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM refresh_tokens WHERE user_account_id = $1',
    [userId],
  );
  const identity = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM auth_identities
     WHERE user_account_id = $1 AND provider = 'password'`,
    [userId],
  );
  return {
    openRefreshTokens: refresh.rows.filter((row) => row.revoked_at === null)
      .length,
    totalRefreshTokens: refresh.rows.length,
    passwordHash: identity.rows[0]?.password_hash ?? '',
  };
}

function reset(
  repository: PostgresPasswordResetTokenRepository,
  resetHash: string,
  passwordHash = firstPasswordHash,
) {
  return repository.consumePasswordReset({
    tokenHash: resetHash,
    passwordHash,
    now: RESET_AT,
  });
}

describe('a password reset and a sign-in that verified the old password', () => {
  it.each(['reset', 'login'] as const)(
    'leaves no open Refresh Session from the old password when %s takes the lock first',
    async (firstOperation) => {
      const { userId, resetHash } = await seedTarget();
      const login = (repository: PostgresRefreshSessionRepository) =>
        repository.createRefreshSession({
          userId,
          token: newRefreshToken(),
          issuedAt: RESET_AT,
          expectedPasswordHash: STORED_PASSWORD_HASH,
        });
      const asFirst = (pausedClient: PostgresAuthClient) =>
        firstOperation === 'reset'
          ? reset(
              new PostgresPasswordResetTokenRepository(
                pausedClient,
                UNUSED_EMAIL_OUTBOX,
              ),
              resetHash,
            )
          : login(new PostgresRefreshSessionRepository(pausedClient));

      const results = await racePausedFirst<unknown, unknown>(
        pool,
        client,
        asFirst,
        () =>
          firstOperation === 'reset'
            ? login(refreshSessions)
            : reset(passwordResets, resetHash),
      );

      expect(results).toEqual(
        firstOperation === 'reset'
          ? [{ kind: 'reset' }, false]
          : [true, { kind: 'reset' }],
      );
      expect(await durableState(userId)).toEqual({
        openRefreshTokens: 0,
        totalRefreshTokens: firstOperation === 'reset' ? 1 : 2,
        passwordHash: firstPasswordHash,
      });
    },
  );
});

describe('a password reset and a Refresh Token rotation', () => {
  it.each(['reset', 'rotation'] as const)(
    'leaves no open Refresh Token from before the reset when %s takes the lock first',
    async (firstOperation) => {
      const { userId, resetHash, refresh } = await seedTarget();
      const rotate = (repository: PostgresRefreshSessionRepository) =>
        repository.rotateRefreshToken({
          tokenId: refresh.id,
          tokenHash: refresh.hash,
          successor: newRefreshToken(),
          now: RESET_AT,
        });
      const asFirst = (pausedClient: PostgresAuthClient) =>
        firstOperation === 'reset'
          ? reset(
              new PostgresPasswordResetTokenRepository(
                pausedClient,
                UNUSED_EMAIL_OUTBOX,
              ),
              resetHash,
            )
          : rotate(new PostgresRefreshSessionRepository(pausedClient));

      const results = await racePausedFirst<unknown, unknown>(
        pool,
        client,
        asFirst,
        () =>
          firstOperation === 'reset'
            ? rotate(refreshSessions)
            : reset(passwordResets, resetHash),
      );

      expect(results).toEqual(
        firstOperation === 'reset'
          ? [{ kind: 'reset' }, { kind: 'invalid', reason: 'revoked' }]
          : [{ kind: 'rotated', userId }, { kind: 'reset' }],
      );
      expect((await durableState(userId)).openRefreshTokens).toBe(0);
    },
  );

  it('queues a rotation behind a reset that holds the account instead of deadlocking', async () => {
    const { userId, resetHash, refresh } = await seedTarget();
    // The reset takes its locks, then stops just before it revokes the Refresh
    // Tokens, so a rotation can reach the account while the reset holds it.
    const gated = pauseAtStatement(
      client,
      (statement) =>
        statement.kind === 'model' &&
        statement.model === 'refreshToken' &&
        statement.action === 'updateMany',
    );

    const resetting = reset(
      new PostgresPasswordResetTokenRepository(
        gated.client,
        UNUSED_EMAIL_OUTBOX,
      ),
      resetHash,
    );
    let rotating:
      | ReturnType<typeof refreshSessions.rotateRefreshToken>
      | undefined;
    try {
      await Promise.race([
        gated.reached,
        resetting.then(() => {
          throw new Error('the reset finished before it reached revocation');
        }),
      ]);
      rotating = refreshSessions.rotateRefreshToken({
        tokenId: refresh.id,
        tokenHash: refresh.hash,
        successor: newRefreshToken(),
        now: RESET_AT,
      });
      await waitForBlockedBy(pool, gated.pid());
      gated.resume();

      await expect(Promise.all([resetting, rotating])).resolves.toEqual([
        { kind: 'reset' },
        { kind: 'invalid', reason: 'revoked' },
      ]);
      expect((await durableState(userId)).openRefreshTokens).toBe(0);
    } finally {
      gated.resume();
      await Promise.allSettled([resetting, rotating]);
    }
  });
});

describe('a password reset request and Password Reset consumption', () => {
  it.each(['issue', 'consume'] as const)(
    'serializes reset-link %s with consumption under the account lock',
    async (firstOperation) => {
      const { userId, resetHash } = await seedTarget();
      const nextResetHash = sha256(randomBytes(32).toString('base64url'));
      const issue = (repository: PostgresPasswordResetTokenRepository) =>
        repository.issuePasswordResetToken({
          email: EMAIL,
          tokenId: `prt_${ulid()}`,
          tokenHash: nextResetHash,
          tokenExpiresAt: new Date(RESET_AT.getTime() + DAY),
          now: RESET_AT,
        });
      const asFirst = (pausedClient: PostgresAuthClient) =>
        firstOperation === 'issue'
          ? issue(
              new PostgresPasswordResetTokenRepository(
                pausedClient,
                UNUSED_EMAIL_OUTBOX,
              ),
            )
          : reset(
              new PostgresPasswordResetTokenRepository(
                pausedClient,
                UNUSED_EMAIL_OUTBOX,
              ),
              resetHash,
            );

      const results = await racePausedFirst<unknown, unknown>(
        pool,
        client,
        asFirst,
        () =>
          firstOperation === 'issue'
            ? reset(passwordResets, resetHash)
            : issue(passwordResets),
      );

      expect(results).toEqual(
        firstOperation === 'issue'
          ? [{ email: EMAIL }, { kind: 'invalid', reason: 'consumed' }]
          : [{ kind: 'reset' }, { email: EMAIL }],
      );
      expect(await durableState(userId)).toMatchObject({
        openRefreshTokens: firstOperation === 'issue' ? 1 : 0,
        passwordHash:
          firstOperation === 'issue' ? STORED_PASSWORD_HASH : firstPasswordHash,
      });
      const resetTokens = await pool.query<{ open: string }>(
        `SELECT COUNT(*) FILTER (WHERE consumed_at IS NULL)::text AS open
         FROM password_reset_tokens WHERE user_account_id = $1`,
        [userId],
      );
      expect(Number(resetTokens.rows[0]?.open ?? 0)).toBe(1);
    },
  );
});

describe('MFA removal and a Refresh Token rotation', () => {
  it.each(['removal', 'rotation'] as const)(
    'leaves no open Refresh Token when %s takes the account lock first',
    async (firstOperation) => {
      const { userId, refresh } = await seedTarget();
      const factorId = `mfa_${ulid()}`;
      await pool.query(
        `INSERT INTO user_mfa_factors (
           factor_id, user_account_id, secret_key_id, secret_ciphertext,
           status, created_at, updated_at
         ) VALUES ($1, $2, 'test-key', 'test-ciphertext', 'enabled', $3, $3)`,
        [factorId, userId, NOW],
      );
      const successor = { ...newRefreshToken(), familyId: refresh.familyId };
      const rotate = (repository: PostgresRefreshSessionRepository) =>
        repository.rotateRefreshToken({
          tokenId: refresh.id,
          tokenHash: refresh.hash,
          successor,
          now: RESET_AT,
        });
      const remove = (repository: PostgresAuthMfaRepository) =>
        repository.removeFactor({
          factorId,
          userId,
          email: EMAIL,
          expectedPasswordHash: STORED_PASSWORD_HASH,
          emailDelivery: undefined,
          now: RESET_AT,
        });
      const asFirst = (pausedClient: PostgresAuthClient) =>
        firstOperation === 'removal'
          ? remove(
              new PostgresAuthMfaRepository(pausedClient, UNUSED_EMAIL_OUTBOX),
            )
          : rotate(new PostgresRefreshSessionRepository(pausedClient));

      const results = await racePausedFirst<unknown, unknown>(
        pool,
        client,
        asFirst,
        () =>
          firstOperation === 'removal'
            ? rotate(refreshSessions)
            : remove(
                new PostgresAuthMfaRepository(client, UNUSED_EMAIL_OUTBOX),
              ),
      );

      expect(results).toEqual(
        firstOperation === 'removal'
          ? [true, { kind: 'invalid', reason: 'revoked' }]
          : [{ kind: 'rotated', userId }, true],
      );
      expect(await durableState(userId)).toMatchObject({
        openRefreshTokens: 0,
        totalRefreshTokens: firstOperation === 'removal' ? 1 : 2,
        passwordHash: STORED_PASSWORD_HASH,
      });
      const factors = await pool.query<{ factor_id: string }>(
        'SELECT factor_id FROM user_mfa_factors WHERE user_account_id = $1',
        [userId],
      );
      expect(factors.rows).toHaveLength(0);
    },
  );
});

describe('two resets consuming one Password Reset Token', () => {
  it('lets one win and answers the other as an already consumed token', async () => {
    const { userId, resetHash } = await seedTarget();

    const results = await racePausedFirst<unknown, unknown>(
      pool,
      client,
      (pausedClient) =>
        reset(
          new PostgresPasswordResetTokenRepository(
            pausedClient,
            UNUSED_EMAIL_OUTBOX,
          ),
          resetHash,
          firstPasswordHash,
        ),
      () => reset(passwordResets, resetHash, secondPasswordHash),
    );

    expect(results).toEqual([
      { kind: 'reset' },
      { kind: 'invalid', reason: 'consumed' },
    ]);
    expect((await durableState(userId)).passwordHash).toBe(firstPasswordHash);
  });
});
