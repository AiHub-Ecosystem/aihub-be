import type { IdempotencyOperation } from '@/modules/idempotency/public/idempotency-operation';

export interface OrganizationRetryBudgetRequest {
  readonly organizationId: string;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export type OrganizationRetryBudgetDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs: number };

export interface OrganizationRetryBudgetPort {
  consume(
    request: OrganizationRetryBudgetRequest,
  ): Promise<OrganizationRetryBudgetDecision>;
}

export const ORGANIZATION_RETRY_BUDGET = Symbol('ORGANIZATION_RETRY_BUDGET');
