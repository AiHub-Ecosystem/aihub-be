export const PUBLIC_API_MAJOR_USAGE_BUFFER = Symbol(
  'PUBLIC_API_MAJOR_USAGE_BUFFER',
);
export const PUBLIC_API_MAJOR_USAGE_REPOSITORY = Symbol(
  'PUBLIC_API_MAJOR_USAGE_REPOSITORY',
);

/** One completed request to a matched Public API route (ADR-0127). */
export interface PublicApiMajorUsageSample {
  readonly major: number;
  /** Absent when the request carried no authenticated Organization. */
  readonly organizationId?: string;
  readonly failed: boolean;
  readonly at: Date;
}

/** A day's traffic for one major and Organization; `null` is unattributed. */
export interface PublicApiMajorUsageRow {
  readonly usageDay: string;
  readonly major: number;
  readonly organizationId: string | null;
  readonly requestCount: number;
  readonly failureCount: number;
  readonly lastSeenAt: Date;
}

export interface PublicApiMajorWindow {
  /** First UTC day, inclusive (`YYYY-MM-DD`). */
  readonly fromDay: string;
  /** Last UTC day, exclusive. */
  readonly toDay: string;
}

export interface PublicApiMajorTotalRow {
  readonly environment: string;
  readonly major: number;
  readonly requestCount: number;
  readonly failureCount: number;
  readonly unattributedCount: number;
}

export interface PublicApiMajorOrganizationRow {
  readonly environment: string;
  readonly major: number;
  readonly organizationId: string;
  readonly requestCount: number;
  readonly lastSeenAt: Date;
}

export interface PublicApiMajorSnapshot {
  readonly coverageStartDay: string | undefined;
  readonly totals: readonly PublicApiMajorTotalRow[];
  readonly organizations: readonly PublicApiMajorOrganizationRow[];
}

export interface PublicApiMajorUsageRepositoryPort {
  /** Adds these counts to the day rows of this process's Environment. */
  add(
    environment: string,
    rows: readonly PublicApiMajorUsageRow[],
  ): Promise<void>;
  snapshot(window: PublicApiMajorWindow): Promise<PublicApiMajorSnapshot>;
  close?(): Promise<void>;
}

export interface PublicApiMajorReport {
  readonly window: PublicApiMajorWindow;
  /** The earliest day any row exists for, so a reader sees what was retained. */
  readonly coverageStartDay: string | undefined;
  readonly majors: readonly {
    readonly environment: string;
    readonly major: number;
    readonly requestCount: number;
    readonly failureCount: number;
    readonly unattributedCount: number;
    readonly organizations: readonly {
      readonly organizationId: string;
      readonly requestCount: number;
      readonly lastSeenAt: Date;
    }[];
  }[];
}

export type PublicApiMajorUsageErrorCode =
  | 'PUBLIC_API_MAJOR_REPORT_INVALID_WINDOW'
  | 'PUBLIC_API_MAJOR_REPORT_CONFIGURATION_MISSING'
  | 'PUBLIC_API_MAJOR_REPORT_DATABASE_FAILURE';

export class PublicApiMajorUsageError extends Error {
  constructor(
    readonly code: PublicApiMajorUsageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PublicApiMajorUsageError';
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

function dayOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * In-process counts waiting for the next flush. A request is one `Map`
 * increment, so recording never waits on the database. A crash loses at most
 * one flush interval of adoption counts; nothing here is billing evidence.
 */
export class PublicApiMajorUsageBuffer {
  private rows = new Map<string, PublicApiMajorUsageRow>();

  record(sample: PublicApiMajorUsageSample): void {
    this.add({
      usageDay: dayOf(sample.at),
      major: sample.major,
      organizationId: sample.organizationId ?? null,
      requestCount: 1,
      failureCount: sample.failed ? 1 : 0,
      lastSeenAt: sample.at,
    });
  }

  drain(): readonly PublicApiMajorUsageRow[] {
    const drained = [...this.rows.values()];
    this.rows = new Map();
    return drained;
  }

  /** Returns rows a failed flush could not write, merged with newer counts. */
  restore(rows: readonly PublicApiMajorUsageRow[]): void {
    for (const row of rows) {
      this.add(row);
    }
  }

  private add(row: PublicApiMajorUsageRow): void {
    const key = `${row.usageDay}|${row.major}|${row.organizationId ?? ''}`;
    const held = this.rows.get(key);
    this.rows.set(
      key,
      held === undefined
        ? row
        : {
            ...row,
            requestCount: held.requestCount + row.requestCount,
            failureCount: held.failureCount + row.failureCount,
            lastSeenAt:
              held.lastSeenAt > row.lastSeenAt
                ? held.lastSeenAt
                : row.lastSeenAt,
          },
    );
  }
}

function invalidWindow(): never {
  throw new PublicApiMajorUsageError(
    'PUBLIC_API_MAJOR_REPORT_INVALID_WINDOW',
    'public API major report window is invalid',
  );
}

function validDay(value: string): boolean {
  if (!DAY.test(value)) {
    return false;
  }
  return dayOf(new Date(`${value}T00:00:00Z`)) === value;
}

/**
 * A report window is whole UTC days, because that is the grain the counts are
 * kept at. The end is exclusive and may be tomorrow, which includes today.
 */
export function parsePublicApiMajorWindow(
  from: string,
  to: string,
  now: Date,
): PublicApiMajorWindow {
  if (Number.isNaN(now.getTime()) || !validDay(from) || !validDay(to)) {
    return invalidWindow();
  }
  const tomorrow = dayOf(new Date(now.getTime() + 24 * 60 * 60 * 1000));
  if (from >= to || to > tomorrow) {
    return invalidWindow();
  }
  return { fromDay: from, toDay: to };
}

export function buildPublicApiMajorReport(input: {
  readonly window: PublicApiMajorWindow;
  readonly coverageStartDay: string | undefined;
  readonly totals: readonly PublicApiMajorTotalRow[];
  readonly organizations: readonly PublicApiMajorOrganizationRow[];
}): PublicApiMajorReport {
  const majors = [...input.totals]
    .sort(
      (a, b) => a.environment.localeCompare(b.environment) || a.major - b.major,
    )
    .map((total) => ({
      ...total,
      organizations: input.organizations
        .filter(
          (row) =>
            row.environment === total.environment && row.major === total.major,
        )
        .sort(
          (a, b) =>
            b.requestCount - a.requestCount ||
            a.organizationId.localeCompare(b.organizationId),
        )
        .map(({ organizationId, requestCount, lastSeenAt }) => ({
          organizationId,
          requestCount,
          lastSeenAt,
        })),
    }));

  return {
    window: input.window,
    coverageStartDay: input.coverageStartDay,
    majors,
  };
}
