import {
  METRICS_ROUTE_PATH,
  getMetrics,
  registerEmailDeliveryMetrics,
  registry,
} from './metrics';
import {
  observeDispatchDeadlineMsRemaining,
  recordArgon2QueueRefusal,
  recordArgon2QueueWait,
  recordCompletedRequest,
  recordDispatchCancelledByDeadline,
  recordDownstreamRetryEvent,
  recordEmailDeliveryFailed,
  recordEmailOutboxBackpressureRefusal,
  recordEmailOutboxUnrecognisedPayload,
  recordIdentityCacheCoalescedWait,
  recordJwksRefreshFailure,
  setDispatchAttemptUnresolvedSource,
  setDownstreamPoolQueuedSource,
  setEmailOutboxBacklogSource,
  setEmailOutboxCancellationSource,
  setEmailProviderOutageDurationSource,
  setPostgresPoolStatsSource,
} from './metrics';

const GRADE = 'writing.task1.grade';
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

/**
 * The value of one sample, or undefined when the series is absent. Prometheus
 * exposition orders labels by name, so the selector is built the same way
 * rather than pattern-matched.
 */
async function sample(
  name: string,
  labels: Record<string, string> = {},
): Promise<string | undefined> {
  const labelSelector = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const selector =
    labelSelector.length === 0 ? name : `${name}{${labelSelector}}`;

  const line = (await getMetrics())
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith(`${selector} `));

  return line?.trimStart().slice(selector.length + 1);
}

describe('request lifecycle metrics', () => {
  it('counts safe downstream retries and budget exhaustion with bounded labels', async () => {
    recordDownstreamRetryEvent(GRADE, 'connection');
    recordDownstreamRetryEvent(GRADE, 'budget_exhausted');
    recordDownstreamRetryEvent(GRADE, 'budget_unavailable');

    expect(
      await sample('aihub_downstream_retry_events_total', {
        operation: GRADE,
        reason: 'connection',
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_downstream_retry_events_total', {
        operation: GRADE,
        reason: 'budget_exhausted',
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_downstream_retry_events_total', {
        operation: GRADE,
        reason: 'budget_unavailable',
      }),
    ).toBeDefined();
    expect(await getMetrics()).not.toContain('request_id');
  });

  it('counts a completed request with its status and outcome', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: 840,
      downstreamMs: 810,
      tokens: 1130,
      meteringStatus: 'complete',
    });

    expect(
      await sample('aihub_requests_total', {
        operation: GRADE,
        status: '200',
        outcome: 'success',
      }),
    ).toBeDefined();
    expect(await sample('aihub_tokens_total', { operation: GRADE })).toBe(
      '1130',
    );
  });

  it('records a bounded journey and gateway overhead without downstream wait', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: 840,
      downstreamMs: 810,
      criticalJourney: 'graded_request',
    });

    expect(
      await sample('aihub_critical_journey_requests_total', {
        journey: 'graded_request',
        outcome: 'success',
      }),
    ).toBeDefined();
    expect(
      Number(
        await sample('aihub_gateway_overhead_duration_seconds_sum', {
          journey: 'graded_request',
        }),
      ),
    ).toBeCloseTo(0.03);
  });

  it('clamps overhead at zero when millisecond rounding exceeds total time', async () => {
    recordCompletedRequest({
      operation: 'unmatched',
      statusCode: 200,
      outcome: 'success',
      totalMs: 10,
      downstreamMs: 11,
      criticalJourney: 'authentication',
    });

    expect(
      Number(
        await sample('aihub_gateway_overhead_duration_seconds_sum', {
          journey: 'authentication',
        }),
      ),
    ).toBe(0);
  });

  it('records a failed request the same way as a successful one', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 503,
      outcome: 'downstream_error',
      totalMs: 5000,
    });

    expect(
      await sample('aihub_requests_total', {
        operation: GRADE,
        status: '503',
        outcome: 'downstream_error',
      }),
    ).toBeDefined();
  });

  it('counts a record whose metering status is missing_usage', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      meteringStatus: 'missing_usage',
    });

    expect(
      await sample('aihub_metering_incomplete_total', { operation: GRADE }),
    ).toBeDefined();
  });

  it('does not count a record whose metering status is complete', async () => {
    recordCompletedRequest({
      operation: 'speaking.grading',
      statusCode: 200,
      outcome: 'success',
      meteringStatus: 'complete',
    });

    expect(
      await sample('aihub_metering_incomplete_total', {
        operation: 'speaking.grading',
      }),
    ).toBeUndefined();
  });

  it('reports duration in seconds rather than milliseconds', async () => {
    recordCompletedRequest({
      operation: 'speaking.grading',
      statusCode: 200,
      outcome: 'success',
      totalMs: 2000,
      downstreamMs: 1500,
    });

    const total = Number(
      await sample('aihub_request_duration_seconds_sum', {
        operation: 'speaking.grading',
      }),
    );
    const downstream = Number(
      await sample('aihub_downstream_duration_seconds_sum', {
        operation: 'speaking.grading',
      }),
    );

    // Summed observations are seconds: 2000ms must never read as 2000.
    expect(total).toBeGreaterThan(1);
    expect(total).toBeLessThan(100);
    expect(downstream).toBeGreaterThan(1);
    expect(downstream).toBeLessThan(100);
  });

  it('never emits a series carrying an organization identifier', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      tokens: 10,
    });

    const payload = await getMetrics();
    expect(payload).not.toContain('org_id');
    expect(payload).not.toMatch(/organization\w*=/);
  });

  it('exposes the scrape path as /metrics', () => {
    expect(METRICS_ROUTE_PATH).toBe('/metrics');
  });

  it('reports a non-finite duration as a zero-length observation', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: Number.NaN,
      downstreamMs: -5,
    });

    // Must not throw, and must not produce NaN in the exposition payload.
    expect(await getMetrics()).not.toContain('NaN');
  });
});

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

describe('identity cache metrics', () => {
  it('counts JWKS refresh failures and coalesced waits with bounded labels', async () => {
    const beforeFailure = Number(
      await sample('aihub_jwks_refresh_failures_total'),
    );
    const beforeWait = Number(
      (await sample('aihub_identity_cache_coalesced_waits_total', {
        kind: 'jwks',
      })) ?? 0,
    );

    recordJwksRefreshFailure();
    recordIdentityCacheCoalescedWait('jwks');
    recordIdentityCacheCoalescedWait('api_key');

    expect(Number(await sample('aihub_jwks_refresh_failures_total'))).toBe(
      beforeFailure + 1,
    );
    expect(
      Number(
        await sample('aihub_identity_cache_coalesced_waits_total', {
          kind: 'jwks',
        }),
      ),
    ).toBe(beforeWait + 1);
    expect(
      Number(
        await sample('aihub_identity_cache_coalesced_waits_total', {
          kind: 'api_key',
        }),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(await getMetrics()).not.toMatch(
      /aihub_(?:jwks_refresh_failures|identity_cache_coalesced_waits)[^\n]*\b(?:org|key|user)_id=/,
    );
  });
});

describe('Argon2 queue metrics', () => {
  it('counts queued waits and capacity refusals separately', async () => {
    const beforeWaits = Number(
      (await sample('aihub_argon2_queue_waits_total')) ?? 0,
    );
    const beforeRefusals = Number(
      (await sample('aihub_argon2_queue_refusals_total')) ?? 0,
    );

    recordArgon2QueueWait();
    recordArgon2QueueRefusal();

    expect(Number(await sample('aihub_argon2_queue_waits_total'))).toBe(
      beforeWaits + 1,
    );
    expect(Number(await sample('aihub_argon2_queue_refusals_total'))).toBe(
      beforeRefusals + 1,
    );
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

describe('unresolved dispatch-attempt metrics', () => {
  afterEach(() => {
    setDispatchAttemptUnresolvedSource(undefined);
  });

  it('reads durable unresolved counts at scrape time by operation', async () => {
    let reads = 0;
    setDispatchAttemptUnresolvedSource(async () => {
      reads += 1;
      return [{ operation: GRADE, count: 2 }];
    });

    expect(
      await sample('aihub_dispatch_attempts_unresolved', {
        operation: GRADE,
      }),
    ).toBe('2');
    expect(reads).toBe(1);
  });

  it('drops prior series when durable evidence cannot be read', async () => {
    let healthy = true;
    setDispatchAttemptUnresolvedSource(async () => {
      if (!healthy) throw new Error('database unavailable');
      return [{ operation: GRADE, count: 2 }];
    });
    expect(
      await sample('aihub_dispatch_attempts_unresolved', {
        operation: GRADE,
      }),
    ).toBe('2');

    healthy = false;

    expect(await getMetrics()).not.toContain(
      'aihub_dispatch_attempts_unresolved{',
    );
  });
});

describe('dispatch deadline metrics', () => {
  it('records remaining milliseconds and deadline cancellations by operation', async () => {
    observeDispatchDeadlineMsRemaining(GRADE, 750);
    recordDispatchCancelledByDeadline(GRADE);

    expect(
      Number(
        await sample('aihub_dispatch_deadline_ms_remaining_count', {
          operation: GRADE,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(
      Number(
        await sample('aihub_dispatch_cancelled_by_deadline_total', {
          operation: GRADE,
        }),
      ),
    ).toBeGreaterThan(0);
    expect(await getMetrics()).not.toMatch(
      /aihub_dispatch_(?:deadline_ms_remaining|cancelled_by_deadline)[^\n]*\b(?:org|request|user)_id=/,
    );
  });
});

describe('runtime resource metrics', () => {
  afterEach(() => {
    setDownstreamPoolQueuedSource(undefined);
    setPostgresPoolStatsSource(undefined);
  });

  it('scrapes process CPU and memory, event-loop lag, Postgres pool counts, and downstream queue', async () => {
    let queued = 3;
    setPostgresPoolStatsSource(() => [
      {
        pool: 'runtime',
        roles: ['runtime', 'control-plane'],
        total: 4,
        idle: 2,
        waiting: 1,
      },
    ]);
    setDownstreamPoolQueuedSource(() => [
      { origin: 'https://ai-writing.test', queued },
    ]);

    const payload = await getMetrics();

    for (const name of [
      'aihub_process_cpu_seconds_total',
      'aihub_process_resident_memory_bytes',
      'aihub_process_heap_used_bytes',
      'aihub_event_loop_lag_seconds',
      'aihub_postgres_pool_total',
      'aihub_postgres_pool_idle',
      'aihub_postgres_pool_waiting',
      'aihub_downstream_pool_queued',
    ]) {
      expect(payload).toContain(`# HELP ${name} `);
    }
    expect(payload).toContain('aihub_postgres_pool_total{pool="runtime"} 4');
    expect(payload).toContain(
      'aihub_postgres_pool_role{pool="runtime",role="control-plane"} 1',
    );
    expect(payload).toContain(
      'aihub_postgres_pool_role{pool="runtime",role="runtime"} 1',
    );
    expect(payload).toContain('aihub_postgres_pool_idle{pool="runtime"} 2');
    expect(payload).toContain('aihub_postgres_pool_waiting{pool="runtime"} 1');
    expect(payload).toContain(
      'aihub_downstream_pool_queued{origin="https://ai-writing.test"} 3',
    );
    expect(payload).toMatch(/^aihub_process_resident_memory_bytes [\d.]+$/m);
    expect(payload).toMatch(/^aihub_process_heap_used_bytes [\d.]+$/m);
    expect(payload).toMatch(/^aihub_process_cpu_seconds_total [\d.]+$/m);
    const lagSeconds = Number(
      payload.match(/^aihub_event_loop_lag_seconds (\S+)$/m)?.[1],
    );
    expect(Number.isFinite(lagSeconds)).toBe(true);
    expect(lagSeconds).toBeGreaterThanOrEqual(0);
    expect(payload).not.toMatch(/\{[^}]*\b(?:org|user|request)_id=/);

    queued = 0;
    expect(await getMetrics()).toContain(
      'aihub_downstream_pool_queued{origin="https://ai-writing.test"} 0',
    );
  });
});
