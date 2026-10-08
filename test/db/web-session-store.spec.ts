import { createHash, randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';
import { ulid } from 'ulid';

import { Argon2PasswordHasher } from '@/modules/auth/infrastructure/argon2-password.hasher';
import {
  type PostgresAuthClient,
  type PostgresAuthQueryClient,
  createPostgresAuthClient,
} from '@/modules/auth/infrastructure/postgres-auth.client';
import { PostgresLocalAuthRepository } from '@/modules/auth/infrastructure/postgres-local-auth.repository';
import { PostgresWebSessionRepository } from '@/modules/auth/infrastructure/postgres-web-session.repository';

import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
  waitForBlockedBy,
} from './database';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const EMAIL = 'web-session@example.com';

/**
 * A fixed shape for the seeded identity, the way local-auth-email-outbox.spec.ts
 * keeps this lane off argon2's cost. The reset below stores a real hash, because
 * that is the credential a User actually signs in with afterwards.
 */
const STORED_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$aGFzaA';

let pool: Pool;
let client: PostgresAuthClient;
let webSessions: PostgresWebSessionRepository;
let localAuth: PostgresLocalAuthRepository;
let resetPasswordHash: string;

beforeAll(async () => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  webSessions = new PostgresWebSessionRepository(client);
  localAuth = new PostgresLocalAuthRepository(client);
  resetPasswordHash = await new Argon2PasswordHasher().hash('a new passphrase');
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

/** A real active account with a real local identity, as the lane seeds one. */
async function seedAccount(email = EMAIL): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [id, `user-${id.slice(4, 16).toLowerCase()}`, NOW],
  );
  await pool.query(
    `INSERT INTO auth_identities (
       id, user_account_id, provider, canonical_email, password_hash,
       created_at, updated_at
     ) VALUES ($1, $2, 'password', $3, $4, $5, $5)`,
    [`auth_${ulid()}`, id, email, STORED_PASSWORD_HASH, NOW],
  );
  return id;
}

/** Stores one session through the real repository, so the insert path is real. */
async function createWebSession(
  userId: string,
  options: { readonly createdAt?: Date; readonly expiresAt: Date },
): Promise<string> {
  const hash = tokenHash();
  await webSessions.createWebSession({
    sessionId: `wbs_${ulid()}`,
    userId,
    token: { raw: 'raw-web-session-token', hash, expiresAt: options.expiresAt },
    now: options.createdAt ?? NOW,
  });
  return hash;
}

async function storedExpiry(hash: string): Promise<Date | undefined> {
  const { rows } = await pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM web_sessions WHERE token_hash = $1',
    [hash],
  );
  return rows[0]?.expires_at;
}

async function beginLockHolderTransaction(): Promise<{
  readonly connection: PoolClient;
  readonly pid: number;
}> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const { rows } = await connection.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    const pid = rows[0]?.pid;
    if (pid === undefined) {
      throw new Error('lock holder reported no backend pid');
    }
    return { connection, pid };
  } catch (error) {
    connection.release(true);
    throw error;
  }
}

/** A row written straight to the table, for the statements production never sends. */
async function insertRow(row: {
  readonly id?: string;
  readonly userId: string;
  readonly hash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}): Promise<void> {
  await pool.query(
    `INSERT INTO web_sessions (
       id, user_account_id, token_hash, created_at, expires_at, last_renewed_at
     ) VALUES ($1, $2, $3, $4, $5, $4)`,
    [
      row.id ?? `wbs_${ulid()}`,
      row.userId,
      row.hash,
      row.createdAt,
      row.expiresAt,
    ],
  );
}

describe('the web_sessions schema on PostgreSQL', () => {
  it('applies the migration with the columns the exchange and renewal read', async () => {
    // The lane's global setup applies every file in database/migrations, so a
    // row here proves 0033 ran; the catalog then says what it produced, which
    // no assertion on the migration text can.
    const { rows } = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'web_sessions'
       ORDER BY ordinal_position`,
    );

    expect(rows).toEqual([
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'user_account_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'token_hash', data_type: 'text', is_nullable: 'NO' },
      {
        column_name: 'created_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'expires_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'last_renewed_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'NO',
      },
      {
        column_name: 'revoked_at',
        data_type: 'timestamp with time zone',
        is_nullable: 'YES',
      },
    ]);
  });

  it('enforces the id shape, the hash shape, and the expiry order in the engine', async () => {
    const constraints = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'web_sessions'::regclass AND contype = 'c'`,
    );
    expect(constraints.rows.map((row) => row.definition).join('\n')).toContain(
      'wbs_[0-9A-HJKMNP-TV-Z]{26}',
    );

    const userId = await seedAccount();
    const malformedId = pool.query(
      `INSERT INTO web_sessions (
         id, user_account_id, token_hash, created_at, expires_at, last_renewed_at
       ) VALUES ('sess_01J00000000000000000000000', $1, $2, $3, $4, $3)`,
      [userId, tokenHash(), NOW, new Date(NOW.getTime() + HOUR)],
    );
    await expect(malformedId).rejects.toMatchObject({ code: '23514' });

    const backwardsExpiry = insertRow({
      userId,
      hash: tokenHash(),
      createdAt: NOW,
      expiresAt: NOW,
    });
    await expect(backwardsExpiry).rejects.toMatchObject({ code: '23514' });
  });

  it('indexes the account for bulk revocation and the hash for lookup', async () => {
    // foreign-key-indexes.spec.ts proves every foreign key is indexed; this
    // names the two indexes this table relies on, so a dropped one fails here
    // rather than as a scan under production load.
    const { rows } = await pool.query<{
      unique: boolean;
      columns: string;
    }>(
      `SELECT index.indisunique AS unique,
              string_agg(attribute.attname, ',' ORDER BY ordinality) AS columns
       FROM pg_index index
       JOIN pg_class table_class ON table_class.oid = index.indrelid
       JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
       JOIN LATERAL unnest(index.indkey) WITH ORDINALITY
         AS ordinal(attnum, ordinality) ON true
       JOIN pg_attribute attribute
         ON attribute.attrelid = table_class.oid
        AND attribute.attnum = ordinal.attnum
       WHERE namespace.nspname = 'public'
         AND table_class.relname = 'web_sessions'
         AND NOT index.indisprimary
       GROUP BY index.indexrelid, index.indisunique
       ORDER BY index.indisunique DESC`,
    );

    expect(rows).toEqual([
      { unique: true, columns: 'token_hash' },
      { unique: false, columns: 'user_account_id' },
    ]);
  });
});

describe('the Web Session credential on PostgreSQL', () => {
  it('refuses a second row carrying the same token hash', async () => {
    const userId = await seedAccount();
    const hash = await createWebSession(userId, {
      expiresAt: new Date(NOW.getTime() + 30 * DAY),
    });

    const duplicate = webSessions.createWebSession({
      sessionId: `wbs_${ulid()}`,
      userId,
      token: {
        raw: 'another-raw-token',
        hash,
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
      },
      now: NOW,
    });
    await expect(duplicate).rejects.toMatchObject({ code: '23505' });

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM web_sessions WHERE token_hash = $1',
      [hash],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('refuses a token hash that is not 64 lowercase hexadecimal characters', async () => {
    const userId = await seedAccount();
    for (const malformed of [
      'A'.repeat(64),
      'a'.repeat(63),
      `${'a'.repeat(63)}z`,
      'not-a-hash',
    ]) {
      await expect(
        insertRow({
          userId,
          hash: malformed,
          createdAt: NOW,
          expiresAt: new Date(NOW.getTime() + HOUR),
        }),
      ).rejects.toMatchObject({ code: '23514' });
    }

    expect(
      await pool.query(
        'SELECT 1 FROM web_sessions WHERE user_account_id = $1',
        [userId],
      ),
    ).toMatchObject({ rows: [] });
  });
});

describe('renewing one Web Session concurrently on PostgreSQL', () => {
  const RENEWED_AT = new Date(NOW.getTime() + MINUTE);

  it('settles a burst on the latest expiry and refuses every earlier one after it', async () => {
    const userId = await seedAccount();
    const hash = await createWebSession(userId, {
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
    const before = await storedExpiry(hash);

    // One request per BFF instance, each deriving its own 30-day expiry, all
    // inside the throttle window so every one of them wants to write.
    const targets = Array.from(
      { length: 8 },
      (_unused, index) => new Date(NOW.getTime() + (index + 2) * DAY),
    );
    const renewed = await Promise.all(
      targets.map((expiresAt) =>
        webSessions.renewWebSession({
          tokenHash: hash,
          expiresAt,
          renewedAt: RENEWED_AT,
          renewedAtBefore: RENEWED_AT,
        }),
      ),
    );

    const written = targets.filter((_unused, index) => renewed[index]);
    expect(written.length).toBeGreaterThan(0);
    // Every value a concurrent renewal managed to write sits after the expiry the
    // burst started from: none of them moved the session's lifetime backwards.
    expect(written.every((expiresAt) => expiresAt > (before ?? NOW))).toBe(
      true,
    );
    // Row locks serialize the writes and the forward-only guard discards the
    // losers, so the burst settles on the latest expiry rather than on whichever
    // update happened to land last.
    expect(await storedExpiry(hash)).toEqual(targets[targets.length - 1]);

    // Replaying every value the burst offered now moves nothing: the stored
    // expiry never gives ground, even one value at a time.
    const replays = await Promise.all(
      targets.map((expiresAt) =>
        webSessions.renewWebSession({
          tokenHash: hash,
          expiresAt,
          renewedAt: RENEWED_AT,
          renewedAtBefore: RENEWED_AT,
        }),
      ),
    );
    expect(replays).toEqual(targets.map(() => false));
    expect(await storedExpiry(hash)).toEqual(targets[targets.length - 1]);
  });

  it('keeps the row locked for one renewal and settles on the later expiry for both', async () => {
    const userId = await seedAccount();
    const hash = await createWebSession(userId, {
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
    const later = new Date(NOW.getTime() + 40 * DAY);
    const earlier = new Date(NOW.getTime() + 20 * DAY);

    const { connection: holder, pid: holderPid } =
      await beginLockHolderTransaction();
    let secondRenewal: Promise<boolean> | undefined;
    try {
      await holder.query(
        'SELECT id FROM web_sessions WHERE token_hash = $1 FOR UPDATE',
        [hash],
      );

      const firstRenewal = webSessions.renewWebSession({
        tokenHash: hash,
        expiresAt: later,
        renewedAt: RENEWED_AT,
        renewedAtBefore: RENEWED_AT,
      });
      const firstPid = await waitForBlockedBy(pool, holderPid);
      secondRenewal = webSessions.renewWebSession({
        tokenHash: hash,
        expiresAt: earlier,
        renewedAt: RENEWED_AT,
        renewedAtBefore: RENEWED_AT,
      });
      await waitForBlockedBy(pool, firstPid);

      await holder.query('COMMIT');
      // Both were in flight against the same row, so whichever order the engine
      // grants them in, the account keeps the later expiry.
      await expect(
        Promise.all([firstRenewal, secondRenewal]),
      ).resolves.toHaveLength(2);
      expect(await storedExpiry(hash)).toEqual(later);
    } finally {
      holder.release(true);
      if (secondRenewal !== undefined) {
        await secondRenewal.catch(() => undefined);
      }
    }
  });
});

describe('password reset and Web Session revocation on PostgreSQL', () => {
  const RESET_AT = new Date(NOW.getTime() + 2 * HOUR);

  /**
   * Fails the Web Session statement inside the reset's real transaction and
   * delegates everything else to the real client, the way
   * local-auth-email-outbox.spec.ts flips one store to make a write fail. The
   * rollback under test is the engine's.
   */
  class FailingWebSessionRevocation implements PostgresAuthClient {
    constructor(private readonly real: PostgresAuthClient) {}

    async checkConnection(timeoutMs: number): Promise<void> {
      await this.real.checkConnection(timeoutMs);
    }

    async query(
      text: string,
      values: readonly unknown[],
    ): Promise<readonly Record<string, unknown>[]> {
      return this.real.query(text, values);
    }

    async transaction<T>(
      callback: (client: PostgresAuthQueryClient) => Promise<T>,
    ): Promise<T> {
      return this.real.transaction((transaction) =>
        callback({
          query: async (text, values) => {
            if (text.includes('UPDATE web_sessions')) {
              throw new Error('the web session revocation was not recorded');
            }
            return transaction.query(text, values);
          },
        }),
      );
    }

    async close(): Promise<void> {
      await this.real.close();
    }
  }

  /** An account with a Refresh Session and two Web Sessions to end. */
  async function seedResetTarget(): Promise<{
    readonly userId: string;
    readonly resetHash: string;
    readonly sessionHashes: readonly string[];
  }> {
    const userId = await seedAccount();
    await pool.query(
      `INSERT INTO refresh_tokens (
         id, family_id, user_account_id, token_hash, issued_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `rft_${ulid()}`,
        `rfs_${ulid()}`,
        userId,
        tokenHash(),
        NOW,
        new Date(NOW.getTime() + 30 * DAY),
      ],
    );
    const expiresAt = new Date(NOW.getTime() + 30 * DAY);
    const sessionHashes = [
      await createWebSession(userId, { expiresAt }),
      await createWebSession(userId, { expiresAt }),
    ];
    const rawToken = randomBytes(32).toString('base64url');
    const resetHash = createHash('sha256')
      .update(rawToken, 'utf8')
      .digest('hex');
    await localAuth.issuePasswordResetToken({
      email: EMAIL,
      tokenId: `prt_${ulid()}`,
      tokenHash: resetHash,
      tokenExpiresAt: new Date(NOW.getTime() + DAY),
      now: NOW,
    });
    return { userId, resetHash, sessionHashes };
  }

  async function durableState(userId: string): Promise<{
    readonly revokedSessions: number;
    readonly openSessions: number;
    readonly revokedRefreshTokens: number;
    readonly consumedResetTokens: number;
    readonly passwordHash: string;
  }> {
    const sessions = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM web_sessions WHERE user_account_id = $1',
      [userId],
    );
    const refresh = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM refresh_tokens WHERE user_account_id = $1',
      [userId],
    );
    const reset = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM password_reset_tokens WHERE user_account_id = $1',
      [userId],
    );
    const identity = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM auth_identities
       WHERE user_account_id = $1 AND provider = 'password'`,
      [userId],
    );
    return {
      revokedSessions: sessions.rows.filter((row) => row.revoked_at !== null)
        .length,
      openSessions: sessions.rows.filter((row) => row.revoked_at === null)
        .length,
      revokedRefreshTokens: refresh.rows.filter(
        (row) => row.revoked_at !== null,
      ).length,
      consumedResetTokens: reset.rows.filter((row) => row.consumed_at !== null)
        .length,
      passwordHash: identity.rows[0]?.password_hash ?? '',
    };
  }

  it('ends the Refresh Sessions and the Web Sessions of the account together', async () => {
    const { userId, resetHash } = await seedResetTarget();

    await expect(
      localAuth.consumePasswordReset({
        tokenHash: resetHash,
        passwordHash: resetPasswordHash,
        now: RESET_AT,
      }),
    ).resolves.toEqual({ kind: 'reset' });

    expect(await durableState(userId)).toEqual({
      revokedSessions: 2,
      openSessions: 0,
      revokedRefreshTokens: 1,
      consumedResetTokens: 1,
      passwordHash: resetPasswordHash,
    });

    // The revocation is what the credential checks, so it has to be the same
    // instant the reset was accepted at.
    const revoked = await pool.query<{ revoked_at: Date }>(
      'SELECT revoked_at FROM web_sessions WHERE user_account_id = $1',
      [userId],
    );
    expect(revoked.rows.map((row) => row.revoked_at)).toEqual([
      RESET_AT,
      RESET_AT,
    ]);
  });

  it('leaves nothing revoked when the transaction fails part-way', async () => {
    const { userId, resetHash } = await seedResetTarget();
    const failing = new FailingWebSessionRevocation(client);

    await expect(
      new PostgresLocalAuthRepository(failing).consumePasswordReset({
        tokenHash: resetHash,
        passwordHash: resetPasswordHash,
        now: RESET_AT,
      }),
    ).rejects.toThrow('the web session revocation was not recorded');

    // The Refresh Session revocation above the failed statement really ran on a
    // real connection, and the engine rolled it back with everything else: an
    // exchange racing the reset can never see a half-revoked account.
    expect(await durableState(userId)).toEqual({
      revokedSessions: 0,
      openSessions: 2,
      revokedRefreshTokens: 0,
      consumedResetTokens: 0,
      passwordHash: STORED_PASSWORD_HASH,
    });
  });
});
