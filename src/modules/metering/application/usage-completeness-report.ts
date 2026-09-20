import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import type { DownstreamId } from '../../../downstream/downstream.types';
import { DOWNSTREAM_USAGE_REPORTING } from './metering.service';

export interface UsageReportWindow {
  readonly from: Date;
  readonly to: Date;
}

export interface UsageReportOperationDefinition {
  readonly operation: string;
  readonly downstream: DownstreamId;
}

export interface UsageReportSnapshotQuery extends UsageReportWindow {
  readonly operations: readonly string[];
}

export interface UsageReportSnapshotRow {
  readonly operation: string;
  readonly successfulCount: number;
  readonly missingUsageCount: number;
}

export interface UsageReportRepositoryPort {
  snapshot(
    query: UsageReportSnapshotQuery,
  ): Promise<readonly UsageReportSnapshotRow[]>;
  close?(): Promise<void>;
}

export type UsageReportStatus = 'healthy' | 'alert';

export interface UsageReportOperationResult {
  readonly operation: string;
  readonly downstream: DownstreamId;
  readonly successfulCount: number;
  readonly missingUsageCount: number;
  readonly incompletePercent: number;
  readonly status: UsageReportStatus;
}

export interface UsageReportSummary {
  readonly eligibleOperations: number;
  readonly eligibleRequests: number;
  readonly alertOperations: number;
  readonly status: UsageReportStatus;
}

export interface UsageCompletenessReport {
  readonly window: UsageReportWindow;
  readonly operations: readonly UsageReportOperationResult[];
  readonly summary: UsageReportSummary;
}

export type UsageReportErrorCode =
  | 'USAGE_REPORT_INVALID_WINDOW'
  | 'USAGE_REPORT_CONFIGURATION_MISSING'
  | 'USAGE_REPORT_DATABASE_FAILURE'
  | 'USAGE_REPORT_SNAPSHOT_INVALID';

export class UsageReportError extends Error {
  constructor(
    readonly code: UsageReportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = UsageReportError.name;
  }
}

export class UsageReportDatabaseError extends UsageReportError {
  constructor() {
    super(
      'USAGE_REPORT_DATABASE_FAILURE',
      'usage completeness report database read failed',
    );
    this.name = UsageReportDatabaseError.name;
  }
}

export class UsageReportSnapshotError extends UsageReportError {
  constructor() {
    super(
      'USAGE_REPORT_SNAPSHOT_INVALID',
      'usage completeness report snapshot is invalid',
    );
    this.name = UsageReportSnapshotError.name;
  }
}

export function usageReportOperations(): readonly UsageReportOperationDefinition[] {
  return Object.entries(OPERATION_CATALOG)
    .filter(
      ([, definition]) =>
        definition.meteringMode === 'model' &&
        DOWNSTREAM_USAGE_REPORTING[definition.downstream],
    )
    .map(([operation, definition]) => ({
      operation,
      downstream: definition.downstream,
    }))
    .sort((left, right) => left.operation.localeCompare(right.operation));
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function orderedOperations(
  operations: readonly UsageReportOperationDefinition[],
): readonly UsageReportOperationDefinition[] {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (
      typeof operation.operation !== 'string' ||
      operation.operation.length === 0 ||
      !['ai-writing', 'ai-speaking'].includes(operation.downstream) ||
      seen.has(operation.operation)
    ) {
      throw new UsageReportSnapshotError();
    }
    seen.add(operation.operation);
  }
  return [...operations].sort((left, right) =>
    left.operation.localeCompare(right.operation),
  );
}

function incompletePercent(
  successfulCount: number,
  missingUsageCount: number,
): number {
  if (successfulCount === 0) {
    return 0;
  }

  const numerator = BigInt(missingUsageCount) * 10_000n;
  const denominator = BigInt(successfulCount);
  const rounded = (numerator + denominator / 2n) / denominator;
  return Number(rounded) / 100;
}

function isAlert(successfulCount: number, missingUsageCount: number): boolean {
  return (
    successfulCount > 0 &&
    BigInt(missingUsageCount) * 100n > BigInt(successfulCount)
  );
}

function snapshotMap(
  rows: readonly UsageReportSnapshotRow[],
  operations: readonly UsageReportOperationDefinition[],
): ReadonlyMap<string, UsageReportSnapshotRow> {
  if (!Array.isArray(rows)) {
    throw new UsageReportSnapshotError();
  }

  const eligible = new Set(operations.map(({ operation }) => operation));
  const result = new Map<string, UsageReportSnapshotRow>();
  for (const row of rows) {
    if (
      typeof row !== 'object' ||
      row === null ||
      Array.isArray(row) ||
      typeof row.operation !== 'string' ||
      !eligible.has(row.operation) ||
      result.has(row.operation) ||
      !validCount(row.successfulCount) ||
      !validCount(row.missingUsageCount) ||
      row.missingUsageCount > row.successfulCount
    ) {
      throw new UsageReportSnapshotError();
    }
    result.set(row.operation, row);
  }
  return result;
}

export class UsageCompletenessReportService {
  private readonly operations: readonly UsageReportOperationDefinition[];

  constructor(
    private readonly repository: UsageReportRepositoryPort,
    operations: readonly UsageReportOperationDefinition[] = usageReportOperations(),
  ) {
    this.operations = orderedOperations(operations);
  }

  async report(window: UsageReportWindow): Promise<UsageCompletenessReport> {
    let rows: readonly UsageReportSnapshotRow[];
    try {
      rows = await this.repository.snapshot({
        ...window,
        operations: this.operations.map(({ operation }) => operation),
      });
    } catch (error) {
      if (error instanceof UsageReportSnapshotError) {
        throw error;
      }
      throw new UsageReportDatabaseError();
    }

    const snapshot = snapshotMap(rows, this.operations);
    const operationResults = this.operations.map((definition) => {
      const counts = snapshot.get(definition.operation) ?? {
        operation: definition.operation,
        successfulCount: 0,
        missingUsageCount: 0,
      };
      const alert = isAlert(counts.successfulCount, counts.missingUsageCount);
      return {
        operation: definition.operation,
        downstream: definition.downstream,
        successfulCount: counts.successfulCount,
        missingUsageCount: counts.missingUsageCount,
        incompletePercent: incompletePercent(
          counts.successfulCount,
          counts.missingUsageCount,
        ),
        status: alert ? 'alert' : 'healthy',
      } as const;
    });
    const alertOperations = operationResults.filter(
      ({ status }) => status === 'alert',
    ).length;

    return {
      window,
      operations: operationResults,
      summary: {
        eligibleOperations: operationResults.length,
        eligibleRequests: operationResults.reduce(
          (total, operation) => total + operation.successfulCount,
          0,
        ),
        alertOperations,
        status: alertOperations > 0 ? 'alert' : 'healthy',
      },
    };
  }
}
