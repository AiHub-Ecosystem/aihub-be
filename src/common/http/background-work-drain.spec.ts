import {
  backgroundWorkSettled,
  backgroundWorkStarted,
  waitForBackgroundWork,
} from './background-work-drain';

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
});
