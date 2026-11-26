import { runIdempotencyCleanupCommand } from './idempotency-cleanup';

describe('runIdempotencyCleanupCommand', () => {
  it('rejects a blank database URL before any cleanup', async () => {
    const cleanup = jest.fn(async () => 0);
    const emit = jest.fn();

    await expect(
      runIdempotencyCleanupCommand({
        databaseUrl: '  ',
        cleanup,
        emit,
      }),
    ).rejects.toThrow('DATABASE_URL is required');

    expect(cleanup).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('cleans at the maintenance cutoff and reports the stable result', async () => {
    const cutoff = new Date('2026-11-01T00:00:00.000Z');
    const cleanup = jest.fn(async () => 4);
    const emit = jest.fn();

    const deleted = await runIdempotencyCleanupCommand({
      databaseUrl: 'postgres://unused',
      now: cutoff,
      cutoffSource: 'database',
      cleanup,
      emit,
    });

    expect(deleted).toBe(4);
    expect(cleanup).toHaveBeenCalledWith(cutoff);
    expect(emit).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'idempotency_cleanup_completed',
        cutoff: cutoff.toISOString(),
        cutoff_source: 'database',
        deleted: 4,
      }),
    );
  });

  it('reports a process clock by default', async () => {
    const now = new Date('2026-11-02T00:00:00.000Z');
    const emit = jest.fn();

    await runIdempotencyCleanupCommand({
      databaseUrl: 'postgres://unused',
      now,
      cleanup: async () => 0,
      emit,
    });

    expect(emit).toHaveBeenCalledWith(
      expect.stringContaining('"cutoff_source":"process"'),
    );
  });
});
