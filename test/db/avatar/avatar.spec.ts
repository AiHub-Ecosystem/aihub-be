import type { Pool } from 'pg';
import sharp from 'sharp';
import { ulid } from 'ulid';

import type { AvatarAuditEvent } from '@/modules/avatar/application/avatar-repository.port';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
  StagedAvatarObject,
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
let auditSequence = 0;

class DeferredStorage implements AvatarStoragePort {
  readonly staging = new Map<string, StoredAvatarObject>();
  readonly final = new Map<string, StoredAvatarObject>();
  readonly stagingBytes = new Map<string, Uint8Array>();
  readonly finalBytes = new Map<string, Uint8Array>();
  copyStarted: () => void = () => undefined;
  copyWait: Promise<void> = Promise.resolve();
  async createUploadUrl() {
    return { url: 'private', expiresAt: new Date() };
  }
  publicUrl(key: string) {
    return key;
  }
  async describeStagingObject(key: string) {
    return this.staging.get(key);
  }
  async describeFinalObject(key: string) {
    return this.final.get(key);
  }
  async readStagingObject(
    objectKey: string,
  ): Promise<StagedAvatarObject | undefined> {
    const object = this.staging.get(objectKey);
    const bytes = this.stagingBytes.get(objectKey);
    return object === undefined || bytes === undefined
      ? undefined
      : { contentType: object.contentType, bytes };
  }
  async putFinalObject(input: {
    readonly objectKey: string;
    readonly contentType: 'image/jpeg' | 'image/png' | 'image/webp';
    readonly bytes: Uint8Array;
  }) {
    this.final.set(input.objectKey, {
      contentType: input.contentType,
      byteSize: input.bytes.byteLength,
      lastModified: new Date(),
    });
    this.finalBytes.set(input.objectKey, input.bytes);
    this.copyStarted();
    await this.copyWait;
  }
  async deleteObject(key: string) {
    this.final.delete(key);
  }
  async deleteStagingObject(key: string) {
    this.staging.delete(key);
    this.stagingBytes.delete(key);
  }
  async *listObjects(): AsyncIterable<ListedAvatarObject> {}
  async *listStagingObjects(): AsyncIterable<ListedAvatarObject> {}
}

let png: Buffer;

async function pngBytes(): Promise<Buffer> {
  png ??= await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .png()
    .toBuffer();
  return png;
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

function audit(
  action: AvatarAuditEvent['action'],
  assetId: string,
): AvatarAuditEvent {
  return {
    action,
    assetId,
    requestId: 'req_01J00000000000000000000000',
    occurredAt: new Date(
      new Date('2026-10-02T10:00:01.000Z').getTime() + auditSequence++,
    ),
  };
}

beforeEach(async () => {
  auditSequence = 0;
  await resetIdentityTables(pool);
  userId = await seedAccount();
});

describe('Avatar records against PostgreSQL', () => {
  it('serializes concurrent same-asset completions across a replayed staging PUT', async () => {
    const assetId = `ava_${ulid()}`;
    const objectKey = avatarObjectKey(userId, assetId);
    const now = new Date('2026-10-02T10:00:00.000Z');
    const storage = new DeferredStorage();
    const accepted = await pngBytes();
    const replacement = await sharp(accepted).resize(4, 4).png().toBuffer();
    storage.staging.set(objectKey, {
      contentType: 'image/png',
      byteSize: accepted.byteLength,
      lastModified: now,
    });
    storage.stagingBytes.set(objectKey, accepted);
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

    const first = service.completeUpload({
      userId,
      assetId,
      requestId: 'req_01J00000000000000000000000',
    });
    await copyStarted;
    storage.stagingBytes.set(objectKey, replacement);
    const second = service.completeUpload({
      userId,
      assetId,
      requestId: 'req_01J00000000000000000000001',
    });
    releaseCopy();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { created: true },
      { created: false },
    ]);
    expect(
      await sharp(storage.finalBytes.get(objectKey)!).metadata(),
    ).toMatchObject({
      width: 2,
      height: 2,
    });
    await expect(repository.findByUser(userId)).resolves.toMatchObject({
      assetId,
    });
    const audits = await pool.query(
      'SELECT action, request_id FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows).toEqual([
      { action: 'avatar.set', request_id: 'req_01J00000000000000000000000' },
    ]);
  });

  it('records an Avatar and reads it back by its owner', async () => {
    const recorded = avatar(userId);

    await expect(
      repository.record(recorded, audit('avatar.set', recorded.assetId)),
    ).resolves.toEqual({
      kind: 'recorded',
      avatar: recorded,
    });
    await expect(repository.findByUser(userId)).resolves.toEqual(recorded);
  });

  it('answers a repeat of the same asset with the stored Avatar', async () => {
    const recorded = avatar(userId);
    await repository.record(recorded, audit('avatar.set', recorded.assetId));

    await expect(
      repository.record(
        { ...recorded, acceptedAt: new Date() },
        audit('avatar.set', recorded.assetId),
      ),
    ).resolves.toEqual({ kind: 'already_recorded', avatar: recorded });
  });

  it('keeps one Avatar per account', async () => {
    const first = avatar(userId);
    const second = avatar(userId);
    await repository.record(first, audit('avatar.set', first.assetId));

    await expect(
      repository.record(second, audit('avatar.set', second.assetId)),
    ).resolves.toEqual({
      kind: 'exists',
    });
    await expect(repository.findByUser(userId)).resolves.toEqual(first);
    const audits = await pool.query(
      'SELECT action, asset_id FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows).toEqual([
      { action: 'avatar.set', asset_id: first.assetId },
    ]);
  });

  it('keeps one Avatar per account under concurrent completions', async () => {
    const first = avatar(userId);
    const second = avatar(userId);
    const results = await Promise.all([
      repository.record(first, audit('avatar.set', first.assetId)),
      repository.record(second, audit('avatar.set', second.assetId)),
    ]);

    expect(results.map((result) => result.kind).sort()).toEqual([
      'exists',
      'recorded',
    ]);
    // Only the record that applied wrote an event.
    const audits = await pool.query(
      'SELECT count(*)::int AS count FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows[0]).toEqual({ count: 1 });
  });

  it('refuses an Avatar for an unknown account', async () => {
    const unknown = avatar(`usr_${ulid()}`);
    await expect(
      repository.record(unknown, audit('avatar.set', unknown.assetId)),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('refuses a key that does not name its owner', async () => {
    const other = await seedAccount();
    const record = avatar(userId, {
      objectKey: avatarObjectKey(other, `ava_${ulid()}`),
    });

    await expect(
      repository.record(record, audit('avatar.set', record.assetId)),
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
    await repository.record(current, audit('avatar.set', current.assetId));
  });

  it('replaces the Avatar while the record still names the previous asset', async () => {
    const next = avatar(userId, { contentType: 'image/webp', byteSize: 99 });

    await expect(
      repository.replace(
        current.assetId,
        next,
        audit('avatar.replaced', next.assetId),
      ),
    ).resolves.toBe(true);
    await expect(repository.findByUser(userId)).resolves.toEqual(next);
    const audits = await pool.query(
      'SELECT action, asset_id FROM user_avatar_audits WHERE user_account_id = $1 ORDER BY occurred_at',
      [userId],
    );
    expect(audits.rows).toEqual([
      { action: 'avatar.set', asset_id: current.assetId },
      { action: 'avatar.replaced', asset_id: next.assetId },
    ]);
  });

  it('changes nothing when the record no longer names the previous asset', async () => {
    const stale = `ava_${ulid()}`;
    const next = avatar(userId);

    await expect(
      repository.replace(stale, next, audit('avatar.replaced', next.assetId)),
    ).resolves.toBe(false);
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
    const audits = await pool.query(
      'SELECT count(*)::int AS count FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows[0]).toEqual({ count: 1 });
  });

  it('lets exactly one of two concurrent replacements apply', async () => {
    const first = avatar(userId);
    const second = avatar(userId);
    const results = await Promise.all([
      repository.replace(
        current.assetId,
        first,
        audit('avatar.replaced', first.assetId),
      ),
      repository.replace(
        current.assetId,
        second,
        audit('avatar.replaced', second.assetId),
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await pool.query(
      'SELECT id FROM user_avatars WHERE user_account_id = $1',
      [userId],
    );
    expect(rows.rowCount).toBe(1);
    const audits = await pool.query(
      'SELECT count(*)::int AS count FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows[0]).toEqual({ count: 2 });
  });

  it('still refuses a replacement whose key does not name its owner', async () => {
    const other = await seedAccount();
    const invalid = avatar(userId, {
      objectKey: avatarObjectKey(other, `ava_${ulid()}`),
    });

    await expect(
      repository.replace(
        current.assetId,
        invalid,
        audit('avatar.replaced', invalid.assetId),
      ),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('removes the record while it still names the asset', async () => {
    await expect(
      repository.remove(
        userId,
        current.assetId,
        audit('avatar.removed', current.assetId),
      ),
    ).resolves.toBe(true);
    await expect(repository.findByUser(userId)).resolves.toBeUndefined();
    const audits = await pool.query(
      'SELECT action, request_id FROM user_avatar_audits WHERE user_account_id = $1 ORDER BY occurred_at',
      [userId],
    );
    expect(audits.rows).toEqual([
      {
        action: 'avatar.set',
        request_id: 'req_01J00000000000000000000000',
      },
      {
        action: 'avatar.removed',
        request_id: 'req_01J00000000000000000000000',
      },
    ]);
  });

  it('keeps a record that no longer names the asset', async () => {
    await expect(
      repository.remove(
        userId,
        `ava_${ulid()}`,
        audit('avatar.removed', current.assetId),
      ),
    ).resolves.toBe(false);
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('never removes another account record', async () => {
    const other = await seedAccount();

    await expect(
      repository.remove(
        other,
        current.assetId,
        audit('avatar.removed', current.assetId),
      ),
    ).resolves.toBe(false);
    await expect(repository.findByUser(userId)).resolves.toEqual(current);
  });

  it('records a new first Avatar after removal', async () => {
    await repository.remove(
      userId,
      current.assetId,
      audit('avatar.removed', current.assetId),
    );
    const next = avatar(userId);

    await expect(
      repository.record(next, audit('avatar.set', next.assetId)),
    ).resolves.toEqual({
      kind: 'recorded',
      avatar: next,
    });
  });

  it('refuses to change an audit row once written', async () => {
    await expect(
      pool.query(
        'UPDATE user_avatar_audits SET action = $1 WHERE user_account_id = $2',
        ['avatar.removed', userId],
      ),
    ).rejects.toThrow('append-only');
    await expect(
      pool.query('DELETE FROM user_avatar_audits WHERE user_account_id = $1', [
        userId,
      ]),
    ).rejects.toThrow('append-only');
    const audits = await pool.query(
      'SELECT count(*)::int AS count FROM user_avatar_audits WHERE user_account_id = $1',
      [userId],
    );
    expect(audits.rows[0]).toEqual({ count: 1 });
  });
});

describe('Which object keys an Avatar record names, against PostgreSQL', () => {
  it('returns exactly the recorded keys among those asked', async () => {
    const recorded = avatar(userId);
    await repository.record(recorded, audit('avatar.set', recorded.assetId));
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
    await repository.record(first, audit('avatar.set', first.assetId));
    const next = avatar(userId);
    await repository.replace(
      first.assetId,
      next,
      audit('avatar.replaced', next.assetId),
    );

    await expect(
      repository.recordedObjectKeys([first.objectKey, next.objectKey]),
    ).resolves.toEqual(new Set([next.objectKey]));
  });

  it('names the keys of several accounts at once', async () => {
    const other = await seedAccount();
    const mine = avatar(userId);
    const theirs = avatar(other);
    await repository.record(mine, audit('avatar.set', mine.assetId));
    await repository.record(theirs, audit('avatar.set', theirs.assetId));

    await expect(
      repository.recordedObjectKeys([mine.objectKey, theirs.objectKey]),
    ).resolves.toEqual(new Set([mine.objectKey, theirs.objectKey]));
  });
});
