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
  /** The run would have deleted more than one run may; it deleted nothing. */
  readonly ceilingExceeded: boolean;
  readonly stagingScanned: number;
  readonly stagingUnrecognised: number;
  readonly stagingEligible: number;
  readonly stagingDeleted: number;
  readonly stagingFailed: number;
}

const BATCH_SIZE = 500;

/**
 * The most one run may delete, and the share of what it listed that may go.
 * A real day leaves a handful of abandoned uploads behind, so a bigger figure
 * means the bucket or the record set is not the one this deployment expects,
 * and deleting would be the damage (#428). The share is measured only above
 * `SHARE_FLOOR` listed objects, so a small bucket can still be swept.
 */
const DELETION_CEILING = 2_000;
const SHARE_FLOOR = 500;

interface SweepPlan {
  readonly scanned: number;
  readonly unrecognised: number;
  readonly orphaned: number;
  readonly orphans: readonly string[];
  readonly stagingScanned: number;
  readonly stagingUnrecognised: number;
  readonly stagingEligible: number;
  readonly stagingEligibleKeys: readonly string[];
}

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
    // Planning reads the records and every listed object first, so a database
    // that cannot be reached, or a run that would delete more than one run may,
    // stops before storage is touched.
    const plan = await this.plan(cutoff);
    const deletions = plan.orphaned + plan.stagingEligible;
    const listed = plan.scanned + plan.stagingScanned;
    const ceilingExceeded =
      deletions > DELETION_CEILING ||
      (listed >= SHARE_FLOOR && deletions * 2 > listed);

    let deleted = 0;
    let failed = 0;
    let stagingDeleted = 0;
    let stagingFailed = 0;

    if (!input.dryRun && !ceilingExceeded) {
      for (const objectKey of plan.orphans) {
        try {
          await this.storage.deleteObject(objectKey);
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
      for (const objectKey of plan.stagingEligibleKeys) {
        try {
          await this.storage.deleteStagingObject(objectKey);
          stagingDeleted += 1;
        } catch {
          stagingFailed += 1;
        }
      }
    }

    return {
      scanned: plan.scanned,
      unrecognised: plan.unrecognised,
      orphaned: plan.orphaned,
      deleted,
      failed,
      dryRun: input.dryRun,
      ceilingExceeded,
      stagingScanned: plan.stagingScanned,
      stagingUnrecognised: plan.stagingUnrecognised,
      stagingEligible: plan.stagingEligible,
      stagingDeleted,
      stagingFailed,
    };
  }

  /** Counts every candidate, but keeps keys only while the ceiling still holds. */
  private async plan(cutoff: number): Promise<SweepPlan> {
    let scanned = 0;
    let unrecognised = 0;
    let orphaned = 0;
    const orphans: string[] = [];
    let batch: string[] = [];

    const flush = async (): Promise<void> => {
      if (batch.length === 0) {
        return;
      }
      const recorded = await this.avatars.recordedObjectKeys(batch);
      for (const objectKey of batch) {
        if (recorded.has(objectKey)) continue;
        orphaned += 1;
        if (orphans.length < DELETION_CEILING) orphans.push(objectKey);
      }
      batch = [];
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

    let stagingScanned = 0;
    let stagingUnrecognised = 0;
    let stagingEligible = 0;
    const stagingEligibleKeys: string[] = [];

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
      ) {
        continue;
      }
      stagingEligible += 1;
      if (stagingEligibleKeys.length < DELETION_CEILING) {
        stagingEligibleKeys.push(object.objectKey);
      }
    }

    return {
      scanned,
      unrecognised,
      orphaned,
      orphans,
      stagingScanned,
      stagingUnrecognised,
      stagingEligible,
      stagingEligibleKeys,
    };
  }
}
