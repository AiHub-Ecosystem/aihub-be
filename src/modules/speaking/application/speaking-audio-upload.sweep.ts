import { SPEAKING_AUDIO_ORPHAN_GRACE_MS } from '@/modules/speaking/domain/speaking-audio-asset';

import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadRepositoryPort,
} from './speaking-audio-upload.port';

const BATCH_SIZE = 500;

export interface SpeakingAudioUploadSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
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
      if (candidates.length === 0) {
        break;
      }

      if (!input.dryRun) {
        for (const intent of candidates) {
          try {
            await this.storage.deleteObject({
              environment: intent.environment,
              objectKey: intent.objectKey,
            });
            if (
              await this.repository.removeCleanupCandidate({
                intent,
                expiredBefore,
              })
            ) {
              deleted += 1;
            } else {
              failed += 1;
            }
          } catch {
            failed += 1;
          }
        }
      }

      const last = candidates.at(-1);
      if (last !== undefined) {
        after = { createdAt: last.createdAt, assetId: last.assetId };
      }
      if (candidates.length < BATCH_SIZE) {
        break;
      }
    }

    return { scanned, eligible, deleted, failed, dryRun: input.dryRun };
  }
}
