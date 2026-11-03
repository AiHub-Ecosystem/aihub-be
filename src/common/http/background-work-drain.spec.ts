import {
  backgroundWorkSettled,
  backgroundWorkStarted,
} from '@/common/background-work-tracker';
import { waitForBackgroundWork } from './background-work-drain';
import { backgroundDrainMs, largestRequestTimeoutMs } from './shutdown-budget';

describe('background work drain', () => {
  it('waits for all tracked work to settle', async () => {
    backgroundWorkStarted();
    backgroundWorkStarted();

    let drained = false;
    const drain = waitForBackgroundWork().then(() => {
      drained = true;
      return undefined;
    });

    backgroundWorkSettled();
    await Promise.resolve();
    expect(drained).toBe(false);

    backgroundWorkSettled();
    await drain;
    expect(drained).toBe(true);
  });

  it('gives up exactly at the budget derived from the largest request timeout', async () => {
    const budgetMs = backgroundDrainMs(largestRequestTimeoutMs());
    jest.useFakeTimers();
    try {
      backgroundWorkStarted();
      const drain = waitForBackgroundWork().catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(budgetMs - 1);
      let settledEarly = false;
      void drain.then(() => {
        settledEarly = true;
        return undefined;
      });
      await Promise.resolve();
      expect(settledEarly).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      expect(await drain).toEqual(
        new Error('Background work did not drain before shutdown deadline'),
      );
    } finally {
      jest.useRealTimers();
      backgroundWorkSettled();
    }
  });
});
