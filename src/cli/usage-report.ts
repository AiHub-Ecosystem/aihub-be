import { parseUtcTimestamp } from '@/common/time/parse-utc-timestamp';
import { createPostgresUsageCompletenessReportRepository } from '@/modules/metering/infrastructure/postgres-usage-completeness-report.repository';
import {
  type UsageCompletenessReport,
  UsageCompletenessReportService,
  UsageReportError,
  type UsageReportErrorCode,
  type UsageReportOperationDefinition,
  type UsageReportRepositoryPort,
  type UsageReportWindow,
} from '@/modules/metering/public/usage-completeness-report';
import {
  UsagePruneError,
  calculateUsageRetentionCutoff,
} from '@/modules/metering/public/usage-retention';

export interface UsageReportCliInput {
  readonly databaseUrl: string;
  readonly from: string;
  readonly to: string;
  readonly now?: Date;
  readonly clock?: () => Date;
  readonly operations?: readonly UsageReportOperationDefinition[];
  readonly repository?: UsageReportRepositoryPort;
  readonly emit?: (line: string) => void;
}

function invalidWindow(): never {
  throw new UsageReportError(
    'USAGE_REPORT_INVALID_WINDOW',
    'usage report window is invalid',
  );
}

export function parseUsageReportTimestamp(raw: string): Date {
  const value = parseUtcTimestamp(raw);
  if (value === undefined) {
    return invalidWindow();
  }
  return value;
}

export function parseUsageReportWindow(
  rawFrom: string,
  rawTo: string,
  now: Date,
): UsageReportWindow {
  if (Number.isNaN(now.getTime())) {
    return invalidWindow();
  }

  const from = parseUsageReportTimestamp(rawFrom);
  const to = parseUsageReportTimestamp(rawTo);
  let cutoff: Date;
  try {
    cutoff = calculateUsageRetentionCutoff(now);
  } catch (error) {
    if (error instanceof UsagePruneError) {
      return invalidWindow();
    }
    return invalidWindow();
  }

  if (
    from.getTime() >= to.getTime() ||
    to.getTime() > now.getTime() ||
    from.getTime() < cutoff.getTime()
  ) {
    return invalidWindow();
  }

  return { from, to };
}

function timestamp(value: Date): string {
  return value.toISOString();
}

export function formatUsageReportResult(
  report: UsageCompletenessReport,
): readonly string[] {
  const operationLines = report.operations.map((operation) =>
    JSON.stringify({
      event: 'usage_report_operation',
      window_from: timestamp(report.window.from),
      window_to: timestamp(report.window.to),
      operation: operation.operation,
      downstream: operation.downstream,
      successful_count: operation.successfulCount,
      missing_usage_count: operation.missingUsageCount,
      incomplete_percent: operation.incompletePercent,
      status: operation.status,
    }),
  );
  return [
    ...operationLines,
    JSON.stringify({
      event: 'usage_report_summary',
      window_from: timestamp(report.window.from),
      window_to: timestamp(report.window.to),
      eligible_operations: report.summary.eligibleOperations,
      eligible_requests: report.summary.eligibleRequests,
      alert_operations: report.summary.alertOperations,
      status: report.summary.status,
    }),
  ];
}

function formatUsageReportFailure(
  window: UsageReportWindow,
  errorCode: UsageReportErrorCode,
): string {
  return JSON.stringify({
    event: 'usage_report_failed',
    window_from: timestamp(window.from),
    window_to: timestamp(window.to),
    status: 'failed',
    error_code: errorCode,
  });
}

function safeReportError(error: unknown): UsageReportError {
  if (error instanceof UsageReportError) {
    return error;
  }
  return new UsageReportError(
    'USAGE_REPORT_DATABASE_FAILURE',
    'usage report database operation failed',
  );
}

export async function runUsageReportCommand(
  input: UsageReportCliInput,
): Promise<UsageCompletenessReport> {
  const emit = input.emit ?? console.log;
  const now = input.clock?.() ?? input.now ?? new Date();
  const window = parseUsageReportWindow(input.from, input.to, now);

  if (input.databaseUrl.trim().length === 0) {
    const error = new UsageReportError(
      'USAGE_REPORT_CONFIGURATION_MISSING',
      'DATABASE_URL is required',
    );
    emit(formatUsageReportFailure(window, error.code));
    throw error;
  }

  let repository: UsageReportRepositoryPort;
  try {
    repository =
      input.repository ??
      createPostgresUsageCompletenessReportRepository(input.databaseUrl);
  } catch {
    const error = new UsageReportError(
      'USAGE_REPORT_DATABASE_FAILURE',
      'usage report database setup failed',
    );
    emit(formatUsageReportFailure(window, error.code));
    throw error;
  }

  const service = new UsageCompletenessReportService(
    repository,
    input.operations,
  );
  let report: UsageCompletenessReport | undefined;
  let operationError: UsageReportError | undefined;

  try {
    report = await service.report(window);
  } catch (error) {
    operationError = safeReportError(error);
  }

  try {
    await repository.close?.();
  } catch {
    if (operationError === undefined) {
      operationError = new UsageReportError(
        'USAGE_REPORT_DATABASE_FAILURE',
        'usage report database shutdown failed',
      );
    }
  }

  if (operationError !== undefined) {
    emit(formatUsageReportFailure(window, operationError.code));
    throw operationError;
  }
  if (report === undefined) {
    const error = new UsageReportError(
      'USAGE_REPORT_DATABASE_FAILURE',
      'usage report did not complete',
    );
    emit(formatUsageReportFailure(window, error.code));
    throw error;
  }

  for (const line of formatUsageReportResult(report)) {
    emit(line);
  }
  return report;
}
