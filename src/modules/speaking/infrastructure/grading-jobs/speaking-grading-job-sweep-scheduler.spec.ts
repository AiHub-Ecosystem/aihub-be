import { SPEAKING_GRADING_JOB_POLICY } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.policy';
import { SpeakingGradingJobSweepScheduler } from './speaking-grading-job-sweep-scheduler';

describe('SpeakingGradingJobSweepScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('staggers its first sweep, re-arms each sweep with a jittered delay, and cancels the timer on shutdown', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75)
      .mockReturnValue(0.5);
    const run = jest.fn(async (_now: Date) => ({
      staleQueuedEnqueued: 0,
      expiredLeasesEnqueued: 0,
      interrupted: 0,
      expired: 0,
      sandboxReservationsReleased: 0,
      quotaReservationsReleased: 0,
      deleted: 0,
      failedSteps: [],
    }));
    const scheduler = new SpeakingGradingJobSweepScheduler(
      { run },
      () => new Date('2026-11-08T01:00:00.000Z'),
      10_000,
    );
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(2_499);
    expect(run).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10_499);
    expect(run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    await scheduler.onApplicationShutdown();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('runs within the policy interval and stops scheduling on shutdown', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const now = new Date('2026-11-08T01:00:00.000Z');
    const run = jest.fn(async (_now: Date) => ({
      staleQueuedEnqueued: 0,
      expiredLeasesEnqueued: 0,
      interrupted: 0,
      expired: 0,
      sandboxReservationsReleased: 0,
      quotaReservationsReleased: 0,
      deleted: 0,
      failedSteps: [],
    }));
    const scheduler = new SpeakingGradingJobSweepScheduler({ run }, () => now);
    scheduler.onModuleInit();

    await jest.advanceTimersByTimeAsync(
      SPEAKING_GRADING_JOB_POLICY.sweepIntervalMs,
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(now);

    await scheduler.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(
      SPEAKING_GRADING_JOB_POLICY.sweepIntervalMs,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits for an active pass before shutdown completes', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    let finishPass: (() => void) | undefined;
    const run = jest.fn(async (_now: Date) => {
      await new Promise<void>((resolve) => {
        finishPass = resolve;
      });
      return {
        staleQueuedEnqueued: 0,
        expiredLeasesEnqueued: 0,
        interrupted: 0,
        expired: 0,
        sandboxReservationsReleased: 0,
        quotaReservationsReleased: 0,
        deleted: 0,
        failedSteps: [],
      };
    });
    const scheduler = new SpeakingGradingJobSweepScheduler(
      { run },
      () => new Date('2026-11-08T01:00:00.000Z'),
    );
    scheduler.onModuleInit();
    await jest.advanceTimersByTimeAsync(
      SPEAKING_GRADING_JOB_POLICY.sweepIntervalMs,
    );

    let shutdownFinished = false;
    const shutdown = scheduler
      .onApplicationShutdown()
      .then(() => (shutdownFinished = true));
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    finishPass?.();
    await shutdown;
    expect(shutdownFinished).toBe(true);
  });
});
