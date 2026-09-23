import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { createPostgresAuthClient } from '../../src/modules/auth/infrastructure/postgres-auth.client';
import { PostgresLocalAuthRepository } from '../../src/modules/auth/infrastructure/postgres-local-auth.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from './database';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EMAIL = 'verify@example.com';

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;
let repository: PostgresLocalAuthRepository;

function tokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

async function seedAccount(
  status:
    | 'pending_verification'
    | 'active'
    | 'disabled' = 'pending_verification',
  email = EMAIL,
): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`, status, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [
      `auth_${ulid()}`,
      id,
      email,
      '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA',
      NOW,
    ],
  );
  return id;
}

async function insertToken(options: {
  readonly userId: string;
  readonly hash: string;
  readonly expiresAt?: Date;
  readonly createdAt?: Date;
}): Promise<string> {
  const id = `evt_${ulid()}`;
  await pool.query(
    `INSERT INTO email_verification_tokens (
       id, user_account_id, token_hash, expires_at, consumed_at, created_at
     ) VALUES ($1, $2, $3, $4, NULL, $5)`,
    [
      id,
      options.userId,
      options.hash,
      options.expiresAt ?? EXPIRES_AT,
      options.createdAt ?? NOW,
    ],
  );
  return id;
}

async function verify(hash: string, now = NOW): Promise<boolean> {
  return repository.consumeVerificationToken({ tokenHash: hash, now });
}

async function beginLockHolderTransaction() {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const { rows } = await connection.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const pid = rows[0]?.pid;
    if (pid === undefined)
      throw new Error('lock holder reported no backend pid');
    return { connection, pid };
  } catch (error) {
    connection.release(true);
    throw error;
  }
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  repository = new PostgresLocalAuthRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

describe('local email verification against PostgreSQL', () => {
  it('replays only the unexpired token that activated the active account', async () => {
    const userId = await seedAccount();
    const hash = tokenHash();
    await insertToken({ userId, hash });

    await expect(verify(hash)).resolves.toBe(true);
    await expect(verify(hash)).resolves.toBe(true);
    await expect(verify(hash, EXPIRES_AT)).resolves.toBe(false);

    const account = await pool.query<{ status: string }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    const token = await pool.query<{
      consumed_reason: string | null;
      consumed_at: Date | null;
    }>(
      `SELECT consumed_at, consumed_reason
       FROM email_verification_tokens WHERE token_hash = $1`,
      [hash],
    );
    expect(account.rows[0]?.status).toBe('active');
    expect(token.rows[0]?.consumed_at).toBeInstanceOf(Date);
    expect(token.rows[0]?.consumed_reason).toBe('verified');
  });

  it('keeps a resent token invalid even after its replacement activates the account', async () => {
    const userId = await seedAccount();
    const oldHash = tokenHash();
    await insertToken({ userId, hash: oldHash });

    const replacementHash = tokenHash();
    await expect(
      repository.rotateVerificationToken({
        email: EMAIL,
        tokenId: `evt_${ulid()}`,
        tokenHash: replacementHash,
        tokenExpiresAt: EXPIRES_AT,
        now: NOW,
      }),
    ).resolves.toEqual({ email: EMAIL });

    await expect(verify(oldHash)).resolves.toBe(false);
    await expect(verify(replacementHash)).resolves.toBe(true);
    await expect(verify(oldHash)).resolves.toBe(false);

    const reasons = await pool.query<{
      token_hash: string;
      consumed_reason: string | null;
    }>(
      `SELECT token_hash, consumed_reason
       FROM email_verification_tokens WHERE token_hash = ANY($1::text[])`,
      [[oldHash, replacementHash]],
    );
    expect(reasons.rows).toEqual(
      expect.arrayContaining([
        { token_hash: oldHash, consumed_reason: 'superseded' },
        { token_hash: replacementHash, consumed_reason: 'verified' },
      ]),
    );
  });

  it('rejects unknown, expired, and disabled-account tokens', async () => {
    const pendingUserId = await seedAccount(
      'pending_verification',
      'pending@example.com',
    );
    const expiredHash = tokenHash();
    await insertToken({
      userId: pendingUserId,
      hash: expiredHash,
      expiresAt: NOW,
    });

    const disabledUserId = await seedAccount(
      'disabled',
      'disabled@example.com',
    );
    const disabledHash = tokenHash();
    await insertToken({ userId: disabledUserId, hash: disabledHash });

    await expect(verify(tokenHash())).resolves.toBe(false);
    await expect(verify(expiredHash)).resolves.toBe(false);
    await expect(verify(disabledHash)).resolves.toBe(false);

    const pendingAccount = await pool.query<{ status: string }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [pendingUserId],
    );
    const disabledAccount = await pool.query<{ status: string }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [disabledUserId],
    );
    expect(pendingAccount.rows[0]?.status).toBe('pending_verification');
    expect(disabledAccount.rows[0]?.status).toBe('disabled');
  });

  it('requires a reason for every consumed token', async () => {
    const userId = await seedAccount();
    const hash = tokenHash();
    await insertToken({ userId, hash });

    await expect(
      pool.query(
        `UPDATE email_verification_tokens
         SET consumed_at = $2, consumed_reason = NULL
         WHERE token_hash = $1`,
        [hash, NOW],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('acknowledges both concurrent submissions of the same valid token', async () => {
    const userId = await seedAccount();
    const hash = tokenHash();
    await insertToken({ userId, hash });

    const { connection: holder, pid: holderPid } =
      await beginLockHolderTransaction();
    let firstVerification: Promise<boolean> | undefined;
    let secondVerification: Promise<boolean> | undefined;
    try {
      await holder.query(
        'SELECT id FROM user_accounts WHERE id = $1 FOR UPDATE',
        [userId],
      );

      firstVerification = verify(hash);
      const firstVerificationPid = await waitForBlockedBy(pool, holderPid);
      secondVerification = verify(hash);
      await waitForBlockedBy(pool, firstVerificationPid);

      await holder.query('COMMIT');
      await expect(
        Promise.all([firstVerification, secondVerification]),
      ).resolves.toEqual([true, true]);
    } finally {
      holder.release(true);
      if (firstVerification !== undefined) {
        await firstVerification.catch(() => undefined);
      }
      if (secondVerification !== undefined) {
        await secondVerification.catch(() => undefined);
      }
    }

    const account = await pool.query<{ status: string }>(
      'SELECT status FROM user_accounts WHERE id = $1',
      [userId],
    );
    expect(account.rows[0]?.status).toBe('active');
  });

  it('serializes verification before resend without sending a replacement', async () => {
    const userId = await seedAccount();
    const hash = tokenHash();
    await insertToken({ userId, hash });

    const { connection: holder, pid: holderPid } =
      await beginLockHolderTransaction();
    let verification: Promise<boolean> | undefined;
    let resend: Promise<{ readonly email: string } | undefined> | undefined;
    try {
      await holder.query(
        'SELECT id FROM email_verification_tokens WHERE token_hash = $1 FOR UPDATE',
        [hash],
      );

      verification = verify(hash);
      const verificationPid = await waitForBlockedBy(pool, holderPid);
      resend = repository.rotateVerificationToken({
        email: EMAIL,
        tokenId: `evt_${ulid()}`,
        tokenHash: tokenHash(),
        tokenExpiresAt: EXPIRES_AT,
        now: NOW,
      });
      await waitForBlockedBy(pool, verificationPid);

      await holder.query('COMMIT');
      await expect(verification).resolves.toBe(true);
      await expect(resend).resolves.toBeUndefined();

      const tokens = await pool.query<{ token_hash: string }>(
        'SELECT token_hash FROM email_verification_tokens WHERE user_account_id = $1',
        [userId],
      );
      expect(tokens.rows).toEqual([{ token_hash: hash }]);
    } finally {
      holder.release(true);
      if (verification !== undefined) await verification.catch(() => undefined);
      if (resend !== undefined) await resend.catch(() => undefined);
    }
  });

  it('serializes resend before verification and rejects the superseded token', async () => {
    const userId = await seedAccount();
    const oldHash = tokenHash();
    await insertToken({ userId, hash: oldHash });

    const { connection: holder, pid: holderPid } =
      await beginLockHolderTransaction();
    let resend: Promise<{ readonly email: string } | undefined> | undefined;
    let verification: Promise<boolean> | undefined;
    const replacementHash = tokenHash();
    try {
      await holder.query(
        'SELECT id FROM email_verification_tokens WHERE token_hash = $1 FOR UPDATE',
        [oldHash],
      );

      resend = repository.rotateVerificationToken({
        email: EMAIL,
        tokenId: `evt_${ulid()}`,
        tokenHash: replacementHash,
        tokenExpiresAt: EXPIRES_AT,
        now: NOW,
      });
      const resendPid = await waitForBlockedBy(pool, holderPid);
      verification = verify(oldHash);
      await waitForBlockedBy(pool, resendPid);

      await holder.query('COMMIT');
      await expect(resend).resolves.toEqual({ email: EMAIL });
      await expect(verification).resolves.toBe(false);

      const tokens = await pool.query<{
        token_hash: string;
        consumed_reason: string | null;
      }>(
        `SELECT token_hash, consumed_reason
         FROM email_verification_tokens WHERE user_account_id = $1`,
        [userId],
      );
      expect(tokens.rows).toEqual(
        expect.arrayContaining([
          { token_hash: oldHash, consumed_reason: 'superseded' },
          { token_hash: replacementHash, consumed_reason: null },
        ]),
      );
    } finally {
      holder.release(true);
      if (resend !== undefined) await resend.catch(() => undefined);
      if (verification !== undefined) await verification.catch(() => undefined);
    }
  });
});
