import type { OperationId } from '../../../catalog/operation-id';

export interface IdempotencyExecutionInput {
  readonly organizationId: string;
  readonly operation: OperationId;
  readonly idempotencyKey?: string;
  readonly actorId: string;
  readonly requestBody: unknown;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;
  readonly backgroundLifecycle?: IdempotencyBackgroundLifecycle;
}

export interface IdempotencyBackgroundLifecycle {
  started(): void;
  settled(): void;
}

export interface IdempotencyWorkContext {
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;
}

export interface IdempotencyExecution<T> {
  readonly result: T;
  readonly replay: boolean;
}

export type IdempotencyWork<T> = (
  context: IdempotencyWorkContext,
) => Promise<T>;

export type IdempotencyReplayDecoder<T> = (value: unknown) => T;

export interface IdempotencyServicePort {
  execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>>;
}

export const IDEMPOTENCY_SERVICE = Symbol('IDEMPOTENCY_SERVICE');
