import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';

import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
} from './graded-admission.port';
import { quotaExceededError } from './quota-period';

/**
 * The operations whose same-key repeats count against the Organization retry
 * budget. A graded operation that takes an Idempotency-Key must be listed here
 * (a spec compares this with the catalog), or its repeats would escape the
 * budget.
 */
export const RETRY_BUDGET_OPERATIONS = [
  'writing.task1.grade',
  'writing.task2.grade',
] as const satisfies readonly OperationId[];

/** The key the retry budget counts, or `undefined` when the operation has none. */
export function retryBudgetKeyFor(
  operation: OperationId,
  idempotencyKey: string | undefined,
): string | undefined {
  return (RETRY_BUDGET_OPERATIONS as readonly OperationId[]).includes(operation)
    ? idempotencyKey
    : undefined;
}

export interface AdmitGradedRequestInput {
  readonly apiKeyId: string;
  readonly rateLimitRpm: number;
  readonly organizationId: string;
  readonly requestId: string;
  readonly operation: OperationId;
  /** The caller's resolved Idempotency-Key, if any and valid. */
  readonly idempotencyKey?: string;
  readonly environment: 'production' | 'sandbox';
  readonly monthlyRequestQuota: number | null;
  readonly hardStopOnQuota: boolean;
}

/**
 * Graded admission: one decision that applies the API key's rate limit, then
 * the Organization retry budget, then the monthly quota, in the order ADR-0057
 * declares. It returns the decision rather than throwing, so the caller decides
 * what a refusal means; `gradedAdmissionRefusal` is the public answer.
 */
export function admitGradedRequest(
  port: GradedAdmissionPort,
  input: AdmitGradedRequestInput,
): Promise<GradedAdmissionDecision> {
  const idempotencyKey = retryBudgetKeyFor(
    input.operation,
    input.idempotencyKey,
  );
  return port.consume({
    apiKeyId: input.apiKeyId,
    rateLimitRpm: input.rateLimitRpm,
    organizationId: input.organizationId,
    requestId: input.requestId,
    operation: input.operation,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    // A sandbox key has no monthly quota (ADR-0056).
    monthlyRequestQuota:
      input.environment === 'sandbox' ? null : input.monthlyRequestQuota,
    hardStopOnQuota: input.hardStopOnQuota,
  });
}

/**
 * The one mapping from a refusal stage to its public error; `undefined` when
 * the request was admitted.
 */
export function gradedAdmissionRefusal(
  decision: GradedAdmissionDecision,
  organizationId: string,
  now: () => Date,
): AppError | undefined {
  switch (decision.stage) {
    case 'admitted':
      return undefined;
    case 'rate_limit':
      return new AppError({
        code: 'RATE_LIMITED',
        message: 'Rate limit exceeded',
        retryable: true,
        retryAfterMs: decision.retryAfterMs,
      });
    case 'retry_budget':
      return new AppError({
        code: 'RATE_LIMITED',
        message: 'Organization retry budget exceeded',
        retryable: true,
        retryAfterMs: decision.retryAfterMs,
      });
    case 'quota':
      return quotaExceededError(now(), organizationId);
  }
}
