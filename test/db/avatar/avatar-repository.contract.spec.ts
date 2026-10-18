import type { Pool } from 'pg';
import { ulid } from 'ulid';

import {
  PostgresAvatarRepository,
  createAvatarQueryClient,
} from '@/modules/avatar/infrastructure/postgres-avatar.repository';
import { avatarRepositoryContract } from '@/modules/avatar/testing/avatar.contract';

import { createTestPool, resetIdentityTables } from '../shared/database';

const userId = `usr_${ulid()}`;

let pool: Pool;
let client: ReturnType<typeof createAvatarQueryClient>;

beforeAll(async () => {
  pool = createTestPool();
  const url =
    (pool.options as { connectionString?: string }).connectionString ?? '';
  client = createAvatarQueryClient(url);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

beforeEach(async () => {
  await resetIdentityTables(pool);
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [userId, `user-${userId.slice(-8).toLowerCase()}`],
  );
});

avatarRepositoryContract(
  () => new PostgresAvatarRepository(client),
  async () => {},
  userId,
);
