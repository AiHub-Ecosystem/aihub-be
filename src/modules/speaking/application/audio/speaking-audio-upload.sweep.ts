import {
  SPEAKING_AUDIO_ORPHAN_GRACE_MS,
  type SpeakingAudioUploadIntent,
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';

import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';

const BATCH_SIZE = 500;

/**
 * The most one run may delete. A real day leaves a handful of abandoned
 * uploads behind, so a bigger figure means the record set or the bucket is not
 * the one this deployment expects, and deleting would be the damage (#428).
 */
const DELETION_CEILING = 2_000;

export interface SpeakingAudioUploadSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
  /** The run would have deleted more than one run may; it deleted nothing. */
  readonly ceilingExceeded: boolean;
}

/** Removes rejected and long-expired upload intents by their recorded key. */
export class SpeakingAudioUploadSweep {
  constructor(
    private readonly repository: Pick<
      SpeakingAudioUploadRepositoryPort,
      'listCleanupCandidates' | 'removeCleanupCandidate'
    >,
    private readonly storage: Pick<
      SpeakingAudioAssetStoragePort,
      'deleteObject'
    >,
  ) {}

  private async deleteCandidate(
    intent: SpeakingAudioUploadIntent,
    expiredBefore: Date,
  ): Promise<boolean> {
    try {
      const outcomes = await Promise.allSettled([
        this.storage.deleteObject({
          environment: intent.environment,
          objectKey: intent.objectKey,
        }),
        this.storage.deleteObject({
          environment: intent.environment,
          objectKey: speakingAudioStagingObjectKey(
            intent.organizationId,
            intent.assetId,
          ),
        }),
      ]);
      if (outcomes.some((outcome) => outcome.status === 'rejected'))
        return false;
      return await this.repository.removeCleanupCandidate({
        intent,
        expiredBefore,
      });
    } catch {
      return false;
    }
  }

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<SpeakingAudioUploadSweepSummary> {
    const expiredBefore = new Date(
      input.now.getTime() - SPEAKING_AUDIO_ORPHAN_GRACE_MS,
    );
    let scanned = 0;
    let eligible = 0;
    let deleted = 0;
    let failed = 0;
    const candidatesToDelete: SpeakingAudioUploadIntent[] = [];

    let after:
      | { readonly createdAt: Date; readonly assetId: string }
      | undefined;
    while (true) {
      const candidates = await this.repository.listCleanupCandidates({
        expiredBefore,
        limit: BATCH_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      scanned += candidates.length;
      eligible += candidates.length;
      for (const candidate of candidates) {
        if (candidatesToDelete.length < DELETION_CEILING) {
          candidatesToDelete.push(candidate);
        }
      }
      if (candidates.length === 0) {
        break;
      }

      const last = candidates.at(-1);
      if (last !== undefined) {
        after = { createdAt: last.createdAt, assetId: last.assetId };
      }
      if (candidates.length < BATCH_SIZE) {
        break;
      }
    }

    // Decided from everything the run listed, before the first delete, so a
    // misconfigured deployment cannot delete part of what it should not touch.
    const ceilingExceeded = eligible > DELETION_CEILING;
    if (!input.dryRun && !ceilingExceeded) {
      for (const intent of candidatesToDelete) {
        if (await this.deleteCandidate(intent, expiredBefore)) {
          deleted += 1;
        } else {
          failed += 1;
        }
      }
    }

    return {
      scanned,
      eligible,
      deleted,
      failed,
      dryRun: input.dryRun,
      ceilingExceeded,
    };
  }
}
