import type { IdempotencyOperation } from './idempotency-operation';

export type IdempotencyScope = 'gateway' | 'management';

export interface IdempotencyExecutionInput {
  /** Null for an Account Idempotency Scope, which names no Organization. */
  readonly organizationId: string | null;
  readonly operation: IdempotencyOperation;
  readonly idempotencyKey?: string;
  readonly actorId: string;
  readonly scope?: IdempotencyScope;
  readonly requestBody: unknown;
  readonly requestId: string;
  readonly timeoutMs: number;
  readonly responseStatus?: number;
  readonly beforeReplay?: () => Promise<void>;
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
