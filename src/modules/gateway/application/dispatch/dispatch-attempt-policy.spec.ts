import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { DispatchAttemptPolicy } from './dispatch-attempt-policy';
import type { DownstreamRetryEventReason } from './dispatch-observer.port';
import type {
  DownstreamRetryBudgetDecision,
  DownstreamRetryBudgetPort,
} from './downstream-retry-budget.port';
import type { DispatchResult, ResponseFor } from './operation-dispatcher.port';
import type { TransportCall } from './operation-transport.port';

const OPERATION = 'writing.task1.grade' as const;
const READ_OPERATION = 'speaking.v2.response-get' as const;
const REQUEST_ID = 'req_01J8QK3M7XW2P5NRTVA9BCDEFG';

function call(
  deadlineMs = 5_000,
  signal = new AbortController().signal,
): TransportCall {
  return {
    deadlineMs,
    signal,
    onResponseReceived: () => undefined,
  };
}

function succeededRead(): DispatchResult<ResponseFor<typeof READ_OPERATION>> {
  return {
    operation: READ_OPERATION,
    data: {} as ResponseFor<typeof READ_OPERATION>,
    downstreamMs: 1,
  };
}

function succeeded(): DispatchResult<ResponseFor<typeof OPERATION>> {
  return {
    operation: OPERATION,
    data: {} as ResponseFor<typeof OPERATION>,
    downstreamMs: 1,
  };
}

function admittedSend(next: TransportCall): Promise<void> {
  return next.onAttemptAdmitted?.() ?? Promise.resolve();
}

function budget(
  options: {
    readonly decision?: 'admitted' | 'exhausted' | 'unavailable';
    readonly expectedAttemptMs?: number;
    readonly firstAttempt?: boolean;
    readonly reserveRetry?: () => Promise<DownstreamRetryBudgetDecision>;
  } = {},
) {
  const reserveRetry = jest.fn(
    options.reserveRetry ?? (async () => options.decision ?? 'admitted'),
  );
  const recordFirstAttempt = jest.fn(async () => options.firstAttempt ?? true);
  const port: DownstreamRetryBudgetPort = {
    isEnabled: () => true,
    expectedAttemptMs: () => options.expectedAttemptMs ?? 100,
    recordFirstAttempt,
    reserveRetry,
  };
  return { port, recordFirstAttempt, reserveRetry };
}

function policy(
  retryBudget: DownstreamRetryBudgetPort,
  options: {
    readonly isRetryablePreSendConnectionFailure?: (error: unknown) => boolean;
    readonly random?: () => number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
    readonly retryAfter503Safe?: (operation: OperationId) => boolean;
    readonly observeRetryEvent?: (
      operation: OperationId,
      reason: DownstreamRetryEventReason,
    ) => void;
  } = {},
): DispatchAttemptPolicy {
  return new DispatchAttemptPolicy(
    retryBudget,
    options.isRetryablePreSendConnectionFailure ?? (() => false),
    options.observeRetryEvent,
    options.random ?? (() => 0),
    options.now ?? (() => 0),
    options.wait ?? (async () => true),
    options.retryAfter503Safe,
  );
}

describe('DispatchAttemptPolicy', () => {
  it('retries an undelivered failure with a deadline computed from one value', async () => {
    const retryBudget = budget();
    const sent: TransportCall[] = [];
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      sent.push(next);
      if (sent.length === 1) throw new Error('connection dropped');
      return succeeded();
    });

    const result = await policy(retryBudget.port, {
      isRetryablePreSendConnectionFailure: () => true,
    }).execute(OPERATION, REQUEST_ID, call(), send);

    expect(result).toEqual(succeeded());
    expect(send).toHaveBeenCalledTimes(2);
    expect(retryBudget.reserveRetry).toHaveBeenCalledWith(
      OPERATION,
      REQUEST_ID,
      1,
    );
    expect(sent[1]?.deadlineMs).toBeLessThanOrEqual(sent[0]?.deadlineMs ?? 0);
  });

  it('stops after an exhausted retry budget', async () => {
    const retryBudget = budget({ decision: 'exhausted' });
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw new Error('connection dropped');
    });

    await expect(
      policy(retryBudget.port, {
        isRetryablePreSendConnectionFailure: () => true,
      }).execute(OPERATION, REQUEST_ID, call(), send),
    ).rejects.toThrow('connection dropped');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not wait when the backoff and attempt cannot fit the deadline', async () => {
    const retryBudget = budget();
    const wait = jest.fn(async () => true);
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw new Error('connection dropped');
    });

    await expect(
      policy(retryBudget.port, {
        isRetryablePreSendConnectionFailure: () => true,
        random: () => 0.5,
        wait,
      }).execute(OPERATION, REQUEST_ID, call(150), send),
    ).rejects.toThrow('connection dropped');

    expect(wait).not.toHaveBeenCalled();
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });

  it('keeps a 503 retry disabled until its operation has a safe-replay contract', async () => {
    const retryBudget = budget();
    const wait = jest.fn(async () => true);
    const throttled = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'downstream error',
      retryable: true,
      downstreamStatus: 503,
      retryAfterMs: 300,
    });
    let attempts = 0;
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      attempts += 1;
      if (attempts === 1) throw throttled;
      return succeeded();
    });

    await expect(
      policy(retryBudget.port, { wait }).execute(
        OPERATION,
        REQUEST_ID,
        call(),
        send,
      ),
    ).rejects.toBe(throttled);

    expect(wait).not.toHaveBeenCalled();
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits Retry-After plus bounded jitter for an explicitly safe 503 replay', async () => {
    const retryBudget = budget();
    const wait = jest.fn(async () => true);
    const observeRetryEvent = jest.fn();
    const throttled = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'downstream error',
      retryable: true,
      downstreamStatus: 503,
      retryAfterMs: 300,
    });
    let attempts = 0;
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      if (++attempts === 1) throw throttled;
      return succeeded();
    });

    await policy(retryBudget.port, {
      retryAfter503Safe: () => true,
      random: () => 0.5,
      wait,
      observeRetryEvent,
    }).execute(OPERATION, REQUEST_ID, call(), send);

    expect(wait).toHaveBeenCalledWith(315, expect.any(AbortSignal));
    expect(send).toHaveBeenCalledTimes(2);
    expect(observeRetryEvent).toHaveBeenCalledWith(OPERATION, 'retry_after');
  });

  it.each([500, 502])(
    'retries one %i response for a catalogued GET',
    async (status) => {
      const retryBudget = budget();
      const observeRetryEvent = jest.fn();
      let attempts = 0;
      const send = jest.fn(async (next: TransportCall) => {
        await admittedSend(next);
        if (++attempts === 1) {
          throw new AppError({
            code: 'AI_SERVICE_ERROR',
            message: 'downstream error',
            retryable: true,
            downstreamStatus: status,
          });
        }
        return succeededRead();
      });

      await policy(retryBudget.port, {
        random: () => 0.5,
        observeRetryEvent,
      }).execute(READ_OPERATION, REQUEST_ID, call(), send);

      expect(send).toHaveBeenCalledTimes(2);
      expect(observeRetryEvent).toHaveBeenCalledWith(
        READ_OPERATION,
        'server_error',
      );
    },
  );

  it.each([400, 500, 502])('does not retry POST status %i', async (status) => {
    const retryBudget = budget();
    const failure = new AppError({
      code: 'AI_SERVICE_ERROR',
      message: 'downstream error',
      retryable: true,
      downstreamStatus: status,
    });
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw failure;
    });

    await expect(
      policy(retryBudget.port).execute(OPERATION, REQUEST_ID, call(), send),
    ).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });

  it('stops waiting on retry-budget reservation when the request is aborted', async () => {
    let signalReservationStarted!: () => void;
    let finishReservation!: (decision: DownstreamRetryBudgetDecision) => void;
    let reservationCount = 0;
    const started = new Promise<void>((resolve) => {
      signalReservationStarted = resolve;
    });
    const retryBudget = budget({
      reserveRetry: () => {
        reservationCount += 1;
        signalReservationStarted();
        return new Promise((resolve) => {
          finishReservation = resolve;
        });
      },
    });
    const controller = new AbortController();
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw new Error('connection refused');
    });
    const pending = policy(retryBudget.port, {
      isRetryablePreSendConnectionFailure: () => true,
    }).execute(OPERATION, REQUEST_ID, call(5_000, controller.signal), send);

    await started;
    controller.abort();
    await expect(pending).rejects.toThrow('connection refused');
    finishReservation('admitted');

    expect(send).toHaveBeenCalledTimes(1);
    expect(reservationCount).toBe(1);
  });

  it('does not reserve a retry when the first attempt was not counted', async () => {
    const retryBudget = budget({ firstAttempt: false });
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw new Error('connection dropped');
    });

    await expect(
      policy(retryBudget.port, {
        isRetryablePreSendConnectionFailure: () => true,
      }).execute(OPERATION, REQUEST_ID, call(), send),
    ).rejects.toThrow('connection dropped');

    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });

  it('does not record a first attempt the transport never admitted', async () => {
    const retryBudget = budget();
    const send = jest.fn(async () => {
      throw new Error('breaker refused');
    });

    await expect(
      policy(retryBudget.port, {
        isRetryablePreSendConnectionFailure: () => true,
      }).execute(OPERATION, REQUEST_ID, call(), send),
    ).rejects.toThrow('breaker refused');

    expect(retryBudget.recordFirstAttempt).not.toHaveBeenCalled();
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });
});
