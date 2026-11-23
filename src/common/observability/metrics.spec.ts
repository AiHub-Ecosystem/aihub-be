import { sample } from './metric-sample.testing';
import {
  METRICS_ROUTE_PATH,
  getMetrics,
  observeDispatchDeadlineMsRemaining,
  recordArgon2QueueRefusal,
  recordArgon2QueueWait,
  recordCompletedRequest,
  recordDispatchCancelledByDeadline,
  recordIdentityCacheCoalescedWait,
  recordJwksRefreshFailure,
  setDispatchAttemptUnresolvedSource,
  setDownstreamPoolQueuedSource,
  setPostgresPoolStatsSource,
} from './metrics';

const GRADE = 'writing.task1.grade';

describe('request lifecycle metrics', () => {
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

  it('exposes duration buckets through the 300-second provider deadline', async () => {
    recordCompletedRequest({
      operation: GRADE,
      statusCode: 200,
      outcome: 'success',
      totalMs: 280000,
      downstreamMs: 280000,
    });

    expect(
      await sample('aihub_request_duration_seconds_bucket', {
        le: '60',
        operation: GRADE,
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_request_duration_seconds_bucket', {
        le: '90',
        operation: GRADE,
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_request_duration_seconds_bucket', {
        le: '120',
        operation: GRADE,
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_request_duration_seconds_bucket', {
        le: '300',
        operation: GRADE,
      }),
    ).toBeDefined();

    expect(
      await sample('aihub_downstream_duration_seconds_bucket', {
        le: '90',
        operation: GRADE,
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_downstream_duration_seconds_bucket', {
        le: '120',
        operation: GRADE,
      }),
    ).toBeDefined();
    expect(
      await sample('aihub_downstream_duration_seconds_bucket', {
        le: '300',
        operation: GRADE,
      }),
    ).toBeDefined();
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
