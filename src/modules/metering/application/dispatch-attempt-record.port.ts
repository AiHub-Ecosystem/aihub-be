import type { OperationId } from '@/catalog/operation-id';

export type DispatchAttemptOutcome =
  | 'response_received'
  | 'not_dispatched'
  | 'outcome_unknown';

export interface DispatchAttemptStart {
  readonly requestId: string;
  readonly organizationId: string;
  readonly operation: OperationId;
  readonly operationTimeoutMs: number;
}

export interface DispatchAttemptRecordPort {
  beginAttempt(input: DispatchAttemptStart): Promise<string>;
  recordOutcome(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void>;
}

export const DISPATCH_ATTEMPT_RECORD = Symbol('DISPATCH_ATTEMPT_RECORD');
