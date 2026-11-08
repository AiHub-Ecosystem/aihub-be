import { SPEAKING_GRADING_JOB_POLICY } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.policy';
import { SpeakingGradingJobSweepScheduler } from './speaking-grading-job-sweep-scheduler';

describe('SpeakingGradingJobSweepScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs at the policy interval and stops scheduling on shutdown', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-11-08T01:00:00.000Z');
    const run = jest.fn(async (_now: Date) => ({
      staleQueuedEnqueued: 0,
      expiredLeasesEnqueued: 0,
      interrupted: 0,
      expired: 0,
      sandboxReservationsReleased: 0,
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
