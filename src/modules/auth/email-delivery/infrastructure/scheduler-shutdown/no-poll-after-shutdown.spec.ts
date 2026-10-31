import { withApp } from './test-support';

describe('EmailOutboxPollerScheduler during shutdown', () => {
  it('starts no new pass once shutdown has begun, however many intervals pass', async () => {
    await withApp(async ({ poller, beginShutdown }) => {
      await poller.started;
      beginShutdown();
      const before = poller.passes;

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(poller.passes).toBe(before);
    }, false);
  });
});
