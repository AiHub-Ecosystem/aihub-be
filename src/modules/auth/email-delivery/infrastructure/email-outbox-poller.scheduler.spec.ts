import { getMetrics } from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/email-delivery/application/email-delivery-poller';
import { Logger } from '@nestjs/common';

import {
  EmailOutboxPollerScheduler,
  emailOutboxLeaseOwner,
  reportEmailProviderConfigurationFailure,
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

  it('runs recipient counter cleanup at startup', async () => {
    const poller = new ControllablePoller();
    const cleanup = jest.fn().mockResolvedValue(0);
    const subject = new EmailOutboxPollerScheduler(
      poller as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      cleanup,
    );
    subjects.push(subject);

    subject.onModuleInit();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('serves durable cancellation timestamps through metrics and removes the source on shutdown', async () => {
    const poller = new ControllablePoller();
    const subject = new EmailOutboxPollerScheduler(
      poller as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      async () => [
        {
          kind: 'verification_email',
          reason: 'credential_expired',
          timestampSeconds: 1_797_000_000,
        },
      ],
    );
    subjects.push(subject);

    subject.onModuleInit();
    expect(await getMetrics()).toContain(
      'aihub_email_delivery_cancelled_timestamp_seconds{kind="verification_email",reason="credential_expired"} 1797000000',
    );

    subject.onApplicationShutdown();

    expect(await getMetrics()).not.toContain(
      'aihub_email_delivery_cancelled_timestamp_seconds{',
    );
  });

  it('reports the shared daily budget through metrics and removes the source on shutdown', async () => {
    const subject = new EmailOutboxPollerScheduler(
      new ControllablePoller() as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      undefined,
      async () => ({ used: 8, limit: 10 }),
    );
    subjects.push(subject);

    subject.onModuleInit();

    expect(await getMetrics()).toContain(
      'aihub_email_daily_send_budget{measurement="used"} 8',
    );
    expect(await getMetrics()).toContain(
      'aihub_email_daily_send_budget{measurement="limit"} 10',
    );

    subject.onApplicationShutdown();

    expect(await getMetrics()).not.toContain('aihub_email_daily_send_budget{');
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

describe('reportEmailProviderConfigurationFailure', () => {
  it.each([401, 403] as const)(
    'emits a bounded configuration signal for status %s',
    (status) => {
      const error = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      try {
        reportEmailProviderConfigurationFailure({ status });
        expect(error).toHaveBeenCalledWith(
          `email provider credentials rejected status=${status}; dispatch paused`,
        );
        expect(JSON.stringify(error.mock.calls)).not.toMatch(
          /person@example\.com|token|body|response/i,
        );
      } finally {
        error.mockRestore();
      }
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
