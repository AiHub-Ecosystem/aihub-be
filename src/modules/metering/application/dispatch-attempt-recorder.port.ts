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

export interface RecordDispatchAttemptPort {
  beginAttempt(input: DispatchAttemptStart): Promise<string>;
  recordOutcome(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void>;
}

export const METERING_DISPATCH_ATTEMPT_RECORDER = Symbol(
  'METERING_DISPATCH_ATTEMPT_RECORDER',
);
