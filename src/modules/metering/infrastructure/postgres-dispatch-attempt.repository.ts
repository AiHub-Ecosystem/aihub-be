import { randomUUID } from 'node:crypto';

import type { OnModuleDestroy } from '@nestjs/common';

import type { OperationId } from '@/catalog/operation-id';
import { OPERATION_IDS, isOperationId } from '@/catalog/operation-id';
import type { DispatchAttemptUnresolvedSample } from '@/common/observability/metrics';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptStart,
  RecordDispatchAttemptPort,
} from '@/modules/metering/application/dispatch-attempt-recorder.port';
import {
  type PostgresMeteringClient,
  createPostgresMeteringClient,
  isRecord,
} from './postgres-usage.repository';

export const INSERT_DISPATCH_ATTEMPT_SQL = `
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

export const UPDATE_DISPATCH_ATTEMPT_OUTCOME_SQL = `
  UPDATE dispatch_attempts
  SET outcome = $2
  WHERE attempt_id = $1 AND outcome IS NULL
`;

export const UNRESOLVED_DISPATCH_ATTEMPTS_SQL = `
  SELECT attempt.operation,
         COUNT(*)::bigint AS unresolved_count
  FROM dispatch_attempts AS attempt
  WHERE attempt.unknown_after < clock_timestamp()
    AND (attempt.outcome IS NULL OR attempt.outcome = 'outcome_unknown')
    AND NOT EXISTS (
      SELECT 1
      FROM usage_records AS usage
      WHERE usage.request_id = attempt.request_id
    )
  GROUP BY attempt.operation
`;

function countFromRow(value: unknown): DispatchAttemptUnresolvedSample {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw new Error('dispatch attempt metric row is invalid');
  }
  const count =
    typeof value.unresolved_count === 'number'
      ? value.unresolved_count
      : typeof value.unresolved_count === 'string'
        ? Number(value.unresolved_count)
        : Number.NaN;
  if (
    !isOperationId(value.operation) ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new Error('dispatch attempt metric row is invalid');
  }
  return { operation: value.operation as OperationId, count };
}

export class PostgresDispatchAttemptRepository
  implements RecordDispatchAttemptPort, OnModuleDestroy
{
  constructor(private readonly client: PostgresMeteringClient) {}

  async beginAttempt(input: DispatchAttemptStart): Promise<string> {
    const attemptId = randomUUID();
    await this.client.query(INSERT_DISPATCH_ATTEMPT_SQL, [
      attemptId,
      input.requestId,
      input.organizationId,
      input.operation,
      input.operationTimeoutMs,
    ]);
    return attemptId;
  }

  async recordOutcome(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void> {
    await this.client.query(UPDATE_DISPATCH_ATTEMPT_OUTCOME_SQL, [
      attemptId,
      outcome,
    ]);
  }

  async getUnresolvedByOperation(): Promise<
    readonly DispatchAttemptUnresolvedSample[]
  > {
    const rows = await this.client.query(UNRESOLVED_DISPATCH_ATTEMPTS_SQL, []);
    const counts = new Map(
      rows.map(countFromRow).map(({ operation, count }) => [operation, count]),
    );
    return OPERATION_IDS.map((operation) => ({
      operation,
      count: counts.get(operation) ?? 0,
    }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

export function createPostgresDispatchAttemptRepository(
  databaseUrl: string,
): PostgresDispatchAttemptRepository {
  return new PostgresDispatchAttemptRepository(
    createPostgresMeteringClient(databaseUrl),
  );
}
