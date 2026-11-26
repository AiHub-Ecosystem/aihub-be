import { AvatarOrphanSweep } from './avatar-orphan-sweep';
import type { AvatarRepositoryPort } from './avatar-repository.port';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from './avatar-storage.port';

const KEY =
  'users/usr_01J00000000000000000000000/avatar/ava_01J00000000000000000000001/original';
const NOW = new Date('2026-10-02T10:00:00.000Z');
const OLD = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);

function orphanKey(n: number): string {
  return `users/usr_01J000000000000000000${String(n).padStart(5, '0')}/avatar/ava_01J00000000000000000000001/original`;
}

class SweepStorage
  implements
    Pick<
      AvatarStoragePort,
      | 'listObjects'
      | 'listStagingObjects'
      | 'deleteObject'
      | 'deleteStagingObject'
    >
{
  readonly final: ListedAvatarObject[] = [];
  readonly staging: ListedAvatarObject[] = [];
  readonly deleted: string[] = [];
  readonly failFinal = new Set<string>();
  readonly failStaging = new Set<string>();
  listedFinal = 0;
  failListingAfter = Number.POSITIVE_INFINITY;
  async *listObjects(
    _prefix?: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    for (const object of this.final) {
      if (startAfter !== undefined && object.objectKey <= startAfter) continue;
      if (this.listedFinal >= this.failListingAfter) {
        throw new Error('listing interrupted');
      }
      this.listedFinal += 1;
      yield object;
    }
  }
  async *listStagingObjects(
    _prefix?: string,
    startAfter?: string,
  ): AsyncIterable<ListedAvatarObject> {
    yield* this.staging.filter(
      (object) => startAfter === undefined || object.objectKey > startAfter,
    );
  }
  async deleteObject(key: string) {
    if (this.failFinal.has(key)) throw new Error('delete failed');
    this.deleted.push(`final:${key}`);
  }
  async deleteStagingObject(key: string) {
    if (this.failStaging.has(key)) throw new Error('delete failed');
    this.deleted.push(key);
  }
}

describe('AvatarOrphanSweep staging bucket', () => {
  it('deletes only old exact-layout staging objects, without checking records', async () => {
    const storage = new SweepStorage();
    storage.staging.push(
      {
        objectKey: KEY,
        lastModified: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
      },
      {
        objectKey: KEY.replace('/original', '/other'),
        lastModified: new Date(0),
      },
      { objectKey: KEY, lastModified: undefined },
      {
        objectKey: KEY,
        lastModified: new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
      },
    );
    const recordedObjectKeys = jest.fn(async () => new Set<string>());
    const repository = {
      recordedObjectKeys,
    } satisfies Pick<AvatarRepositoryPort, 'recordedObjectKeys'>;
    const result = await new AvatarOrphanSweep(repository, storage).run({
      dryRun: false,
      now: NOW,
    });
    expect(storage.deleted).toEqual([KEY]);
    expect(recordedObjectKeys).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      stagingScanned: 4,
      stagingUnrecognised: 1,
      stagingEligible: 1,
      stagingDeleted: 1,
    });
  });

  it('reports eligible staging objects without deleting during dry run', async () => {
    const storage = new SweepStorage();
    storage.staging.push({ objectKey: KEY, lastModified: new Date(0) });
    const repository = {
      recordedObjectKeys: async () => new Set<string>(),
    } satisfies Pick<AvatarRepositoryPort, 'recordedObjectKeys'>;
    const result = await new AvatarOrphanSweep(repository, storage).run({
      dryRun: true,
      now: NOW,
    });
    expect(storage.deleted).toEqual([]);
    expect(result.stagingEligible).toBe(1);
    expect(result.stagingDeleted).toBe(0);
  });

  it.each([
    {
      ceiling: 'deletes up to the count ceiling and reports no breach',
      orphans: 2_000,
      listed: 4_100,
      deleted: 2_000,
      ceilingExceeded: false,
    },
    {
      ceiling: 'stops without deleting past the count ceiling',
      orphans: 2_001,
      listed: 4_100,
      deleted: 0,
      ceilingExceeded: true,
    },
    {
      ceiling: 'stops without deleting when over half a large bucket would go',
      orphans: 600,
      listed: 1_000,
      deleted: 0,
      ceilingExceeded: true,
    },
  ])(
    'deletion ceiling: $ceiling',
    async ({ orphans, listed, deleted, ceilingExceeded }) => {
      const storage = new SweepStorage();
      for (let n = 0; n < listed; n += 1) {
        storage.final.push({
          objectKey: orphanKey(n),
          lastModified: n < orphans ? OLD : NOW,
        });
      }
      const repository = {
        recordedObjectKeys: async () => new Set<string>(),
      } satisfies Pick<AvatarRepositoryPort, 'recordedObjectKeys'>;

      const result = await new AvatarOrphanSweep(repository, storage).run({
        dryRun: false,
        now: NOW,
      });

      expect(storage.deleted).toHaveLength(deleted);
      expect(result).toMatchObject({
        scanned: listed,
        orphaned: orphans,
        deleted,
        ceilingExceeded,
      });
    },
  );
});

describe('AvatarOrphanSweep recovery', () => {
  const repository = {
    recordedObjectKeys: jest.fn(async () => new Set<string>()),
  } satisfies Pick<AvatarRepositoryPort, 'recordedObjectKeys'>;

  beforeEach(() => repository.recordedObjectKeys.mockReset());

  it('deletes a bounded pass and resumes after its saved cursor', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    for (let n = 1; n <= 6; n += 1) {
      storage.final.push({ objectKey: orphanKey(n), lastModified: OLD });
    }

    const first = await new AvatarOrphanSweep(repository, storage).runRecovery({
      now: NOW,
      maxListed: 4,
      maxDeletes: 2,
    });
    expect(first.deleted).toBe(2);
    expect(first.finalDone).toBe(false);
    expect(first.nextFinalCursor).toBe(orphanKey(2));
    expect(storage.deleted).toEqual([
      `final:${orphanKey(1)}`,
      `final:${orphanKey(2)}`,
    ]);

    const second = await new AvatarOrphanSweep(repository, storage).runRecovery(
      {
        now: NOW,
        ...(first.nextFinalCursor === undefined
          ? {}
          : { finalCursor: first.nextFinalCursor }),
        maxListed: 4,
        maxDeletes: 2,
      },
    );
    expect(second.deleted).toBe(2);
    expect(second.nextFinalCursor).toBe(orphanKey(4));
    expect(storage.deleted).toHaveLength(4);
  });

  it('refuses an object that acquires a record between the two checks', async () => {
    repository.recordedObjectKeys
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set([orphanKey(1)]));
    const storage = new SweepStorage();
    storage.final.push({ objectKey: orphanKey(1), lastModified: OLD });

    const result = await new AvatarOrphanSweep(repository, storage).runRecovery(
      {
        now: NOW,
      },
    );

    expect(storage.deleted).toEqual([]);
    expect(result).toMatchObject({ failed: 0, nextFinalCursor: orphanKey(1) });
  });

  it('keeps a failed delete at the cursor so the next pass retries it', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    storage.final.push({ objectKey: orphanKey(1), lastModified: OLD });
    storage.failFinal.add(orphanKey(1));
    const sweep = new AvatarOrphanSweep(repository, storage);

    const first = await sweep.runRecovery({ now: NOW });
    expect(first).toMatchObject({ deleted: 0, failed: 1, partial: true });
    expect(first.nextFinalCursor).toBeUndefined();

    storage.failFinal.clear();
    const second = await sweep.runRecovery({ now: NOW });
    expect(second).toMatchObject({ deleted: 1, failed: 0 });
    expect(storage.deleted).toEqual([`final:${orphanKey(1)}`]);
  });

  it('keeps protected objects and reports the pass as finished', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    storage.final.push(
      {
        objectKey: orphanKey(1),
        lastModified: new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
      },
      { objectKey: orphanKey(2), lastModified: undefined },
      {
        objectKey: orphanKey(3).replace('/original', '/other'),
        lastModified: OLD,
      },
    );
    storage.staging.push(
      {
        objectKey: orphanKey(4),
        lastModified: new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
      },
      { objectKey: orphanKey(5), lastModified: undefined },
    );

    const result = await new AvatarOrphanSweep(repository, storage).runRecovery(
      {
        now: NOW,
      },
    );

    expect(storage.deleted).toEqual([]);
    expect(result).toMatchObject({
      unrecognised: 1,
      orphaned: 0,
      stagingUnrecognised: 0,
      stagingEligible: 0,
      finalDone: true,
      stagingDone: true,
      partial: false,
    });
  });

  it('drains a reviewed backlog beyond the normal ceiling in bounded passes', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    for (let n = 0; n < 2_001; n += 1) {
      storage.final.push({ objectKey: orphanKey(n), lastModified: OLD });
    }

    const result = await new AvatarOrphanSweep(repository, storage).runRecovery(
      {
        now: NOW,
        maxListed: 500,
        maxDeletes: 500,
      },
    );

    expect(result).toMatchObject({
      deleted: 500,
      orphaned: 500,
      partial: true,
      finalDone: false,
    });
    expect(storage.deleted).toHaveLength(500);
  });

  it('drains a reviewed over-half backlog rather than refusing it', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    for (let n = 0; n < 1_000; n += 1) {
      storage.final.push({
        objectKey: orphanKey(n),
        lastModified: n < 600 ? OLD : NOW,
      });
    }

    const result = await new AvatarOrphanSweep(repository, storage).runRecovery(
      {
        now: NOW,
        maxListed: 500,
        maxDeletes: 500,
      },
    );

    expect(result).toMatchObject({
      deleted: 500,
      orphaned: 500,
      partial: true,
    });
    expect(storage.deleted).toHaveLength(500);
  });

  it('deletes nothing when the listing is interrupted before the pass settles', async () => {
    repository.recordedObjectKeys.mockResolvedValue(new Set());
    const storage = new SweepStorage();
    storage.final.push(
      { objectKey: orphanKey(1), lastModified: OLD },
      { objectKey: orphanKey(2), lastModified: OLD },
    );
    storage.failListingAfter = 1;

    await expect(
      new AvatarOrphanSweep(repository, storage).runRecovery({ now: NOW }),
    ).rejects.toThrow('listing interrupted');
    expect(storage.deleted).toEqual([]);
  });
});
