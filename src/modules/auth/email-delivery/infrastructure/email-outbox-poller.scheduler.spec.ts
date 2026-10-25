import { getMetrics } from '@/common/observability/metrics';
import { EmailDeliveryPoller } from '@/modules/auth/email-delivery/application/email-delivery-poller';
import { ScriptedPrisma } from '@/modules/persistence/testing/query-fake-client';
import { Logger } from '@nestjs/common';
import { RetiredKeyVersionLiveError } from './auth-email-recipient-limit';
import { missingQueuedEmailPayloadKeyVersions } from './email-outbox-key-retention';

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

  async function start(
    poller: ControllablePoller,
    nodeEnv: string,
  ): Promise<EmailOutboxPollerScheduler> {
    const subject = scheduler(poller, INTERVAL_MS, nodeEnv !== 'test');
    subjects.push(subject);
    await subject.onModuleInit();
    return subject;
  }

  it('does not start a poller under test', async () => {
    const poller = new ControllablePoller();

    void start(poller, 'test');
    await delay(INTERVAL_MS * 4);

    expect(poller.calls).toBe(0);
  });

  it('polls on its interval outside test', async () => {
    const poller = new ControllablePoller();

    void start(poller, 'production');
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

    await subject.onModuleInit();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports queued key versions missing from this instance before polling', async () => {
    const poller = new ControllablePoller();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const script = new ScriptedPrisma();
    script.outside = [
      [{ key_version: 'current-v2' }, { key_version: 'retired-v1' }],
    ];
    const readMissingKeyVersions = jest.fn(() =>
      missingQueuedEmailPayloadKeyVersions(script.client(), {
        currentKeyId: 'current-v2',
        keys: { 'current-v2': 'unused' },
      }),
    );
    const subject = new EmailOutboxPollerScheduler(
      poller as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      readMissingKeyVersions,
    );
    subjects.push(subject);

    try {
      await subject.onModuleInit();

      expect(readMissingKeyVersions).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(
        'email outbox queued requests reference unavailable key versions: retired-v1',
      );
      expect(poller.calls).toBe(0);

      await delay(INTERVAL_MS * 3);
      expect(poller.calls).toBeGreaterThan(0);
    } finally {
      error.mockRestore();
    }
  });

  it('refuses to start when a retired key version still has live recipient windows', async () => {
    const poller = new ControllablePoller();
    const subject = new EmailOutboxPollerScheduler(
      poller as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        throw new RetiredKeyVersionLiveError(
          'v1 (windows live until 2026-10-25T00:00:00.000Z)',
        );
      },
    );
    subjects.push(subject);

    await expect(subject.onModuleInit()).rejects.toThrow(
      /v1 \(windows live until 2026-10-25T00:00:00.000Z\)/,
    );
    expect(poller.calls).toBe(0);
    subject.onApplicationShutdown();
  });

  it('boots with the gate deferred while the counter table cannot be read, and holds every pass until it resolves', async () => {
    const poller = new ControllablePoller();
    let tableReadable = false;
    const subject = new EmailOutboxPollerScheduler(
      poller as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        if (!tableReadable) {
          // The image-boot contract boots without a database: an unreadable
          // counter table defers the verdict instead of failing startup.
          throw new Error("Can't reach database server at database.invalid");
        }
      },
    );
    subjects.push(subject);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    try {
      await expect(subject.onModuleInit()).resolves.toBeUndefined();
      await delay(INTERVAL_MS * 12);
      // The gate has not passed: no pass may run, so no ceiling can reset.
      expect(poller.calls).toBe(0);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('email outbox keyring gate not passed'),
      );

      // The table becomes readable: the next tick passes the gate and the
      // outbox resumes, with the deferral logged exactly once.
      tableReadable = true;
      await delay(INTERVAL_MS * 12);
      expect(poller.calls).toBeGreaterThan(0);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
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

    await subject.onModuleInit();
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

    await subject.onModuleInit();

    expect(await getMetrics()).toContain(
      'aihub_email_daily_send_budget{measurement="used"} 8',
    );
    expect(await getMetrics()).toContain(
      'aihub_email_daily_send_budget{measurement="limit"} 10',
    );

    subject.onApplicationShutdown();

    expect(await getMetrics()).not.toContain('aihub_email_daily_send_budget{');
  });

  it('reports the shared provider outage duration through metrics and removes the source on shutdown', async () => {
    const subject = new EmailOutboxPollerScheduler(
      new ControllablePoller() as unknown as EmailDeliveryPoller,
      INTERVAL_MS,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      async () => 45_000,
    );
    subjects.push(subject);

    await subject.onModuleInit();

    expect(await getMetrics()).toContain(
      'aihub_email_provider_outage_duration_seconds 45',
    );

    subject.onApplicationShutdown();

    expect(
      await getMetrics().then((metrics) =>
        metrics.includes('aihub_email_provider_outage_duration_seconds 0'),
      ),
    ).toBe(true);
  });

  it('skips a tick while the previous pass is still running', async () => {
    const poller = new ControllablePoller(true);

    void start(poller, 'production');
    await delay(INTERVAL_MS * 4);
    expect(poller.calls).toBe(1);

    poller.finish();
    await delay(INTERVAL_MS * 4);
    expect(poller.calls).toBeGreaterThan(1);
  });

  it('stops polling after shutdown', async () => {
    const poller = new ControllablePoller();
    const subject = await start(poller, 'production');
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
    ['organization_invite_email', 'key_unavailable'],
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
