export interface CoverageMetricSummary {
  readonly total: number;
  readonly covered: number;
  readonly skipped?: number;
}

export interface CoverageTotals {
  readonly lines: CoverageMetricSummary;
  readonly statements: CoverageMetricSummary;
  readonly functions: CoverageMetricSummary;
  readonly branches: CoverageMetricSummary;
}

/** The recorded percentages, one per metric, as the gate reads them. */
export interface CoverageReport {
  readonly lines?: number;
  readonly branches?: number;
  readonly statements?: number;
  readonly functions?: number;
  readonly marginPoints?: number;
  readonly recordedLanes?: readonly string[];
}

export interface CoverageFinding {
  readonly metric: 'lines' | 'branches' | 'statements' | 'functions';
  /** `unknown` means the metric was not recorded on both sides. */
  readonly status: 'ok' | 'drop' | 'unknown';
  readonly baseline: number | undefined;
  readonly current: number | undefined;
  readonly delta: number | undefined;
}

export interface CoverageComparison {
  /** False when any metric dropped past the margin, or when there was no baseline. */
  readonly ok: boolean;
  readonly marginPoints: number;
  readonly findings: readonly CoverageFinding[];
}

export declare const BASELINE_PATH: string;
export declare const DEFAULT_MARGIN_POINTS: number;

export declare function branchPercent(
  summary: Pick<CoverageTotals, 'branches'>,
): number | null;

export declare function compareCoverage(
  baseline: CoverageReport | undefined,
  current: CoverageReport | undefined,
  marginPoints?: number,
): CoverageComparison;

export declare function isProductionCode(relativePath: string): boolean;

/** Merges the lane reports, prints them, and applies the gate. Exit code is the result. */
export declare function main(argv?: readonly string[], root?: string): number;
