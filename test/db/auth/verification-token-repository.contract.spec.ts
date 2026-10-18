import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { verificationTokenRepositoryContract } from '@/modules/auth/testing/verification-token.contract';
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
}) {
  const id = `evt_${ulid()}`;
  await pool.query(
    `INSERT INTO email_verification_tokens (
       id, user_account_id, token_hash, expires_at, consumed_at, consumed_reason,
       created_at, browser_binding_hash, signed_in_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
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
  createRepo: () => new PostgresVerificationTokenRepository(client),
  reset: async () => {
    await resetIdentityTables(pool);
  },
  seedAccount: async (status: string) => {
    await seedAccount(status);
  },
  insertToken: async (options: any) => {
    await insertToken(options);
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
  setFailSessionWrite: () => {
    // Not supported for the Postgres repo.
  },
});
