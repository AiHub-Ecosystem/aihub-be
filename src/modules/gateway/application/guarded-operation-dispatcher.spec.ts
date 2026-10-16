import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
} from '@/modules/metering/public/dispatch-attempts';
import { GuardedOperationDispatcher } from './guarded-operation-dispatcher';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from './operation-dispatcher.port';
import type {
  OperationTransportPort,
  PreparedDispatch,
  TransportCall,
} from './operation-transport.port';
import { SandboxAdmission } from './sandbox-admission';
import type { SandboxDispatchBudgetPort } from './sandbox-dispatch-budget.port';

const input = {} as RequestFor<'writing.task1.grade'>;
const result = {
  operation: 'writing.task1.grade',
  data: {},
  downstreamMs: 1,
} as DispatchResult<ResponseFor<'writing.task1.grade'>>;

function context(
  options: {
    sandbox?: boolean;
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  return createRequestContext({
    requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
    receivedAt: new Date(),
    deadlineMs: options.deadlineMs ?? 5_000,
    organizationId: 'org_test',
    scopes: [],
    ...(options.sandbox === true ? { environment: 'sandbox' } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

class FakeTransport implements OperationTransportPort {
  readonly calls: TransportCall[] = [];
  undelivered = false;
  behavior: (call: TransportCall) => Promise<typeof result> = async () =>
    result;

  async prepare<O extends OperationId>(): Promise<PreparedDispatch<O>> {
    return {
      send: async (call) => {
        this.calls.push(call);
        // The fake returns one canned result whatever the operation.
        return (await this.behavior(call)) as DispatchResult<ResponseFor<O>>;
      },
    };
  }

  isUndelivered(): boolean {
    return this.undelivered;
  }
}

function fixture(options: { admit?: boolean | Error } = {}) {
  const transport = new FakeTransport();
  const outcomes: DispatchAttemptOutcome[] = [];
  const beginAttempt = jest.fn(async () => 'attempt-1');
  const attempts: DispatchAttemptRecordPort = {
    beginAttempt,
    recordOutcome: jest.fn(async (_id, outcome) => {
      outcomes.push(outcome);
    }),
  };
  const reserve = jest.fn(async () => {
    if (options.admit instanceof Error) {
      throw options.admit;
    }
    return options.admit ?? true;
  });
  const release = jest.fn(async () => undefined);
  const budget = {
    reserve,
    release,
    allowanceFor: jest.fn(),
  } as unknown as SandboxDispatchBudgetPort;
  const warn = jest.fn();
  const deadlineMsRemaining = jest.fn();
  const cancelledByDeadline = jest.fn();
  const dispatcher = new GuardedOperationDispatcher(
    transport,
    attempts,
    new SandboxAdmission(budget, warn),
    { deadlineMsRemaining, cancelledByDeadline },
    warn,
  );
  return {
    dispatcher,
    transport,
    beginAttempt,
    outcomes,
    reserve,
    release,
    warn,
    deadlineMsRemaining,
    cancelledByDeadline,
  };
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected rejection');
}

describe('GuardedOperationDispatcher', () => {
  it('records response_received and returns the transport result', async () => {
    const { dispatcher, outcomes } = fixture();

    await expect(
      dispatcher.dispatch('writing.task1.grade', input, context()),
    ).resolves.toBe(result);
    expect(outcomes).toEqual(['response_received']);
  });

  it('hands the transport the remaining deadline and a signal', async () => {
    const { dispatcher, transport } = fixture();

    await dispatcher.dispatch('writing.task1.grade', input, context());

    const [call] = transport.calls;
    expect(call?.deadlineMs).toBeGreaterThan(0);
    expect(call?.deadlineMs).toBeLessThanOrEqual(5_000);
    expect(call?.signal.aborted).toBe(false);
  });

  it('reports the remaining deadline to the observer before the call', async () => {
    const { dispatcher, deadlineMsRemaining } = fixture();

    await dispatcher.dispatch('writing.task1.grade', input, context());

    expect(deadlineMsRemaining).toHaveBeenCalledWith(
      'writing.task1.grade',
      expect.any(Number),
    );
  });

  it('reports a call cancelled by the deadline to the observer', async () => {
    const { dispatcher, transport, cancelledByDeadline } = fixture();
    transport.behavior = (call) =>
      new Promise((_resolve, reject) => {
        call.signal.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });

    await expect(
      dispatcher.dispatch(
        'writing.task1.grade',
        input,
        context({ deadlineMs: 20 }),
      ),
    ).rejects.toThrow('aborted');

    expect(cancelledByDeadline).toHaveBeenCalledWith('writing.task1.grade');
  });

  describe('outcome classification', () => {
    it('records response_received when a status arrived before the failure', async () => {
      const { dispatcher, transport, outcomes } = fixture();
      transport.behavior = async (call) => {
        call.onResponseReceived(500);
        throw new AppError({
          code: 'AI_SERVICE_ERROR',
          message: 'x',
          retryable: true,
        });
      };

      await rejection(
        dispatcher.dispatch('writing.task1.grade', input, context()),
      );

      expect(outcomes).toEqual(['response_received']);
    });

    it('records outcome_unknown when the call may have left the process', async () => {
      const { dispatcher, transport, outcomes, release } = fixture();
      transport.behavior = async () => {
        throw new Error('socket hang up');
      };

      await expect(
        dispatcher.dispatch('writing.task1.grade', input, context()),
      ).rejects.toThrow('socket hang up');

      expect(outcomes).toEqual(['outcome_unknown']);
      expect(release).not.toHaveBeenCalled();
    });

    it('records not_dispatched and releases a Sandbox reservation when the call never left', async () => {
      const { dispatcher, transport, outcomes, release } = fixture();
      transport.undelivered = true;
      transport.behavior = async () => {
        throw new Error('connection refused');
      };

      await expect(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true }),
        ),
      ).rejects.toThrow('connection refused');

      expect(outcomes).toEqual(['not_dispatched']);
      expect(release).toHaveBeenCalledWith('req_01J8QK3M7XW2P5NRTVA9BCDEFG');
    });

    it('keeps the Sandbox reservation when the outcome is unknown', async () => {
      const { dispatcher, transport, release } = fixture();
      transport.behavior = async () => {
        throw new Error('socket hang up');
      };

      await expect(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true }),
        ),
      ).rejects.toThrow('socket hang up');

      expect(release).not.toHaveBeenCalled();
    });
  });

  describe('Sandbox admission', () => {
    it('refuses with QUOTA_EXCEEDED before any attempt begins', async () => {
      const { dispatcher, beginAttempt, transport } = fixture({ admit: false });

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true }),
        ),
      );

      expect(error.code).toBe('QUOTA_EXCEEDED');
      expect(beginAttempt).not.toHaveBeenCalled();
      expect(transport.calls).toHaveLength(0);
    });

    it('answers a retryable 503-class error when the budget store is unreadable', async () => {
      const { dispatcher, beginAttempt } = fixture({
        admit: new Error('down'),
      });

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true }),
        ),
      );

      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.retryable).toBe(true);
      expect(beginAttempt).not.toHaveBeenCalled();
    });

    it('does not touch the budget for a production request', async () => {
      const { dispatcher, reserve } = fixture();

      await dispatcher.dispatch('writing.task1.grade', input, context());

      expect(reserve).not.toHaveBeenCalled();
    });

    it('releases the reservation when the deadline passes during admission', async () => {
      const { dispatcher, reserve, release, beginAttempt } = fixture();
      const controller = new AbortController();
      reserve.mockImplementationOnce(async () => {
        controller.abort();
        return true;
      });

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true, signal: controller.signal }),
        ),
      );

      expect(error.code).toBe('AI_SERVICE_TIMEOUT');
      expect(release.mock.calls).toEqual([['req_01J8QK3M7XW2P5NRTVA9BCDEFG']]);
      expect(beginAttempt).not.toHaveBeenCalled();
    });

    it('warns and still fails the request when a release fails', async () => {
      const { dispatcher, reserve, release, warn } = fixture();
      const controller = new AbortController();
      reserve.mockImplementationOnce(async () => {
        controller.abort();
        return true;
      });
      release.mockRejectedValueOnce(new Error('db down'));

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true, signal: controller.signal }),
        ),
      );

      expect(error.code).toBe('AI_SERVICE_TIMEOUT');
      expect(warn).toHaveBeenCalledWith(
        'Sandbox dispatch reservation could not be released after a pre-dispatch failure',
      );
    });
  });

  describe('deadline', () => {
    it('times out without reserving or beginning an attempt when already aborted', async () => {
      const { dispatcher, reserve, beginAttempt } = fixture();
      const controller = new AbortController();
      controller.abort();

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ sandbox: true, signal: controller.signal }),
        ),
      );

      expect(error.code).toBe('AI_SERVICE_TIMEOUT');
      expect(reserve).not.toHaveBeenCalled();
      expect(beginAttempt).not.toHaveBeenCalled();
    });

    it('times out before the call when the deadline passes while the attempt begins', async () => {
      const { dispatcher, beginAttempt, transport, outcomes } = fixture();
      const controller = new AbortController();
      beginAttempt.mockImplementationOnce(async () => {
        controller.abort();
        return 'attempt-1';
      });

      const error = await rejection(
        dispatcher.dispatch(
          'writing.task1.grade',
          input,
          context({ signal: controller.signal }),
        ),
      );

      expect(error.code).toBe('AI_SERVICE_TIMEOUT');
      expect(transport.calls).toHaveLength(0);
      expect(outcomes).toEqual(['not_dispatched']);
    });
  });

  it('fails closed when dispatch evidence cannot be opened', async () => {
    const { dispatcher, beginAttempt, transport } = fixture();
    beginAttempt.mockRejectedValueOnce(new Error('db down'));

    const error = await rejection(
      dispatcher.dispatch('writing.task1.grade', input, context()),
    );

    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.retryable).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it('prepares the transport before admitting, so a bad operation never reserves', async () => {
    const { dispatcher, transport, reserve } = fixture();
    transport.prepare = async () => {
      throw new Error('no adapter');
    };

    await expect(
      dispatcher.dispatch(
        'writing.task1.grade',
        input,
        context({ sandbox: true }),
      ),
    ).rejects.toThrow('no adapter');

    expect(reserve).not.toHaveBeenCalled();
  });
});
