import type {
  UsageRetentionBatch,
  UsageRetentionPort,
} from '@/modules/metering/application/usage-retention';
import type { WritingChartRevocationAuditRepositoryPort } from '@/modules/writing/application/writing-chart-revocation.port';
import { effectiveMaintenanceTime } from '../../scripts/cli/operator-safety.cjs';
import { formatUsageRetentionEvent, runUsagePruneCommand } from './usage-prune';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonLine(line: string): Record<string, unknown> {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new Error('usage prune output is not a JSON object');
  }
  return value;
}

class FakeUsageRetentionPort implements UsageRetentionPort {
  readonly pruneCalls: string[] = [];
  readonly previewCounts = { usageRecords: 4, dispatchAttempts: 2 };
  constructor(
    private readonly batch: UsageRetentionBatch = { deleted: 0 },
    private readonly closeError?: Error,
  ) {}

  async pruneBatch(): Promise<UsageRetentionBatch> {
    this.pruneCalls.push('usage');
    return this.batch;
  }

  async pruneDispatchAttempts(): Promise<number> {
    this.pruneCalls.push('dispatch_attempts');
    return 0;
  }

  async previewPrune() {
    return this.previewCounts;
  }

  async close(): Promise<void> {
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

class ClockAwareUsageRetentionPort implements UsageRetentionPort {
  readonly rows = [
    {
      createdAt: new Date('2025-09-30T23:59:59.000Z'),
      requestId: 'req_expired',
    },
    {
      createdAt: new Date('2025-10-15T00:00:00.000Z'),
      requestId: 'req_retained',
    },
  ];

  async pruneBatch(request: { cutoff: Date; batchSize: number }) {
    const eligible = this.rows.filter((row) => row.createdAt < request.cutoff);
    for (const row of eligible) this.rows.splice(this.rows.indexOf(row), 1);
    const last = eligible.at(-1);
    return last === undefined
      ? { deleted: 0 }
      : {
          deleted: eligible.length,
          nextCursor: { createdAt: last.createdAt, requestId: last.requestId },
        };
  }

  async pruneDispatchAttempts() {
    return 0;
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
  it('does not delete evidence newer than the database-clock cutoff when process time is ahead', async () => {
    const processNow = new Date('2026-12-01T00:00:00.000Z');
    const databaseNow = new Date('2026-11-01T00:00:00.000Z');
    const maintenanceClock = effectiveMaintenanceTime(processNow, databaseNow);
    const repository = new ClockAwareUsageRetentionPort();
    const lines: string[] = [];

    await runUsagePruneCommand({
      databaseUrl: 'postgres://test',
      repository,
      clock: () => maintenanceClock.now,
      cutoffSource: maintenanceClock.source,
      emit: (line) => lines.push(line),
    });

    expect(repository.rows).toEqual([
      {
        createdAt: new Date('2025-10-15T00:00:00.000Z'),
        requestId: 'req_retained',
      },
    ]);
    expect(lines.map(parseJsonLine).at(-1)).toMatchObject({
      event: 'usage_prune_completed',
      cutoff: '2025-10-01T00:00:00.000Z',
      cutoff_source: 'database',
      deleted: 1,
    });
  });

  it('previews both age-based deletes without executing either delete', async () => {
    const lines: string[] = [];
    const repository = new FakeUsageRetentionPort();
    const pruneExpired = jest.fn();
    const auditRepository: WritingChartRevocationAuditRepositoryPort = {
      findActiveOperatorAccount: jest.fn(),
      requestRevocation: jest.fn(),
      append: jest.fn(),
      pruneExpired,
      countExpired: jest.fn().mockResolvedValue(3),
    };

    await runUsagePruneCommand({
      databaseUrl: 'postgres://test',
      repository,
      writingChartAuditRepository: auditRepository,
      dryRun: true,
      now: new Date('2026-10-19T02:30:00.000Z'),
      cutoffSource: 'database',
      emit: (line) => lines.push(line),
    });

    expect(repository.pruneCalls).toEqual([]);
    expect(pruneExpired).not.toHaveBeenCalled();
    expect(lines.map(parseJsonLine)).toEqual([
      {
        event: 'usage_prune_preview',
        cutoff: '2025-09-19T02:30:00.000Z',
        cutoff_source: 'database',
        would_delete: { usage_records: 4, dispatch_attempts: 2 },
        status: 'preview',
      },
      {
        event: 'writing_chart_revocation_audit_prune_preview',
        cutoff: '2024-10-19T02:30:00.000Z',
        cutoff_source: 'database',
        would_delete: 3,
        status: 'preview',
      },
    ]);
  });

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

    expect(lines.map(parseJsonLine)).toEqual([
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

    expect(lines.map(parseJsonLine)).toEqual([
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

  it('runs the Writing chart audit retention step inside usage:prune', async () => {
    const lines: string[] = [];
    const auditRepository = {
      findActiveOperatorAccount: jest.fn(),
      requestRevocation: jest.fn(),
      append: jest.fn(),
      pruneExpired: jest
        .fn<Promise<number>, [Date, number]>()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0),
      countExpired: jest.fn().mockResolvedValue(0),
      close: jest.fn().mockResolvedValue(undefined),
    };

    await runUsagePruneCommand({
      databaseUrl: 'postgres://test',
      repository: new FakeUsageRetentionPort(),
      writingChartAuditRepository: auditRepository,
      now: new Date('2026-10-19T02:30:00.000Z'),
      emit: (line) => lines.push(line),
    });

    expect(auditRepository.pruneExpired).toHaveBeenNthCalledWith(
      1,
      new Date('2024-10-19T02:30:00.000Z'),
      1_000,
    );
    expect(auditRepository.pruneExpired).toHaveBeenNthCalledWith(
      2,
      new Date('2024-10-19T02:30:00.000Z'),
      1_000,
    );
    expect(
      lines
        .map(parseJsonLine)
        .find(
          (event) =>
            event.event === 'writing_chart_revocation_audit_prune_completed',
        ),
    ).toMatchObject({ deleted: 1, status: 'completed' });
    expect(auditRepository.close).toHaveBeenCalledTimes(1);
  });
});
