import { withApp } from './test-support';

describe('EmailOutboxPollerScheduler during startup', () => {
  it('prunes recipient limits on a fresh runtime', async () => {
    await withApp(async ({ prune }) => {
      await prune.started;
      expect(prune.runs).toBe(1);
    }, false);
  });
});
