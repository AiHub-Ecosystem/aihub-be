import { monitorEventLoopDelay } from 'node:perf_hooks';

import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

import type { OperationId } from '@/catalog/operation-id';
import { registerEmailDailySendBudgetMetric } from './email-daily-send-budget-metric';
import {
  type EmailDeliveryKindLabel,
  registerEmailOutboxCancellationMetric,
} from './email-outbox-cancellation-metric';

export type {
  EmailDeliveryKindLabel,
  EmailOutboxCancellationSample,
} from './email-outbox-cancellation-metric';

/**
 * Shared metric registry. The rejection counter (`aihub_rejected_total`)
 * belongs to #200; `aihub_redis_unavailable_total` lives in
 * `redis-unavailable-metric.ts`.
 */
export const METRICS_ROUTE_PATH = '/metrics';

export const registry = new Registry();

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

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

new Gauge({
  name: 'aihub_process_resident_memory_bytes',
  help: 'Resident memory used by this Node.js process, in bytes.',
  registers: [registry],
  collect() {
    this.set(process.memoryUsage().rss);
  },
});

new Gauge({
  name: 'aihub_process_heap_used_bytes',
  help: 'V8 heap currently used by this Node.js process, in bytes.',
  registers: [registry],
  collect() {
    this.set(process.memoryUsage().heapUsed);
  },
});

new Gauge({
  name: 'aihub_event_loop_lag_seconds',
  help: '99th percentile event-loop delay since the previous metrics scrape, in seconds.',
  registers: [registry],
  collect() {
    const lagSeconds = eventLoopDelay.percentile(99) / 1_000_000_000;
    this.set(Number.isFinite(lagSeconds) ? lagSeconds : 0);
    eventLoopDelay.reset();
  },
});

const requestsTotal = new Counter({
  name: 'aihub_requests_total',
  help: 'Completed customer requests, labelled by operation and how they ended.',
  labelNames: ['operation', 'status', 'outcome'],
  registers: [registry],
});

const requestDuration = new Histogram({
  name: 'aihub_request_duration_seconds',
  help: 'Wall time of a completed customer request, in seconds.',
  labelNames: ['operation'],
  // A grading request runs 800-3000ms while a rejected one returns in
  // single-digit milliseconds, so the buckets are denser at the fast end
  // where the interesting distinction sits.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

const downstreamDuration = new Histogram({
  name: 'aihub_downstream_duration_seconds',
  help: 'Time spent waiting on the downstream AI service, in seconds.',
  labelNames: ['operation'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

const dispatchDeadlineMsRemaining = new Histogram({
  name: 'aihub_dispatch_deadline_ms_remaining',
  help: 'AIHUB work-deadline budget remaining immediately before downstream dispatch, in milliseconds.',
  labelNames: ['operation'],
  buckets: [
    1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
    60_000, 120_000,
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

/**
 * The bounded email kinds are the whole label domain, so this counter cannot grow
 * a series per recipient. Cancellation has a separate durable timestamp gauge;
 * only `credential_expired` pages, while routine lifecycle reasons stay quiet.
 */
const emailDeliveryFailedTotal = new Counter({
  name: 'aihub_email_delivery_failed_total',
  help: 'Email Delivery Requests that used all their attempts without provider acceptance.',
  labelNames: ['kind'],
  registers: [registry],
});

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

export function recordEmailDeliveryFailed(kind: EmailDeliveryKindLabel): void {
  emailDeliveryFailedTotal.inc({ kind });
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

const EMAIL_DELIVERY_KIND_LABELS: readonly EmailDeliveryKindLabel[] = [
  'verification_email',
  'password_reset_email',
  'organization_invite_email',
  'mfa_enabled_notification',
  'mfa_removed_notification',
  'api_key_near_expiry_notification',
];

const EMAIL_OUTBOX_BACKLOG_KIND_LABELS: readonly (
  | EmailDeliveryKindLabel
  | 'unknown'
)[] = [...EMAIL_DELIVERY_KIND_LABELS, 'unknown'];

export interface EmailOutboxBacklogSample {
  readonly kind: EmailDeliveryKindLabel | 'unknown';
  readonly queued: number;
  readonly oldestAgeSeconds: number;
}

type EmailOutboxBacklogSource = () => Promise<
  readonly EmailOutboxBacklogSample[]
>;

let emailOutboxBacklogSource: EmailOutboxBacklogSource | undefined;
let pendingBacklogRead: Promise<void> | undefined;

/**
 * Reads the queue once per scrape for both gauges. The terminal-failure
 * counter only moves when a request gives up, so it cannot see dispatch that
 * has stopped altogether; these are read from the table at scrape time for
 * exactly that reason. A failed read drops the series rather than repeating the
 * last value, because a stale "nothing waiting" is the reading that hides an
 * outage.
 */
function readEmailOutboxBacklog(): Promise<void> {
  const source = emailOutboxBacklogSource;
  if (source === undefined) return Promise.resolve();
  pendingBacklogRead ??= (async () => {
    try {
      const samples = await source();
      for (const kind of EMAIL_OUTBOX_BACKLOG_KIND_LABELS) {
        const sample = samples.find((entry) => entry.kind === kind);
        emailOutboxQueued.set({ kind }, sample?.queued ?? 0);
        emailOutboxOldestAge.set({ kind }, sample?.oldestAgeSeconds ?? 0);
      }
    } catch {
      emailOutboxQueued.reset();
      emailOutboxOldestAge.reset();
    } finally {
      pendingBacklogRead = undefined;
    }
  })();
  return pendingBacklogRead;
}

const emailOutboxQueued = new Gauge({
  name: 'aihub_email_outbox_queued',
  help: 'Email Delivery Requests queued, including rows with unknown kinds.',
  labelNames: ['kind'],
  registers: [registry],
  collect: readEmailOutboxBacklog,
});

const emailOutboxOldestAge = new Gauge({
  name: 'aihub_email_outbox_oldest_queued_age_seconds',
  help: 'Age of the oldest Email Delivery Request still waiting for dispatch.',
  labelNames: ['kind'],
  registers: [registry],
  collect: readEmailOutboxBacklog,
});

/**
 * Registers where the backlog gauges read from. Only the process that owns an
 * outbox registers one; until then the gauges expose no series.
 */
export function setEmailOutboxBacklogSource(
  source: EmailOutboxBacklogSource | undefined,
): void {
  emailOutboxBacklogSource = source;
  if (source === undefined) {
    emailOutboxQueued.reset();
    emailOutboxOldestAge.reset();
  }
}

export const setEmailOutboxCancellationSource =
  registerEmailOutboxCancellationMetric(registry);
export const setEmailDailySendBudgetSource =
  registerEmailDailySendBudgetMetric(registry);

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
 * Only called from the Request Completion hook, where the operation is the
 * catalog's own identifier. A label value is therefore bounded by the
 * catalog rather than by whatever a caller put in the URL.
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

/** A duration only reaches a histogram if it is a real, non-negative number. */
function secondsOf(milliseconds: number): number | undefined {
  return Number.isFinite(milliseconds) && milliseconds >= 0
    ? milliseconds / 1000
    : undefined;
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
