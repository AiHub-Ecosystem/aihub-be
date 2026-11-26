import type { UploadSessionPolicy } from '@/modules/uploads/application/upload-session.policy';
import type {
  UploadSessionRepositoryPort,
  UploadSessionStoragePort,
} from '@/modules/uploads/application/upload-session.port';
import type { UploadSessionCleanupCandidate } from '@/modules/uploads/domain/upload-session';

const BATCH_SIZE = 500;

export interface UploadSessionSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
}

/** Deletes private or retention-expired objects and their durable records. */
export class UploadSessionSweep {
  constructor(
    private readonly repository: Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate'
    >,
    private readonly storage: Pick<
      UploadSessionStoragePort,
      'deleteStagingObject' | 'deletePublishedObject'
    >,
    private readonly policy: Pick<UploadSessionPolicy, 'orphanGraceMs'>,
  ) {}

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<UploadSessionSweepSummary> {
    let scanned = 0;
    let eligible = 0;
    let deleted = 0;
    let failed = 0;
    let after:
      | { readonly createdAt: Date; readonly assetId: string }
      | undefined;

    while (true) {
      const candidates = await this.repository.cleanupCandidates({
        now: input.now,
        orphanBefore: new Date(input.now.getTime() - this.policy.orphanGraceMs),
        limit: BATCH_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      scanned += candidates.length;
      eligible += candidates.length;
      if (candidates.length === 0) break;

      if (!input.dryRun) {
        for (const candidate of candidates) {
          if (await this.deleteCandidate(candidate)) deleted += 1;
          else failed += 1;
        }
      }

      const last = candidates.at(-1);
      if (last !== undefined)
        after = { createdAt: last.createdAt, assetId: last.assetId };
      if (candidates.length < BATCH_SIZE) break;
    }
    return { scanned, eligible, deleted, failed, dryRun: input.dryRun };
  }

  private async deleteCandidate(
    candidate: UploadSessionCleanupCandidate,
  ): Promise<boolean> {
    // shortcut: candidates are not claimed, so two sweep workers may attempt
    // the same row; upgrade to a leased page when #1873 lands.
    let failed = false;
    try {
      await this.storage.deleteStagingObject({
        environment: candidate.environment,
        stagingKey: candidate.stagingKey,
      });
    } catch {
      failed = true;
    }
    try {
      await this.storage.deletePublishedObject({
        environment: candidate.environment,
        publishedKey: candidate.publishedKey,
      });
    } catch {
      failed = true;
    }
    if (failed) return false;
    try {
      return await this.repository.removeCleanupCandidate(candidate);
    } catch {
      return false;
    }
  }
}
