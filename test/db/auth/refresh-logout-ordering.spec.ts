import { createHash, randomBytes } from 'node:crypto';

import type { Pool } from 'pg';
import { ulid } from 'ulid';

import type { IssuedRefreshToken } from '@/modules/auth/web-sessions/application/refresh-token.port';
import { PostgresRefreshSessionRepository } from '@/modules/auth/web-sessions/infrastructure/postgres-refresh-session.repository';
import {
  createTestPool,
  resetIdentityTables,
  testDatabaseUrl,
} from '../shared/database';
import { racePausedFirst } from './pause-before-commit';
import {
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './postgres-auth.client';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let pool: Pool;
let client: PostgresAuthClient;
let refreshSessions: PostgresRefreshSessionRepository;

beforeAll(async () => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  refreshSessions = new PostgresRefreshSessionRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
});

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

async function seedFamily(): Promise<{
  readonly userId: string;
  readonly predecessor: IssuedRefreshToken;
  readonly current: IssuedRefreshToken;
}> {
  const userId = `usr_${ulid()}`;
  const predecessor = newRefreshToken();
  const current = newRefreshToken(predecessor.familyId);
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', $3, $3)`,
    [userId, `user-${userId.slice(4, 16).toLowerCase()}`, NOW],
  );
  await pool.query(
    `INSERT INTO refresh_tokens (
       id, family_id, user_account_id, token_hash, issued_at, expires_at, used_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7),
             ($8, $2, $3, $9, $5, $10, NULL)`,
    [
      predecessor.id,
      predecessor.familyId,
      userId,
      predecessor.hash,
      NOW,
      predecessor.expiresAt,
      NOW,
      current.id,
      current.hash,
      current.expiresAt,
    ],
  );
  return { userId, predecessor, current };
}

function rotate(
  repository: PostgresRefreshSessionRepository,
  token: IssuedRefreshToken,
  successor = newRefreshToken(token.familyId),
) {
  return repository.rotateRefreshToken({
    tokenId: token.id,
    tokenHash: token.hash,
    successor,
    now: new Date(NOW.getTime() + 1),
  });
}

function logout(
  repository: PostgresRefreshSessionRepository,
  token: IssuedRefreshToken,
) {
  return repository.revokeRefreshFamilyByTokenHash({
    tokenHash: token.hash,
    now: new Date(NOW.getTime() + 1),
  });
}

async function familyState(familyId: string) {
  const result = await pool.query<{
    readonly total: string;
    readonly open: string;
  }>(
    `SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE revoked_at IS NULL)::text AS open
     FROM refresh_tokens WHERE family_id = $1`,
    [familyId],
  );
  return {
    total: Number(result.rows[0]?.total ?? 0),
    open: Number(result.rows[0]?.open ?? 0),
  };
}

describe('Refresh Token logout and rotation ordering', () => {
  it('revokes a successor when logout of a used predecessor waits behind rotation', async () => {
    const { userId, predecessor, current } = await seedFamily();
    const successor = newRefreshToken(current.familyId);

    const results = await racePausedFirst(
      pool,
      client,
      (pausedClient) =>
        rotate(
          new PostgresRefreshSessionRepository(pausedClient),
          current,
          successor,
        ),
      () => logout(refreshSessions, predecessor),
    );

    expect(results).toEqual([{ kind: 'rotated', userId }, undefined]);
    expect(await familyState(current.familyId)).toEqual({ total: 3, open: 0 });
    await expect(rotate(refreshSessions, successor)).resolves.toEqual({
      kind: 'invalid',
      reason: 'revoked',
    });
  });

  it('refuses rotation when logout of a used predecessor takes the account lock first', async () => {
    const { predecessor, current } = await seedFamily();

    const results = await racePausedFirst(
      pool,
      client,
      (pausedClient) =>
        logout(new PostgresRefreshSessionRepository(pausedClient), predecessor),
      () => rotate(refreshSessions, current),
    );

    expect(results).toEqual([
      undefined,
      { kind: 'invalid', reason: 'revoked' },
    ]);
    expect(await familyState(current.familyId)).toEqual({ total: 2, open: 0 });
  });

  it.each(['rotation', 'logout'] as const)(
    'preserves the same-token control when %s takes the account lock first',
    async (firstOperation) => {
      const { userId, current } = await seedFamily();
      const successor = newRefreshToken(current.familyId);
      const pausedRepository = (pausedClient: PostgresAuthClient) =>
        new PostgresRefreshSessionRepository(pausedClient);
      const results = await racePausedFirst<unknown, unknown>(
        pool,
        client,
        (pausedClient) =>
          firstOperation === 'rotation'
            ? rotate(pausedRepository(pausedClient), current, successor)
            : logout(pausedRepository(pausedClient), current),
        () =>
          firstOperation === 'rotation'
            ? logout(refreshSessions, current)
            : rotate(refreshSessions, current, successor),
      );

      expect(results).toEqual(
        firstOperation === 'rotation'
          ? [{ kind: 'rotated', userId }, undefined]
          : [undefined, { kind: 'invalid', reason: 'revoked' }],
      );
      expect(await familyState(current.familyId)).toEqual({
        total: 3,
        open: 0,
      });
    },
  );
});
