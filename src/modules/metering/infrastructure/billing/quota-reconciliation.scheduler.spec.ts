import type { QuotaReconciliationService } from '@/modules/metering/public/quota-reconciliation';
import {
  QuotaReconciliationScheduler,
  nextQuotaReconciliationDelay,
} from './quota-reconciliation.scheduler';

describe('QuotaReconciliationScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('keeps each pass on its interval boundary plus a random stagger, and cancels the timer on shutdown', async () => {
    jest.useFakeTimers({ now: new Date('2026-09-16T12:03:00.000Z') });
    jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.2)
      .mockReturnValue(0);
    const reconcile = jest.fn(async () => undefined);
    const scheduler = new QuotaReconciliationScheduler(
      { reconcile } as unknown as QuotaReconciliationService,
      5 * 60 * 1000,
      0,
      0,
      true,
    );
    scheduler.onModuleInit();

    // Boundary 12:05:00, plus 15s (half of a 30s stagger window).
    await jest.advanceTimersByTimeAsync(2 * 60 * 1000 + 14_999);
    expect(reconcile).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    // Boundary 12:10:00, plus 6s.
    await jest.advanceTimersByTimeAsync(4 * 60 * 1000 + 50_999);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(reconcile).toHaveBeenCalledTimes(2);

    await scheduler.beforeApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('quota reconciliation schedule', () => {
  const intervalMs = 5 * 60 * 1000;

  it('aligns its first run to an interval boundary from the UTC quota-period start', () => {
    expect(
      nextQuotaReconciliationDelay(
        new Date('2026-09-16T12:03:00.000Z'),
        intervalMs,
      ),
    ).toBe(2 * 60 * 1000);
  });

  it('waits a full interval at a boundary instead of replaying a missed run', () => {
    expect(
      nextQuotaReconciliationDelay(
        new Date('2026-09-01T00:10:00.000Z'),
        intervalMs,
      ),
    ).toBe(intervalMs);
  });
});
