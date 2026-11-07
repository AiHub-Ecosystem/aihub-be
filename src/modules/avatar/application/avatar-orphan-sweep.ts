import {
  AVATAR_OBJECT_PREFIX,
  AVATAR_SWEEP_GRACE_MS,
  isAvatarObjectKey,
} from '@/modules/avatar/domain/avatar';

import type { AvatarRepositoryPort } from './avatar-repository.port';
import type { AvatarStoragePort } from './avatar-storage.port';

export interface AvatarSweepSummary {
  /** Every object storage listed under the Avatar prefix. */
  readonly scanned: number;
  /** Keys outside the Avatar layout, which the sweep never touches. */
  readonly unrecognised: number;
  /** Old enough, in the layout, and named by no Avatar record. */
  readonly orphaned: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
  readonly stagingScanned: number;
  readonly stagingUnrecognised: number;
  readonly stagingEligible: number;
  readonly stagingDeleted: number;
  readonly stagingFailed: number;
}

const BATCH_SIZE = 500;

/**
 * Deletes Avatar objects that no record names once they are older than the
 * grace (ADR-0068).
 *
 * A completion only adopts an object younger than its own, much shorter,
 * window, so an object past the grace can no longer become an Avatar and
 * checking the records and deleting cannot race a completion. Only keys in the
 * exact Avatar layout are ever considered, and an object whose age storage does
 * not report is kept.
 */
export class AvatarOrphanSweep {
  constructor(
    private readonly avatars: Pick<AvatarRepositoryPort, 'recordedObjectKeys'>,
    private readonly storage: Pick<
      AvatarStoragePort,
      | 'listObjects'
      | 'deleteObject'
      | 'listStagingObjects'
      | 'deleteStagingObject'
    >,
  ) {}

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<AvatarSweepSummary> {
    const cutoff = input.now.getTime() - AVATAR_SWEEP_GRACE_MS;
    let scanned = 0;
    let unrecognised = 0;
    let orphaned = 0;
    let deleted = 0;
    let failed = 0;
    let batch: string[] = [];
    let stagingScanned = 0;
    let stagingUnrecognised = 0;
    let stagingEligible = 0;
    let stagingDeleted = 0;
    let stagingFailed = 0;

    // The records are read before anything is deleted, so a database that
    // cannot be reached stops the run before it touches storage.
    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const recorded = await this.avatars.recordedObjectKeys(batch);
      const orphans = batch.filter((objectKey) => !recorded.has(objectKey));
      batch = [];
      orphaned += orphans.length;
      if (input.dryRun) {
        return;
      }
      for (const objectKey of orphans) {
        try {
          await this.storage.deleteObject(objectKey);
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
    };

    for await (const object of this.storage.listObjects(AVATAR_OBJECT_PREFIX)) {
      scanned += 1;
      if (!isAvatarObjectKey(object.objectKey)) {
        unrecognised += 1;
        continue;
      }
      if (
        object.lastModified === undefined ||
        object.lastModified.getTime() > cutoff
      ) {
        continue;
      }
      batch.push(object.objectKey);
      if (batch.length >= BATCH_SIZE) {
        await flush();
      }
    }
    await flush();

    for await (const object of this.storage.listStagingObjects(
      AVATAR_OBJECT_PREFIX,
    )) {
      stagingScanned += 1;
      if (!isAvatarObjectKey(object.objectKey)) {
        stagingUnrecognised += 1;
        continue;
      }
      if (
        object.lastModified === undefined ||
        object.lastModified.getTime() > cutoff
      )
        continue;
      stagingEligible += 1;
      if (input.dryRun) continue;
      try {
        await this.storage.deleteStagingObject(object.objectKey);
        stagingDeleted += 1;
      } catch {
        stagingFailed += 1;
      }
    }

    return {
      scanned,
      unrecognised,
      orphaned,
      deleted,
      failed,
      dryRun: input.dryRun,
      stagingScanned,
      stagingUnrecognised,
      stagingEligible,
      stagingDeleted,
      stagingFailed,
    };
  }
}
