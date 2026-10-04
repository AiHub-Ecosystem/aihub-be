import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from '@prometheus-io/client';

/**
 * The metric names spec section L.2 fixes. Issue #198 owns five of the
 * eight; the protection-state metrics (`aihub_rejected_total`,
 * `aihub_redis_unavailable_total`) belong to #200 and the breaker gauge to
 * #199, so they are absent here until those land rather than pre-empted.
 */
export const METRICS_ROUTE_PATH = '/metrics';

const registry = new Registry();

// Node process and event-loop metrics, so a dashboard can show what the
// service itself was doing while a request was slow. Prefixed to keep them
// from colliding with the `aihub_` business series below.
collectDefaultMetrics({ register: registry, prefix: 'aihub_process_' });

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
