import {
  type UsageRetentionBatch,
  type UsageRetentionBatchRequest,
  type UsageRetentionCursor,
  type UsageRetentionPort,
  UsageRetentionService,
  calculateUsageRetentionCutoff,
} from './usage-retention';

class FakeUsageRetentionPort implements UsageRetentionPort {
  readonly requests: UsageRetentionBatchRequest[] = [];
  batches: UsageRetentionBatch[] = [];
  dispatchAttemptBatches: number[] = [];

  async pruneBatch(
    request: UsageRetentionBatchRequest,
  ): Promise<UsageRetentionBatch> {
    this.requests.push(request);
    return this.batches.shift() ?? { deleted: 0 };
  }

  async pruneDispatchAttempts(): Promise<number> {
    return this.dispatchAttemptBatches.shift() ?? 0;
  }
}

class InMemoryUsageRetentionPort implements UsageRetentionPort {
  constructor(readonly rows: UsageRetentionCursor[]) {}

  async pruneBatch(
    request: UsageRetentionBatchRequest,
  ): Promise<UsageRetentionBatch> {
    const candidates = this.rows
      .filter((row) => row.createdAt < request.cutoff)
      .filter(
        (row) =>
          request.after === undefined ||
          row.createdAt > request.after.createdAt ||
          (row.createdAt.getTime() === request.after.createdAt.getTime() &&
            row.requestId > request.after.requestId),
      )
      .sort((left, right) => {
        const timeDifference =
          left.createdAt.getTime() - right.createdAt.getTime();
        return timeDifference === 0
          ? left.requestId.localeCompare(right.requestId)
          : timeDifference;
      })
      .slice(0, request.batchSize);

    for (const candidate of candidates) {
      const index = this.rows.indexOf(candidate);
      if (index >= 0) {
        this.rows.splice(index, 1);
      }
    }

    const nextCursor = candidates.at(-1);
    return nextCursor === undefined
      ? { deleted: 0 }
      : { deleted: candidates.length, nextCursor };
  }

  async pruneDispatchAttempts(): Promise<number> {
    return 0;
  }
}

describe('UsageRetentionService', () => {
  it('captures a clamped UTC cutoff and completes after bounded batches', async () => {
    const port = new FakeUsageRetentionPort();
    port.batches = [
      {
        deleted: 2,
        nextCursor: {
          createdAt: new Date('2025-02-28T02:29:59.000Z'),
          requestId: 'req_oldest',
        },
      },
      {
        deleted: 1,
        nextCursor: {
          createdAt: new Date('2025-02-28T02:30:00.000Z'),
          requestId: 'req_newer',
        },
      },
      { deleted: 0 },
    ];
    const events: unknown[] = [];
    const service = new UsageRetentionService(
      port,
      () => new Date('2026-03-31T02:30:00.000Z'),
    );

    await expect(service.prune((event) => events.push(event))).resolves.toEqual(
      {
        cutoff: new Date('2025-02-28T02:30:00.000Z'),
        batches: 2,
        deleted: 3,
        dispatchAttemptsDeleted: 0,
      },
    );
    expect(port.requests).toEqual([
      {
        cutoff: new Date('2025-02-28T02:30:00.000Z'),
        batchSize: 1000,
      },
      {
        cutoff: new Date('2025-02-28T02:30:00.000Z'),
        batchSize: 1000,
        after: {
          createdAt: new Date('2025-02-28T02:29:59.000Z'),
          requestId: 'req_oldest',
        },
      },
      {
        cutoff: new Date('2025-02-28T02:30:00.000Z'),
        batchSize: 1000,
        after: {
          createdAt: new Date('2025-02-28T02:30:00.000Z'),
          requestId: 'req_newer',
        },
      },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'started',
      batchSize: 1000,
      cutoff: new Date('2025-02-28T02:30:00.000Z'),
    });
    expect(events[1]).toMatchObject({
      type: 'completed',
      batches: 2,
      deleted: 3,
      status: 'completed',
    });
  });

  it('clamps calendar subtraction at the target month end', () => {
    expect(
      calculateUsageRetentionCutoff(new Date('2024-03-31T02:30:00.000Z')),
    ).toEqual(new Date('2023-02-28T02:30:00.000Z'));
    expect(
      calculateUsageRetentionCutoff(new Date('2024-02-29T02:30:00.000Z')),
    ).toEqual(new Date('2023-01-29T02:30:00.000Z'));
  });

  it('succeeds as a no-op when no rows are eligible', async () => {
    const port = new FakeUsageRetentionPort();
    const events: unknown[] = [];

    await expect(
      new UsageRetentionService(
        port,
        () => new Date('2026-09-19T02:30:00.000Z'),
      ).prune((event) => events.push(event)),
    ).resolves.toMatchObject({ batches: 0, deleted: 0 });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      batches: 0,
      deleted: 0,
      status: 'completed',
    });
  });

  it('prunes expired dispatch attempts in bounded batches even without usage rows', async () => {
    const port = new FakeUsageRetentionPort();
    port.dispatchAttemptBatches = [1000, 2, 0];

    await expect(
      new UsageRetentionService(
        port,
        () => new Date('2026-09-19T02:30:00.000Z'),
      ).prune(),
    ).resolves.toMatchObject({
      batches: 0,
      deleted: 0,
      dispatchAttemptsDeleted: 1002,
    });
  });

  it('retains cutoff and future rows and makes reruns idempotent', async () => {
    const cutoff = new Date('2025-08-19T02:30:00.000Z');
    const port = new InMemoryUsageRetentionPort([
      {
        createdAt: new Date('2025-08-19T02:29:59.999Z'),
        requestId: 'req_expired',
      },
      { createdAt: cutoff, requestId: 'req_exact' },
      {
        createdAt: new Date('2026-09-19T02:30:00.000Z'),
        requestId: 'req_future',
      },
    ]);
    const service = new UsageRetentionService(
      port,
      () => new Date('2026-09-19T02:30:00.000Z'),
    );

    await expect(service.prune()).resolves.toMatchObject({
      batches: 1,
      deleted: 1,
    });
    await expect(service.prune()).resolves.toMatchObject({
      batches: 0,
      deleted: 0,
    });
    expect(port.rows).toEqual([
      { createdAt: cutoff, requestId: 'req_exact' },
      {
        createdAt: new Date('2026-09-19T02:30:00.000Z'),
        requestId: 'req_future',
      },
    ]);
  });

  it('reports committed progress when a later batch fails', async () => {
    const port = new FakeUsageRetentionPort();
    port.batches = [
      {
        deleted: 1000,
        nextCursor: {
          createdAt: new Date('2025-08-18T02:29:59.000Z'),
          requestId: 'req_1000',
        },
      },
    ];
    let calls = 0;
    const originalPruneBatch = port.pruneBatch.bind(port);
    port.pruneBatch = async (request) => {
      calls += 1;
      if (calls === 2) {
        throw new Error('database unavailable');
      }
      return originalPruneBatch(request);
    };
    const events: unknown[] = [];

    await expect(
      new UsageRetentionService(
        port,
        () => new Date('2026-09-19T02:30:00.000Z'),
      ).prune((event) => events.push(event)),
    ).rejects.toMatchObject({
      code: 'DATABASE_FAILURE',
    });
    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      batches: 1,
      deleted: 1000,
      dispatchAttemptsDeleted: 0,
      status: 'failed',
      errorCode: 'DATABASE_FAILURE',
    });
  });
});
