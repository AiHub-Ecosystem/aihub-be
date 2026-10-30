/**
 * The longest stretch with no collecting process that still counts as
 * complete. Persisted dropped-sample intervals are inconclusive on their own;
 * an unpersisted interval falls back to this gap rule (ADR-0136).
 */
export const PUBLIC_API_MAJOR_COVERAGE_TOLERANCE_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One process's collection window. Dropped samples are separately recorded by
 * interval; coverage alone does not prove those samples were counted.
 */
export interface PublicApiMajorCollectorRow {
  readonly environment: string;
  readonly startedAt: Date;
  readonly coveredThrough: Date;
  /** `null` until the process writes its last counts on a clean shutdown. */
  readonly stoppedCleanlyAt: Date | null;
}

export interface PublicApiMajorUsageDroppedInterval {
  readonly environment: string;
  readonly droppedFrom: Date;
  readonly droppedThrough: Date;
}

export interface PublicApiMajorCoverage {
  readonly environment: string;
  readonly verdict: 'complete' | 'inconclusive';
  /** UTC days whose counts cannot be shown complete, ascending. */
  readonly inconclusiveDays: readonly string[];
  /** The UTC day of each unclean exit in the window, ascending. */
  readonly uncleanExitDays: readonly string[];
}

interface Stretch {
  readonly from: number;
  readonly to: number;
}

function dayOf(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function startOf(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function addInconclusiveDays(
  days: Set<string>,
  from: number,
  through: number,
): void {
  if (from === through) {
    days.add(dayOf(from));
    return;
  }
  for (let day = startOf(dayOf(from)); day < through; day += DAY_MS) {
    days.add(dayOf(day));
  }
}

function uncoveredStretches(
  collectors: readonly PublicApiMajorCollectorRow[],
  from: number,
  to: number,
): Stretch[] {
  const covered = collectors
    .map((row) => ({
      from: row.startedAt.getTime(),
      to: row.coveredThrough.getTime(),
    }))
    .sort((a, b) => a.from - b.from);
  const gaps: Stretch[] = [];
  let cursor = from;
  for (const stretch of covered) {
    if (stretch.to <= cursor) continue;
    if (stretch.from >= to) break;
    if (stretch.from > cursor) gaps.push({ from: cursor, to: stretch.from });
    cursor = stretch.to;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps;
}

/**
 * Whether one Environment's counts for a window can be shown complete. Missing
 * counts are never read as zero traffic: a stretch with no collecting process
 * longer than the tolerance makes every UTC day it touches inconclusive, and so
 * does every day before the first process ever collected.
 */
export function assessPublicApiMajorCoverage(input: {
  readonly environment: string;
  /** Whole UTC days, `toDay` exclusive, as the report window holds them. */
  readonly window: { readonly fromDay: string; readonly toDay: string };
  readonly asOf: Date;
  readonly collectors: readonly PublicApiMajorCollectorRow[];
  readonly droppedIntervals: readonly PublicApiMajorUsageDroppedInterval[];
}): PublicApiMajorCoverage {
  const from = startOf(input.window.fromDay);
  const to = Math.min(startOf(input.window.toDay), input.asOf.getTime());
  const days = new Set<string>();
  for (const gap of uncoveredStretches(input.collectors, from, to)) {
    if (gap.to - gap.from <= PUBLIC_API_MAJOR_COVERAGE_TOLERANCE_MS) continue;
    addInconclusiveDays(days, gap.from, gap.to);
  }
  for (const interval of input.droppedIntervals) {
    if (interval.environment !== input.environment) continue;
    const lossFrom = Math.max(interval.droppedFrom.getTime(), from);
    const lossThrough = Math.min(interval.droppedThrough.getTime(), to);
    if (lossFrom > lossThrough || lossFrom >= to) continue;
    addInconclusiveDays(days, lossFrom, lossThrough);
  }

  const staleBefore =
    input.asOf.getTime() - PUBLIC_API_MAJOR_COVERAGE_TOLERANCE_MS;
  const uncleanExitDays = input.collectors
    .filter((row) => row.stoppedCleanlyAt === null)
    .map((row) => row.coveredThrough.getTime())
    .filter((time) => time < staleBefore && time >= from && time < to)
    .sort((a, b) => a - b)
    .map(dayOf);

  const inconclusiveDays = [...days].sort();
  return {
    environment: input.environment,
    verdict: inconclusiveDays.length === 0 ? 'complete' : 'inconclusive',
    inconclusiveDays,
    uncleanExitDays,
  };
}
