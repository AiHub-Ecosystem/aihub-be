import { withApp } from './test-support';

describe('EmailOutboxPollerScheduler during shutdown', () => {
  it('lets the pass in flight finish before the connections it uses close', async () => {
    await withApp(async ({ app, poller, prune, events }) => {
      await Promise.all([poller.started, prune.started]);

      const closing = app.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['prune-started', 'pass-started']);

      prune.finish();
      poller.finish();
      await closing;

      expect(events).toEqual([
        'prune-started',
        'pass-started',
        'prune-finished',
        'pass-finished',
        'redis-closed',
      ]);
    });
  });
});
