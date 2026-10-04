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

```sql
-- Request-based pricing
SELECT organization_id, operation, sum(billable_requests) AS billable_requests
FROM usage_records
WHERE created_at >= :month_start AND outcome = 'success'
GROUP BY 1, 2;

-- Token-based pricing
SELECT organization_id,
       sum(total_tokens) FILTER (WHERE billable_requests = 1),
       count(*) FILTER (WHERE metering_status = 'missing_usage') AS unmetered
FROM usage_records
WHERE created_at >= :month_start AND outcome = 'success'
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
  "downstream_ms": 810,
  "ai_processing_ms": 790,
  "total_tokens": 1130,
  "metering_status": "complete",
}
```

Identical schema across all requests, including errors. Triage incidents via `request_id`; filter customer usage via `org_id`.

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

## L.2 Metrics Inventory — Exactly 8 Metrics

```
aihub_requests_total{operation,status,outcome}
aihub_request_duration_seconds{operation}          histogram
aihub_downstream_duration_seconds{operation}       histogram
aihub_tokens_total{operation}                       counter
aihub_rejected_total{reason}                       rate_limit|quota|concurrency|auth
aihub_breaker_state{operation}                     0 closed / 1 open / 2 half-open
aihub_metering_incomplete_total{operation}
aihub_redis_unavailable_total
```

Answers every performance question raised in brief §13.12. `gateway_overhead` **requires no dedicated metric** — it is derived directly from the delta between the first two histograms.

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

Grafana alerts push notifications directly to developer chat channels. No separate Alertmanager container — eliminates another misconfiguration vector.

### L.4.1 Synthetic Canary — AI Writing Contract

Beyond reactive metrics, a synthetic canary actively probes AI Writing's response shape every 6 hours. If AI Writing deploys an unannounced breaking change, the canary detects it within the run interval before customer traffic is impacted.

→ Runbook: [Canary: AI Writing Contract](../../../operations/canary-ai-writing.md)

---

→ Next: [09 — Security Threat Model](09-security.md)
