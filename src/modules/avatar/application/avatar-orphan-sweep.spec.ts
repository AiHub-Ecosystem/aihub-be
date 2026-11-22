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
  async *listObjects(): AsyncIterable<ListedAvatarObject> {
    yield* this.final;
  }
  async *listStagingObjects(): AsyncIterable<ListedAvatarObject> {
    yield* this.staging;
  }
  async deleteObject(key: string) {
    this.deleted.push(`final:${key}`);
  }
  async deleteStagingObject(key: string) {
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
