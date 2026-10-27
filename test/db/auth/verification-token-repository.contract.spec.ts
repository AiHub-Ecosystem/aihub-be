import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { UNUSED_EMAIL_OUTBOX } from '@/modules/auth/testing/email-outbox.stub';
import {
  type VerificationTokenContractHarness,
  verificationTokenRepositoryContract,
} from '@/modules/auth/testing/verification-token.contract';
import { PostgresVerificationTokenRepository } from '@/modules/auth/verification/infrastructure/postgres-verification-token.repository';
import { createPostgresAuthClient } from './postgres-auth.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EXPIRED_AT = new Date('2026-09-22T00:00:00.000Z');
const EMAIL = 'verify@example.com';
const BINDING = 'a'.repeat(64);
const USER_ID = `usr_${ulid()}`;
const PASSWORD_HASH = ARGON2ID_DUMMY_HASH;

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;

async function seedAccount(status: string) {
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [USER_ID, `user-${USER_ID.slice(4, 16).toLowerCase()}`, status, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [`auth_${ulid()}`, USER_ID, EMAIL, PASSWORD_HASH, NOW],
  );
}

async function insertToken(options: {
  hash: string;
  expiresAt?: Date;
  consumedAt?: Date;
  consumedReason?: 'verified' | 'superseded';
  bindingHash?: string;
  signedInAt?: Date;
  requiresPassword?: boolean;
}) {
  const id = `evt_${ulid()}`;
  await pool.query(
    `INSERT INTO email_verification_tokens (
       id, user_account_id, token_hash, expires_at, consumed_at, consumed_reason,
       created_at, browser_binding_hash, signed_in_at, requires_password
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      USER_ID,
      options.hash,
      options.expiresAt ?? EXPIRES_AT,
      options.consumedAt ?? null,
      options.consumedReason ?? null,
      NOW,
      options.bindingHash ?? null,
      options.signedInAt ?? null,
      options.requiresPassword ?? false,
    ],
  );
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
});

afterAll(async () => {
  await pool.end();
});

verificationTokenRepositoryContract({
  userId: USER_ID,
  email: EMAIL,
  binding: BINDING,
  now: NOW,
  expiresAt: EXPIRES_AT,
  expiredAt: EXPIRED_AT,
  passwordHash: PASSWORD_HASH,
  createRepo: () =>
    new PostgresVerificationTokenRepository(client, UNUSED_EMAIL_OUTBOX),
  reset: async () => {
    await resetIdentityTables(pool);
  },
  seedAccount: async (status: string) => {
    await seedAccount(status);
  },
  insertToken: async (
    options: Parameters<VerificationTokenContractHarness['insertToken']>[0],
  ) => {
    await insertToken(options);
  },
  readToken: async (hash: string) => {
    const { rows } = await pool.query<{
      consumed_reason: string | null;
      password_failures: number;
    }>(
      `SELECT consumed_reason, password_failures
       FROM email_verification_tokens WHERE token_hash = $1`,
      [hash],
    );
    return {
      consumedReason: rows[0]?.consumed_reason ?? undefined,
      passwordFailures: Number(rows[0]?.password_failures ?? 0),
    };
  },
  setAccountStatus: async (_userId: string, status: string) => {
    await pool.query('UPDATE user_accounts SET status = $1 WHERE id = $2', [
      status,
      USER_ID,
    ]);
  },
  getTokenSignedInAt: async (hash: string) => {
    const { rows } = await pool.query<{ signed_in_at: Date | null }>(
      'SELECT signed_in_at FROM email_verification_tokens WHERE token_hash = $1',
      [hash],
    );
    return rows[0]?.signed_in_at ?? undefined;
  },
  enableSecondFactor: async () => {
    await pool.query(
      `INSERT INTO user_mfa_factors (
         factor_id, user_account_id, secret_key_id, secret_ciphertext,
         status, created_at, updated_at
       ) VALUES ($1, $2, 'test-key', 'ciphertext', 'enabled', $3, $3)`,
      [`mfa_${ulid()}`, USER_ID, NOW],
    );
  },
  sessionCount: async () => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT (SELECT count(*) FROM refresh_tokens WHERE user_account_id = $1)
            + (SELECT count(*) FROM web_sessions WHERE user_account_id = $1)
              AS count`,
      [USER_ID],
    );
    return Number(rows[0]?.count ?? 0);
  },
  setFailSessionWrite: () => {
    // Not supported for the Postgres repo.
  },
});
