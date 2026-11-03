import { WRITING_CHART_ORPHAN_GRACE_MS } from './writing-chart-upload.policy';
import type {
  WritingChartCleanupCandidate,
  WritingChartUploadRepositoryPort,
  WritingChartUploadStoragePort,
} from './writing-chart-upload.port';

const BATCH_SIZE = 500;

export interface WritingChartUploadSweepSummary {
  readonly scanned: number;
  readonly eligible: number;
  readonly deleted: number;
  readonly failed: number;
  readonly dryRun: boolean;
}

/** Deletes private or expired public chart objects and their durable records. */
export class WritingChartUploadSweep {
  constructor(
    private readonly repository: Pick<
      WritingChartUploadRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate'
    >,
    private readonly storage: Pick<
      WritingChartUploadStoragePort,
      'deleteStagingObject' | 'deletePublishedObject'
    >,
  ) {}

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<WritingChartUploadSweepSummary> {
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
        orphanBefore: new Date(
          input.now.getTime() - WRITING_CHART_ORPHAN_GRACE_MS,
        ),
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
    candidate: WritingChartCleanupCandidate,
  ): Promise<boolean> {
    try {
      // Interrupted publication can leave either object behind any row (#921).
      const outcomes = await Promise.allSettled([
        this.storage.deleteStagingObject({
          environment: candidate.environment,
          stagingKey: candidate.stagingKey,
        }),
        this.storage.deletePublishedObject({
          environment: candidate.environment,
          publishedKey: candidate.publishedKey,
        }),
      ]);
      if (outcomes.some((outcome) => outcome.status === 'rejected'))
        return false;
      return await this.repository.removeCleanupCandidate(candidate);
    } catch {
      return false;
    }
  }
}
