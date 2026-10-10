import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import type { MfaSessionProof } from '@/modules/auth/application/auth-mfa-repository.port';
import type {
  EmailDeliveryTransaction,
  InsertEmailDeliveryRequestInput,
} from '@/modules/auth/application/email-delivery-request.port';
import { PostgresAuthMfaRepository } from '@/modules/auth/infrastructure/postgres-auth-mfa.repository';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from '@/modules/auth/infrastructure/postgres-auth.client';
import { PostgresEmailDeliveryRequestRepository } from '@/modules/auth/infrastructure/postgres-email-delivery-request.repository';
import { PostgresLocalAuthRepository } from '@/modules/auth/infrastructure/postgres-local-auth.repository';
import { PostgresWebSessionRepository } from '@/modules/auth/infrastructure/postgres-web-session.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from './database';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const EMAIL = 'mfa@example.com';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA';

class FailingEmailRequests extends PostgresEmailDeliveryRequestRepository {
  async insert(
    _transaction: EmailDeliveryTransaction,
    _input: InsertEmailDeliveryRequestInput,
  ): Promise<void> {
    throw new Error('email delivery request store is unavailable');
  }
}

let pool: Pool;
let client: PostgresAuthClient;
let refreshSessions: PostgresLocalAuthRepository;
let webSessions: PostgresWebSessionRepository;
let mfa: PostgresAuthMfaRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  refreshSessions = new PostgresLocalAuthRepository(client);
  webSessions = new PostgresWebSessionRepository(client);
  mfa = new PostgresAuthMfaRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

function tokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

async function seedAccount(): Promise<string> {
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
    [`auth_${ulid()}`, userId, EMAIL, PASSWORD_HASH, NOW],
  );
  return userId;
}

async function seedEnabledFactor(
  userId: string,
  codeHash: string,
): Promise<string> {
  const factorId = `mfa_${ulid()}`;
  await pool.query(
    `INSERT INTO user_mfa_factors (
       factor_id, user_account_id, secret_key_id, secret_ciphertext,
       status, created_at, updated_at
     ) VALUES ($1, $2, 'test-key', 'ciphertext', 'enabled', $3, $3)`,
    [factorId, userId, NOW],
  );
  await pool.query(
    `INSERT INTO user_mfa_recovery_codes (user_account_id, code_hash, created_at)
     VALUES ($1, $2, $3)`,
    [userId, codeHash, NOW],
  );
  return factorId;
}

function recoveryProof(codeHash: string): MfaSessionProof {
  return { kind: 'recovery', codeHash };
}

async function createWebSession(
  userId: string,
  mfaProof?: MfaSessionProof,
): Promise<boolean> {
  const now = new Date(NOW);
  return webSessions.createWebSession({
    sessionId: `wbs_${ulid()}`,
    userId,
    expectedPasswordHash: PASSWORD_HASH,
    token: {
      raw: 'raw-web-session-token',
      hash: tokenHash(),
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    },
    now,
    ...(mfaProof === undefined ? {} : { mfaProof }),
  });
}

function delivery(
  kind: 'mfa_enabled_notification' | 'mfa_removed_notification',
): InsertEmailDeliveryRequestInput {
  return {
    id: `edr_${ulid()}`,
    kind,
    payloadCiphertext: 'sealed-email-only',
    createdAt: NOW,
  };
}

describe('MFA session persistence on PostgreSQL', () => {
  it('allows only one concurrent Web Session to consume a Recovery Code', async () => {
    const userId = await seedAccount();
    const codeHash = createHash('sha256').update('one-time-code').digest('hex');
    await seedEnabledFactor(userId, codeHash);

    const outcomes = await Promise.all([
      createWebSession(userId, recoveryProof(codeHash)),
      createWebSession(userId, recoveryProof(codeHash)),
    ]);

    expect(outcomes.sort()).toEqual([false, true]);
    const rows = await pool.query(
      'SELECT id FROM web_sessions WHERE user_account_id = $1',
      [userId],
    );
    expect(rows.rowCount).toBe(1);
    const recovery = await pool.query<{ consumed_at: Date | null }>(
      `SELECT consumed_at FROM user_mfa_recovery_codes
       WHERE user_account_id = $1 AND code_hash = $2`,
      [userId, codeHash],
    );
    expect(recovery.rows[0]?.consumed_at).toBeInstanceOf(Date);
  });

  it('allows only one concurrent Refresh Session to consume a Recovery Code', async () => {
    const userId = await seedAccount();
    const codeHash = createHash('sha256')
      .update('another-one-time-code')
      .digest('hex');
    await seedEnabledFactor(userId, codeHash);
    const proof = recoveryProof(codeHash);

    const outcomes = await Promise.all(
      [1, 2].map((index) =>
        refreshSessions.createRefreshSession({
          userId,
          token: {
            id: `rft_${ulid()}`,
            familyId: `rfs_${ulid()}`,
            raw: `raw-refresh-token-${index}`,
            hash: tokenHash(),
            expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
          },
          issuedAt: NOW,
          mfaProof: proof,
        }),
      ),
    );

    expect(outcomes.sort()).toEqual([false, true]);
    const rows = await pool.query(
      'SELECT id FROM refresh_tokens WHERE user_account_id = $1',
      [userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('rolls back MFA removal if its notice cannot be queued, then revokes both session types atomically', async () => {
    const userId = await seedAccount();
    const refreshTokenHash = tokenHash();
    await refreshSessions.createRefreshSession({
      userId,
      token: {
        id: `rft_${ulid()}`,
        familyId: `rfs_${ulid()}`,
        raw: 'raw-refresh-token',
        hash: refreshTokenHash,
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
      issuedAt: NOW,
    });
    await createWebSession(userId);
    const codeHash = createHash('sha256')
      .update('unused-recovery-code')
      .digest('hex');
    const factorId = await seedEnabledFactor(userId, codeHash);
    const notice = delivery('mfa_removed_notification');

    const failingRepository = new PostgresAuthMfaRepository(
      client,
      new FailingEmailRequests(),
    );
    await expect(
      failingRepository.removeFactor({
        factorId,
        userId,
        email: EMAIL,
        expectedPasswordHash: PASSWORD_HASH,
        emailDelivery: notice,
        now: NOW,
      }),
    ).rejects.toThrow('email delivery request store is unavailable');

    expect(
      await pool.query(
        'SELECT factor_id FROM user_mfa_factors WHERE user_account_id = $1',
        [userId],
      ),
    ).toHaveProperty('rowCount', 1);
    expect(
      await pool.query(
        'SELECT revoked_at FROM web_sessions WHERE user_account_id = $1',
        [userId],
      ),
    ).toMatchObject({ rows: [expect.objectContaining({ revoked_at: null })] });
    expect(
      await pool.query(
        'SELECT revoked_at FROM refresh_tokens WHERE user_account_id = $1',
        [userId],
      ),
    ).toMatchObject({ rows: [expect.objectContaining({ revoked_at: null })] });

    await expect(
      mfa.removeFactor({
        factorId,
        userId,
        email: EMAIL,
        expectedPasswordHash: PASSWORD_HASH,
        emailDelivery: notice,
        now: NOW,
      }),
    ).resolves.toBe(true);
    const remaining = await pool.query(
      'SELECT factor_id FROM user_mfa_factors WHERE user_account_id = $1',
      [userId],
    );
    expect(remaining.rowCount).toBe(0);
    const sessions = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM web_sessions WHERE user_account_id = $1
       UNION ALL
       SELECT revoked_at FROM refresh_tokens WHERE user_account_id = $1`,
      [userId],
    );
    expect(sessions.rows).toHaveLength(2);
    expect(
      sessions.rows.every(({ revoked_at }) => revoked_at instanceof Date),
    ).toBe(true);
    const notices = await pool.query<{ kind: string }>(
      'SELECT kind FROM email_delivery_requests WHERE id = $1',
      [notice.id],
    );
    expect(notices.rows).toEqual([{ kind: 'mfa_removed_notification' }]);
  });
});
