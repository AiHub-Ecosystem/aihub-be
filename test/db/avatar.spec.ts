import type { Pool } from 'pg';
import { ulid } from 'ulid';

import { type Avatar, avatarObjectKey } from '@/modules/avatar/domain/avatar';
import {
  PostgresAvatarRepository,
  createAvatarQueryClient,
} from '@/modules/avatar/infrastructure/postgres-avatar.repository';

import { createTestPool, resetIdentityTables } from './database';

let pool: Pool;
let client: ReturnType<typeof createAvatarQueryClient>;
let repository: PostgresAvatarRepository;

beforeAll(() => {
  pool = createTestPool();
  const url =
    (pool.options as { connectionString?: string }).connectionString ?? '';
  client = createAvatarQueryClient(url);
  repository = new PostgresAvatarRepository(client);
});

afterAll(async () => {
  await client.close();
  await pool.end();
});

let userId: string;

async function seedAccount(): Promise<string> {
  const id = `usr_${ulid()}`;
  await pool.query(
    `INSERT INTO user_accounts (id, username, status, created_at, updated_at)
     VALUES ($1, $2, 'active', now(), now())`,
    [id, `user-${id.slice(-8).toLowerCase()}`],
  );
  return id;
}

function avatar(owner: string, overrides: Partial<Avatar> = {}): Avatar {
  const assetId = overrides.assetId ?? `ava_${ulid()}`;
  return {
    assetId,
    userId: owner,
    objectKey: avatarObjectKey(owner, assetId),
    contentType: 'image/png',
    byteSize: 1234,
    acceptedAt: new Date('2026-10-02T10:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(async () => {
  await resetIdentityTables(pool);
  userId = await seedAccount();
});

describe('Avatar records against PostgreSQL', () => {
  it('records an Avatar and reads it back by its owner', async () => {
    const recorded = avatar(userId);

    await expect(repository.record(recorded)).resolves.toEqual({
      kind: 'recorded',
      avatar: recorded,
    });
    await expect(repository.findByUser(userId)).resolves.toEqual(recorded);
  });

  it('answers a repeat of the same asset with the stored Avatar', async () => {
    const recorded = avatar(userId);
    await repository.record(recorded);

    await expect(
      repository.record({ ...recorded, acceptedAt: new Date() }),
    ).resolves.toEqual({ kind: 'already_recorded', avatar: recorded });
  });

  it('keeps one Avatar per account', async () => {
    const first = avatar(userId);
    await repository.record(first);

    await expect(repository.record(avatar(userId))).resolves.toEqual({
      kind: 'exists',
    });
    await expect(repository.findByUser(userId)).resolves.toEqual(first);
  });

  it('keeps one Avatar per account under concurrent completions', async () => {
    const results = await Promise.all([
      repository.record(avatar(userId)),
      repository.record(avatar(userId)),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'exists',
      'recorded',
    ]);
  });

  it('refuses an Avatar for an unknown account', async () => {
    await expect(
      repository.record(avatar(`usr_${ulid()}`)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('refuses a key that does not name its owner', async () => {
    const other = await seedAccount();

    await expect(
      repository.record(
        avatar(userId, { objectKey: avatarObjectKey(other, `ava_${ulid()}`) }),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(repository.findByUser(userId)).resolves.toBeUndefined();
  });

  it('finds nothing for an account without an Avatar', async () => {
    await expect(repository.findByUser(userId)).resolves.toBeUndefined();
  });
});
