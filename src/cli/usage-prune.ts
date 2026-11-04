import { internalError } from '@/common/errors/app-error';
import { PostgresUsageRetentionRepository } from '@/modules/metering/infrastructure/billing/postgres-usage-retention.repository';
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
import {
  WRITING_CHART_REVOCATION_AUDIT_BATCH_SIZE,
  type WritingChartRevocationAuditRepositoryPort,
  WritingChartRevocationAuditRetentionService,
  calculateWritingChartRevocationAuditCutoff,
} from '@/modules/writing/public/chart-uploads';
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

export interface ParsedUsagePruneArguments {
  readonly databaseUrl: string;
  readonly dryRun: boolean;
  readonly cutoffSource?: 'process' | 'database';
}

export function parseUsagePruneArguments(
  input: Pick<UsagePruneCliInput, 'databaseUrl' | 'dryRun' | 'cutoffSource'>,
): ParsedUsagePruneArguments {
  if (input.databaseUrl.trim().length === 0) {
    throw new UsagePruneError(
      'CONFIGURATION_MISSING',
      'DATABASE_URL is required',
    );
  }
  return {
    databaseUrl: input.databaseUrl,
    dryRun: input.dryRun === true,
    ...(input.cutoffSource === undefined
      ? {}
      : { cutoffSource: input.cutoffSource }),
  };
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

function shouldPruneWritingChartAudits(input: UsagePruneCliInput): boolean {
  return (
    input.writingChartAuditRepository !== undefined ||
    input.repository === undefined
  );
}

async function previewUsageRetentionCounts(
  repository: UsageRetentionPort,
  cutoff: Date,
): Promise<{
  readonly usageRecords: number;
  readonly dispatchAttempts: number;
}> {
  let counts:
    | { readonly usageRecords: number; readonly dispatchAttempts: number }
    | undefined;
  let failed = false;
  try {
    if (repository.previewPrune === undefined) {
      throw internalError('usage retention preview is unavailable');
    }
    counts = await repository.previewPrune(cutoff);
    if (
      !safePreviewCount(counts.usageRecords) ||
      !safePreviewCount(counts.dispatchAttempts)
    ) {
      throw internalError('usage retention preview is invalid');
    }
  } catch {
    failed = true;
  }
  try {
    await repository.close?.();
  } catch {
    failed = true;
  }
  if (failed || counts === undefined) {
    throw new UsagePruneError(
      'DATABASE_FAILURE',
      'usage retention preview failed',
    );
  }
  return counts;
}

async function createWritingChartAuditRepository(
  input: UsagePruneCliInput,
): Promise<WritingChartRevocationAuditRepositoryPort> {
  try {
    const repository =
      input.writingChartAuditRepository ??
      (
        await import('./operator-writing-chart-client')
      ).createOperatorWritingChartRevocationAuditClient(input.databaseUrl);
    return await repository;
  } catch {
    throw new UsagePruneError(
      'DATABASE_FAILURE',
      'Writing chart revocation audit preview setup failed',
    );
  }
}

async function previewWritingChartAudits(
  input: UsagePruneCliInput,
  emit: (line: string) => void,
): Promise<void> {
  const auditRepository = await createWritingChartAuditRepository(input);
  const auditCutoff = calculateWritingChartRevocationAuditCutoff(
    input.clock?.() ?? input.now ?? new Date(),
  );
  let auditCount: number | undefined;
  let failed = false;
  try {
    auditCount = await auditRepository.countExpired(auditCutoff);
    if (!safePreviewCount(auditCount)) {
      throw internalError('writing chart audit preview is invalid');
    }
  } catch {
    failed = true;
  }
  try {
    await auditRepository.close?.();
  } catch {
    failed = true;
  }
  if (failed || auditCount === undefined) {
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

async function previewUsagePrune(
  input: UsagePruneCliInput,
  repository: UsageRetentionPort,
  cutoff: Date,
  emit: (line: string) => void,
): Promise<UsageRetentionSummary> {
  const usageCounts = await previewUsageRetentionCounts(repository, cutoff);

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

  if (shouldPruneWritingChartAudits(input)) {
    await previewWritingChartAudits(input, emit);
  }

  return {
    cutoff,
    batches: 0,
    deleted: 0,
    dispatchAttemptsDeleted: 0,
  };
}

async function openUsageRetentionRepository(
  input: UsagePruneCliInput,
  databaseUrl: string,
  clock: () => Date,
  emit: (line: string) => void,
): Promise<UsageRetentionPort> {
  try {
    return (
      input.repository ??
      new PostgresUsageRetentionRepository(
        await createOperatorMeteringClient(databaseUrl),
      )
    );
  } catch {
    const error = new UsagePruneError(
      'DATABASE_FAILURE',
      'usage retention database setup failed',
    );
    emitFailure(emit, clock(), error.code);
    throw error;
  }
}

async function runUsagePrunePreview(
  input: UsagePruneCliInput,
  repository: UsageRetentionPort,
  clock: () => Date,
  emit: (line: string) => void,
): Promise<UsageRetentionSummary> {
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

async function runUsageRetention(
  input: UsagePruneCliInput,
  repository: UsageRetentionPort,
  clock: () => Date,
  emit: (line: string) => void,
): Promise<{
  readonly summary: UsageRetentionSummary;
  readonly completionLine: string;
}> {
  const service = new UsageRetentionService(repository, clock);
  let summary: UsageRetentionSummary | undefined;
  let completionLine: string | undefined;
  let operationError: unknown;
  let operationFailed = false;
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
  return { summary, completionLine };
}

async function pruneWritingChartAudits(
  input: UsagePruneCliInput,
  databaseUrl: string,
  clock: () => Date,
  emit: (line: string) => void,
): Promise<void> {
  const startedAt = clock();
  let auditRepository = input.writingChartAuditRepository;
  let auditSummary:
    | Awaited<ReturnType<WritingChartRevocationAuditRetentionService['prune']>>
    | undefined;
  let failed = false;
  try {
    auditRepository ??= await (
      await import('./operator-writing-chart-client')
    ).createOperatorWritingChartRevocationAuditClient(databaseUrl);
    auditSummary = await new WritingChartRevocationAuditRetentionService(
      auditRepository,
      clock,
    ).prune();
  } catch {
    failed = true;
  } finally {
    try {
      await auditRepository?.close?.();
    } catch {
      failed = true;
    }
  }

  if (failed || auditSummary === undefined) {
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

export async function runUsagePruneCommand(
  input: UsagePruneCliInput,
): Promise<UsageRetentionSummary> {
  const emit = input.emit ?? console.log;
  const clock = input.clock ?? (() => input.now ?? new Date());
  let args: ParsedUsagePruneArguments;
  try {
    args = parseUsagePruneArguments(input);
  } catch (error) {
    if (error instanceof UsagePruneError) {
      emitFailure(emit, clock(), error.code);
    }
    throw error;
  }
  const { databaseUrl, dryRun } = args;
  const repository = await openUsageRetentionRepository(
    input,
    databaseUrl,
    clock,
    emit,
  );

  if (dryRun) {
    return runUsagePrunePreview(input, repository, clock, emit);
  }

  const { summary, completionLine } = await runUsageRetention(
    input,
    repository,
    clock,
    emit,
  );
  if (shouldPruneWritingChartAudits(input)) {
    await pruneWritingChartAudits(input, databaseUrl, clock, emit);
  }

  emit(completionLine);
  return summary;
}
