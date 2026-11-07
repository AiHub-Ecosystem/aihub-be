import { AvatarOrphanSweep } from './avatar-orphan-sweep';
import type { AvatarRepositoryPort } from './avatar-repository.port';
import type {
  AvatarStoragePort,
  ListedAvatarObject,
} from './avatar-storage.port';

const KEY =
  'users/usr_01J00000000000000000000000/avatar/ava_01J00000000000000000000001/original';
const NOW = new Date('2026-10-02T10:00:00.000Z');

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
  readonly staging: ListedAvatarObject[] = [];
  readonly deleted: string[] = [];
  async *listObjects(): AsyncIterable<ListedAvatarObject> {}
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
    } as unknown as AvatarRepositoryPort;
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
    } as unknown as AvatarRepositoryPort;
    const result = await new AvatarOrphanSweep(repository, storage).run({
      dryRun: true,
      now: NOW,
    });
    expect(storage.deleted).toEqual([]);
    expect(result.stagingEligible).toBe(1);
    expect(result.stagingDeleted).toBe(0);
  });
});
