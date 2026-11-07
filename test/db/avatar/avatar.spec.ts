import type { Pool } from 'pg';
import { ulid } from 'ulid';

import type {
  AvatarStoragePort,
  ListedAvatarObject,
  StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import { AvatarUploadService } from '@/modules/avatar/application/avatar-upload.service';
import { type Avatar, avatarObjectKey } from '@/modules/avatar/domain/avatar';
import {
  PostgresAvatarRepository,
  createAvatarQueryClient,
} from '@/modules/avatar/infrastructure/postgres-avatar.repository';

import { createTestPool, resetIdentityTables } from '../shared/database';

let pool: Pool;
let client: ReturnType<typeof createAvatarQueryClient>;
let repository: PostgresAvatarRepository;

class DeferredStorage implements AvatarStoragePort {
  readonly staging = new Map<string, StoredAvatarObject>();
  readonly final = new Map<string, StoredAvatarObject>();
  stagingBytes = 'accepted-bytes';
  finalBytes = '';
  copyStarted: () => void = () => undefined;
  copyWait: Promise<void> = Promise.resolve();
  async createUploadUrl() {
    return { url: 'private', expiresAt: new Date() };
  }
  publicUrl(key: string) {
    return key;
  }
  async describeObject(key: string) {
    return this.staging.get(key);
  }
  async describeFinalObject(key: string) {
    return this.final.get(key);
  }
  async copyStagingToFinal(input: {
    readonly objectKey: string;
    readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  }) {
    const object = this.staging.get(input.objectKey);
    if (object !== undefined)
      this.final.set(input.objectKey, {
        ...object,
        contentType: input.contentType,
      });
    this.finalBytes = this.stagingBytes;
    this.copyStarted();
    await this.copyWait;
  }
  async deleteObject(key: string) {
    this.final.delete(key);
  }
  async deleteStagingObject(key: string) {
    this.staging.delete(key);
  }
  async *listObjects(): AsyncIterable<ListedAvatarObject> {}
  async *listStagingObjects(): AsyncIterable<ListedAvatarObject> {}
}

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
  it('serializes concurrent same-asset completions across a replayed staging PUT', async () => {
    const assetId = `ava_${ulid()}`;
    const objectKey = avatarObjectKey(userId, assetId);
    const now = new Date('2026-10-02T10:00:00.000Z');
    const storage = new DeferredStorage();
    storage.staging.set(objectKey, {
      contentType: 'image/png',
      byteSize: 12,
      lastModified: now,
    });
    let beginCopy = (): void => undefined;
    let releaseCopy = (): void => undefined;
    const copyStarted = new Promise<void>((resolve) => {
      beginCopy = resolve;
    });
    storage.copyWait = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    storage.copyStarted = beginCopy;
    const service = new AvatarUploadService(
      repository,
      storage,
      () => assetId,
      () => now,
    );

    const first = service.completeUpload({ userId, assetId });
    await copyStarted;
    storage.stagingBytes = 'replacement-same-length';
    const second = service.completeUpload({ userId, assetId });
    releaseCopy();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { created: true },
      { created: false },
    ]);
    expect(storage.finalBytes).toBe('accepted-bytes');
    await expect(repository.findByUser(userId)).resolves.toMatchObject({
      assetId,
    });
  });

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

describe('Avatar replacement and removal against PostgreSQL', () => {
  let current: Avatar;

  beforeEach(async () => {
    current = avatar(userId);
    await repository.record(current);
  });

  it('replaces the Avatar while the record still names the previous asset', async () => {
    const next = avatar(userId, { contentType: 'image/webp', byteSize: 99 });

    await expect(repository.replace(current.assetId, next)).resolves.toBe(true);
    await expect(repository.findByUser(userId)).resolves.toEqual(next);
  });

  it('changes nothing when the record no longer names the previous asset', async () => {
    const stale = `ava_${ulid()}`;

    await expect(repository.replace(stale, avatar(userId))).resolves.toBe(
      false,
    );
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('lets exactly one of two concurrent replacements apply', async () => {
    const results = await Promise.all([
      repository.replace(current.assetId, avatar(userId)),
      repository.replace(current.assetId, avatar(userId)),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await pool.query(
      'SELECT id FROM user_avatars WHERE user_account_id = $1',
      [userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('still refuses a replacement whose key does not name its owner', async () => {
    const other = await seedAccount();

    await expect(
      repository.replace(
        current.assetId,
        avatar(userId, { objectKey: avatarObjectKey(other, `ava_${ulid()}`) }),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('removes the record while it still names the asset', async () => {
    await expect(repository.remove(userId, current.assetId)).resolves.toBe(
      true,
    );
    await expect(repository.findByUser(userId)).resolves.toBeUndefined();
  });

  it('keeps a record that no longer names the asset', async () => {
    await expect(repository.remove(userId, `ava_${ulid()}`)).resolves.toBe(
      false,
    );
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('never removes another account record', async () => {
    const other = await seedAccount();

    await expect(repository.remove(other, current.assetId)).resolves.toBe(
      false,
    );
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('records a new first Avatar after removal', async () => {
    await repository.remove(userId, current.assetId);
    const next = avatar(userId);

    await expect(repository.record(next)).resolves.toEqual({
      kind: 'recorded',
      avatar: next,
    });
  });
});

describe('Which object keys an Avatar record names, against PostgreSQL', () => {
  it('returns exactly the recorded keys among those asked', async () => {
    const recorded = avatar(userId);
    await repository.record(recorded);
    const unrecorded = avatarObjectKey(userId, `ava_${ulid()}`);

    await expect(
      repository.recordedObjectKeys([recorded.objectKey, unrecorded]),
    ).resolves.toEqual(new Set([recorded.objectKey]));
  });

  it('returns nothing when none are recorded, or none are asked', async () => {
    await expect(
      repository.recordedObjectKeys([avatarObjectKey(userId, `ava_${ulid()}`)]),
    ).resolves.toEqual(new Set());
    await expect(repository.recordedObjectKeys([])).resolves.toEqual(new Set());
  });

  it('stops naming a key once its Avatar is replaced', async () => {
    const first = avatar(userId);
    await repository.record(first);
    const next = avatar(userId);
    await repository.replace(first.assetId, next);

    await expect(
      repository.recordedObjectKeys([first.objectKey, next.objectKey]),
    ).resolves.toEqual(new Set([next.objectKey]));
  });

  it('names the keys of several accounts at once', async () => {
    const other = await seedAccount();
    const mine = avatar(userId);
    const theirs = avatar(other);
    await repository.record(mine);
    await repository.record(theirs);

    await expect(
      repository.recordedObjectKeys([mine.objectKey, theirs.objectKey]),
    ).resolves.toEqual(new Set([mine.objectKey, theirs.objectKey]));
  });
});
