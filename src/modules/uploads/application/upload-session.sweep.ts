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
  ceilingExceeded = false;

  constructor(
    repository: Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate' | 'claimCleanupCandidate'
    >,
    private readonly storage: Pick<
      UploadSessionStoragePort,
      'deleteStagingObject' | 'deletePublishedObject'
    >,
    private readonly policy: Pick<UploadSessionPolicy, 'orphanGraceMs'>,
    private readonly deletionCeiling?: number,
    private readonly keysPerCandidate = 1,
    private readonly candidateSource: Pick<
      UploadSessionRepositoryPort,
      'cleanupCandidates' | 'removeCleanupCandidate' | 'claimCleanupCandidate'
    > = repository,
  ) {}

  async run(input: {
    readonly dryRun: boolean;
    readonly now: Date;
  }): Promise<UploadSessionSweepSummary> {
    this.ceilingExceeded = false;
    const all: UploadSessionCleanupCandidate[] = [];
    let after:
      | { readonly createdAt: Date; readonly assetId: string }
      | undefined;

    while (true) {
      const candidates = await this.candidateSource.cleanupCandidates({
        now: input.now,
        orphanBefore: new Date(input.now.getTime() - this.policy.orphanGraceMs),
        limit: BATCH_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      all.push(...candidates);
      if (candidates.length === 0 || candidates.length < BATCH_SIZE) break;
      const last = candidates.at(-1);
      if (last !== undefined)
        after = {
          createdAt: last.createdAt,
          assetId: last.candidateId ?? last.assetId,
        };
    }

    const scanned = all.length;
    const eligible = all.length;
    if (
      this.deletionCeiling !== undefined &&
      all.reduce(
        (total, candidate) =>
          total +
          (candidate.kind === 'reservation' ? 1 : this.keysPerCandidate),
        0,
      ) > this.deletionCeiling
    ) {
      this.ceilingExceeded = true;
      return {
        scanned,
        eligible,
        deleted: 0,
        failed: 0,
        dryRun: input.dryRun,
      };
    }

    let deleted = 0;
    let failed = 0;
    if (!input.dryRun) {
      for (const candidate of all) {
        const result = await this.deleteCandidate(candidate, input.now);
        if (result === 'deleted') deleted += 1;
        else if (result === 'failed') failed += 1;
      }
    }
    return { scanned, eligible, deleted, failed, dryRun: input.dryRun };
  }

  private async deleteCandidate(
    candidate: UploadSessionCleanupCandidate,
    now: Date,
  ): Promise<'deleted' | 'failed' | 'skipped'> {
    let claimed: UploadSessionCleanupCandidate | undefined;
    try {
      claimed =
        this.candidateSource.claimCleanupCandidate === undefined
          ? candidate
          : await this.candidateSource.claimCleanupCandidate(candidate, now);
    } catch {
      return 'failed';
    }
    if (claimed === undefined) return 'skipped';
    let failed = false;
    if (claimed.stagingKey !== undefined) {
      try {
        await this.storage.deleteStagingObject({
          environment: claimed.environment,
          stagingKey: claimed.stagingKey,
        });
      } catch {
        failed = true;
      }
    }
    try {
      await this.storage.deletePublishedObject({
        environment: claimed.environment,
        publishedKey: claimed.publishedKey,
      });
    } catch {
      failed = true;
    }
    if (failed) return 'failed';
    try {
      return (await this.candidateSource.removeCleanupCandidate(claimed))
        ? 'deleted'
        : 'skipped';
    } catch {
      return 'failed';
    }
  }
}
