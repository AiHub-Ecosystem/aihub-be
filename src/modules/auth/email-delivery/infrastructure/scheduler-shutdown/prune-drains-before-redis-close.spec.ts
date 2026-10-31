import { withApp } from './test-support';

describe('EmailOutboxPollerScheduler during shutdown', () => {
  it('lets the recipient-counter prune finish before its connection closes', async () => {
    await withApp(async ({ app, poller, prune, events }) => {
      await prune.started;

      const closing = app.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toContain('prune-started');
      expect(events).not.toContain('redis-closed');

      prune.finish();
      poller.finish();
      await closing;

      expect(events[events.indexOf('prune-finished')]).toBeDefined();
      expect(events.indexOf('redis-closed')).toBeGreaterThan(
        events.indexOf('prune-finished'),
      );
    });
  }, 15_000);
});
