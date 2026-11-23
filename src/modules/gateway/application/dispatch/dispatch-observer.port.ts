import type { OperationId } from '@/catalog/operation-id';

export type DownstreamRetryEventReason =
  | 'connection'
  | 'retry_after'
  | 'server_error'
  | 'budget_exhausted'
  | 'budget_unavailable';

/** What the dispatch policy reports about the deadline; metrics implement it. */
export interface DispatchObserverPort {
  deadlineMsRemaining(operation: OperationId, remainingMs: number): void;
  cancelledByDeadline(operation: OperationId): void;
  downstreamRetryEvent(
    operation: OperationId,
    reason: DownstreamRetryEventReason,
  ): void;
}
