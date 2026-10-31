import type { OnModuleDestroy } from '@nestjs/common';
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

export class HeldPoller {
  passes = 0;
  private release: (() => void) | undefined;
  private markStarted: () => void = () => undefined;
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

export class FakeRedis implements OnModuleDestroy {
  constructor(private readonly events: string[]) {}

  onModuleDestroy(): void {
    this.events.push('redis-closed');
  }
}

export class HeldPrune {
  runs = 0;
  private release: (() => void) | undefined;
  private markStarted: () => void = () => undefined;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  constructor(
    private readonly events: string[],
    private readonly hold = true,
  ) {}

  async prune(): Promise<number> {
    this.runs += 1;
    this.events.push('prune-started');
    this.markStarted();
    if (this.hold) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    this.events.push('prune-finished');
    return 0;
  }

  finish(): void {
    this.release?.();
  }
}

interface AppContext {
  app: NestFastifyApplication;
  poller: HeldPoller;
  prune: HeldPrune;
  events: string[];
  beginShutdown: () => void;
}

export async function withApp(
  run: (context: AppContext) => Promise<void>,
  hold = true,
  shutdownBeforeInit = false,
): Promise<void> {
  const { GracefulFastifyAdapter } = await import(
    '@/common/http/graceful-fastify-adapter'
  );
  const { beginShutdown } = await import('@/common/http/background-work-drain');
  const { EmailOutboxPollerScheduler } = await import(
    '@/modules/auth/email-delivery/infrastructure/email-outbox-poller.scheduler'
  );
  const events: string[] = [];
  const poller = new HeldPoller(events, hold);
  const prune = new HeldPrune(events, hold);
  if (shutdownBeforeInit) {
    beginShutdown();
  }
  const moduleRef = await Test.createTestingModule({
    providers: [
      {
        provide: EmailOutboxPollerScheduler,
        useFactory: () =>
          new EmailOutboxPollerScheduler({
            poller: poller as unknown as EmailDeliveryPoller,
            intervalMs: INTERVAL_MS,
            pruneExpiredRecipientLimits: () => prune.prune(),
          }),
      },
      { provide: FakeRedis, useFactory: () => new FakeRedis(events) },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new GracefulFastifyAdapter(),
  );
  await app.init();
  try {
    await run({ app, poller, prune, events, beginShutdown });
  } finally {
    await app.close().catch(() => undefined);
  }
}
