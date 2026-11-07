import { billBackgroundCompletion } from './background-completion-billing';
import type { MeteringEvidence } from './metering-evidence';
import type { MeteringFinalizeInput } from './metering-finalizer.port';

function evidence(overrides: Partial<MeteringEvidence> = {}): MeteringEvidence {
  return {
    operation: 'writing.task2.grade',
    organizationId: 'org_acme',
    apiKeyId: 'ak_backend',
    environment: 'production',
    actorId: 'student_1',
    quotaTracked: true,
    settled: true,
    ...overrides,
  };
}

function setup(withEvidence = true) {
  const finalized: MeteringFinalizeInput[] = [];
  const inner = {
    started: jest.fn(),
    settled: jest.fn(),
    completed: jest.fn(),
  };
  const lifecycle = billBackgroundCompletion({
    requestId: 'req_late',
    receivedAt: new Date(1_000),
    evidence: withEvidence ? evidence() : undefined,
    finalizer: {
      finalize: async (input) => {
        finalized.push(input);
      },
    },
    inner,
    now: () => 66_000,
  });
  return { finalized, inner, lifecycle };
}

describe('billBackgroundCompletion', () => {
  it('writes one billable record for the completed grading under its own id', async () => {
    const { finalized, lifecycle } = setup();

    await lifecycle?.completed?.();

    expect(finalized).toEqual([
      expect.objectContaining({
        requestId: 'req_late:background',
        organizationId: 'org_acme',
        apiKeyId: 'ak_backend',
        actorId: 'student_1',
        operation: 'writing.task2.grade',
        environment: 'production',
        outcome: 'success',
        httpStatus: 200,
        totalMs: 65_000,
        quotaTracked: true,
        billingBasis: 'background_completion',
      }),
    ]);
    expect(finalized[0]?.idempotentReplay).toBeUndefined();
  });

  it('writes nothing until the work completes, and keeps the permit lifecycle', async () => {
    const { finalized, inner, lifecycle } = setup();

    lifecycle?.started();
    await lifecycle?.settled();

    expect(finalized).toEqual([]);
    expect(inner.started).toHaveBeenCalledTimes(1);
    expect(inner.settled).toHaveBeenCalledTimes(1);
  });

  it('notifies completion only after background permit settlement', async () => {
    const onCompletionSettled = jest.fn();
    let permitSettled = false;
    const settledLifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(1_000),
      evidence: evidence(),
      finalizer: { finalize: async () => undefined },
      inner: {
        started: () => undefined,
        settled: async () => {
          permitSettled = true;
        },
      },
      onCompletionSettled: () => {
        expect(permitSettled).toBe(true);
        onCompletionSettled();
      },
    });

    await settledLifecycle?.settled();
    expect(onCompletionSettled).toHaveBeenCalledTimes(1);
  });

  it('does not record completion when background permit settlement fails', async () => {
    const onCompletionSettled = jest.fn();
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(1_000),
      evidence: evidence(),
      finalizer: { finalize: async () => undefined },
      inner: {
        started: () => undefined,
        settled: async () => {
          throw new Error('redis timeout');
        },
      },
      onCompletionSettled,
    });

    await expect(lifecycle?.settled()).rejects.toThrow('redis timeout');
    expect(onCompletionSettled).not.toHaveBeenCalled();
  });

  it('leaves the lifecycle untouched for a request with no Metering evidence', () => {
    const { inner, lifecycle } = setup(false);

    expect(lifecycle).toBe(inner);
  });

  it('bills exactly once when the inner completion throws', async () => {
    const finalized: MeteringFinalizeInput[] = [];
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(0),
      evidence: evidence(),
      finalizer: {
        finalize: async (input) => {
          finalized.push(input);
        },
      },
      inner: {
        started: () => undefined,
        settled: async () => undefined,
        completed: async () => {
          throw new Error('inner down');
        },
      },
    });

    await lifecycle?.completed?.();

    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.requestId).toBe('req_late:background');
  });

  it('bills exactly once when the inner completion stalls', async () => {
    const finalized: MeteringFinalizeInput[] = [];
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(0),
      evidence: evidence(),
      finalizer: {
        finalize: async (input) => {
          finalized.push(input);
        },
      },
      inner: {
        started: () => undefined,
        settled: async () => undefined,
        completed: () => new Promise<void>(() => undefined),
      },
      innerCompletedTimeoutMs: 20,
    });

    await expect(lifecycle?.completed?.()).resolves.toBeUndefined();
    expect(finalized).toHaveLength(1);
  });

  it('surfaces a failed billing write and leaves the evidence unsettled for recovery', async () => {
    const ev = evidence({ settled: true });
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(0),
      evidence: ev,
      finalizer: { finalize: () => Promise.reject(new Error('db down')) },
    });

    await expect(lifecycle?.completed?.()).rejects.toThrow('db down');
    expect(ev.settled).toBe(false);
  });

  it('still runs the inner completion when the billing write fails', async () => {
    const innerCompleted = jest.fn();
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(0),
      evidence: evidence(),
      finalizer: { finalize: () => Promise.reject(new Error('db down')) },
      inner: {
        started: () => undefined,
        settled: async () => undefined,
        completed: async () => {
          innerCompleted();
        },
      },
    });

    await expect(lifecycle?.completed?.()).rejects.toThrow('db down');
    expect(innerCompleted).toHaveBeenCalledTimes(1);
  });

  it('marks evidence settled once the billing write succeeds', async () => {
    const ev = evidence({ settled: false });
    const lifecycle = billBackgroundCompletion({
      requestId: 'req_late',
      receivedAt: new Date(0),
      evidence: ev,
      finalizer: { finalize: async () => undefined },
    });

    await lifecycle?.completed?.();
    expect(ev.settled).toBe(true);
  });
});
