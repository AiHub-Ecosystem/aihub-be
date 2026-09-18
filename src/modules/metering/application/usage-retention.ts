export const USAGE_PRUNE_BATCH_SIZE = 1000;
const USAGE_RETENTION_MONTHS = 13;

export interface UsageRetentionCursor {
  readonly createdAt: Date;
  readonly requestId: string;
}

export interface UsageRetentionBatchRequest {
  readonly cutoff: Date;
  readonly batchSize: number;
  readonly after?: UsageRetentionCursor;
}

export interface UsageRetentionBatch {
  readonly deleted: number;
  readonly nextCursor?: UsageRetentionCursor;
}

export interface UsageRetentionPort {
  pruneBatch(request: UsageRetentionBatchRequest): Promise<UsageRetentionBatch>;
  close?(): Promise<void>;
}

export type UsagePruneErrorCode =
  | 'CONFIGURATION_MISSING'
  | 'DATABASE_FAILURE'
  | 'CLOCK_INVALID';

export class UsagePruneError extends Error {
  constructor(
    readonly code: UsagePruneErrorCode,
    message: string,
  ) {
    super(message);
    this.name = UsagePruneError.name;
  }
}

export type UsageRetentionEvent =
  | {
      readonly type: 'started';
      readonly startedAt: Date;
      readonly cutoff: Date;
      readonly batchSize: number;
    }
  | {
      readonly type: 'completed';
      readonly startedAt: Date;
      readonly completedAt: Date;
      readonly cutoff: Date;
      readonly batchSize: number;
      readonly batches: number;
      readonly deleted: number;
      readonly status: 'completed';
    }
  | {
      readonly type: 'failed';
      readonly startedAt: Date;
      readonly failedAt: Date;
      readonly cutoff: Date | null;
      readonly batchSize: number;
      readonly batches: number;
      readonly deleted: number;
      readonly status: 'failed';
      readonly errorCode: UsagePruneErrorCode;
    };

export interface UsageRetentionSummary {
  readonly cutoff: Date;
  readonly batches: number;
  readonly deleted: number;
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function compareCursor(
  left: UsageRetentionCursor,
  right: UsageRetentionCursor,
): number {
  const timeDifference = left.createdAt.getTime() - right.createdAt.getTime();
  if (timeDifference !== 0) {
    return timeDifference;
  }
  if (left.requestId < right.requestId) {
    return -1;
  }
  if (left.requestId > right.requestId) {
    return 1;
  }
  return 0;
}

function validCursor(value: unknown): value is UsageRetentionCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'createdAt' in value &&
    value.createdAt instanceof Date &&
    validDate(value.createdAt) &&
    'requestId' in value &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0
  );
}

export function calculateUsageRetentionCutoff(now: Date): Date {
  if (!validDate(now)) {
    throw new UsagePruneError(
      'CLOCK_INVALID',
      'usage retention clock is invalid',
    );
  }

  const originalDay = now.getUTCDate();
  const cutoff = new Date(now.getTime());
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - USAGE_RETENTION_MONTHS);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return cutoff;
}

function invalidBatch(): never {
  throw new UsagePruneError(
    'DATABASE_FAILURE',
    'usage retention batch response is invalid',
  );
}

export class UsageRetentionService {
  constructor(
    private readonly port: UsageRetentionPort,
    private readonly now: () => Date = () => new Date(),
    private readonly batchSize = USAGE_PRUNE_BATCH_SIZE,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('usage retention batch size is invalid');
    }
  }

  async prune(
    emit: (event: UsageRetentionEvent) => void = () => undefined,
  ): Promise<UsageRetentionSummary> {
    const startedAt = this.now();
    let cutoff: Date | null = null;
    let batches = 0;
    let deleted = 0;

    try {
      cutoff = calculateUsageRetentionCutoff(startedAt);
      emit({
        type: 'started',
        startedAt,
        cutoff,
        batchSize: this.batchSize,
      });

      let after: UsageRetentionCursor | undefined;
      while (true) {
        let batch: UsageRetentionBatch;
        try {
          batch = await this.port.pruneBatch({
            cutoff,
            batchSize: this.batchSize,
            ...(after === undefined ? {} : { after }),
          });
        } catch {
          throw new UsagePruneError(
            'DATABASE_FAILURE',
            'usage retention database operation failed',
          );
        }

        if (
          typeof batch !== 'object' ||
          batch === null ||
          !Number.isSafeInteger(batch.deleted) ||
          batch.deleted < 0 ||
          batch.deleted > this.batchSize
        ) {
          invalidBatch();
        }
        if (batch.deleted === 0) {
          break;
        }
        if (!validCursor(batch.nextCursor)) {
          invalidBatch();
        }
        if (
          after !== undefined &&
          compareCursor(batch.nextCursor, after) <= 0
        ) {
          invalidBatch();
        }

        batches += 1;
        deleted += batch.deleted;
        after = batch.nextCursor;
      }

      const summary = { cutoff, batches, deleted } as const;
      emit({
        type: 'completed',
        startedAt,
        completedAt: this.now(),
        cutoff,
        batchSize: this.batchSize,
        batches,
        deleted,
        status: 'completed',
      });
      return summary;
    } catch (error) {
      const safeError =
        error instanceof UsagePruneError
          ? error
          : new UsagePruneError('DATABASE_FAILURE', 'usage retention failed');
      emit({
        type: 'failed',
        startedAt,
        failedAt: this.now(),
        cutoff,
        batchSize: this.batchSize,
        batches,
        deleted,
        status: 'failed',
        errorCode: safeError.code,
      });
      throw safeError;
    }
  }
}
