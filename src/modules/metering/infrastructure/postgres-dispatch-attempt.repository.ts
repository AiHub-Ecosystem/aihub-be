import { randomUUID } from 'node:crypto';

import type { OnModuleDestroy } from '@nestjs/common';

import { OPERATION_IDS, isOperationId } from '@/catalog/operation-id';
import type { DispatchAttemptUnresolvedSample } from '@/common/observability/metrics';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
  DispatchAttemptStart,
} from '@/modules/metering/application/dispatch-attempt-record.port';
import { isRecord, safeNonNegativeCount } from './metering-row';
import type { PrismaMeteringClient } from './prisma-metering.client';

// The deadline is stamped with the database's own clock, so the evidence does
// not depend on this process's clock or on how long the request waited to start.
const INSERT_DISPATCH_ATTEMPT_SQL = `
  INSERT INTO dispatch_attempts (
    attempt_id,
    request_id,
    organization_id,
    operation,
    created_at,
    unknown_after
  )
  SELECT $1, $2, $3, $4, created_at,
         created_at + ($5::bigint * 2 * INTERVAL '1 millisecond')
  FROM (SELECT clock_timestamp() AS created_at) AS dispatch_clock
`;

const UNRESOLVED_DISPATCH_ATTEMPTS_SQL = `
  SELECT CASE
           WHEN attempt.operation = ANY($1::text[]) THEN attempt.operation
           ELSE 'other'
         END AS operation,
         COUNT(*)::bigint AS unresolved_count
  FROM dispatch_attempts AS attempt
  WHERE attempt.unknown_after < clock_timestamp()
    AND (attempt.outcome IS NULL OR attempt.outcome = 'outcome_unknown')
    AND NOT EXISTS (
      SELECT 1
      FROM usage_records AS usage
      WHERE usage.request_id = attempt.request_id
        AND usage.error_code IS DISTINCT FROM 'AI_SERVICE_TIMEOUT'
    )
  GROUP BY 1
`;

function countFromRow(value: unknown): DispatchAttemptUnresolvedSample {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw new Error('dispatch attempt metric row is invalid');
  }
  const count = safeNonNegativeCount(value.unresolved_count);
  if (
    (!isOperationId(value.operation) && value.operation !== 'other') ||
    count === undefined
  ) {
    throw new Error('dispatch attempt metric row is invalid');
  }
  return { operation: value.operation, count };
}

interface DispatchAttemptUnresolvedRow {
  readonly operation: string;
  readonly unresolved_count: bigint;
}

export class PostgresDispatchAttemptRepository
  implements DispatchAttemptRecordPort, OnModuleDestroy
{
  constructor(private readonly client: PrismaMeteringClient) {}

  async beginAttempt(input: DispatchAttemptStart): Promise<string> {
    const attemptId = randomUUID();
    await this.client.$executeRawUnsafe(
      INSERT_DISPATCH_ATTEMPT_SQL,
      attemptId,
      input.requestId,
      input.organizationId,
      input.operation,
      input.operationTimeoutMs,
    );
    return attemptId;
  }

  async recordOutcome(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void> {
    // Once: an outcome already recorded is never overwritten.
    await this.client.dispatchAttempt.updateMany({
      where: { attemptId, outcome: null },
      data: { outcome },
    });
  }

  async getUnresolvedByOperation(): Promise<
    readonly DispatchAttemptUnresolvedSample[]
  > {
    const rows = await this.client.$queryRawUnsafe<
      readonly DispatchAttemptUnresolvedRow[]
    >(UNRESOLVED_DISPATCH_ATTEMPTS_SQL, [...OPERATION_IDS]);
    const counts = new Map(
      rows.map(countFromRow).map(({ operation, count }) => [operation, count]),
    );
    const otherCount = counts.get('other');
    return [
      ...OPERATION_IDS.map((operation) => ({
        operation,
        count: counts.get(operation) ?? 0,
      })),
      ...(otherCount === undefined
        ? []
        : [{ operation: 'other' as const, count: otherCount }]),
    ];
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
