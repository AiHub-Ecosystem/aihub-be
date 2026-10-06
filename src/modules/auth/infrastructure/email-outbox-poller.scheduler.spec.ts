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
    deferred: number;
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
      deferred: 0,
    };
  }

  finish(): void {
    this.release?.();
  }
}

function scheduler(
  poller: ControllablePoller,
  intervalMs = INTERVAL_MS,
  enabled = true,
): EmailOutboxPollerScheduler {
  return new EmailOutboxPollerScheduler(
    poller as unknown as EmailDeliveryPoller,
    intervalMs,
    undefined,
    enabled,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EmailOutboxPollerScheduler', () => {
  const subjects: EmailOutboxPollerScheduler[] = [];

  afterEach(() => {
    for (const subject of subjects.splice(0)) {
      subject.onApplicationShutdown();
    }
  });

  function start(
    poller: ControllablePoller,
    nodeEnv: string,
  ): EmailOutboxPollerScheduler {
    const subject = scheduler(poller, INTERVAL_MS, nodeEnv !== 'test');
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
  /**
   * Nest's own framing (timestamp, context, colour codes) is not the payload;
   * what an alert channel forwards is the message after the context tag.
   */
  function payloadOf(written: string): string {
    return (
      written
        .replace(/\[\d+m/g, '')
        .split('[EmailOutboxDispatch] ')[1]
        ?.trim() ?? ''
    );
  }

  async function emit(
    failure: Parameters<typeof reportTerminalEmailDeliveryFailure>[0],
  ): Promise<string> {
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      reportTerminalEmailDeliveryFailure(failure);
    } finally {
      spy.mockRestore();
    }
    return payloadOf(written.join(''));
  }

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

  /**
   * The alert payload is pinned whole rather than field by field: equality is
   * what proves an address, a token, a message body, or a provider response
   * cannot appear in it, now or after a future edit to the format.
   */
  it.each([
    ['verification_email', 'provider_rejected'],
    ['password_reset_email', 'timeout'],
  ] as const)(
    'emits only the request, kind=%s, and error=%s',
    async (kind, errorCode) => {
      expect(
        await emit({
          id: 'edr_01J00000000000000000000000',
          kind,
          errorCode,
        }),
      ).toBe(
        `email delivery request edr_01J00000000000000000000000 exhausted its attempts kind=${kind} error=${errorCode}`,
      );
    },
  );
});

describe('emailOutboxLeaseOwner', () => {
  it('names an owner the lease column accepts, and differs per instance', () => {
    expect(emailOutboxLeaseOwner()).toMatch(
      /^outbox-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(emailOutboxLeaseOwner()).not.toBe(emailOutboxLeaseOwner());
  });
});
