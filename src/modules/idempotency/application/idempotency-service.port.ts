import type { IdempotencyOperation } from './idempotency-operation';
import type { CompletedIdempotencyReplay } from './idempotency-repository.port';

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

export type CompletedReplayLookupInput = Pick<
  IdempotencyExecutionInput,
  | 'organizationId'
  | 'operation'
  | 'actorId'
  | 'scope'
  | 'idempotencyKey'
  | 'requestBody'
> & { readonly idempotencyKey: string };

export interface IdempotencyBackgroundLifecycle {
  started(): void;
  settled(): void | Promise<void>;
  /**
   * The work that outlived its response finished and its result is stored, so
   * a replay will now deliver it. Called at most once and awaited before
   * `settled`, so a shutdown drain also waits for what it does.
   */
  completed?(): void | Promise<void>;
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
  findCompletedReplay?(
    input: CompletedReplayLookupInput,
  ): Promise<CompletedIdempotencyReplay | undefined>;
  execute<T>(
    input: IdempotencyExecutionInput,
    work: IdempotencyWork<T>,
    decodeReplay: IdempotencyReplayDecoder<T>,
  ): Promise<IdempotencyExecution<T>>;
}

export const IDEMPOTENCY_SERVICE = Symbol('IDEMPOTENCY_SERVICE');
