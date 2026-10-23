import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { PostgresPendingRegistrationRecords } from '@/modules/auth/accounts/infrastructure/postgres-pending-registration-records';
import { PostgresUserAccountRepository } from '@/modules/auth/accounts/infrastructure/postgres-user-account.repository';
import { ARGON2ID_DUMMY_HASH } from '@/modules/auth/local-credentials/application/argon2id-parameters';
import { PostgresEmailCredentialRepository } from '@/modules/auth/local-credentials/infrastructure/postgres-email-credential.repository';
import { createPostgresAuthClient } from './postgres-auth.client';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF = new Date('2026-10-23T00:00:00.000Z');

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;
let accounts: PostgresUserAccountRepository;
let records: PostgresPendingRegistrationRecords;

function newTokenHash(): string {
  return createHash('sha256')
    .update(randomBytes(32).toString('base64url'), 'utf8')
    .digest('hex');
}

/** A pending registration made at `at`, with its identity and one open token. */
async function register(
  name: string,
  at: Date,
  tokenHash = newTokenHash(),
): Promise<string> {
  await accounts.register({
    email: `${name}@example.com`,
    username: name,
    passwordHash: ARGON2ID_DUMMY_HASH,
    tokenId: `evt_${ulid()}`,
    tokenHash,
    tokenExpiresAt: new Date(at.getTime() + DAY_MS),
    requiresPassword: false,
    now: at,
  });
  return tokenHash;
}

async function usernames(): Promise<string[]> {
  const { rows } = await pool.query<{ username: string }>(
    'SELECT username FROM user_accounts ORDER BY username',
  );
  return rows.map((row) => row.username);
}

async function counts() {
  const { rows } = await pool.query<{ table: string; count: string }>(`
    SELECT 'accounts' AS "table", count(*) FROM user_accounts
    UNION ALL SELECT 'identities', count(*) FROM auth_identities
    UNION ALL SELECT 'tokens', count(*) FROM email_verification_tokens
  `);
  return Object.fromEntries(rows.map((row) => [row.table, Number(row.count)]));
}

function expire(limit = 100) {
  return records.deleteExpiredPending({ expiredAtOrBefore: CUTOFF, limit });
}

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  accounts = new PostgresUserAccountRepository(client);
  records = new PostgresPendingRegistrationRecords(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

describe('expiring pending registrations against PostgreSQL', () => {
  it('deletes an expired pending account with its identity and tokens, and leaves the rest', async () => {
    await register('old_pending', new Date(CUTOFF.getTime() - DAY_MS));
    await register('fresh_pending', new Date(CUTOFF.getTime() + DAY_MS));
    await register('old_active', new Date(CUTOFF.getTime() - DAY_MS));
    await register('old_disabled', new Date(CUTOFF.getTime() - DAY_MS));
    await pool.query(
      "UPDATE user_accounts SET status = 'active' WHERE username = 'old_active'",
    );
    await pool.query(
      "UPDATE user_accounts SET status = 'disabled' WHERE username = 'old_disabled'",
    );

    await expect(expire()).resolves.toBe(1);

    await expect(usernames()).resolves.toEqual([
      'fresh_pending',
      'old_active',
      'old_disabled',
    ]);
    await expect(counts()).resolves.toEqual({
      accounts: 3,
      identities: 3,
      tokens: 3,
    });
  });

  it('releases the email and username of a deleted registration', async () => {
    await register('taken_name', new Date(CUTOFF.getTime() - DAY_MS));
    await expire();

    await expect(
      register('taken_name', new Date(CUTOFF.getTime() + DAY_MS)),
    ).resolves.toEqual(expect.any(String));
    await expect(usernames()).resolves.toEqual(['taken_name']);
  });

  it('treats the cutoff as inclusive and one millisecond later as still inside the window', async () => {
    await register('at_cutoff', CUTOFF);
    await register('just_after', new Date(CUTOFF.getTime() + 1));

    await expect(expire()).resolves.toBe(1);

    await expect(usernames()).resolves.toEqual(['just_after']);
  });

  it('counts a replaced registration from its replacement', async () => {
    await register('replaced', new Date(CUTOFF.getTime() - 6 * DAY_MS));
    await register('replaced', new Date(CUTOFF.getTime() + DAY_MS));

    await expect(expire()).resolves.toBe(0);

    await expect(usernames()).resolves.toEqual(['replaced']);
  });

  it('deletes at most the limit and the rest on the next call', async () => {
    for (const name of ['a_old', 'b_old', 'c_old']) {
      await register(name, new Date(CUTOFF.getTime() - DAY_MS));
    }

    await expect(expire(2)).resolves.toBe(2);
    await expect(expire(2)).resolves.toBe(1);
    await expect(expire(2)).resolves.toBe(0);
  });

  it('skips an account another transaction holds, instead of waiting on it', async () => {
    await register('held', new Date(CUTOFF.getTime() - DAY_MS));
    await register('free', new Date(CUTOFF.getTime() - DAY_MS));
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT id FROM user_accounts WHERE username = 'held' FOR UPDATE",
      );

      await expect(expire()).resolves.toBe(1);
      await holder.query('COMMIT');
    } finally {
      holder.release(true);
    }

    await expect(usernames()).resolves.toEqual(['held']);
  });

  it('leaves no actionable token for an email still queued for a deleted registration', async () => {
    const tokenHash = await register(
      'queued_mail',
      new Date(CUTOFF.getTime() - DAY_MS),
    );
    await expire();

    await expect(
      new PostgresEmailCredentialRepository(client).check({
        kind: 'verification_email',
        tokenHash,
        now: CUTOFF,
      }),
    ).resolves.toBe('missing');
  });
});
