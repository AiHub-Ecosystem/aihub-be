import type { Pool } from 'pg';

import { PostgresUserAccessTokenRevocationRepository } from '@/modules/auth/user-access-tokens/infrastructure/postgres-user-access-token-revocation.repository';
import { createTestPool, testDatabaseUrl } from '../../shared/database';
import { createPostgresAuthClient } from '../postgres-auth.client';

const ISSUER = 'https://api.test.aihub.example.com';
const JTI = 'revoked-token-id';
const RAW_TOKEN = 'header.payload.signature';

let pool: Pool;
let client: ReturnType<typeof createPostgresAuthClient>;
let repository: PostgresUserAccessTokenRevocationRepository;

beforeAll(() => {
  pool = createTestPool();
  client = createPostgresAuthClient(testDatabaseUrl());
  repository = new PostgresUserAccessTokenRevocationRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE user_access_token_revocations');
});

describe('User Access JWT revocation records in PostgreSQL', () => {
  it('commits only issuer and token ID, is idempotent, and survives another repository instance', async () => {
    const effectiveExpiresAt = new Date('2026-11-05T12:01:00.000Z');
    const input = { issuer: ISSUER, jti: JTI, effectiveExpiresAt };

    await repository.revoke(input);
    await repository.revoke(input);
    const otherInstance = new PostgresUserAccessTokenRevocationRepository(
      client,
    );

    await expect(
      otherInstance.isRevoked({
        issuer: ISSUER,
        jti: JTI,
        now: new Date('2026-11-05T12:00:59.999Z'),
      }),
    ).resolves.toBe(true);
    const { rows } = await pool.query<{
      issuer: string;
      jti: string;
      effective_expires_at: Date;
    }>(
      'SELECT issuer, jti, effective_expires_at FROM user_access_token_revocations',
    );
    expect(rows).toEqual([
      {
        issuer: ISSUER,
        jti: JTI,
        effective_expires_at: effectiveExpiresAt,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(RAW_TOKEN);
  });

  it('stays effective through expiry and leaves the row eligible for later cleanup', async () => {
    const effectiveExpiresAt = new Date('2026-11-05T12:01:00.000Z');
    await repository.revoke({ issuer: ISSUER, jti: JTI, effectiveExpiresAt });

    await expect(
      repository.isRevoked({
        issuer: ISSUER,
        jti: JTI,
        now: new Date(effectiveExpiresAt.getTime() - 1),
      }),
    ).resolves.toBe(true);
    await expect(
      repository.isRevoked({
        issuer: ISSUER,
        jti: JTI,
        now: effectiveExpiresAt,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.isRevoked({
        issuer: ISSUER,
        jti: JTI,
        now: new Date(effectiveExpiresAt.getTime() + 1),
      }),
    ).resolves.toBe(false);
    const { rowCount } = await pool.query(
      'SELECT 1 FROM user_access_token_revocations WHERE issuer = $1 AND jti = $2',
      [ISSUER, JTI],
    );
    expect(rowCount).toBe(1);
  });
});
