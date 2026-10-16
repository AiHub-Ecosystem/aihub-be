import type { OperationId } from '@/catalog/operation-id';

/** What the dispatch policy reports about the deadline; metrics implement it. */
export interface DispatchObserverPort {
  deadlineMsRemaining(operation: OperationId, remainingMs: number): void;
  cancelledByDeadline(operation: OperationId): void;
}
