import type { OperationId } from '@/catalog/operation-id';
import type { AppError } from '@/common/errors/app-error';

import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
  GradedAdmissionRefusal,
} from './graded-admission.port';
import { quotaExceededError } from './quota-period';
import { rateLimitedError } from './rate-limited-error';

/**
 * How long a same-key repeat is refused for: one window of first attempts. The
 * graded admission script counts first attempts and admitted repeats over the
 * same window.
 */
export const RETRY_BUDGET_WINDOW_MS = 60_000;

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

/** What graded admission applies to one request, before it asks the port. */
export interface GradedAdmissionPolicy {
  /** The key the retry budget counts, or `undefined` when the operation has none. */
  readonly retryBudgetKey: string | undefined;
  readonly retryBudget: 'none' | 'keyed_writing';
  /** The monthly quota that is checked; `null` when none applies. */
  readonly quota: number | null;
  /** Whether the request counts against a monthly quota. */
  readonly quotaTracked: boolean;
}

/**
 * The one place that decides which of the retry budget and the monthly quota
 * apply to a request: a sandbox key has no quota (ADR-0056), and only the
 * operations in `RETRY_BUDGET_OPERATIONS` count same-key repeats.
 */
export function gradedAdmissionPolicy(
  input: Pick<
    AdmitGradedRequestInput,
    'operation' | 'idempotencyKey' | 'environment' | 'monthlyRequestQuota'
  >,
): GradedAdmissionPolicy {
  const retryBudgetKey = (
    RETRY_BUDGET_OPERATIONS as readonly OperationId[]
  ).includes(input.operation)
    ? input.idempotencyKey
    : undefined;
  const quota =
    input.environment === 'sandbox' ? null : input.monthlyRequestQuota;
  return {
    retryBudgetKey,
    retryBudget: retryBudgetKey === undefined ? 'none' : 'keyed_writing',
    quota,
    quotaTracked: quota !== null,
  };
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
  const policy = gradedAdmissionPolicy(input);
  return port.consume({
    apiKeyId: input.apiKeyId,
    rateLimitRpm: input.rateLimitRpm,
    organizationId: input.organizationId,
    requestId: input.requestId,
    operation: input.operation,
    ...(policy.retryBudgetKey === undefined
      ? {}
      : { idempotencyKey: policy.retryBudgetKey }),
    monthlyRequestQuota: policy.quota,
    hardStopOnQuota: input.hardStopOnQuota,
  });
}

/** The one mapping from a refusal stage to its public error. */
export function gradedAdmissionRefusal(
  decision: GradedAdmissionRefusal,
  organizationId: string,
  now: () => Date,
): AppError {
  switch (decision.stage) {
    case 'rate_limit':
      return rateLimitedError(decision.retryAfterMs);
    case 'retry_budget':
      return rateLimitedError(
        decision.retryAfterMs,
        'Organization retry budget exceeded',
      );
    case 'quota':
      return quotaExceededError(now(), organizationId);
  }
}
