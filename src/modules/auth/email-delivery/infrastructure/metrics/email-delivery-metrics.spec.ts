import { sample } from '@/common/observability/metric-sample.testing';
import { getMetrics, registry } from '@/common/observability/metrics';
import {
  recordEmailDeliveryFailed,
  recordEmailOutboxBackpressureRefusal,
  recordEmailOutboxUnrecognisedPayload,
  registerEmailDeliveryMetrics,
  setEmailOutboxBacklogSource,
  setEmailOutboxCancellationSource,
  setEmailOutboxWalHealthSource,
  setEmailProviderOutageDurationSource,
} from './email-delivery-metrics';

const EMAIL_DELIVERY_KINDS = [
  'verification_email',
  'password_reset_email',
  'organization_invite_email',
  'mfa_enabled_notification',
  'mfa_removed_notification',
  'api_key_near_expiry_notification',
] as const;
const EMAIL_BACKPRESSURE_KINDS = EMAIL_DELIVERY_KINDS.slice(0, 3);

registerEmailDeliveryMetrics(EMAIL_DELIVERY_KINDS, EMAIL_BACKPRESSURE_KINDS);

describe('email delivery failure series before any failure', () => {
  it.each([
    'verification_email',
    'password_reset_email',
    'organization_invite_email',
    'mfa_enabled_notification',
    'mfa_removed_notification',
    'api_key_near_expiry_notification',
  ])(
    'exposes %s at zero, so its first failure is an increase',
    async (kind) => {
      registry.resetMetrics();
      registerEmailDeliveryMetrics(
        EMAIL_DELIVERY_KINDS,
        EMAIL_BACKPRESSURE_KINDS,
      );

      expect(await getMetrics()).toContain(
        `aihub_email_delivery_failed_total{kind="${kind}"} 0`,
      );
    },
  );
});

describe('email delivery failure metric', () => {
  it('counts an exhausted delivery request under its email kind', async () => {
    recordEmailDeliveryFailed('organization_invite_email');

    expect(
      await sample('aihub_email_delivery_failed_total', {
        kind: 'organization_invite_email',
      }),
    ).toBe('1');
  });

  it('has no series for a cancelled request, which is not a failure', async () => {
    recordEmailDeliveryFailed('verification_email');

    expect(await getMetrics()).not.toContain(
      'aihub_email_delivery_failed_total{kind="cancelled"}',
    );
  });
});

describe('email outbox unrecognised payload metric', () => {
  it('counts a payload only a newer release can open under its email kind and nothing else', async () => {
    recordEmailOutboxUnrecognisedPayload('organization_invite_email');
    recordEmailOutboxUnrecognisedPayload('organization_invite_email');

    expect(
      await sample('aihub_email_outbox_unrecognised_payload_total', {
        kind: 'organization_invite_email',
      }),
    ).toBe('2');
    expect(await getMetrics()).not.toMatch(
      /aihub_email_outbox_unrecognised_payload_total\{[^}]*(email|token|role)=/,
    );
  });
});

describe('email outbox backpressure metric', () => {
  it.each([
    'verification_email',
    'password_reset_email',
    'organization_invite_email',
  ])(
    'exposes %s at zero, so its first refusal is an increase',
    async (kind) => {
      registry.resetMetrics();
      registerEmailDeliveryMetrics(
        EMAIL_DELIVERY_KINDS,
        EMAIL_BACKPRESSURE_KINDS,
      );

      expect(await getMetrics()).toContain(
        `aihub_email_outbox_backpressure_refusals_total{kind="${kind}"} 0`,
      );
    },
  );

  it('counts a refusal under the kind of the route', async () => {
    const before = Number(
      (await sample('aihub_email_outbox_backpressure_refusals_total', {
        kind: 'password_reset_email',
      })) ?? 0,
    );

    recordEmailOutboxBackpressureRefusal('password_reset_email');

    expect(
      await sample('aihub_email_outbox_backpressure_refusals_total', {
        kind: 'password_reset_email',
      }),
    ).toBe(String(before + 1));
  });
});

describe('email outbox backlog metrics', () => {
  afterEach(() => {
    setEmailOutboxBacklogSource(undefined);
  });

  it('exposes no backlog series until an outbox registers its source', async () => {
    expect(await getMetrics()).not.toContain('aihub_email_outbox_queued{');
  });

  it('reads the queue at scrape time, with zero for kinds that have nothing waiting', async () => {
    let reads = 0;
    setEmailOutboxBacklogSource(async () => {
      reads += 1;
      return [{ kind: 'verification_email', queued: 4, oldestAgeSeconds: 930 }];
    });

    expect(
      await sample('aihub_email_outbox_queued', { kind: 'verification_email' }),
    ).toBe('4');
    expect(
      await sample('aihub_email_outbox_oldest_queued_age_seconds', {
        kind: 'verification_email',
      }),
    ).toBe('930');
    expect(
      await sample('aihub_email_outbox_queued', {
        kind: 'organization_invite_email',
      }),
    ).toBe('0');
    // Each scrape reads once for both gauges, and a later scrape reads again.
    expect(reads).toBe(3);
  });

  it('counts queued rows with a kind this release does not recognize', async () => {
    setEmailOutboxBacklogSource(async () => [
      { kind: 'unknown', queued: 2, oldestAgeSeconds: 45 },
    ]);

    expect(await sample('aihub_email_outbox_queued', { kind: 'unknown' })).toBe(
      '2',
    );
    expect(
      await sample('aihub_email_outbox_oldest_queued_age_seconds', {
        kind: 'unknown',
      }),
    ).toBe('45');
  });

  it('drops the series when the queue cannot be read, rather than repeating a stale value', async () => {
    let healthy = true;
    setEmailOutboxBacklogSource(async () => {
      if (!healthy) throw new Error('database unavailable');
      return [
        { kind: 'password_reset_email', queued: 2, oldestAgeSeconds: 12 },
      ];
    });
    expect(
      await sample('aihub_email_outbox_queued', {
        kind: 'password_reset_email',
      }),
    ).toBe('2');

    healthy = false;

    expect(await getMetrics()).not.toContain('aihub_email_outbox_queued{');
  });
});

describe('email outbox WAL health metrics', () => {
  afterEach(() => {
    setEmailOutboxWalHealthSource(undefined);
  });

  it('exposes health-read failures and clears the signal after recovery', async () => {
    setEmailOutboxWalHealthSource(async () => {
      throw new Error('database unavailable');
    });
    expect(await sample('aihub_email_outbox_wal_health_read_failed')).toBe('1');

    setEmailOutboxWalHealthSource(async () => ({
      active: true,
      retainedBytes: 100,
      safeBytes: 1_000,
      status: 'reserved',
    }));
    expect(await sample('aihub_email_outbox_wal_health_read_failed')).toBe('0');
  });
});

describe('email provider outage metric', () => {
  afterEach(() => {
    setEmailProviderOutageDurationSource(undefined);
  });

  it('exposes shared outage duration in seconds without labels', async () => {
    setEmailProviderOutageDurationSource(async () => 90_000);

    expect(await sample('aihub_email_provider_outage_duration_seconds')).toBe(
      '90',
    );
    expect(await getMetrics()).toContain(
      '# HELP aihub_email_provider_outage_duration_seconds',
    );
    expect(await getMetrics()).not.toMatch(
      /aihub_email_provider_outage_duration_seconds\{/,
    );
  });

  it('resets the gauge when shared outage state cannot be read', async () => {
    let healthy = true;
    setEmailProviderOutageDurationSource(async () => {
      if (!healthy) throw new Error('Redis unavailable');
      return 12_000;
    });
    expect(await sample('aihub_email_provider_outage_duration_seconds')).toBe(
      '12',
    );

    healthy = false;

    expect(await sample('aihub_email_provider_outage_duration_seconds')).toBe(
      '0',
    );
  });
});

describe('email outbox cancellation metrics', () => {
  afterEach(() => {
    setEmailOutboxCancellationSource(undefined);
  });

  it('reads durable cancellation timestamps with bounded kind and reason labels', async () => {
    setEmailOutboxCancellationSource(async () => [
      {
        kind: 'verification_email',
        reason: 'credential_expired',
        timestampSeconds: 1_797_000_000,
      },
      {
        kind: 'organization_invite_email',
        reason: 'credential_revoked',
        timestampSeconds: 1_797_000_030,
      },
    ]);

    expect(
      await sample('aihub_email_delivery_cancelled_timestamp_seconds', {
        kind: 'verification_email',
        reason: 'credential_expired',
      }),
    ).toBe('1797000000');
    expect(
      await sample('aihub_email_delivery_cancelled_timestamp_seconds', {
        kind: 'organization_invite_email',
        reason: 'credential_revoked',
      }),
    ).toBe('1797000030');
  });

  it('drops durable cancellation series if the database read fails', async () => {
    let healthy = true;
    setEmailOutboxCancellationSource(async () => {
      if (!healthy) throw new Error('database unavailable');
      return [
        {
          kind: 'verification_email',
          reason: 'credential_expired',
          timestampSeconds: 1_797_000_000,
        },
      ];
    });
    expect(
      await sample('aihub_email_delivery_cancelled_timestamp_seconds', {
        kind: 'verification_email',
        reason: 'credential_expired',
      }),
    ).toBe('1797000000');

    healthy = false;

    expect(await getMetrics()).not.toContain(
      'aihub_email_delivery_cancelled_timestamp_seconds{',
    );
  });
});
