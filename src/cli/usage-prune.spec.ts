import { formatUsageRetentionEvent, runUsagePruneCommand } from './usage-prune';

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
        status: 'failed',
        error_code: 'CONFIGURATION_MISSING',
      }),
    );
  });
});

describe('runUsagePruneCommand', () => {
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
        status: 'failed',
        error_code: 'CONFIGURATION_MISSING',
      }),
    ]);
  });
});
