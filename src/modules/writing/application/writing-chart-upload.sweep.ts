import type {
  WritingChartUploadRepositoryPort,
  WritingChartUploadStoragePort,
} from './writing-chart-upload.port';

const BATCH_SIZE = 500;

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

  async run(input: { readonly dryRun: boolean; readonly now: Date }) {
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
        limit: BATCH_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      scanned += candidates.length;
      eligible += candidates.length;
      if (candidates.length === 0) break;

      if (!input.dryRun) {
        for (const candidate of candidates) {
          try {
            const deletions = [
              this.storage.deleteStagingObject({
                environment: candidate.environment,
                stagingKey: candidate.stagingKey,
              }),
            ];
            if (candidate.kind === 'asset') {
              deletions.push(
                this.storage.deletePublishedObject({
                  environment: candidate.environment,
                  publishedKey: candidate.publishedKey,
                }),
              );
            }
            const outcomes = await Promise.allSettled(deletions);
            if (outcomes.some((outcome) => outcome.status === 'rejected')) {
              failed += 1;
              continue;
            }
            if (await this.repository.removeCleanupCandidate(candidate))
              deleted += 1;
            else failed += 1;
          } catch {
            failed += 1;
          }
        }
      }

      const last = candidates.at(-1);
      if (last !== undefined)
        after = { createdAt: last.createdAt, assetId: last.assetId };
      if (candidates.length < BATCH_SIZE) break;
    }
    return { scanned, eligible, deleted, failed, dryRun: input.dryRun };
  }
}
