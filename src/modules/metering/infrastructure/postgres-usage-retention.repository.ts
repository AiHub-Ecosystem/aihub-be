import { isRecord } from '@/common/is-record';
import type {
  UsageRetentionBatch,
  UsageRetentionBatchRequest,
  UsageRetentionCursor,
  UsageRetentionPort,
} from '@/modules/metering/application/usage-retention';
import { compareUsageRetentionCursor } from '@/modules/metering/application/usage-retention';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { PrismaMeteringClient } from './prisma-metering.client';

export const USAGE_RETENTION_BATCH_SQL = [
  '  WITH candidates AS (',
  '    SELECT request_id, created_at',
  '    FROM usage_records',
  '    WHERE created_at < $1',
  '      AND (',
  '        $2::timestamptz IS NULL',
  '        OR (created_at, request_id) > ($2::timestamptz, $3::text)',
  '      )',
  '    ORDER BY created_at, request_id',
  '    LIMIT $4',
  '    FOR UPDATE SKIP LOCKED',
  '  )',
  '  DELETE FROM usage_records AS usage',
  '  USING candidates',
  '  WHERE usage.request_id = candidates.request_id',
  '  RETURNING usage.created_at, usage.request_id',
].join('\n');

export const DISPATCH_ATTEMPT_RETENTION_BATCH_SQL = `
  WITH candidates AS (
    SELECT attempt_id
    FROM dispatch_attempts
    WHERE created_at < $1
    ORDER BY created_at, attempt_id
    LIMIT $2
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM dispatch_attempts AS attempt
  USING candidates
  WHERE attempt.attempt_id = candidates.attempt_id
  RETURNING attempt.attempt_id
`;

function cursorFromRow(value: unknown): UsageRetentionCursor {
  if (!isRecord(value) || typeof value.request_id !== 'string') {
    throw new Error('usage retention row is invalid');
  }
  const createdAt =
    value.created_at instanceof Date
      ? new Date(value.created_at.getTime())
      : typeof value.created_at === 'string'
        ? new Date(value.created_at)
        : null;
  if (
    createdAt === null ||
    Number.isNaN(createdAt.getTime()) ||
    value.request_id.length === 0
  ) {
    throw new Error('usage retention row is invalid');
  }
  return { createdAt, requestId: value.request_id };
}

interface UsageRetentionRow {
  readonly created_at: Date;
  readonly request_id: string;
}

interface DispatchAttemptRetentionRow {
  readonly attempt_id: string;
}

export class PostgresUsageRetentionRepository implements UsageRetentionPort {
  constructor(private readonly client: PrismaMeteringClient) {}

  async pruneBatch(
    request: UsageRetentionBatchRequest,
  ): Promise<UsageRetentionBatch> {
    return this.client.$transaction(async (transaction) => {
      const rows = await transaction.$queryRawUnsafe<
        readonly UsageRetentionRow[]
      >(
        USAGE_RETENTION_BATCH_SQL,
        request.cutoff,
        request.after?.createdAt ?? null,
        request.after?.requestId ?? null,
        request.batchSize,
      );
      const cursors = rows.map(cursorFromRow).sort(compareUsageRetentionCursor);
      const nextCursor = cursors[cursors.length - 1];
      return nextCursor === undefined
        ? { deleted: 0 }
        : { deleted: cursors.length, nextCursor };
    }, CONTROL_PLANE_TRANSACTION_OPTIONS);
  }

  async pruneDispatchAttempts(
    cutoff: Date,
    batchSize: number,
  ): Promise<number> {
    const rows = await this.client.$queryRawUnsafe<
      readonly DispatchAttemptRetentionRow[]
    >(DISPATCH_ATTEMPT_RETENTION_BATCH_SQL, cutoff, batchSize);
    return rows.length;
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
