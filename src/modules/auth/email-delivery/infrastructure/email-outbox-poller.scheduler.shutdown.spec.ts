import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';

import type { EmailDeliveryPoller } from '@/modules/auth/email-delivery/application/email-delivery-poller';

const INTERVAL_MS = 5;

const SUMMARY = {
  claimed: 1,
  providerAccepted: 1,
  cancelled: 0,
  failed: 0,
  deferred: 0,
};

/** A pass that stays in flight until the test lets it finish. */
class HeldPoller {
  passes = 0;
  private release: (() => void) | undefined;
  private markStarted: () => void = () => undefined;
  // Declared after `markStarted`, which it assigns: a field initializer that
  // runs first would be overwritten by the default above.
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  constructor(
    private readonly events: string[],
    private readonly hold = true,
  ) {}

  async runOnce(): Promise<typeof SUMMARY> {
    this.passes += 1;
    this.events.push('pass-started');
    this.markStarted();
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.events.push('pass-finished');
    return SUMMARY;
  }

  finish(): void {
    this.release?.();
  }
}

/** Stands in for the email Redis client: it closes where the real one does. */
class FakeRedis implements OnModuleDestroy {
  constructor(private readonly events: string[]) {}

  onModuleDestroy(): void {
    this.events.push('redis-closed');
  }
}

/** Each case needs a fresh process-wide shutdown flag, so it loads fresh modules. */
async function withApp(
  run: (context: {
    app: NestFastifyApplication;
    poller: HeldPoller;
    events: string[];
    beginShutdown: () => void;
  }) => Promise<void>,
  hold = true,
): Promise<void> {
  await jest.isolateModulesAsync(async () => {
    const { GracefulFastifyAdapter } = await import(
      '@/common/http/graceful-fastify-adapter'
    );
    const { beginShutdown } = await import(
      '@/common/http/background-work-drain'
    );
    const { EmailOutboxPollerScheduler } = await import(
      './email-outbox-poller.scheduler'
    );
    const events: string[] = [];
    const poller = new HeldPoller(events, hold);
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: EmailOutboxPollerScheduler,
          useFactory: () =>
            new EmailOutboxPollerScheduler(
              poller as unknown as EmailDeliveryPoller,
              INTERVAL_MS,
            ),
        },
        { provide: FakeRedis, useFactory: () => new FakeRedis(events) },
      ],
    }).compile();
    const app = moduleRef.createNestApplication<NestFastifyApplication>(
      new GracefulFastifyAdapter(),
    );
    await app.init();
    try {
      await run({ app, poller, events, beginShutdown });
    } finally {
      await app.close().catch(() => undefined);
    }
  });
}

describe('EmailOutboxPollerScheduler during shutdown', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets the pass in flight finish before the connections it uses close', async () => {
    await withApp(async ({ app, poller, events }) => {
      await poller.started;

      const closing = app.close();
      // The pass is still with its provider: the server cannot have finished
      // closing, and Redis must still be open under it.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(['pass-started']);

      poller.finish();
      await closing;

      expect(events).toEqual(['pass-started', 'pass-finished', 'redis-closed']);
    });
  });

  it('starts no new pass once shutdown has begun, however many intervals pass', async () => {
    await withApp(async ({ poller, beginShutdown }) => {
      await poller.started;
      beginShutdown();
      const before = poller.passes;

      // Dozens of intervals elapse with nothing running to block a new pass.
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(poller.passes).toBe(before);
    }, false);
  });

  it('logs no failed pass on a normal shutdown', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    await withApp(async ({ app, poller }) => {
      await poller.started;
      const closing = app.close();
      poller.finish();
      await closing;
    });

    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining('email outbox pass failed'),
    );
  });
});
