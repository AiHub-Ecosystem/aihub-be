import { AppError } from '@/common/errors/app-error';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
  StoredAvatarObject,
} from '@/modules/avatar/application/avatar-storage.port';
import {
  AVATAR_SWEEP_GRACE_MS,
  type Avatar,
  avatarObjectKey,
} from '@/modules/avatar/domain/avatar';
import { InMemoryAvatarRepository } from '@/modules/avatar/testing/in-memory-avatar.repository';

import { runAvatarSweepCommand } from './avatar-sweep';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - AVATAR_SWEEP_GRACE_MS - 1_000);
const YOUNG = new Date(NOW.getTime() - AVATAR_SWEEP_GRACE_MS + 60_000);

function userId(n: number): string {
  return `usr_01J000000000000000000000${String(n).padStart(2, '0')}`;
}

function assetId(n: number): string {
  return `ava_01J000000000000000000000${String(n).padStart(2, '0')}`;
}

function keyOf(n: number): string {
  return avatarObjectKey(userId(n), assetId(n));
}

class FakeAvatarStorage implements AvatarStoragePort {
  readonly objects = new Map<string, Date | undefined>();
  readonly deleted: string[] = [];
  readonly failDeleteOf = new Set<string>();
  listedPages = 0;
  unavailable = false;

  async createUploadUrl(): Promise<never> {
    throw new Error('not used by the sweep');
  }

  publicUrl(): string {
    throw new Error('not used by the sweep');
  }

  async describeObject(): Promise<StoredAvatarObject | undefined> {
    throw new Error('not used by the sweep');
  }

  async deleteObject(objectKey: string): Promise<void> {
    if (this.failDeleteOf.has(objectKey)) {
      throw new AppError({
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        message: 'Avatar storage is unavailable',
        retryable: true,
      });
    }
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
  }

  async *listObjects(prefix: string): AsyncIterable<ListedAvatarObject> {
    if (this.unavailable) {
      throw new AppError({
        code: 'AVATAR_STORAGE_UNAVAILABLE',
        message: 'Avatar storage is unavailable',
        retryable: true,
      });
    }
    const all = [...this.objects.entries()].filter(([key]) =>
      key.startsWith(prefix),
    );
    // Two objects per page, so a sweep must follow every page.
    for (let index = 0; index < all.length; index += 2) {
      this.listedPages += 1;
      for (const [objectKey, lastModified] of all.slice(index, index + 2)) {
        yield { objectKey, lastModified };
      }
    }
  }
}

function avatarRecord(n: number): Avatar {
  return {
    assetId: assetId(n),
    userId: userId(n),
    objectKey: keyOf(n),
    contentType: 'image/png',
    byteSize: 10,
    acceptedAt: OLD,
  };
}

function run(
  setup: (
    storage: FakeAvatarStorage,
    repository: InMemoryAvatarRepository,
  ) => void,
  options: { dryRun?: boolean } = {},
) {
  const storage = new FakeAvatarStorage();
  const repository = new InMemoryAvatarRepository();
  const lines: string[] = [];
  setup(storage, repository);
  const closed = { value: false };
  const outcome = runAvatarSweepCommand({
    databaseUrl: 'postgres://unused',
    dryRun: options.dryRun ?? false,
    repository: Object.assign(repository, {
      close: async () => {
        closed.value = true;
      },
    }),
    storage,
    emit: (line) => lines.push(line),
    now: () => NOW,
  });
  return { outcome, storage, repository, lines, closed };
}

describe('runAvatarSweepCommand', () => {
  it('deletes an unrecorded object older than the grace and reports it', async () => {
    const { outcome, storage, lines, closed } = run((s) => {
      s.objects.set(keyOf(1), OLD);
    });

    await expect(outcome).resolves.toMatchObject({ orphaned: 1, deleted: 1 });
    expect(storage.deleted).toEqual([keyOf(1)]);
    expect(JSON.parse(lines.join('\n'))).toEqual({
      scanned: 1,
      unrecognised: 0,
      orphaned: 1,
      deleted: 1,
      failed: 0,
      dryRun: false,
    });
    expect(closed.value).toBe(true);
  });

  it('keeps an unrecorded object that is still inside the grace', async () => {
    const { outcome, storage } = run((s) => {
      s.objects.set(keyOf(1), YOUNG);
    });

    await expect(outcome).resolves.toMatchObject({ orphaned: 0, deleted: 0 });
    expect(storage.deleted).toEqual([]);
  });

  it('never deletes an object a record names, at any age', async () => {
    const { outcome, storage } = run((s, r) => {
      s.objects.set(keyOf(1), OLD);
      s.objects.set(keyOf(2), new Date(0));
      r.avatars.set(userId(1), avatarRecord(1));
      r.avatars.set(userId(2), avatarRecord(2));
    });

    await expect(outcome).resolves.toMatchObject({
      scanned: 2,
      orphaned: 0,
      deleted: 0,
    });
    expect(storage.deleted).toEqual([]);
  });

  it('keeps an object whose age storage does not report', async () => {
    const { outcome, storage } = run((s) => {
      s.objects.set(keyOf(1), undefined);
    });

    await expect(outcome).resolves.toMatchObject({ orphaned: 0, deleted: 0 });
    expect(storage.deleted).toEqual([]);
  });

  it.each([
    ['another prefix layout', 'users/usr_01J00000000000000000000001/other.png'],
    ['a different object name', `users/${userId(1)}/avatar/${assetId(1)}/copy`],
    ['a malformed account id', `users/bob/avatar/${assetId(1)}/original`],
    ['a malformed asset id', `users/${userId(1)}/avatar/ava_nope/original`],
    [
      'extra path segments',
      `users/${userId(1)}/avatar/${assetId(1)}/original/x`,
    ],
  ])('leaves a key with %s alone and counts it', async (_, objectKey) => {
    const { outcome, storage } = run((s) => {
      s.objects.set(objectKey, OLD);
    });

    await expect(outcome).resolves.toMatchObject({
      scanned: 1,
      unrecognised: 1,
      orphaned: 0,
      deleted: 0,
    });
    expect(storage.deleted).toEqual([]);
  });

  it('reports a dry run without deleting anything', async () => {
    const { outcome, storage, lines } = run(
      (s) => {
        s.objects.set(keyOf(1), OLD);
        s.objects.set(keyOf(2), OLD);
      },
      { dryRun: true },
    );

    await expect(outcome).resolves.toMatchObject({
      orphaned: 2,
      deleted: 0,
      dryRun: true,
    });
    expect(storage.deleted).toEqual([]);
    expect(storage.objects.size).toBe(2);
    expect(JSON.parse(lines.join('\n')).dryRun).toBe(true);
  });

  it('follows every page of the listing', async () => {
    const { outcome, storage } = run((s) => {
      for (const n of [1, 2, 3, 4, 5]) {
        s.objects.set(keyOf(n), OLD);
      }
    });

    await expect(outcome).resolves.toMatchObject({ scanned: 5, deleted: 5 });
    expect(storage.listedPages).toBe(3);
  });

  it('counts a failed delete, carries on, and reports it', async () => {
    const { outcome, storage } = run((s) => {
      s.objects.set(keyOf(1), OLD);
      s.objects.set(keyOf(2), OLD);
      s.failDeleteOf.add(keyOf(1));
    });

    await expect(outcome).resolves.toMatchObject({
      orphaned: 2,
      deleted: 1,
      failed: 1,
    });
    expect(storage.deleted).toEqual([keyOf(2)]);
  });

  it('deletes nothing and fails when storage cannot be listed', async () => {
    const { outcome, storage, closed } = run((s) => {
      s.objects.set(keyOf(1), OLD);
      s.unavailable = true;
    });

    await expect(outcome).rejects.toMatchObject({
      code: 'AVATAR_STORAGE_UNAVAILABLE',
    });
    expect(storage.deleted).toEqual([]);
    expect(closed.value).toBe(true);
  });

  it('deletes nothing and fails when the records cannot be read', async () => {
    const storage = new FakeAvatarStorage();
    storage.objects.set(keyOf(1), OLD);
    const repository = Object.assign(new InMemoryAvatarRepository(), {
      close: async () => undefined,
      recordedObjectKeys: async () => {
        throw new Error('database is down');
      },
    });

    await expect(
      runAvatarSweepCommand({
        databaseUrl: 'postgres://unused',
        dryRun: false,
        repository,
        storage,
        emit: () => undefined,
        now: () => NOW,
      }),
    ).rejects.toThrow('database is down');
    expect(storage.deleted).toEqual([]);
  });

  it('says nothing about storage beyond counts', async () => {
    const { outcome, lines } = run((s) => {
      s.objects.set(keyOf(1), OLD);
    });
    await outcome;

    expect(lines.join('')).not.toContain('users/');
    expect(lines.join('')).not.toContain(userId(1));
  });
});
