import { PostgresPublicApiMajorUsageRepository } from '@/modules/metering/infrastructure/postgres-public-api-major-usage.repository';
import {
  type PublicApiMajorReport,
  PublicApiMajorUsageError,
  type PublicApiMajorUsageErrorCode,
  type PublicApiMajorUsageRepositoryPort,
  type PublicApiMajorWindow,
  buildPublicApiMajorReport,
  parsePublicApiMajorWindow,
} from '@/modules/metering/public/public-api-major-usage';
import { createOperatorMeteringClient } from './operator-metering-client';

export interface PublicApiMajorReportCliInput {
  readonly databaseUrl: string;
  /** First UTC day, `YYYY-MM-DD`. */
  readonly from: string;
  /** Exclusive end day, `YYYY-MM-DD`. */
  readonly to: string;
  readonly now?: Date;
  readonly repository?: PublicApiMajorUsageRepositoryPort;
  readonly emit?: (line: string) => void;
}

function failureLine(
  input: PublicApiMajorReportCliInput,
  code: PublicApiMajorUsageErrorCode,
): string {
  return JSON.stringify({
    event: 'public_api_major_report_failed',
    window_from: input.from,
    window_to: input.to,
    status: 'failed',
    error_code: code,
  });
}

export function formatPublicApiMajorReport(
  report: PublicApiMajorReport,
): readonly string[] {
  const window = {
    window_from: report.window.fromDay,
    window_to: report.window.toDay,
  };
  const lines = report.majors.flatMap((major) => [
    JSON.stringify({
      event: 'public_api_major_total',
      ...window,
      environment: major.environment,
      major: major.major,
      request_count: major.requestCount,
      failure_count: major.failureCount,
      unattributed_count: major.unattributedCount,
      organization_count: major.organizations.length,
    }),
    ...major.unattributed.map((kind) =>
      JSON.stringify({
        event: 'public_api_major_unattributed',
        ...window,
        environment: major.environment,
        major: major.major,
        caller_kind: kind.callerKind,
        request_count: kind.requestCount,
        failure_count: kind.failureCount,
      }),
    ),
    ...major.organizations.map((organization) =>
      JSON.stringify({
        event: 'public_api_major_organization',
        ...window,
        environment: major.environment,
        major: major.major,
        organization_id: organization.organizationId,
        request_count: organization.requestCount,
        last_seen_at: organization.lastSeenAt.toISOString(),
      }),
    ),
  ]);
  return [
    ...lines,
    ...report.coverage.map((coverage) =>
      JSON.stringify({
        event: 'public_api_major_coverage',
        ...window,
        environment: coverage.environment,
        verdict: coverage.verdict,
        inconclusive_days: coverage.inconclusiveDays,
        unclean_exits: coverage.uncleanExitDays,
      }),
    ),
    JSON.stringify({
      event: 'public_api_major_window',
      ...window,
      as_of: report.asOf.toISOString(),
      ...(report.coverageStartDay === undefined
        ? {}
        : { coverage_start_day: report.coverageStartDay }),
      majors: report.majors.length,
    }),
  ];
}

async function openRepository(
  input: PublicApiMajorReportCliInput,
): Promise<PublicApiMajorUsageRepositoryPort> {
  if (input.repository !== undefined) {
    return input.repository;
  }
  if (input.databaseUrl.trim().length === 0) {
    throw new PublicApiMajorUsageError(
      'PUBLIC_API_MAJOR_REPORT_CONFIGURATION_MISSING',
      'DATABASE_URL is required',
    );
  }
  try {
    return new PostgresPublicApiMajorUsageRepository(
      await createOperatorMeteringClient(input.databaseUrl),
    );
  } catch {
    throw new PublicApiMajorUsageError(
      'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
      'public API major report database setup failed',
    );
  }
}

async function readReport(
  repository: PublicApiMajorUsageRepositoryPort,
  window: PublicApiMajorWindow,
): Promise<PublicApiMajorReport> {
  try {
    const snapshot = await repository.snapshot(window);
    return buildPublicApiMajorReport({ window, ...snapshot });
  } catch {
    throw new PublicApiMajorUsageError(
      'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
      'public API major report database operation failed',
    );
  }
}

/**
 * Who still uses each Public API major in a window of UTC days: totals by
 * major and Environment, then each Organization with its request count and
 * last-seen time. Organization ids appear only here, on operator stdout.
 */
export async function runPublicApiMajorReportCommand(
  input: PublicApiMajorReportCliInput,
): Promise<PublicApiMajorReport> {
  const emit = input.emit ?? console.log;
  // A malformed window is a usage error, refused before anything is emitted.
  const window = parsePublicApiMajorWindow(
    input.from,
    input.to,
    input.now ?? new Date(),
  );
  let report: PublicApiMajorReport | undefined;
  let failure: PublicApiMajorUsageError | undefined;
  let repository: PublicApiMajorUsageRepositoryPort | undefined;

  try {
    repository = await openRepository(input);
    report = await readReport(repository, window);
  } catch (error) {
    failure =
      error instanceof PublicApiMajorUsageError
        ? error
        : new PublicApiMajorUsageError(
            'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
            'public API major report did not complete',
          );
  }

  try {
    await repository?.close?.();
  } catch {
    failure ??= new PublicApiMajorUsageError(
      'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
      'public API major report database shutdown failed',
    );
  }

  if (failure !== undefined || report === undefined) {
    const error =
      failure ??
      new PublicApiMajorUsageError(
        'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE',
        'public API major report did not complete',
      );
    emit(failureLine(input, error.code));
    throw error;
  }

  for (const line of formatPublicApiMajorReport(report)) {
    emit(line);
  }
  return report;
}
