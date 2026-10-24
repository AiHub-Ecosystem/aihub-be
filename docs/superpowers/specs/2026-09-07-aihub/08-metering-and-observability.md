# 08 — Metering, Billing & Observability

← [Table of Contents](README.md) · [07 — Reliability & Errors](07-reliability-and-errors.md)

# K. Usage / Metering / Billing

## K.1 Where and When to Record Telemetry

`usage_records` in Postgres is the **single source of truth**. Written **before returning the HTTP response**, and directly `await`ed:

```ts
await usageRepo.insert(record); // ~1ms
return envelope;
```

This sounds counter to the conventional "never block responses" reflex. However: grading requests consume 800–3,000ms; adding 1ms of Postgres write latency is imperceptible noise. In exchange, **we require no queuing infrastructure, no in-memory buffers, and carry zero risk of data loss on process crashes**. Here, the simplest possible solution is also the most correct.

If the INSERT fails, **still return the successful response to the customer** — a telemetry write failure must never fail a successfully completed AI generation. However, actionable audit breadcrumbs must be preserved:

```ts
catch (e) {
  logger.error({ event: 'metering_write_failed', record }, 'BILLING DATA AT RISK');
}
```

The complete record payload is logged as JSON → reconstructible manually from Loki logs. Two lines of code bridging the gap between "lost billing data" and "exact forensic knowledge of what failed".

<a id="k2-billing-chưa-chốt-thì-đo-cả-hai"></a>
<a id="k2-unfinalized-billing-model-measure-both"></a>

## K.2 Unfinalized Billing Model — Measure Both Metrics

Request-based pricing is not computed by hand: `billing:statement` states what
an Organization is billed for one UTC month, with what it excluded and why, its
adjustments, and whether the month is closed ([ADR-0097](../../../adr/0097-billing-statements-adjustments-and-closed-months.md)).
Its query is `BILLING_USAGE_SQL` in
`src/modules/metering/infrastructure/postgres-billing-statement.repository.ts`,
and it bounds the month on both sides. An earlier version of this section gave
`WHERE created_at >= :month_start` with no upper bound, which counts every later
month too; do not copy it.

```sql
-- Token-based pricing (exploration only; nothing bills by token today)
SELECT organization_id,
       sum(total_tokens) FILTER (WHERE billable_requests = 1),
       count(*) FILTER (WHERE metering_status = 'missing_usage') AS unmetered
FROM usage_records
WHERE created_at >= :month_start AND created_at < :next_month_start
  AND outcome = 'success' AND environment = 'production'
GROUP BY 1;
```

The `unmetered` column dictates whether you **are even legally permitted** to bill by token. If `unmetered > 0`, token billing is unviable — and you discover this **before signing client contracts**, not after.

**Invoiced strictly when `outcome = 'success'`.** Downstream failures are absorbed by us, never billed to customers.

AI Services return aggregate token usage and `metrics.ai_processing_ms` only. Model identity is intentionally outside the provider contract and is not required for metering or billing aggregates.

## K.3 Handling Missing Usage Data

Per target architecture §24 — never fabricate numbers:

```
Missing usage -> metering_status = 'missing_usage'
              -> NEVER estimate tokens, NEVER record 0
              -> metric aihub_metering_incomplete_total + alert if > 1%
              -> business rules decide whether to reject or pass (currently: pass)
```

AIHUB **never re-tokenizes raw requests to estimate tokens** (brief §17.7).

## K.4 Nightly Maintenance Slices

Quota reconciliation is its own command and issue (#53):

```
pnpm cli quota:reconcile
```

It restores the current UTC-month Redis quota counters from the durable
`usage_records` evidence. The command is executed by cron within the
application container; no external scheduler is required. The runbook is
[`docs/operations/quota-reconciliation.md`](../../../operations/quota-reconciliation.md).

The broader nightly maintenance plan remains three separate slices:

```
1. Reconcile Redis quota counters against usage_records (Issue #53)
2. Aggregate missing_usage counts per operation -> alert if > 1%
3. Prune usage_records older than 13 months, delete expired idempotency_records
```

Issue #53 covers only the first slice. Missing-usage alerting and retention /
idempotency cleanup are separate follow-ups; the existing
`idempotency:cleanup` command is unchanged.

---

# L. Observability

## L.1 Structured Logging: Single JSON Line Per Request

```jsonc
{
  "level": "info",
  "event": "request_completed",
  "request_id": "req_01J8...",
  "correlation_id": "cust-123",
  "trace_id": "...",
  "org_id": "org_01J8...",
  "api_key_id": "ak_01J8...",
  "actor_id": "student_456",
  "operation": "writing.task1.grade",
  "environment": "production",
  "http_status": 200,
  "outcome": "success",
  "total_ms": 840,
  "admission_ms": 24,
  "downstream_ms": 810,
  "ai_processing_ms": 790,
  "total_tokens": 1130,
  "metering_status": "complete",
}
```

`admission_ms` records time from ingress until dispatch starts or the request
is refused before dispatch. A replay that returns without dispatch omits this
field and its histogram sample. `total_ms` starts when Fastify receives the
request and covers body and cookie parsing, authentication, identity checks,
rate limits, quota admission, and gateway work. For metered successes it is
sampled when the result is ready, before usage-record finalization; the
response timing, durable record, completion log, and request histogram reuse
that value. For failures it is sampled when the refusal is handled, also before
finalization. Both exclude usage-record persistence and response delivery, so
they are not client-observed end-to-end latency. Triage incidents via
`request_id`; filter customer usage via `org_id`.

Downstream failure logs append internal diagnostic payloads ([07 §J.4](07-reliability-and-errors.md#j4-internal-downstream-error-us08)) — isolated internally, never dispatched to clients.

### Three IDs, Three Distinct Roles

Per D1 §6.1 and target architecture §18:

| Identifier       | Generator                     | Purpose                                                          |
| ---------------- | ----------------------------- | ---------------------------------------------------------------- |
| `request_id`     | **AIHUB**                     | Primary distributed tracing key. Never trust client-provided IDs |
| `correlation_id` | Client via `X-Correlation-Id` | Gateway preserves and echoes for client convenience              |
| `trace_id`       | OTel / `traceparent`          | Connects distributed spans when OTel collectors are deployed     |

`request_id` is tracing metadata, **never an identity anchor**.

<a id="không-bao-giờ-log"></a>
<a id="never-logged"></a>

### Strictly Forbidden From Logs

- Raw API keys
- `X-User-Identity` values (Signed User Assertion JWTs), and the retired `X-User-Assertion` header if an unmigrated client still sends it
- **Student essay body content**

Essay content represents PII belonging to our customer's end-users — logging it creates legal liability, not just technical bad practice. Enforced via a **redaction filter** in the logger alongside **automated test verification** ([10 §N.7](10-deployment-roadmap.md#n7-testing-strategy)).

## L.2 Metrics Inventory

```
aihub_requests_total{operation,status,outcome}
aihub_request_duration_seconds{operation}          histogram
aihub_admission_duration_seconds{operation,identity_mode,retry_budget} histogram
aihub_graded_completion_duration_seconds{operation,identity_mode,retry_budget} histogram
aihub_downstream_duration_seconds{operation}       histogram
aihub_tokens_total{operation}                       counter
aihub_argon2_queue_waits_total                      counter
aihub_argon2_queue_refusals_total                   counter
aihub_breaker_state{operation}                     0 closed / 1 open / 2 half-open
aihub_rejected_total{reason}                         counter
aihub_metering_incomplete_total{operation}
aihub_redis_unavailable_total{seam}                   counter
aihub_process_resident_memory_bytes
aihub_process_heap_used_bytes
aihub_event_loop_lag_seconds
aihub_postgres_pool_total{pool}
aihub_postgres_pool_idle{pool}
aihub_postgres_pool_waiting{pool}
aihub_downstream_pool_queued{origin}
```

The Argon2 counters record process-wide queue waits and refusals without
request or tenant labels. Refusals use their own counter; `aihub_rejected_total`
remains owned by #200.

`aihub_rejected_total` counts a request once at the admission decision that
refuses it, not by re-deriving a reason from its response. Its fixed `reason`
values are `rate_limit`, `quota`, `concurrency`, and `auth`. `auth` covers API
key authentication and operation authorization, including organization
suspension, environment or scope denial, and a rejected required Signed User
Assertion. It does not count membership authorization on user-management
routes, request validation, unmatched routes, downstream failures, or Redis
unavailability. A rejected response may also increment `aihub_requests_total`
once in that separate metric family as specified by #240.

`aihub_redis_unavailable_total` increments once when a request-path protection
or cache seam reports a failed Redis operation, and does not increment for a
successful operation. Its fixed `seam` values are `graded_admission`,
`concurrency`, `rate_limit`, `quota`, `retry_budget`, `api_key_cache`,
`api_key_cache_invalidation_revoke`, `api_key_cache_invalidation_rotate`,
`api_key_cache_invalidation_suspension`, `auth_failure_counter`,
`auth_rate_limit`, `jwks_cache`, and `email_send_rate`. The three
invalidation values distinguish best-effort API-key cache deletion after
revocation, rotation, or suspension; other API-key cache command failures use
`api_key_cache`. Recording a Redis failure does not change the customer-facing
response. Neither metric carries organization, user, request, API-key, signed
assertion, or essay-content labels.

The `operation` label comes from the bounded operation catalog. A response
without a catalog operation uses the fixed value `unmatched`, the same sentinel
as the Request Completion Event's `route` field. This includes unmatched paths
and responses before a route can be resolved; the label never contains a
request path or URL. `/health` probes and `/metrics` scrapes are operational
responses and count once in `aihub_requests_total`, but are omitted from the
Request Completion Event log. A scrape's own increment is visible on the next
scrape because its response is counted after the current metrics body is sent.
A rejection may increment `aihub_rejected_total` once as a separate metric
family; it still increments `aihub_requests_total` only once.

`gateway_overhead` **requires no dedicated metric** — it is derived directly
from total and downstream durations; `admission_ms` exposes the time before
dispatch separately.

The process gauges report RSS and used V8 heap in bytes. Event-loop lag is the
99th percentile delay in seconds since the previous scrape. PostgreSQL pool
labels use the fixed pool names in the application, and downstream origin
labels come from configured HTTP pool origins. These runtime metrics carry no
organization, user, or request identifiers.

`aihub_tokens_total` carries an `operation` label only. An `org_id` label was
specified here originally and is deliberately dropped: it is unbounded, so
every Organization would multiply the series count and no runbook could
predict it. Per-Organization usage is still exact — it lives in the durable
`usage_records` aggregate and in the `request_completed` structured log line,
which is where an unbounded dimension belongs.

## L.3 Request Tracing: OTLP Endpoint, No Bundled Collector

AIHUB creates a Fastify request span and child spans for ioredis commands,
Postgres queries, and Undici downstream calls. The request span uses the route
template rather than the raw URL and records AIHUB's generated `request_id`.
W3C trace context is propagated downstream; baggage is not propagated.

Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to an OTLP/HTTP traces receiver to
enable tracing. Leave it empty to disable instrumentation. Traces are batched
and exported asynchronously, so exporter availability does not gate a customer
response. The application Compose stack does not bundle a collector or trace
store.

Span data is restricted: Redis records the command name without keys or values;
Postgres records the SQL operation name without query text or parameters;
request bodies, credentials, and raw URLs are not attached to request spans.

## L.4 Core Alerting Thresholds

```
Circuit breaker open > 2 minutes
5xx error rate > 5% over 5 minutes
p95 latency > 2x historical baseline
Redis connection loss
missing_usage > 1% over 1 hour
Postgres disk space utilization > 80%
```

The 5xx rate uses `aihub_requests_total` alone; its numerator is the 5xx
responses and its denominator is all HTTP responses in the same window:

```promql
sum(rate(aihub_requests_total{status=~"5.."}[5m]))
/
sum(rate(aihub_requests_total[5m])) > 0.05
```

Grafana alerts push notifications directly to developer chat channels. No separate Alertmanager container — eliminates another misconfiguration vector.

### L.4.1 Synthetic Canary — AI Writing Contract

Beyond reactive metrics, a synthetic canary actively probes AI Writing's response shape every 6 hours. If AI Writing deploys an unannounced breaking change, the canary detects it within the run interval before customer traffic is impacted.

→ Runbook: [Canary: AI Writing Contract](../../../operations/canary-ai-writing.md)

---

→ Next: [09 — Security Threat Model](09-security.md)
