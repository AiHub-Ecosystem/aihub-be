import type { OperationId } from '@/catalog/operation-id';

export type DownstreamRetryBudgetDecision =
  | 'admitted'
  | 'exhausted'
  | 'unavailable';

export interface DownstreamRetryBudgetPort {
  isEnabled(operation: OperationId): boolean;
  expectedAttemptMs(operation: OperationId): number | undefined;
  recordFirstAttempt(
    operation: OperationId,
    requestId: string,
  ): Promise<boolean>;
  reserveRetry(
    operation: OperationId,
    requestId: string,
    retryNumber: number,
  ): Promise<DownstreamRetryBudgetDecision>;
}

export const DOWNSTREAM_RETRY_BUDGET = Symbol('DOWNSTREAM_RETRY_BUDGET');
