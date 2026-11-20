import { AppError } from '@/common/errors/app-error';
import { DispatchAttemptPolicy } from './dispatch-attempt-policy';
import type { DownstreamRetryBudgetPort } from './downstream-retry-budget.port';
import type { DispatchResult, ResponseFor } from './operation-dispatcher.port';
import type { TransportCall } from './operation-transport.port';

const OPERATION = 'writing.task1.grade' as const;
const REQUEST_ID = 'req_01J8QK3M7XW2P5NRTVA9BCDEFG';

function call(deadlineMs = 5_000): TransportCall {
  return {
    deadlineMs,
    signal: new AbortController().signal,
    onResponseReceived: () => undefined,
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
  } = {},
) {
  const reserveRetry = jest.fn(async () => options.decision ?? 'admitted');
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
    readonly isUndelivered?: (error: unknown) => boolean;
    readonly random?: () => number;
    readonly now?: () => number;
    readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<boolean>;
  } = {},
): DispatchAttemptPolicy {
  return new DispatchAttemptPolicy(
    retryBudget,
    options.isUndelivered ?? (() => false),
    options.random ?? (() => 0),
    options.now ?? (() => 0),
    options.wait ?? (async () => true),
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
      isUndelivered: () => true,
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
      policy(retryBudget.port, { isUndelivered: () => true }).execute(
        OPERATION,
        REQUEST_ID,
        call(),
        send,
      ),
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
        isUndelivered: () => true,
        random: () => 0.5,
        wait,
      }).execute(OPERATION, REQUEST_ID, call(150), send),
    ).rejects.toThrow('connection dropped');

    expect(wait).not.toHaveBeenCalled();
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });

  it('waits for the downstream Retry-After hint before replaying a 503', async () => {
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

    await policy(retryBudget.port, { wait }).execute(
      OPERATION,
      REQUEST_ID,
      call(),
      send,
    );

    expect(wait).toHaveBeenCalledWith(300, expect.any(AbortSignal));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not reserve a retry when the first attempt was not counted', async () => {
    const retryBudget = budget({ firstAttempt: false });
    const send = jest.fn(async (next: TransportCall) => {
      await admittedSend(next);
      throw new Error('connection dropped');
    });

    await expect(
      policy(retryBudget.port, { isUndelivered: () => true }).execute(
        OPERATION,
        REQUEST_ID,
        call(),
        send,
      ),
    ).rejects.toThrow('connection dropped');

    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });

  it('does not record a first attempt the transport never admitted', async () => {
    const retryBudget = budget();
    const send = jest.fn(async () => {
      throw new Error('breaker refused');
    });

    await expect(
      policy(retryBudget.port, { isUndelivered: () => true }).execute(
        OPERATION,
        REQUEST_ID,
        call(),
        send,
      ),
    ).rejects.toThrow('breaker refused');

    expect(retryBudget.recordFirstAttempt).not.toHaveBeenCalled();
    expect(retryBudget.reserveRetry).not.toHaveBeenCalled();
  });
});
