import type {
  UsageRetentionBatch,
  UsageRetentionPort,
} from '@/modules/metering/application/usage-retention';
import { formatUsageRetentionEvent, runUsagePruneCommand } from './usage-prune';

class FakeUsageRetentionPort implements UsageRetentionPort {
  constructor(
    private readonly batch: UsageRetentionBatch = { deleted: 0 },
    private readonly closeError?: Error,
  ) {}

  async pruneBatch(): Promise<UsageRetentionBatch> {
    return this.batch;
  }

  async pruneDispatchAttempts(): Promise<number> {
    return 0;
  }

  async close(): Promise<void> {
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

describe('formatUsageRetentionEvent', () => {
  it('formats completion as stable JSONL without sensitive fields', () => {
    expect(
      formatUsageRetentionEvent({
        type: 'completed',
        startedAt: new Date('2026-09-19T02:30:00.000Z'),
        completedAt: new Date('2026-09-19T02:30:04.000Z'),
        cutoff: new Date('2025-08-19T02:30:00.000Z'),
        batchSize: 1000,
        batches: 2,
        deleted: 1234,
        dispatchAttemptsDeleted: 567,
        status: 'completed',
      }),
    ).toBe(
      JSON.stringify({
        event: 'usage_prune_completed',
        completed_at: '2026-09-19T02:30:04.000Z',
        cutoff: '2025-08-19T02:30:00.000Z',
        batch_size: 1000,
        batches: 2,
        deleted: 1234,
        dispatch_attempts_deleted: 567,
        status: 'completed',
      }),
    );
  });

  it('formats a configuration failure with a safe code and null cutoff', () => {
    expect(
      formatUsageRetentionEvent({
        type: 'failed',
        startedAt: new Date('2026-09-19T02:30:00.000Z'),
        failedAt: new Date('2026-09-19T02:30:00.001Z'),
        cutoff: null,
        batchSize: 1000,
        batches: 0,
        deleted: 0,
        dispatchAttemptsDeleted: 0,
        status: 'failed',
        errorCode: 'CONFIGURATION_MISSING',
      }),
    ).toBe(
      JSON.stringify({
        event: 'usage_prune_failed',
        failed_at: '2026-09-19T02:30:00.001Z',
        cutoff: null,
        batch_size: 1000,
        batches: 0,
        deleted: 0,
        dispatch_attempts_deleted: 0,
        status: 'failed',
        error_code: 'CONFIGURATION_MISSING',
      }),
    );
  });
});

describe('runUsagePruneCommand', () => {
  it('emits a completion event with a fresh end timestamp', async () => {
    const lines: string[] = [];
    const start = new Date('2026-09-19T02:30:00.000Z');
    const end = new Date('2026-09-19T02:30:04.000Z');
    const clock = jest
      .fn<Date, []>()
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(end);

    await expect(
      runUsagePruneCommand({
        databaseUrl: 'postgres://test',
        repository: new FakeUsageRetentionPort(),
        clock,
        emit: (line) => lines.push(line),
      }),
    ).resolves.toMatchObject({ batches: 0, deleted: 0 });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'usage_prune_started',
        started_at: start.toISOString(),
        cutoff: '2025-08-19T02:30:00.000Z',
        batch_size: 1000,
      },
      {
        event: 'usage_prune_completed',
        completed_at: end.toISOString(),
        cutoff: '2025-08-19T02:30:00.000Z',
        batch_size: 1000,
        batches: 0,
        deleted: 0,
        dispatch_attempts_deleted: 0,
        status: 'completed',
      },
    ]);
  });

  it('reports a safe failure when closing the database fails', async () => {
    const lines: string[] = [];
    const start = new Date('2026-09-19T02:30:00.000Z');
    const failure = new Date('2026-09-19T02:30:04.000Z');
    const clock = jest
      .fn<Date, []>()
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(new Date('2026-09-19T02:30:04.000Z'))
      .mockReturnValueOnce(failure);

    await expect(
      runUsagePruneCommand({
        databaseUrl: 'postgres://test',
        repository: new FakeUsageRetentionPort(
          { deleted: 0 },
          new Error('raw pool shutdown detail'),
        ),
        clock,
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_FAILURE' });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        event: 'usage_prune_started',
        started_at: start.toISOString(),
        cutoff: '2025-08-19T02:30:00.000Z',
        batch_size: 1000,
      },
      {
        event: 'usage_prune_failed',
        failed_at: failure.toISOString(),
        cutoff: '2025-08-19T02:30:00.000Z',
        batch_size: 1000,
        batches: 0,
        deleted: 0,
        dispatch_attempts_deleted: 0,
        status: 'failed',
        error_code: 'DATABASE_FAILURE',
      },
    ]);
    expect(lines.join('\n')).not.toContain('raw pool shutdown detail');
  });

  it('reports missing configuration before opening Postgres', async () => {
    const lines: string[] = [];

    await expect(
      runUsagePruneCommand({
        databaseUrl: ' ',
        now: new Date('2026-09-19T02:30:00.000Z'),
        emit: (line) => lines.push(line),
      }),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_MISSING' });

    expect(lines).toEqual([
      JSON.stringify({
        event: 'usage_prune_failed',
        failed_at: '2026-09-19T02:30:00.000Z',
        cutoff: null,
        batch_size: 1000,
        batches: 0,
        deleted: 0,
        dispatch_attempts_deleted: 0,
        status: 'failed',
        error_code: 'CONFIGURATION_MISSING',
      }),
    ]);
  });
});
