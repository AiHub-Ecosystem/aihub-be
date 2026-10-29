import type { CallerAuth } from '@/catalog/public-routes';
import type {
  PublicApiMajorCollectorRow,
  PublicApiMajorCoverage,
} from './public-api-major-coverage';
import { assessPublicApiMajorCoverage } from './public-api-major-coverage';

export const PUBLIC_API_MAJOR_USAGE_BUFFER = Symbol(
  'PUBLIC_API_MAJOR_USAGE_BUFFER',
);
export const PUBLIC_API_MAJOR_USAGE_REPOSITORY = Symbol(
  'PUBLIC_API_MAJOR_USAGE_REPOSITORY',
);

/**
 * How the matched route authenticates its caller, as the route registries
 * declare it; `undeclared` for a versioned route neither registry lists.
 */
export type PublicApiCallerKind = CallerAuth | 'undeclared';

/** One completed request to a matched Public API route (ADR-0127). */
export interface PublicApiMajorUsageSample {
  readonly major: number;
  /** Absent when the request carried no authenticated Organization. */
  readonly organizationId?: string;
  readonly failed: boolean;
  /** How the matched route authenticates its caller, as it declares it. */
  readonly callerKind: PublicApiCallerKind;
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

/**
 * A day's unattributed traffic for one major, by how the route authenticates
 * its caller, so an operator can tell Customer Web from a failed API key.
 */
export interface PublicApiMajorUnattributedRow {
  readonly usageDay: string;
  readonly major: number;
  readonly callerKind: PublicApiCallerKind;
  readonly requestCount: number;
  readonly failureCount: number;
}

export interface PublicApiMajorUsageBatch {
  readonly rows: readonly PublicApiMajorUsageRow[];
  readonly unattributed: readonly PublicApiMajorUnattributedRow[];
}

/** One running process, identified only for its own collection record. */
export interface PublicApiMajorCollector {
  readonly processId: string;
  readonly startedAt: Date;
}

/**
 * Counts and the collection record they extend, written together: the record
 * never claims coverage the counts did not reach.
 */
export interface PublicApiMajorUsageWrite extends PublicApiMajorUsageBatch {
  readonly collector: PublicApiMajorCollector;
  /**
   * This process's write number, from 1. A retry keeps its number, so a write
   * whose commit response was lost is not counted a second time.
   */
  readonly batch: number;
  /** When the buffer was drained: every earlier sample is in this write. */
  readonly coveredThrough: Date;
  /** True for the last write of a clean shutdown. */
  readonly stoppedCleanly: boolean;
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
  readonly unattributedFailureCount: number;
}

export interface PublicApiMajorOrganizationRow {
  readonly environment: string;
  readonly major: number;
  readonly organizationId: string;
  readonly requestCount: number;
  readonly lastSeenAt: Date;
}

export interface PublicApiMajorUnattributedTotalRow {
  readonly environment: string;
  readonly major: number;
  readonly callerKind: string;
  readonly requestCount: number;
  readonly failureCount: number;
}

/** Everything one report reads, from one database snapshot taken at `asOf`. */
export interface PublicApiMajorSnapshot {
  readonly asOf: Date;
  readonly coverageStartDay: string | undefined;
  readonly totals: readonly PublicApiMajorTotalRow[];
  readonly organizations: readonly PublicApiMajorOrganizationRow[];
  readonly unattributed: readonly PublicApiMajorUnattributedTotalRow[];
  readonly collectors: readonly PublicApiMajorCollectorRow[];
}

export interface PublicApiMajorUsageRepositoryPort {
  /**
   * Adds these counts to the day rows of this process's Environment and
   * extends its collection record, in one transaction.
   */
  add(environment: string, write: PublicApiMajorUsageWrite): Promise<void>;
  snapshot(window: PublicApiMajorWindow): Promise<PublicApiMajorSnapshot>;
  close?(): Promise<void>;
}

/**
 * Unattributed counts written by a release that kept no caller breakdown are
 * reported under this kind, so the breakdown always sums to the total.
 */
export const UNCLASSIFIED_CALLER_KIND = 'unclassified';

export interface PublicApiMajorReport {
  readonly window: PublicApiMajorWindow;
  readonly asOf: Date;
  /**
   * One for the Environment the database serves, even with no rows, so missing
   * collection never reads as zero traffic (#1389); one more for any other
   * Environment the snapshot holds rows for.
   */
  readonly coverage: readonly PublicApiMajorCoverage[];
  /** The earliest day any row exists for, so a reader sees what was retained. */
  readonly coverageStartDay: string | undefined;
  readonly majors: readonly {
    readonly environment: string;
    readonly major: number;
    readonly requestCount: number;
    readonly failureCount: number;
    readonly unattributedCount: number;
    readonly unattributed: readonly {
      readonly callerKind: string;
      readonly requestCount: number;
      readonly failureCount: number;
    }[];
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
  private unattributed = new Map<string, PublicApiMajorUnattributedRow>();

  record(sample: PublicApiMajorUsageSample): void {
    const usageDay = dayOf(sample.at);
    const failureCount = sample.failed ? 1 : 0;
    this.addRow({
      usageDay,
      major: sample.major,
      organizationId: sample.organizationId ?? null,
      requestCount: 1,
      failureCount,
      lastSeenAt: sample.at,
    });
    if (sample.organizationId === undefined) {
      this.addUnattributed({
        usageDay,
        major: sample.major,
        callerKind: sample.callerKind,
        requestCount: 1,
        failureCount,
      });
    }
  }

  drain(): PublicApiMajorUsageBatch {
    const drained = {
      rows: [...this.rows.values()],
      unattributed: [...this.unattributed.values()],
    };
    this.rows = new Map();
    this.unattributed = new Map();
    return drained;
  }

  private addRow(row: PublicApiMajorUsageRow): void {
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

  private addUnattributed(row: PublicApiMajorUnattributedRow): void {
    const key = `${row.usageDay}|${row.major}|${row.callerKind}`;
    const held = this.unattributed.get(key);
    this.unattributed.set(
      key,
      held === undefined
        ? row
        : {
            ...row,
            requestCount: held.requestCount + row.requestCount,
            failureCount: held.failureCount + row.failureCount,
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

function unattributedOf(
  total: PublicApiMajorTotalRow,
  rows: readonly PublicApiMajorUnattributedTotalRow[],
): PublicApiMajorReport['majors'][number]['unattributed'] {
  const kinds = rows
    .filter(
      (row) =>
        row.environment === total.environment && row.major === total.major,
    )
    .map(({ callerKind, requestCount, failureCount }) => ({
      callerKind,
      requestCount,
      failureCount,
    }))
    .sort((a, b) => a.callerKind.localeCompare(b.callerKind));
  const requestCount =
    total.unattributedCount -
    kinds.reduce((sum, kind) => sum + kind.requestCount, 0);
  const failureCount =
    total.unattributedFailureCount -
    kinds.reduce((sum, kind) => sum + kind.failureCount, 0);
  return requestCount > 0
    ? [
        ...kinds,
        {
          callerKind: UNCLASSIFIED_CALLER_KIND,
          requestCount,
          failureCount: Math.max(failureCount, 0),
        },
      ]
    : kinds;
}

export function buildPublicApiMajorReport(
  input: PublicApiMajorSnapshot & {
    readonly window: PublicApiMajorWindow;
    /** The Environment whose database the snapshot was read from. */
    readonly environment: string;
  },
): PublicApiMajorReport {
  const majors = [...input.totals]
    .sort(
      (a, b) => a.environment.localeCompare(b.environment) || a.major - b.major,
    )
    .map((total) => ({
      environment: total.environment,
      major: total.major,
      requestCount: total.requestCount,
      failureCount: total.failureCount,
      unattributedCount: total.unattributedCount,
      unattributed: unattributedOf(total, input.unattributed),
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
  const environments = [
    ...new Set([
      input.environment,
      ...input.totals.map((row) => row.environment),
      ...input.collectors.map((row) => row.environment),
    ]),
  ].sort();

  return {
    window: input.window,
    asOf: input.asOf,
    coverageStartDay: input.coverageStartDay,
    coverage: environments.map((environment) =>
      assessPublicApiMajorCoverage({
        environment,
        window: input.window,
        asOf: input.asOf,
        collectors: input.collectors.filter(
          (row) => row.environment === environment,
        ),
      }),
    ),
    majors,
  };
}
