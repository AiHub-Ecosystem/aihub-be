import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/postgres-usage-retention.repository';
import {
  USAGE_PRUNE_BATCH_SIZE,
  UsagePruneError,
  type UsagePruneErrorCode,
  type UsageRetentionEvent,
  type UsageRetentionPort,
  UsageRetentionService,
  type UsageRetentionSummary,
  calculateUsageRetentionCutoff,
} from '@/modules/metering/public/usage-retention';
import type { WritingChartRevocationAuditRepositoryPort } from '@/modules/writing/application/writing-chart-revocation.port';
import {
  WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE,
  WritingChartRevocationAuditRetentionService,
  calculateWritingChartRevocationAuditCutoff,
} from '@/modules/writing/public/chart-revocation';
import { createOperatorMeteringClient } from './operator-metering-client';

export interface UsagePruneCliInput {
  readonly databaseUrl: string;
  readonly dryRun?: boolean;
  readonly cutoffSource?: 'process' | 'database';
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

export function formatUsageRetentionEvent(
  event: UsageRetentionEvent,
  cutoffSource?: 'process' | 'database',
): string {
  if (event.type === 'started') {
    return JSON.stringify({
      event: 'usage_prune_started',
      started_at: timestamp(event.startedAt),
      cutoff: timestamp(event.cutoff),
      ...(cutoffSource === undefined ? {} : { cutoff_source: cutoffSource }),
      batch_size: event.batchSize,
    });
  }

  if (event.type === 'completed') {
    return JSON.stringify({
      event: 'usage_prune_completed',
      completed_at: timestamp(event.completedAt),
      cutoff: timestamp(event.cutoff),
      ...(cutoffSource === undefined ? {} : { cutoff_source: cutoffSource }),
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
    ...(cutoffSource === undefined ? {} : { cutoff_source: cutoffSource }),
    batch_size: event.batchSize,
    batches: event.batches,
    deleted: event.deleted,
    dispatch_attempts_deleted: event.dispatchAttemptsDeleted,
    status: event.status,
    error_code: event.errorCode,
  });
}

function safePreviewCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

async function previewUsagePrune(
  input: UsagePruneCliInput,
  repository: UsageRetentionPort,
  cutoff: Date,
  emit: (line: string) => void,
): Promise<UsageRetentionSummary> {
  let usageCounts:
    | { readonly usageRecords: number; readonly dispatchAttempts: number }
    | undefined;
  let previewFailed = false;
  try {
    if (repository.previewPrune === undefined) {
      throw new Error('usage retention preview is unavailable');
    }
    usageCounts = await repository.previewPrune(cutoff);
    if (
      !safePreviewCount(usageCounts.usageRecords) ||
      !safePreviewCount(usageCounts.dispatchAttempts)
    ) {
      throw new Error('usage retention preview is invalid');
    }
  } catch {
    previewFailed = true;
  }
  try {
    await repository.close?.();
  } catch {
    previewFailed = true;
  }
  if (previewFailed || usageCounts === undefined) {
    throw new UsagePruneError(
      'DATABASE_FAILURE',
      'usage retention preview failed',
    );
  }

  emit(
    JSON.stringify({
      event: 'usage_prune_preview',
      cutoff: timestamp(cutoff),
      cutoff_source: input.cutoffSource ?? 'process',
      would_delete: {
        usage_records: usageCounts.usageRecords,
        dispatch_attempts: usageCounts.dispatchAttempts,
      },
      status: 'preview',
    }),
  );

  const shouldPreviewWritingChartAudits =
    input.writingChartAuditRepository !== undefined ||
    input.repository === undefined;
  if (shouldPreviewWritingChartAudits) {
    let auditRepository = input.writingChartAuditRepository;
    try {
      auditRepository ??= await (
        await import('./operator-writing-chart-client')
      ).createOperatorWritingChartRevocationAuditClient(input.databaseUrl);
    } catch {
      throw new UsagePruneError(
        'DATABASE_FAILURE',
        'Writing chart revocation audit preview setup failed',
      );
    }

    const auditCutoff = calculateWritingChartRevocationAuditCutoff(
      input.clock?.() ?? input.now ?? new Date(),
    );
    let auditCount: number | undefined;
    let auditFailed = false;
    try {
      auditCount = await auditRepository.countExpired(auditCutoff);
      if (!safePreviewCount(auditCount)) {
        throw new Error('writing chart audit preview is invalid');
      }
    } catch {
      auditFailed = true;
    }
    try {
      await auditRepository.close?.();
    } catch {
      auditFailed = true;
    }
    if (auditFailed || auditCount === undefined) {
      throw new UsagePruneError(
        'DATABASE_FAILURE',
        'Writing chart revocation audit preview failed',
      );
    }
    emit(
      JSON.stringify({
        event: 'writing_chart_revocation_audit_prune_preview',
        cutoff: timestamp(auditCutoff),
        cutoff_source: input.cutoffSource ?? 'process',
        would_delete: auditCount,
        status: 'preview',
      }),
    );
  }

  return {
    cutoff,
    batches: 0,
    deleted: 0,
    dispatchAttemptsDeleted: 0,
  };
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

  if (input.dryRun === true) {
    let cutoff: Date;
    try {
      cutoff = calculateUsageRetentionCutoff(clock());
    } catch {
      const error = new UsagePruneError(
        'CLOCK_INVALID',
        'usage retention clock is invalid',
      );
      emitFailure(emit, clock(), error.code);
      await repository.close?.().catch(() => undefined);
      throw error;
    }
    try {
      return await previewUsagePrune(input, repository, cutoff, emit);
    } catch (error) {
      emitFailure(
        emit,
        clock(),
        error instanceof UsagePruneError ? error.code : 'DATABASE_FAILURE',
        cutoff,
      );
      throw error;
    }
  }

  const service = new UsageRetentionService(repository, clock);
  let summary: UsageRetentionSummary | undefined;
  let completionLine: string | undefined;
  let operationFailed = false;
  let operationError: unknown;

  try {
    summary = await service.prune((event) => {
      if (event.type === 'completed') {
        completionLine = formatUsageRetentionEvent(event, input.cutoffSource);
        return;
      }
      emit(formatUsageRetentionEvent(event, input.cutoffSource));
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
        cutoff_source: input.cutoffSource ?? 'process',
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
