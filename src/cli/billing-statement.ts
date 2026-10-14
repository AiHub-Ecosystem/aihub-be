import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PostgresBillingStatementRepository } from '@/modules/metering/infrastructure/postgres-billing-statement.repository';
import {
  type BillingAdjustmentTarget,
  type BillingStatement,
  BillingStatementError,
  type BillingStatementRepositoryPort,
  BillingStatementService,
  parseBillingMonth,
} from '@/modules/metering/public/billing-statement';
import { ulid } from 'ulid';
import { createOperatorMeteringClient } from './operator-metering-client';

export interface BillingStatementCliInput {
  readonly databaseUrl: string;
  readonly month: string;
  /** Omitted for every Organization. */
  readonly organizationId?: string;
  /** Present to close the month as this actor. */
  readonly closeAs?: string;
  readonly repository?: BillingStatementRepositoryPort;
  readonly emit?: (line: string) => void;
  readonly now?: () => Date;
}

export interface BillingAdjustCliInput {
  readonly databaseUrl: string;
  readonly organizationId: string;
  readonly month: string;
  readonly operation: string;
  readonly requests: number;
  readonly reason: string;
  readonly corrects: BillingAdjustmentTarget;
  readonly actor: string;
  readonly repository?: BillingStatementRepositoryPort;
  readonly emit?: (line: string) => void;
}

async function openRepository(
  databaseUrl: string,
  repository: BillingStatementRepositoryPort | undefined,
): Promise<BillingStatementRepositoryPort> {
  if (repository !== undefined) {
    return repository;
  }
  if (databaseUrl.trim().length === 0) {
    throw new BillingStatementError(
      'BILLING_DATABASE_FAILURE',
      'DATABASE_URL is required',
    );
  }
  return new PostgresBillingStatementRepository(
    await createOperatorMeteringClient(databaseUrl),
  );
}

export function formatBillingStatement(
  statement: BillingStatement,
): readonly string[] {
  const month = statement.month.label;
  const out: string[] = [];
  for (const line of statement.lines) {
    out.push(
      JSON.stringify({
        event: 'billing_statement_line',
        month,
        organization_id: line.organizationId,
        operation: line.operation,
        billable_requests: line.billableRequests,
        background_completion_requests: line.backgroundCompletionRequests,
        adjustment_requests: line.adjustmentRequests,
        total_requests: line.totalRequests,
        quota_unverified: line.quotaUnverified,
        excluded: {
          replay: line.excludedReplays,
          failure: line.excludedFailures,
          internal: line.excludedInternal,
          non_production: line.excludedNonProduction,
        },
      }),
    );
    if (line.excludedInternal > 0) {
      out.push(
        JSON.stringify({
          event: 'billing_statement_internal',
          month,
          organization_id: line.organizationId,
          operation: line.operation,
          requests: line.excludedInternal,
        }),
      );
    }
  }
  for (const adjustment of statement.adjustments) {
    out.push(
      JSON.stringify({
        event: 'billing_statement_adjustment',
        month,
        id: adjustment.id,
        organization_id: adjustment.organizationId,
        operation: adjustment.operation,
        requests: adjustment.requests,
        reason: adjustment.reason,
        corrects:
          'requestIds' in adjustment.corrects
            ? { request_ids: adjustment.corrects.requestIds }
            : { period: adjustment.corrects.period },
        actor: adjustment.actor,
        created_at: adjustment.createdAt.toISOString(),
      }),
    );
  }
  for (const closed of statement.closed) {
    out.push(
      JSON.stringify({
        event: 'billing_statement_closed',
        month,
        organization_id: closed.organizationId,
        closed_by: closed.closedBy,
        closed_at: closed.closedAt.toISOString(),
      }),
    );
  }
  for (const difference of statement.differences) {
    out.push(
      JSON.stringify({
        event: 'billing_statement_difference',
        month,
        organization_id: difference.organizationId,
        operation: difference.operation,
        closed_total: difference.closedTotal,
        current_total: difference.currentTotal,
      }),
    );
  }
  out.push(
    JSON.stringify({
      event: 'billing_statement_summary',
      month,
      window_from: statement.month.from.toISOString(),
      window_to: statement.month.to.toISOString(),
      organizations: new Set(statement.lines.map((l) => l.organizationId)).size,
      total_requests: statement.lines.reduce((s, l) => s + l.totalRequests, 0),
      differences: statement.differences.length,
    }),
  );
  return out;
}

function failure(error: unknown): BillingStatementError {
  return error instanceof BillingStatementError
    ? error
    : new BillingStatementError(
        'BILLING_DATABASE_FAILURE',
        'billing database operation failed',
      );
}

async function closed<T>(
  repository: BillingStatementRepositoryPort,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } finally {
    await repository.close?.().catch(() => undefined);
  }
}

/** `billing:statement` (ADR-0097). A closed month is compared, never rewritten. */
export async function runBillingStatementCommand(
  input: BillingStatementCliInput,
): Promise<BillingStatement> {
  const emit = input.emit ?? console.log;
  try {
    const month = parseBillingMonth(input.month);
    const repository = await openRepository(
      input.databaseUrl,
      input.repository,
    );
    const statement = await closed(repository, () =>
      new BillingStatementService(repository).statement({
        month,
        ...(input.organizationId === undefined
          ? {}
          : { organizationId: input.organizationId }),
        ...(input.closeAs === undefined ? {} : { closeAs: input.closeAs }),
        now: input.now?.() ?? new Date(),
      }),
    );
    for (const line of formatBillingStatement(statement)) {
      emit(line);
    }
    return statement;
  } catch (error) {
    const safe = failure(error);
    emit(
      JSON.stringify({
        event: 'billing_statement_failed',
        month: input.month,
        error_code: safe.code,
      }),
    );
    throw safe;
  }
}

/** `billing:adjust` (ADR-0097). Never edits a usage record. */
export async function runBillingAdjustCommand(
  input: BillingAdjustCliInput,
): Promise<string> {
  const emit = input.emit ?? console.log;
  const id = `badj_${ulid()}`;
  try {
    if (!Object.hasOwn(OPERATION_CATALOG, input.operation)) {
      throw new BillingStatementError(
        'BILLING_INVALID_ADJUSTMENT',
        'unknown operation',
      );
    }
    const month = parseBillingMonth(input.month);
    const repository = await openRepository(
      input.databaseUrl,
      input.repository,
    );
    await closed(repository, () =>
      new BillingStatementService(repository).adjust({
        id,
        organizationId: input.organizationId,
        month,
        operation: input.operation,
        requests: input.requests,
        reason: input.reason,
        corrects: input.corrects,
        actor: input.actor,
      }),
    );
    emit(
      JSON.stringify({
        event: 'billing_adjustment_recorded',
        id,
        month: month.label,
        organization_id: input.organizationId,
        operation: input.operation,
        requests: input.requests,
      }),
    );
    return id;
  } catch (error) {
    const safe = failure(error);
    emit(
      JSON.stringify({
        event: 'billing_adjustment_failed',
        month: input.month,
        organization_id: input.organizationId,
        error_code: safe.code,
      }),
    );
    throw safe;
  }
}
