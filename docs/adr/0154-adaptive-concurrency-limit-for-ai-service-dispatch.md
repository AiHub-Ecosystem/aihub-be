# ADR-0154: Adaptive concurrency limit for AI-service dispatch

- Status: Accepted
- Date: 2026-11-07
- Related: [#1590](https://github.com/AiHub-Ecosystem/aihub-be/issues/1590), [ADR-0149](0149-process-local-bulkheads-for-ai-and-object-storage.md)

## Context

ADR-0149 left a process-local static bulkhead of 10 concurrent requests per
AI-service origin in `DownstreamHttpClient` and explicitly deferred adaptive
tuning to #1590. A static cap contains a stalled dependency but cannot find
the knee where the downstream service starts queueing, and the undici Pool
setting had to match the cap to preserve the HTTP/1.1 capacity assumption.

Meanwhile `RedisConcurrencyLimiter` still gates graded requests per
Organization at a fixed cap. That limiter protects the control plane from
runaway tenants; it does not know whether the AI service itself is
degrading. Under a provider latency spike both limiters refuse the same
traffic, and the Redis gate hides RTT evidence the adaptive signal needs.

## Decision

Replace the static per-origin bulkhead with a Gradient2-style adaptive
limit in `src/modules/gateway/infrastructure/dispatch/`, following Netflix
concurrency-limits. Each configured origin gets its own `Gradient2Limit`:

- the long-term RTT baseline is an exponentially weighted average (warm-up
  window 10, long window 600, factor `2/(n+1)`);
- every completed downstream request reports its wall time;
- the gradient is `max(0.5, min(1.0, tolerance * longRtt / currentRtt))`
  with tolerance `1.25`, a queue allowance of `1`, and smoothing `0.2`;
- the baseline decays 5% whenever it exceeds twice the current RTT, so a
  recovering provider pulls the limit back up instead of waiting for the
  exponential average to catch down;
- the limit is seeded at `10` (the previous static value), bounded to a
  minimum of `2` and a maximum of `20`;
- admission is per origin and fail-fast: when `inFlight >= limit`, excess
  work is refused with retryable `AI_SERVICE_UNAVAILABLE` and the existing
  `ai_service:bulkhead_exhausted` diagnostic, marked definitely-not-
  dispatched, so the dispatcher never queues behind a degrading origin and
  never burns the socket budget.

The Undici Pool ceiling rises from `10` to `20` connections per origin so
the socket layer never queues before the adaptive limit — the adaptive
limit is now the single admission signal per origin, and the Pool cap is a
documented hard ceiling that kills HTTP/1.1 capacity instead of blocking on
a stalled dependency.

`RedisConcurrencyLimiter` is kept unchanged as the tenant-facing fallback
gate. It still enforces the per-Organization fixed cap in the graded
pipeline and is not named by #1590's acceptance criteria beyond "removed or
documented as fallback"; this ADR records it as the fallback, so when the
adaptive limiter is disabled the deployment still refuses runaway tenants.
The two limiters protect different axes (tenant fairness vs. provider
health) and are expected to compose, not compete.

`src/common/observability/downstream-concurrency-metrics.ts` exposes the
four metrics the acceptance criteria name, labelled by configured origin
only (never request data), following the established origin-label pattern
used by `aihub_downstream_pool_queued`:

- `aihub_downstream_concurrency_limit` (gauge) — current adaptive limit;
- `aihub_downstream_rtt_min_seconds` (gauge) — RTT baseline in seconds;
- `aihub_downstream_rtt_avg_seconds` (gauge) — last/average RTT in seconds;
- `aihub_downstream_limit_dropped_total` (counter) — refused admissions.

The Grafana and alert path from #903 can scrape these unchanged; an alert
rule for the floor projection is tracked as follow-up and is not added in
this slice because no production RTT distribution exists yet to ground a
threshold.

## Consequences

A provider that slows from 1 s to 20 s drives the limit from 10 toward the
2 floor within a few hundred samples; the load test in
`downstream-http.client.spec.ts` proves the degraded origin fast-fails
without blocking another origin, and the route-isolation test from ADR-0149
still passes because the seeded limit equals the old static value.

The limiter is process-local, like ADR-0149's bulkhead; total in-flight work
scales with the number of instances. The 5% recovery decay and the 0.5
gradient floor keep the limit from collapsing below the floor during a
single outlier sample.

Follow-ups: add an alert rule once production RTT distributions ground a
threshold, and revisit whether the static tenant cap should also adapt.
