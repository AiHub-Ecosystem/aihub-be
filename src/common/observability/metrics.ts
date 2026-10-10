import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';

/**
 * The metric names spec section L.2 fixes. Issue #198 owns five of the
 * eight; the protection-state metrics (`aihub_rejected_total`,
 * `aihub_redis_unavailable_total`) belong to #200 and the breaker gauge to
 * #199, so they are absent here until those land rather than pre-empted.
 */
export const METRICS_ROUTE_PATH = '/metrics';

const registry = new Registry();

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

/**
 * The bounded email kinds are the whole label domain, so this counter cannot grow
 * a series per recipient. A cancellation is deliberately absent: ADR-0074 calls
 * it expected lifecycle handling, so paging on it would train operators to
 * ignore the counter that does page.
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

export type PostgresPoolName =
  | 'auth'
  | 'idempotency'
  | 'sandbox-dispatch-budget'
  | 'avatar'
  | 'speaking-audio-upload'
  | 'metering'
  | 'identity'
  | 'identity-read'
  | 'identity-write'
  | 'integration-test';

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

export type EmailDeliveryKindLabel =
  | 'verification_email'
  | 'password_reset_email'
  | 'organization_invite_email'
  | 'mfa_enabled_notification'
  | 'mfa_removed_notification';

export function recordEmailDeliveryFailed(kind: EmailDeliveryKindLabel): void {
  emailDeliveryFailedTotal.inc({ kind });
}

const EMAIL_DELIVERY_KIND_LABELS: readonly EmailDeliveryKindLabel[] = [
  'verification_email',
  'password_reset_email',
  'organization_invite_email',
  'mfa_enabled_notification',
  'mfa_removed_notification',
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
