import { withApp } from '../../../../../../test/support/auth/scheduler-shutdown-test-support';

describe('EmailOutboxPollerScheduler during shutdown', () => {
  it('starts no prune after shutdown has already begun', async () => {
    await withApp(
      async ({ poller, prune }) => {
        await new Promise((resolve) => setTimeout(resolve, 30)); // real-timer-ok: startup is observed through several production polling intervals

        expect(prune.runs).toBe(0);
        expect(poller.passes).toBe(0);
      },
      false,
      true,
    );
  });
});
