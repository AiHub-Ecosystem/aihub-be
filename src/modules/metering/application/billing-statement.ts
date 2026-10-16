import { quotaMonth } from '@/modules/gateway/public/quota-period';

/**
 * What an Organization is billed for one UTC month (ADR-0097, #404).
 *
 * The billing month is the UTC calendar month of the moment a request
 * completes (`usage_records.created_at`). A statement bills successful,
 * non-replayed Production requests made with a customer key, plus the one
 * charge for a grading completed after its `504`, plus any adjustments. Every
 * request it leaves out is counted beside it with the reason.
 */

export type BillingStatementErrorCode =
  | 'BILLING_INVALID_MONTH'
  | 'BILLING_MONTH_NOT_ENDED'
  | 'BILLING_MONTH_CLOSED'
  | 'BILLING_INVALID_ADJUSTMENT'
  | 'BILLING_DATABASE_FAILURE';

export class BillingStatementError extends Error {
  constructor(
    readonly code: BillingStatementErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BillingStatementError';
  }
}

export interface BillingMonth {
  /** `YYYY-MM`. */
  readonly label: string;
  /** First instant of the month, UTC; also the stored `billing_month`. */
  readonly from: Date;
  /** First instant of the next month, UTC; exclusive. */
  readonly to: Date;
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function parseBillingMonth(raw: string): BillingMonth {
  const match = MONTH_PATTERN.exec(raw.trim());
  if (match === null) {
    throw new BillingStatementError(
      'BILLING_INVALID_MONTH',
      'billing month must be YYYY-MM',
    );
  }
  const month = quotaMonth(Number(match[1]), Number(match[2]) - 1);
  return {
    label: raw.trim(),
    from: month.start,
    to: month.end,
  };
}

/** Per Organization and operation, counted straight from the usage records. */
export interface BillingUsageRow {
  readonly organizationId: string;
  readonly operation: string;
  readonly billableResponses: number;
  readonly billableBackgroundCompletions: number;
  /** Billed, but the quota counter could not confirm the increment. */
  readonly quotaUnverified: number;
  readonly excludedReplays: number;
  readonly excludedFailures: number;
  readonly excludedInternal: number;
  readonly excludedNonProduction: number;
}

export interface BillingAdjustmentRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly operation: string;
  readonly requests: number;
  readonly reason: string;
  readonly corrects: BillingAdjustmentTarget;
  readonly actor: string;
  readonly createdAt: Date;
}

export type BillingAdjustmentTarget =
  | { readonly requestIds: readonly string[] }
  | { readonly period: { readonly from: string; readonly to: string } };

export interface BillingClosureRecord {
  readonly organizationId: string;
  readonly operation: string;
  readonly billableRequests: number;
  readonly adjustmentRequests: number;
  readonly totalRequests: number;
  readonly closedBy: string;
  readonly closedAt: Date;
}

export interface BillingStatementLine {
  readonly organizationId: string;
  readonly operation: string;
  /** Responses and background completions together. */
  readonly billableRequests: number;
  readonly backgroundCompletionRequests: number;
  readonly adjustmentRequests: number;
  readonly totalRequests: number;
  readonly quotaUnverified: number;
  readonly excludedReplays: number;
  readonly excludedFailures: number;
  readonly excludedInternal: number;
  readonly excludedNonProduction: number;
}

export interface BillingClosureDifference {
  readonly organizationId: string;
  readonly operation: string;
  readonly closedTotal: number;
  readonly currentTotal: number;
}

export interface BillingStatement {
  readonly month: BillingMonth;
  readonly lines: readonly BillingStatementLine[];
  readonly adjustments: readonly BillingAdjustmentRecord[];
  /** Organizations whose month is closed, with when and by whom. */
  readonly closed: readonly {
    readonly organizationId: string;
    readonly closedBy: string;
    readonly closedAt: Date;
  }[];
  /** A closed month whose evidence no longer adds up to what was billed. */
  readonly differences: readonly BillingClosureDifference[];
}

export interface NewBillingAdjustment {
  readonly id: string;
  readonly organizationId: string;
  readonly month: BillingMonth;
  readonly operation: string;
  readonly requests: number;
  readonly reason: string;
  readonly corrects: BillingAdjustmentTarget;
  readonly actor: string;
}

export interface BillingStatementRepositoryPort {
  usage(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingUsageRow[]>;
  adjustments(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingAdjustmentRecord[]>;
  closures(
    month: BillingMonth,
    organizationId: string | undefined,
  ): Promise<readonly BillingClosureRecord[]>;
  /** Stores the lines of Organizations not yet closed; never rewrites one. */
  closeMonth(
    month: BillingMonth,
    lines: readonly BillingStatementLine[],
    actor: string,
  ): Promise<void>;
  /** Refuses a month already closed for the Organization. */
  addAdjustment(
    input: NewBillingAdjustment,
  ): Promise<'created' | 'month_closed'>;
  close?(): Promise<void>;
}

function key(organizationId: string, operation: string): string {
  return `${organizationId}\u0000${operation}`;
}

export function buildBillingStatement(
  month: BillingMonth,
  usage: readonly BillingUsageRow[],
  adjustments: readonly BillingAdjustmentRecord[],
  closures: readonly BillingClosureRecord[],
): BillingStatement {
  const lines = new Map<string, BillingStatementLine>();
  const empty = (organizationId: string, operation: string) => ({
    organizationId,
    operation,
    billableRequests: 0,
    backgroundCompletionRequests: 0,
    adjustmentRequests: 0,
    totalRequests: 0,
    quotaUnverified: 0,
    excludedReplays: 0,
    excludedFailures: 0,
    excludedInternal: 0,
    excludedNonProduction: 0,
  });

  for (const row of usage) {
    const billable = row.billableResponses + row.billableBackgroundCompletions;
    lines.set(key(row.organizationId, row.operation), {
      ...empty(row.organizationId, row.operation),
      billableRequests: billable,
      backgroundCompletionRequests: row.billableBackgroundCompletions,
      totalRequests: billable,
      quotaUnverified: row.quotaUnverified,
      excludedReplays: row.excludedReplays,
      excludedFailures: row.excludedFailures,
      excludedInternal: row.excludedInternal,
      excludedNonProduction: row.excludedNonProduction,
    });
  }
  for (const adjustment of adjustments) {
    const k = key(adjustment.organizationId, adjustment.operation);
    const line =
      lines.get(k) ?? empty(adjustment.organizationId, adjustment.operation);
    lines.set(k, {
      ...line,
      adjustmentRequests: line.adjustmentRequests + adjustment.requests,
      totalRequests: line.totalRequests + adjustment.requests,
    });
  }

  const sorted = [...lines.values()].sort((a, b) =>
    key(a.organizationId, a.operation).localeCompare(
      key(b.organizationId, b.operation),
    ),
  );

  const closedBy = new Map<string, { closedBy: string; closedAt: Date }>();
  const closedTotals = new Map<string, number>();
  for (const closure of closures) {
    closedBy.set(closure.organizationId, {
      closedBy: closure.closedBy,
      closedAt: closure.closedAt,
    });
    closedTotals.set(
      key(closure.organizationId, closure.operation),
      closure.totalRequests,
    );
  }

  const differences: BillingClosureDifference[] = [];
  for (const organizationId of closedBy.keys()) {
    const keys = new Set<string>();
    for (const line of sorted) {
      if (line.organizationId === organizationId) {
        keys.add(key(line.organizationId, line.operation));
      }
    }
    for (const closure of closures) {
      if (closure.organizationId === organizationId) {
        keys.add(key(closure.organizationId, closure.operation));
      }
    }
    for (const k of [...keys].sort()) {
      const current = lines.get(k)?.totalRequests ?? 0;
      const stored = closedTotals.get(k) ?? 0;
      if (current !== stored) {
        const [, operation = ''] = k.split('\u0000');
        differences.push({
          organizationId,
          operation,
          closedTotal: stored,
          currentTotal: current,
        });
      }
    }
  }

  return {
    month,
    lines: sorted,
    adjustments,
    closed: [...closedBy.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([organizationId, value]) => ({ organizationId, ...value })),
    differences,
  };
}

export interface BillingStatementRequest {
  readonly month: BillingMonth;
  readonly organizationId?: string;
  /** Present to close the month as this actor. */
  readonly closeAs?: string;
  readonly now: Date;
}

export class BillingStatementService {
  constructor(private readonly repository: BillingStatementRepositoryPort) {}

  async statement(request: BillingStatementRequest): Promise<BillingStatement> {
    const { month, organizationId } = request;
    if (request.closeAs !== undefined && request.now < month.to) {
      throw new BillingStatementError(
        'BILLING_MONTH_NOT_ENDED',
        'a month can only be closed after it ends',
      );
    }

    const [usage, adjustments, closures] = await Promise.all([
      this.repository.usage(month, organizationId),
      this.repository.adjustments(month, organizationId),
      this.repository.closures(month, organizationId),
    ]);
    const statement = buildBillingStatement(
      month,
      usage,
      adjustments,
      closures,
    );
    if (request.closeAs === undefined) {
      return statement;
    }

    // Already-closed Organizations are compared above, never rewritten.
    const closed = new Set(statement.closed.map((c) => c.organizationId));
    const open = statement.lines.filter(
      (line) => !closed.has(line.organizationId),
    );
    if (open.length > 0) {
      await this.repository.closeMonth(month, open, request.closeAs);
    }
    return buildBillingStatement(
      month,
      usage,
      adjustments,
      await this.repository.closures(month, organizationId),
    );
  }

  async adjust(input: NewBillingAdjustment): Promise<'created'> {
    if (
      !Number.isInteger(input.requests) ||
      input.requests === 0 ||
      input.reason.trim().length === 0 ||
      input.reason.length > 500 ||
      input.actor.trim().length === 0 ||
      !validTarget(input.corrects)
    ) {
      throw new BillingStatementError(
        'BILLING_INVALID_ADJUSTMENT',
        'billing adjustment is invalid',
      );
    }
    const result = await this.repository.addAdjustment(input);
    if (result === 'month_closed') {
      throw new BillingStatementError(
        'BILLING_MONTH_CLOSED',
        'the month is closed; record the correction in an open month',
      );
    }
    return result;
  }
}

function validTarget(target: BillingAdjustmentTarget): boolean {
  if ('requestIds' in target) {
    return (
      target.requestIds.length > 0 &&
      target.requestIds.every((id) => id.trim().length > 0)
    );
  }
  const from = Date.parse(target.period.from);
  const to = Date.parse(target.period.to);
  return Number.isFinite(from) && Number.isFinite(to) && from < to;
}
