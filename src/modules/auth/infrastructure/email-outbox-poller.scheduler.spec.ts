import { getMetrics } from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/application/email-delivery-poller';

import {
  EmailOutboxPollerScheduler,
  emailOutboxLeaseOwner,
  reportTerminalEmailDeliveryFailure,
} from './email-outbox-poller.scheduler';

/** Short enough to keep the suite fast, long enough to order deterministically. */
const INTERVAL_MS = 5;

class ControllablePoller {
  calls = 0;
  private release: (() => void) | undefined;

  constructor(private readonly holdOpen = false) {}

  async runOnce(): Promise<{
    claimed: number;
    providerAccepted: number;
    cancelled: number;
    failed: number;
  }> {
    this.calls += 1;
    if (this.holdOpen) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return {
      claimed: 1,
      providerAccepted: 1,
      cancelled: 0,
      failed: 0,
    };
  }

  finish(): void {
    this.release?.();
  }
}

function scheduler(
  poller: ControllablePoller,
  intervalMs = INTERVAL_MS,
): EmailOutboxPollerScheduler {
  return new EmailOutboxPollerScheduler(
    poller as unknown as EmailDeliveryPoller,
    intervalMs,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EmailOutboxPollerScheduler', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const subjects: EmailOutboxPollerScheduler[] = [];

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    for (const subject of subjects.splice(0)) {
      subject.onApplicationShutdown();
    }
  });

  function start(
    poller: ControllablePoller,
    nodeEnv: string,
  ): EmailOutboxPollerScheduler {
    process.env.NODE_ENV = nodeEnv;
    const subject = scheduler(poller);
    subjects.push(subject);
    subject.onModuleInit();
    return subject;
  }

  it('does not start a poller under test', async () => {
    const poller = new ControllablePoller();

    start(poller, 'test');
    await delay(INTERVAL_MS * 4);

    expect(poller.calls).toBe(0);
  });

  it('polls on its interval outside test', async () => {
    const poller = new ControllablePoller();

    start(poller, 'production');
    await delay(INTERVAL_MS * 3);

    expect(poller.calls).toBeGreaterThanOrEqual(1);
  });

  it('skips a tick while the previous pass is still running', async () => {
    const poller = new ControllablePoller(true);

    start(poller, 'production');
    await delay(INTERVAL_MS * 4);
    expect(poller.calls).toBe(1);

    poller.finish();
    await delay(INTERVAL_MS * 4);
    expect(poller.calls).toBeGreaterThan(1);
  });

  it('stops polling after shutdown', async () => {
    const poller = new ControllablePoller();
    const subject = start(poller, 'production');
    await delay(INTERVAL_MS * 3);
    poller.finish();
    const beforeShutdown = poller.calls;

    subject.onApplicationShutdown();
    await delay(INTERVAL_MS * 4);

    expect(poller.calls).toBe(beforeShutdown);
  });
});

describe('reportTerminalEmailDeliveryFailure', () => {
  it('counts the failure under its email kind', async () => {
    reportTerminalEmailDeliveryFailure({
      id: 'edr_01J00000000000000000000000',
      kind: 'organization_invite_email',
      errorCode: 'timeout',
    });

    expect(await getMetrics()).toContain(
      'aihub_email_delivery_failed_total{kind="organization_invite_email"} 1',
    );
  });

  it('names the request and its bounded codes, and nothing else', async () => {
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });

    reportTerminalEmailDeliveryFailure({
      id: 'edr_01J00000000000000000000000',
      kind: 'verification_email',
      errorCode: 'provider_rejected',
    });
    spy.mockRestore();

    const line = written.join('');
    expect(line).toContain('edr_01J00000000000000000000000');
    expect(line).toContain('verification_email');
    expect(line).toContain('provider_rejected');
    expect(line).not.toContain('@');
  });
});

describe('emailOutboxLeaseOwner', () => {
  it('names an owner the lease column accepts, and differs per instance', () => {
    expect(emailOutboxLeaseOwner()).toMatch(
      /^outbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(emailOutboxLeaseOwner()).not.toBe(emailOutboxLeaseOwner());
  });
});
