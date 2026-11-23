import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { DownstreamRetryEventReason } from './dispatch-observer.port';
import type {
  DownstreamRetryBudgetDecision,
  DownstreamRetryBudgetPort,
} from './downstream-retry-budget.port';
import type { DispatchResult, ResponseFor } from './operation-dispatcher.port';
import type { TransportCall } from './operation-transport.port';

export type AttemptSend<O extends OperationId> = (
  call: TransportCall,
) => Promise<DispatchResult<ResponseFor<O>>>;

interface RetryState {
  totalRetries: number;
  connectionRetries: number;
  retriedAfter: boolean;
  serverErrorRetries: number;
  firstAttemptCounted: boolean;
}

type RetryReason = 'connection' | 'retry_after' | 'server_error';

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(completed);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function retryDelayMs(
  reason: RetryReason,
  retryNumber: number,
  random: () => number,
  error: unknown,
): number {
  if (
    reason === 'retry_after' &&
    error instanceof AppError &&
    error.retryAfterMs !== undefined
  ) {
    return (
      error.retryAfterMs + random() * Math.min(1_000, error.retryAfterMs * 0.1)
    );
  }
  return random() * Math.min(2_000, 200 * 2 ** (retryNumber - 1));
}

function reserveRetryBeforeAbort(
  budget: DownstreamRetryBudgetPort,
  operation: OperationId,
  requestId: string,
  retryNumber: number,
  signal: AbortSignal,
): Promise<DownstreamRetryBudgetDecision | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      decision: DownstreamRetryBudgetDecision | undefined,
    ): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(decision);
    };
    const onAbort = (): void => finish(undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    // Redis cannot cancel an admitted reservation; an abort stops this wait and
    // the next send, while a command already in flight may still spend a token.
    void Promise.resolve()
      .then(() =>
        signal.aborted
          ? undefined
          : budget.reserveRetry(operation, requestId, retryNumber),
      )
      .then(finish, () => finish('unavailable'));
  });
}

/**
 * The application-side attempt policy: one deadline value in, one HTTP call
 * per `send`. The transport decides nothing about retries, backoff, the retry
 * budget, or how much of the deadline is left.
 */
export class DispatchAttemptPolicy {
  constructor(
    private readonly budget: DownstreamRetryBudgetPort | undefined,
    private readonly isRetryablePreSendConnectionFailure: (
      error: unknown,
    ) => boolean,
    private readonly observeRetryEvent: (
      operation: OperationId,
      reason: DownstreamRetryEventReason,
    ) => void = () => undefined,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (
      delayMs: number,
      signal: AbortSignal,
    ) => Promise<boolean> = waitForRetry,
    private readonly retryAfter503Safe: (operation: OperationId) => boolean = (
      operation,
    ) => {
      const definition = OPERATION_CATALOG[operation];
      return (
        'retryAfter503Safe' in definition &&
        definition.retryAfter503Safe === true
      );
    },
  ) {}

  async execute<O extends OperationId>(
    operation: O,
    requestId: string,
    call: TransportCall,
    send: AttemptSend<O>,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const deadlineAt = this.now() + call.deadlineMs;
    const retryEnabled = this.budget?.isEnabled(operation) ?? false;
    const state: RetryState = {
      totalRetries: 0,
      connectionRetries: 0,
      retriedAfter: false,
      serverErrorRetries: 0,
      firstAttemptCounted: false,
    };

    const onAttemptAdmitted = async (): Promise<void> => {
      if (
        !retryEnabled ||
        this.budget === undefined ||
        state.firstAttemptCounted
      ) {
        return;
      }
      state.firstAttemptCounted = await this.budget
        .recordFirstAttempt(operation, requestId)
        .catch(() => false);
    };

    while (true) {
      const remainingMs = Math.max(1, Math.floor(deadlineAt - this.now()));
      try {
        return await send({
          ...call,
          deadlineMs: remainingMs,
          onAttemptAdmitted,
        });
      } catch (error) {
        if (
          !(await this.scheduleRetry(
            error,
            operation,
            requestId,
            call,
            deadlineAt,
            retryEnabled,
            state,
          ))
        ) {
          throw error;
        }
      }
    }
  }

  private async scheduleRetry(
    error: unknown,
    operation: OperationId,
    requestId: string,
    call: TransportCall,
    deadlineAt: number,
    retryEnabled: boolean,
    state: RetryState,
  ): Promise<boolean> {
    const budget = this.budget;
    const connectionFailure =
      this.isRetryablePreSendConnectionFailure(error) &&
      state.connectionRetries < 2;
    const retryAfterFailure =
      !state.retriedAfter &&
      this.retryAfter503Safe(operation) &&
      error instanceof AppError &&
      error.downstreamStatus === 503 &&
      error.retryAfterMs !== undefined;
    const serverErrorFailure =
      state.serverErrorRetries < 1 &&
      OPERATION_CATALOG[operation].method === 'GET' &&
      error instanceof AppError &&
      (error.downstreamStatus === 500 || error.downstreamStatus === 502);
    if (
      !retryEnabled ||
      budget === undefined ||
      (!connectionFailure && !retryAfterFailure && !serverErrorFailure)
    ) {
      return false;
    }
    if (!state.firstAttemptCounted) {
      this.observeRetryEvent(operation, 'budget_unavailable');
      return false;
    }

    const reason: RetryReason = connectionFailure
      ? 'connection'
      : retryAfterFailure
        ? 'retry_after'
        : 'server_error';
    const retryNumber = state.totalRetries + 1;
    const delayMs = retryDelayMs(reason, retryNumber, this.random, error);
    const expectedAttemptMs = budget.expectedAttemptMs(operation);
    if (
      expectedAttemptMs === undefined ||
      delayMs + expectedAttemptMs >= deadlineAt - this.now() ||
      call.signal.aborted
    ) {
      return false;
    }

    const decision = await reserveRetryBeforeAbort(
      budget,
      operation,
      requestId,
      retryNumber,
      call.signal,
    );
    if (decision === undefined) return false;
    if (decision !== 'admitted') {
      this.observeRetryEvent(
        operation,
        decision === 'exhausted' ? 'budget_exhausted' : 'budget_unavailable',
      );
      return false;
    }
    if (
      delayMs + expectedAttemptMs >= deadlineAt - this.now() ||
      call.signal.aborted ||
      !(await this.wait(delayMs, call.signal)) ||
      call.signal.aborted ||
      expectedAttemptMs >= deadlineAt - this.now()
    ) {
      return false;
    }

    state.totalRetries += 1;
    if (connectionFailure) state.connectionRetries += 1;
    else if (retryAfterFailure) state.retriedAfter = true;
    else state.serverErrorRetries += 1;
    this.observeRetryEvent(operation, reason);
    return true;
  }
}
