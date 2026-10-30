/**
 * The longest stretch with no collecting process that still counts as
 * complete. A process that dies loses only what it had not yet written, at most
 * one flush interval, and a replacement starts within this tolerance; a longer
 * stretch cannot be told apart from lost counts (ADR-0127, #1376).
 */
export const PUBLIC_API_MAJOR_COVERAGE_TOLERANCE_MS = 5 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One process's collection: every request it served between `startedAt` and
 * `coveredThrough` is durably counted. A failed write keeps its counts for the
 * next one, so a process's coverage never has a hole; only its death can lose
 * counts, which is why a process is one stretch and not many.
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
    for (let day = startOf(dayOf(gap.from)); day < gap.to; day += DAY_MS) {
      days.add(dayOf(day));
    }
  }
  for (const interval of input.droppedIntervals) {
    if (interval.environment !== input.environment) continue;
    const lossFrom = Math.max(interval.droppedFrom.getTime(), from);
    const lossThrough = Math.min(interval.droppedThrough.getTime(), to);
    if (lossFrom === lossThrough && lossFrom >= from && lossFrom < to) {
      days.add(dayOf(lossFrom));
      continue;
    }
    if (lossFrom >= lossThrough) continue;
    for (let day = startOf(dayOf(lossFrom)); day < lossThrough; day += DAY_MS) {
      days.add(dayOf(day));
    }
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
