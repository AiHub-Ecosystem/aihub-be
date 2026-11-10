import type { PublicApiMajorUsageFlusher } from '@/modules/metering/application/billing/public-api-major-usage-flusher';
import { PublicApiMajorUsageScheduler } from './public-api-major-usage.scheduler';

describe('PublicApiMajorUsageScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('staggers its first flush, re-arms each flush with a jittered delay, and flushes once more on shutdown with no timer left', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.1)
      .mockReturnValueOnce(0)
      .mockReturnValue(0.5);
    const flush = jest.fn(async () => undefined);
    const finish = jest.fn(async () => undefined);
    const scheduler = new PublicApiMajorUsageScheduler(
      { flush, finish } as unknown as PublicApiMajorUsageFlusher,
      true,
      10_000,
    );
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(999);
    expect(flush).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(8_999);
    expect(flush).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(flush).toHaveBeenCalledTimes(2);

    await scheduler.beforeApplicationShutdown();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
