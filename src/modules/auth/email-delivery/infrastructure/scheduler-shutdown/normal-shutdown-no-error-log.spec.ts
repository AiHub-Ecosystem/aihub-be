import { Logger } from '@nestjs/common';

import { withApp } from './test-support';

describe('EmailOutboxPollerScheduler during normal shutdown', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs no failed pass', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await withApp(async ({ app, poller, prune }) => {
      await poller.started;
      const closing = app.close();
      prune.finish();
      poller.finish();
      await closing;
    });

    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('email outbox pass failed'),
    );
  });
});
