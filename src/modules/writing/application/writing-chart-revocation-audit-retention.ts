import type { WritingChartRevocationAuditRepositoryPort } from './writing-chart-revocation.port';

export const WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE = 1_000;

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

export function calculateWritingChartRevocationAuditCutoff(now: Date): Date {
  if (!validDate(now)) {
    throw new Error('Writing chart revocation audit clock is invalid');
  }
  const originalDay = now.getUTCDate();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 24);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return cutoff;
}

export class WritingChartRevocationAuditRetentionService {
  constructor(
    private readonly repository: Pick<
      WritingChartRevocationAuditRepositoryPort,
      'pruneExpired'
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly batchSize = WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Writing chart revocation audit batch size is invalid');
    }
  }

  async prune(): Promise<{
    readonly cutoff: Date;
    readonly batches: number;
    readonly deleted: number;
  }> {
    const cutoff = calculateWritingChartRevocationAuditCutoff(this.now());
    let batches = 0;
    let deleted = 0;
    while (true) {
      const count = await this.repository.pruneExpired(cutoff, this.batchSize);
      if (!Number.isSafeInteger(count) || count < 0 || count > this.batchSize) {
        throw new Error('Writing chart revocation audit batch is invalid');
      }
      if (count === 0) break;
      batches += 1;
      deleted += count;
    }
    return { cutoff, batches, deleted };
  }
}
