import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/postgres-usage-retention.repository';
import {
  USAGE_PRUNE_BATCH_SIZE,
  UsagePruneError,
  type UsagePruneErrorCode,
  type UsageRetentionEvent,
  type UsageRetentionPort,
  UsageRetentionService,
  type UsageRetentionSummary,
} from '@/modules/metering/public/usage-retention';
import type { WritingChartRevocationAuditRepositoryPort } from '@/modules/writing/application/writing-chart-revocation.port';
import {
  WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE,
  WritingChartRevocationAuditRetentionService,
} from '@/modules/writing/public/chart-revocation';
import { createOperatorMeteringClient } from './operator-metering-client';

export interface UsagePruneCliInput {
  readonly databaseUrl: string;
  readonly now?: Date;
  readonly clock?: () => Date;
  readonly repository?: UsageRetentionPort;
  readonly writingChartAuditRepository?: WritingChartRevocationAuditRepositoryPort;
  readonly emit?: (line: string) => void;
}

function timestamp(value: Date): string {
  return value.toISOString();
}

function emitFailure(
  emit: (line: string) => void,
  at: Date,
  errorCode: UsagePruneErrorCode,
  cutoff: Date | null = null,
  batches = 0,
  deleted = 0,
  dispatchAttemptsDeleted = 0,
): void {
  emit(
    formatUsageRetentionEvent({
      type: 'failed',
      startedAt: at,
      failedAt: at,
      cutoff,
      batchSize: USAGE_PRUNE_BATCH_SIZE,
      batches,
      deleted,
      dispatchAttemptsDeleted,
      status: 'failed',
      errorCode,
    }),
  );
}

export function formatUsageRetentionEvent(event: UsageRetentionEvent): string {
  if (event.type === 'started') {
    return JSON.stringify({
      event: 'usage_prune_started',
      started_at: timestamp(event.startedAt),
      cutoff: timestamp(event.cutoff),
      batch_size: event.batchSize,
    });
  }

  if (event.type === 'completed') {
    return JSON.stringify({
      event: 'usage_prune_completed',
      completed_at: timestamp(event.completedAt),
      cutoff: timestamp(event.cutoff),
      batch_size: event.batchSize,
      batches: event.batches,
      deleted: event.deleted,
      dispatch_attempts_deleted: event.dispatchAttemptsDeleted,
      status: event.status,
    });
  }

  return JSON.stringify({
    event: 'usage_prune_failed',
    failed_at: timestamp(event.failedAt),
    cutoff: event.cutoff === null ? null : timestamp(event.cutoff),
    batch_size: event.batchSize,
    batches: event.batches,
    deleted: event.deleted,
    dispatch_attempts_deleted: event.dispatchAttemptsDeleted,
    status: event.status,
    error_code: event.errorCode,
  });
}

export async function runUsagePruneCommand(
  input: UsagePruneCliInput,
): Promise<UsageRetentionSummary> {
  const emit = input.emit ?? console.log;
  const clock = input.clock ?? (() => input.now ?? new Date());
  if (input.databaseUrl.trim().length === 0) {
    const error = new UsagePruneError(
      'CONFIGURATION_MISSING',
      'DATABASE_URL is required',
    );
    emitFailure(emit, clock(), error.code);
    throw error;
  }

  let repository: UsageRetentionPort;
  try {
    repository =
      input.repository ??
      new PostgresUsageRetentionRepository(
        await createOperatorMeteringClient(input.databaseUrl),
      );
  } catch {
    const error = new UsagePruneError(
      'DATABASE_FAILURE',
      'usage retention database setup failed',
    );
    emitFailure(emit, clock(), error.code);
    throw error;
  }

  const service = new UsageRetentionService(repository, clock);
  let summary: UsageRetentionSummary | undefined;
  let completionLine: string | undefined;
  let operationFailed = false;
  let operationError: unknown;

  try {
    summary = await service.prune((event) => {
      if (event.type === 'completed') {
        completionLine = formatUsageRetentionEvent(event);
        return;
      }
      emit(formatUsageRetentionEvent(event));
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await repository.close?.();
  } catch {
    if (!operationFailed) {
      const error = new UsagePruneError(
        'DATABASE_FAILURE',
        'usage retention database shutdown failed',
      );
      emitFailure(
        emit,
        clock(),
        error.code,
        summary?.cutoff ?? null,
        summary?.batches ?? 0,
        summary?.deleted ?? 0,
        summary?.dispatchAttemptsDeleted ?? 0,
      );
      operationFailed = true;
      operationError = error;
    }
  }

  if (operationFailed) {
    throw operationError;
  }
  if (summary === undefined || completionLine === undefined) {
    const error = new UsagePruneError(
      'DATABASE_FAILURE',
      'usage retention did not complete',
    );
    emitFailure(emit, clock(), error.code, summary?.cutoff ?? null);
    throw error;
  }

  const shouldPruneWritingChartAudits =
    input.writingChartAuditRepository !== undefined ||
    input.repository === undefined;
  if (shouldPruneWritingChartAudits) {
    const startedAt = clock();
    let auditRepository = input.writingChartAuditRepository;
    let auditSummary:
      | Awaited<
          ReturnType<WritingChartRevocationAuditRetentionService['prune']>
        >
      | undefined;
    let auditFailed = false;
    try {
      auditRepository ??= await (
        await import('./operator-writing-chart-client')
      ).createOperatorWritingChartRevocationAuditClient(input.databaseUrl);
      auditSummary = await new WritingChartRevocationAuditRetentionService(
        auditRepository,
        clock,
      ).prune();
    } catch {
      auditFailed = true;
    } finally {
      try {
        await auditRepository?.close?.();
      } catch {
        auditFailed = true;
      }
    }

    if (auditFailed || auditSummary === undefined) {
      emit(
        JSON.stringify({
          event: 'writing_chart_revocation_audit_prune_failed',
          failed_at: timestamp(clock()),
          status: 'failed',
          error_code: 'DATABASE_FAILURE',
        }),
      );
      throw new UsagePruneError(
        'DATABASE_FAILURE',
        'Writing chart revocation audit retention failed',
      );
    }
    emit(
      JSON.stringify({
        event: 'writing_chart_revocation_audit_prune_completed',
        started_at: timestamp(startedAt),
        completed_at: timestamp(clock()),
        cutoff: timestamp(auditSummary.cutoff),
        batch_size: WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE,
        batches: auditSummary.batches,
        deleted: auditSummary.deleted,
        status: 'completed',
      }),
    );
  }

  emit(completionLine);
  return summary;
}
