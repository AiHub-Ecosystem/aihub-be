import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

import type { OperationId } from '@/catalog/operation-id';
import { registerProcessRuntimeMetrics } from './process-runtime-metrics';

export const METRICS_ROUTE_PATH = '/metrics';

/**
 * Shared metric registry. Protection rejection and Redis failure counters live
 * in `rejected-metric.ts` and `redis-unavailable-metric.ts`. A module that owns
 * a metric family registers it here from its own code: the email delivery
 * metrics live in Auth, the critical-journey metrics in Metering, and the
 * downstream breaker and concurrency metrics in Gateway.
 */
export const registry = new Registry();
registerProcessRuntimeMetrics(registry);

export function secondsOf(milliseconds: number): number | undefined {
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds / 1000
    : undefined;
}

let objectStorageQueueSource: (() => number) | undefined;

const objectStorageFailures = new Counter({
  name: 'aihub_object_storage_failures_total',
  help: 'S3 call failures by bounded failure reason, without object or credential labels.',
  labelNames: ['reason'],
  registers: [registry],
});

export type ObjectStorageFailureReason =
  | 'deadline'
  | 'cancelled'
  | 'connection_refused'
  | 'connection_timeout'
  | 'request_timeout'
  | 'bulkhead_exhausted'
  | 'unavailable';

export function recordObjectStorageFailure(
  reason: ObjectStorageFailureReason,
): void {
  objectStorageFailures.inc({ reason });
}

const argon2QueueWaitsTotal = new Counter({
  name: 'aihub_argon2_queue_waits_total',
  help: 'Argon2 operations that waited for a per-process worker slot.',
  registers: [registry],
});

const argon2QueueRefusalsTotal = new Counter({
  name: 'aihub_argon2_queue_refusals_total',
  help: 'Argon2 operations refused after the bounded queue filled or timed out.',
  registers: [registry],
});

export function recordArgon2QueueWait(): void {
  argon2QueueWaitsTotal.inc();
}

export function recordArgon2QueueRefusal(): void {
  argon2QueueRefusalsTotal.inc();
}

new Gauge({
  name: 'aihub_object_storage_queued_requests',
  help: 'S3 requests waiting for a socket in this process.',
  registers: [registry],
  collect() {
    this.set(objectStorageQueueSource?.() ?? 0);
  },
});

export function setObjectStorageQueueSource(source: () => number): void {
  objectStorageQueueSource = source;
}

const requestsTotal = new Counter({
  name: 'aihub_requests_total',
  help: 'Completed HTTP responses, labelled by operation and how they ended.',
  labelNames: ['operation', 'status', 'outcome'],
  registers: [registry],
});

const requestDuration = new Histogram({
  name: 'aihub_request_duration_seconds',
  help: 'Wall time of a completed HTTP response, in seconds.',
  labelNames: ['operation'],
  // A grading request runs 800-3000ms while a rejected one returns in
  // single-digit milliseconds, so the buckets are denser at the fast end
  // where the interesting distinction sits.
  buckets: [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90, 120,
    180, 300,
  ],
  registers: [registry],
});

const downstreamDuration = new Histogram({
  name: 'aihub_downstream_duration_seconds',
  help: 'Time spent waiting on the downstream AI service, in seconds.',
  labelNames: ['operation'],
  buckets: [
    0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 90, 120, 180, 300,
  ],
  registers: [registry],
});

const dispatchDeadlineMsRemaining = new Histogram({
  name: 'aihub_dispatch_deadline_ms_remaining',
  help: 'AIHUB work-deadline budget remaining immediately before downstream dispatch, in milliseconds.',
  labelNames: ['operation'],
  buckets: [
    1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
    60_000, 120_000, 125_000, 180_000, 300_000,
  ],
  registers: [registry],
});

const dispatchCancelledByDeadlineTotal = new Counter({
  name: 'aihub_dispatch_cancelled_by_deadline_total',
  help: 'In-flight downstream calls aborted by an AIHUB work deadline.',
  labelNames: ['operation'],
  registers: [registry],
});

const downstreamRetryEventsTotal = new Counter({
  name: 'aihub_downstream_retry_events_total',
  help: 'Safe downstream retries and bounded-budget refusals by operation and reason.',
  labelNames: ['operation', 'reason'],
  registers: [registry],
});

// `downstream` is the adapter's fixed service name, never request input, so the
// label set stays at operations x AI Services (#845).
const downstreamCredentialFailuresTotal = new Counter({
  name: 'aihub_downstream_credential_failures_total',
  help: 'Downstream 401 or 403 answers: the AI Service rejected AIHUB credential.',
  labelNames: ['operation', 'downstream'],
  registers: [registry],
});

const tokensTotal = new Counter({
  name: 'aihub_tokens_total',
  help: 'Aggregate tokens reported by the downstream AI service.',
  // No `org_id` label: it is unbounded, so every Organization would multiply
  // the series count and no runbook could predict it. Spec section L.2 named
  // the label; issue #198 records that conflict and drops it. Per-org usage
  // belongs in `usage_records` and in the `request_completed` log line, which
  // is where an unbounded dimension belongs.
  labelNames: ['operation'],
  registers: [registry],
});

const meteringIncompleteTotal = new Counter({
  name: 'aihub_metering_incomplete_total',
  help: "Requests recorded with metering_status = 'missing_usage'.",
  labelNames: ['operation'],
  registers: [registry],
});

const jwksRefreshFailuresTotal = new Counter({
  name: 'aihub_jwks_refresh_failures_total',
  help: 'Organization JWKS refresh attempts that failed.',
  registers: [registry],
});

const identityCacheCoalescedWaitsTotal = new Counter({
  name: 'aihub_identity_cache_coalesced_waits_total',
  help: 'Identity cache requests that joined in-flight work by cache kind.',
  labelNames: ['kind'],
  registers: [registry],
});

export type IdentityCacheKind = 'api_key' | 'jwks';

export function recordJwksRefreshFailure(): void {
  jwksRefreshFailuresTotal.inc();
}

export function recordIdentityCacheCoalescedWait(
  kind: IdentityCacheKind,
): void {
  identityCacheCoalescedWaitsTotal.inc({ kind });
}

const postgresPoolErrorsTotal = new Counter({
  name: 'aihub_postgres_pool_errors_total',
  help: 'PostgreSQL pool and checked-out client errors by pool and SQLSTATE class.',
  labelNames: ['pool', 'sqlstate_class'],
  registers: [registry],
});

/**
 * What a pool is labelled as in `aihub_postgres_pool_errors_total`.
 *
 * A pool belongs to a connection role rather than to the module that happens to
 * open it, because ADR-0088 collapses the per-module pools into one pool per
 * distinct database URL. When several roles name one URL they share one pool,
 * which carries the first role's name; `aihub_postgres_pool_role` lists every
 * role the pool serves. `integration-test` labels the pools database-lane specs
 * open for themselves.
 */
export type PostgresConnectionRole =
  | 'runtime'
  | 'control-plane'
  | 'control-plane-read'
  | 'email-daily-budget';

export type PostgresPoolName = PostgresConnectionRole | 'integration-test';

export interface PostgresPoolStatsSample {
  readonly pool: PostgresPoolName;
  /** The connection roles this pool serves; several share one pool. */
  readonly roles: readonly PostgresConnectionRole[];
  readonly total: number;
  readonly idle: number;
  readonly waiting: number;
}

type PostgresPoolStatsSource = () => readonly PostgresPoolStatsSample[];

let postgresPoolStatsSource: PostgresPoolStatsSource | undefined;

function readPostgresPoolStats(
  gauge: Gauge<'pool'>,
  value: 'total' | 'idle' | 'waiting',
): void {
  gauge.reset();
  try {
    for (const sample of postgresPoolStatsSource?.() ?? []) {
      gauge.set({ pool: sample.pool }, sample[value]);
    }
  } catch {
    gauge.reset();
  }
}

const postgresPoolTotal = new Gauge({
  name: 'aihub_postgres_pool_total',
  help: 'Total PostgreSQL clients in each application pool.',
  labelNames: ['pool'],
  registers: [registry],
  collect() {
    readPostgresPoolStats(this, 'total');
  },
});

const postgresPoolIdle = new Gauge({
  name: 'aihub_postgres_pool_idle',
  help: 'Idle PostgreSQL clients in each application pool.',
  labelNames: ['pool'],
  registers: [registry],
  collect() {
    readPostgresPoolStats(this, 'idle');
  },
});

const postgresPoolWaiting = new Gauge({
  name: 'aihub_postgres_pool_waiting',
  help: 'Requests waiting for a PostgreSQL client in each application pool.',
  labelNames: ['pool'],
  registers: [registry],
  collect() {
    readPostgresPoolStats(this, 'waiting');
  },
});

// One series per pool and role it serves, always 1. The counts above belong to
// the pool, so a pool shared by three roles reports once; this is how a
// dashboard reads "the runtime pool is also the control-plane pool" without the
// counts being summed three times.
const postgresPoolRole = new Gauge({
  name: 'aihub_postgres_pool_role',
  help: 'Connection roles served by each application pool.',
  labelNames: ['pool', 'role'],
  registers: [registry],
  collect() {
    this.reset();
    try {
      for (const sample of postgresPoolStatsSource?.() ?? []) {
        for (const role of sample.roles) {
          this.set({ pool: sample.pool, role }, 1);
        }
      }
    } catch {
      this.reset();
    }
  },
});

export function setPostgresPoolStatsSource(
  source: PostgresPoolStatsSource | undefined,
): void {
  postgresPoolStatsSource = source;
  if (source === undefined) {
    postgresPoolTotal.reset();
    postgresPoolIdle.reset();
    postgresPoolWaiting.reset();
    postgresPoolRole.reset();
  }
}

export interface DownstreamPoolQueuedSample {
  readonly origin: string;
  readonly queued: number;
}

type DownstreamPoolQueuedSource = () => readonly DownstreamPoolQueuedSample[];

let downstreamPoolQueuedSource: DownstreamPoolQueuedSource | undefined;

function readDownstreamPoolQueued(gauge: Gauge<'origin'>): void {
  gauge.reset();
  try {
    for (const sample of downstreamPoolQueuedSource?.() ?? []) {
      gauge.set({ origin: sample.origin }, sample.queued);
    }
  } catch {
    gauge.reset();
  }
}

const downstreamPoolQueued = new Gauge({
  name: 'aihub_downstream_pool_queued',
  help: 'Requests queued in each configured downstream HTTP connection pool.',
  labelNames: ['origin'],
  registers: [registry],
  collect() {
    readDownstreamPoolQueued(this);
  },
});

export function setDownstreamPoolQueuedSource(
  source: DownstreamPoolQueuedSource | undefined,
): void {
  downstreamPoolQueuedSource = source;
  if (source === undefined) {
    downstreamPoolQueued.reset();
  }
}

export function recordPostgresPoolError(
  pool: PostgresPoolName,
  errorCode: unknown,
): string {
  const sqlstateClass =
    typeof errorCode === 'string' && /^[A-Z0-9]{5}$/.test(errorCode)
      ? errorCode.slice(0, 2)
      : 'unknown';
  postgresPoolErrorsTotal.inc({ pool, sqlstate_class: sqlstateClass });
  return sqlstateClass;
}

export function observeDispatchDeadlineMsRemaining(
  operation: OperationId,
  remainingMs: number,
): void {
  if (Number.isInteger(remainingMs) && remainingMs > 0) {
    dispatchDeadlineMsRemaining.observe({ operation }, remainingMs);
  }
}

export function recordDispatchCancelledByDeadline(
  operation: OperationId,
): void {
  dispatchCancelledByDeadlineTotal.inc({ operation });
}

export function recordDownstreamRetryEvent(
  operation: OperationId,
  reason:
    | 'connection'
    | 'retry_after'
    | 'budget_exhausted'
    | 'budget_unavailable',
): void {
  downstreamRetryEventsTotal.inc({ operation, reason });
}

export function recordDownstreamCredentialRejection(
  operation: OperationId,
  downstream: string,
): void {
  downstreamCredentialFailuresTotal.inc({ operation, downstream });
}

export interface DispatchAttemptUnresolvedSample {
  readonly operation: OperationId | 'other';
  readonly count: number;
}

type DispatchAttemptUnresolvedSource = () => Promise<
  readonly DispatchAttemptUnresolvedSample[]
>;

let dispatchAttemptUnresolvedSource:
  | DispatchAttemptUnresolvedSource
  | undefined;
let pendingDispatchAttemptRead: Promise<void> | undefined;

function readDispatchAttemptUnresolved(): Promise<void> {
  const source = dispatchAttemptUnresolvedSource;
  if (source === undefined) {
    dispatchAttemptsUnresolved.reset();
    return Promise.resolve();
  }
  pendingDispatchAttemptRead ??= (async () => {
    try {
      const samples = await source();
      dispatchAttemptsUnresolved.reset();
      for (const sample of samples) {
        dispatchAttemptsUnresolved.set(
          { operation: sample.operation },
          sample.count,
        );
      }
    } catch {
      dispatchAttemptsUnresolved.reset();
    } finally {
      pendingDispatchAttemptRead = undefined;
    }
  })();
  return pendingDispatchAttemptRead;
}

const dispatchAttemptsUnresolved = new Gauge({
  name: 'aihub_dispatch_attempts_unresolved',
  help: 'AI Service dispatch attempts past their deadline without final dispatch evidence.',
  labelNames: ['operation'],
  registers: [registry],
  collect: readDispatchAttemptUnresolved,
});

export function setDispatchAttemptUnresolvedSource(
  source: DispatchAttemptUnresolvedSource | undefined,
): void {
  dispatchAttemptUnresolvedSource = source;
  if (source === undefined) {
    dispatchAttemptsUnresolved.reset();
  }
}

/**
 * Only called from the Request Completion hook, where the operation is either
 * a catalog identifier or its fixed unmatched sentinel. Label values are
 * bounded by code rather than whatever a caller put in the URL.
 */
export interface CompletedRequestMetrics {
  readonly operation: string;
  readonly statusCode: number;
  readonly outcome: string;
  /** Total wall time in milliseconds; converted to seconds here. */
  readonly totalMs?: number;
  /** Downstream wait in milliseconds, already timed by the dispatcher. */
  readonly downstreamMs?: number;
  readonly tokens?: number;
  readonly meteringStatus?: string;
}

export function recordCompletedRequest(request: CompletedRequestMetrics): void {
  const { operation, statusCode, outcome } = request;
  requestsTotal.inc({ operation, status: String(statusCode), outcome });

  const totalSeconds = secondsOf(request.totalMs ?? Number.NaN);
  if (totalSeconds !== undefined) {
    requestDuration.observe({ operation }, totalSeconds);
  }

  const downstreamSeconds = secondsOf(request.downstreamMs ?? Number.NaN);
  if (downstreamSeconds !== undefined) {
    downstreamDuration.observe({ operation }, downstreamSeconds);
  }

  if (
    request.tokens !== undefined &&
    Number.isFinite(request.tokens) &&
    request.tokens > 0
  ) {
    tokensTotal.inc({ operation }, request.tokens);
  }

  if (request.meteringStatus === 'missing_usage') {
    meteringIncompleteTotal.inc({ operation });
  }
}

export function getMetrics(): Promise<string> {
  return registry.metrics();
}

export function getMetricsContentType(): string {
  return registry.contentType;
}
