import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';
import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { PostgresVerificationTokenRepository } from '@/modules/auth/verification/infrastructure/postgres-verification-token.repository';
import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { createPostgresAuthClient } from './postgres-auth.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from '../shared/database';

const FIRST_AT = new Date('2026-09-23T00:00:00.000Z');
const SECOND_AT = new Date('2026-09-23T01:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EMAIL = 'pending@example.com';
const FIRST_HASH = `${ARGON2ID_DUMMY_HASH}first`;
const SECOND_HASH = `${ARGON2ID_DUMMY_HASH}second`;

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;
let accounts: PostgresUserAccountRepository;
let verificationTokens: PostgresVerificationTokenRepository;

function newTokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

function register(options: {
  readonly username: string;
  readonly passwordHash: string;
  readonly tokenHash: string;
  readonly now: Date;
  readonly email?: string;
}): Promise<'queued' | 'suppressed'> {
  return accounts.register({
    email: options.email ?? EMAIL,
    username: options.username,
    passwordHash: options.passwordHash,
    tokenId: `evt_${ulid()}`,
    tokenHash: options.tokenHash,
    tokenExpiresAt: EXPIRES_AT,
    requiresPassword: false,
    now: options.now,
  });
}

async function verifies(hash: string): Promise<boolean> {
  const token: IssuedRefreshToken = {
    id: `rft_${ulid()}`,
    familyId: `rfs_${ulid()}`,
    raw: 'raw-refresh-token',
    hash: newTokenHash(),
    expiresAt: EXPIRES_AT,
  };
  const outcome = await verificationTokens.consumeVerificationToken({
    tokenHash: hash,
    signInSession: { kind: 'refresh', token, issuedAt: SECOND_AT },
    now: SECOND_AT,
  });
  return outcome.kind !== 'invalid';
}

async function account(email = EMAIL) {
  const { rows } = await pool.query<{
    id: string;
    username: string;
    status: string;
    updated_at: Date;
    password_hash: string;
  }>(
    `SELECT ua.id, ua.username, ua.status, ua.updated_at, ai.password_hash
     FROM user_accounts ua
     JOIN auth_identities ai ON ai.user_account_id = ua.id
     WHERE ai.canonical_email = $1`,
    [email],
  );
  return rows;
}

async function beginLockHolder(accountId: string) {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const { rows } = await connection.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    await connection.query(
      'SELECT id FROM user_accounts WHERE id = $1 FOR UPDATE',
      [accountId],
    );
    const pid = rows[0]?.pid;
    if (pid === undefined) throw new Error('lock holder reported no pid');
    return { connection, pid };
  } catch (error) {
    connection.release(true);
    throw error;
  }
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  accounts = new PostgresUserAccountRepository(client);
  verificationTokens = new PostgresVerificationTokenRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

describe('registering again on a pending email against PostgreSQL', () => {
  it('replaces the credential and username, supersedes the open token, and keeps one account', async () => {
    const firstToken = newTokenHash();
    const secondToken = newTokenHash();
    await register({
      username: 'first_name',
      passwordHash: FIRST_HASH,
      tokenHash: firstToken,
      now: FIRST_AT,
    });
    const [before] = await account();

    await register({
      username: 'second_name',
      passwordHash: SECOND_HASH,
      tokenHash: secondToken,
      now: SECOND_AT,
    });

    const rows = await account();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before?.id,
      username: 'second_name',
      status: 'pending_verification',
      password_hash: SECOND_HASH,
    });
    expect(rows[0]?.updated_at).toEqual(SECOND_AT);
    const tokens = await pool.query<{
      token_hash: string;
      consumed_reason: string | null;
    }>(
      `SELECT token_hash, consumed_reason FROM email_verification_tokens
       WHERE user_account_id = $1 ORDER BY created_at`,
      [before?.id],
    );
    expect(tokens.rows).toEqual([
      { token_hash: firstToken, consumed_reason: 'superseded' },
      { token_hash: secondToken, consumed_reason: null },
    ]);
    await expect(verifies(firstToken)).resolves.toBe(false);
    await expect(verifies(secondToken)).resolves.toBe(true);
  });

  it('refuses an active account and changes nothing', async () => {
    await register({
      username: 'first_name',
      passwordHash: FIRST_HASH,
      tokenHash: newTokenHash(),
      now: FIRST_AT,
    });
    await pool.query("UPDATE user_accounts SET status = 'active'");

    await expect(
      register({
        username: 'second_name',
        passwordHash: SECOND_HASH,
        tokenHash: newTokenHash(),
        now: SECOND_AT,
      }),
    ).rejects.toMatchObject({ name: 'AuthIdentityConflictError' });

    expect(await account()).toMatchObject([
      { username: 'first_name', password_hash: FIRST_HASH },
    ]);
  });

  it('leaves the pending account untouched when the new username belongs to another account', async () => {
    await register({
      username: 'first_name',
      passwordHash: FIRST_HASH,
      tokenHash: newTokenHash(),
      now: FIRST_AT,
    });
    await register({
      email: 'other@example.com',
      username: 'held_name',
      passwordHash: FIRST_HASH,
      tokenHash: newTokenHash(),
      now: FIRST_AT,
    });
    const firstToken = (
      await pool.query<{ token_hash: string }>(
        `SELECT t.token_hash FROM email_verification_tokens t
         JOIN auth_identities ai ON ai.user_account_id = t.user_account_id
         WHERE ai.canonical_email = $1`,
        [EMAIL],
      )
    ).rows[0]?.token_hash;

    await expect(
      register({
        username: 'held_name',
        passwordHash: SECOND_HASH,
        tokenHash: newTokenHash(),
        now: SECOND_AT,
      }),
    ).rejects.toMatchObject({ name: 'AuthIdentityConflictError' });

    expect(await account()).toMatchObject([
      { username: 'first_name', password_hash: FIRST_HASH },
    ]);
    await expect(verifies(firstToken ?? '')).resolves.toBe(true);
  });

  it('serializes a replacement queued first before a verification of the superseded token', async () => {
    const firstToken = newTokenHash();
    await register({
      username: 'first_name',
      passwordHash: FIRST_HASH,
      tokenHash: firstToken,
      now: FIRST_AT,
    });
    const [existing] = await account();
    const { connection: holder, pid: holderPid } = await beginLockHolder(
      existing?.id ?? '',
    );
    let replacement: Promise<unknown> | undefined;
    let verification: Promise<boolean> | undefined;
    try {
      replacement = register({
        username: 'second_name',
        passwordHash: SECOND_HASH,
        tokenHash: newTokenHash(),
        now: SECOND_AT,
      });
      const replacementPid = await waitForBlockedBy(pool, holderPid);
      verification = verifies(firstToken);
      await waitForBlockedBy(pool, replacementPid);

      await holder.query('COMMIT');
      await replacement;
      await expect(verification).resolves.toBe(false);
    } finally {
      holder.release(true);
      await replacement?.catch(() => undefined);
      await verification?.catch(() => undefined);
    }

    expect(await account()).toMatchObject([
      { status: 'pending_verification', password_hash: SECOND_HASH },
    ]);
  });

  it('serializes a verification queued first before a replacement, which then finds an active account', async () => {
    const firstToken = newTokenHash();
    await register({
      username: 'first_name',
      passwordHash: FIRST_HASH,
      tokenHash: firstToken,
      now: FIRST_AT,
    });
    const [existing] = await account();
    const { connection: holder, pid: holderPid } = await beginLockHolder(
      existing?.id ?? '',
    );
    let verification: Promise<boolean> | undefined;
    let replacement: Promise<unknown> | undefined;
    try {
      verification = verifies(firstToken);
      const verificationPid = await waitForBlockedBy(pool, holderPid);
      replacement = register({
        username: 'second_name',
        passwordHash: SECOND_HASH,
        tokenHash: newTokenHash(),
        now: SECOND_AT,
      });
      await waitForBlockedBy(pool, verificationPid);

      await holder.query('COMMIT');
      await expect(verification).resolves.toBe(true);
      await expect(replacement).rejects.toMatchObject({
        name: 'AuthIdentityConflictError',
      });
    } finally {
      holder.release(true);
      await verification?.catch(() => undefined);
      await replacement?.catch(() => undefined);
    }

    expect(await account()).toMatchObject([
      { status: 'active', username: 'first_name', password_hash: FIRST_HASH },
    ]);
  });
});
