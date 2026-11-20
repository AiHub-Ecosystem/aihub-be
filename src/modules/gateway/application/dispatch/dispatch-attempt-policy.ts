import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { recordDownstreamRetryEvent } from '@/common/observability/metrics';
import type { DownstreamRetryBudgetPort } from './downstream-retry-budget.port';
import type { DispatchResult, ResponseFor } from './operation-dispatcher.port';
import type { TransportCall } from './operation-transport.port';

export type AttemptSend<O extends OperationId> = (
  call: TransportCall,
) => Promise<DispatchResult<ResponseFor<O>>>;

interface RetryState {
  totalRetries: number;
  connectionRetries: number;
  retriedAfter: boolean;
  firstAttemptCounted: boolean;
}

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
  reason: 'connection' | 'retry_after',
  retryNumber: number,
  random: () => number,
  error: unknown,
): number {
  if (
    reason === 'retry_after' &&
    error instanceof AppError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }
  return random() * Math.min(2_000, 200 * 2 ** (retryNumber - 1));
}

/**
 * The application-side attempt policy: one deadline value in, one HTTP call
 * per `send`. The transport decides nothing about retries, backoff, the retry
 * budget, or how much of the deadline is left.
 */
export class DispatchAttemptPolicy {
  constructor(
    private readonly budget: DownstreamRetryBudgetPort | undefined,
    private readonly isUndelivered: (error: unknown) => boolean,
    private readonly random: () => number = Math.random,
    private readonly now: () => number = () => performance.now(),
    private readonly wait: (
      delayMs: number,
      signal: AbortSignal,
    ) => Promise<boolean> = waitForRetry,
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
      this.isUndelivered(error) && state.connectionRetries < 2;
    const retryAfterFailure =
      !state.retriedAfter &&
      error instanceof AppError &&
      error.downstreamStatus === 503 &&
      error.retryAfterMs !== undefined;
    if (
      !retryEnabled ||
      budget === undefined ||
      (!connectionFailure && !retryAfterFailure)
    ) {
      return false;
    }
    if (!state.firstAttemptCounted) {
      recordDownstreamRetryEvent(operation, 'budget_unavailable');
      return false;
    }

    const reason = connectionFailure ? 'connection' : 'retry_after';
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

    const decision = await budget
      .reserveRetry(operation, requestId, retryNumber)
      .catch(() => 'unavailable' as const);
    if (decision !== 'admitted') {
      recordDownstreamRetryEvent(
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
    else state.retriedAfter = true;
    recordDownstreamRetryEvent(operation, reason);
    return true;
  }
}
