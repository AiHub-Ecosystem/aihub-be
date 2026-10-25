# AIHUB service-level objectives

These are internal operating objectives for Production, not customer SLAs.
The measurement window is a rolling 30 days; Sandbox is excluded from the
objectives. The application runs as a single instance on one shared VPS, so
host failure, maintenance, and resource contention can affect every journey at
once. A 99.5% gateway availability target accepts at most 3 hours 36 minutes
of gateway-owned unavailability per 30 days; it does not claim host
redundancy.

## Journeys and targets

| Journey                   | Gateway availability | Gateway overhead latency | AI Service success | AI Service latency                      |
| ------------------------- | -------------------- | ------------------------ | ------------------ | --------------------------------------- |
| `graded_request`          | 99.5%                | 95% at or below 1 second | 99% per provider   | 95% at or below 30 seconds per provider |
| `authentication`          | 99.5%                | 95% at or below 1 second | Not applicable     | Not applicable                          |
| `organization_management` | 99.5%                | 95% at or below 1 second | Not applicable     | Not applicable                          |
| `api_key_management`      | 99.5%                | 95% at or below 1 second | Not applicable     | Not applicable                          |

The authentication journey includes the public `auth.*` routes, including
login and refresh. Organization management includes `organizations.*` except
`organizations.apiKeys.*`; API-key management includes that API-key route
family. Graded requests are the four operation-catalog routes. The SLO metric
uses only these fixed journey labels and never labels a request with an
organization, user, key, or raw URL.

The gateway availability numerator is successful responses; its denominator
is successful plus gateway-internal-error responses. Client errors and
`downstream_error` are excluded so bad input and provider outages consume only
their own budgets. AI Service success is measured only over successful and
`downstream_error` outcomes for that provider's operations. Provider errors
are reported independently from gateway errors.

Gateway latency is `max(total_ms - downstream_ms, 0)` for graded requests and
`total_ms` for routes that do not call an AI Service. The subtraction uses
the same request timing evidence as durable metering; negative rounding
difference is clamped to zero. AI Service latency is the measured downstream
wait. The 1-second gateway threshold is 303 ms above the observed 30-day
graded-request p95. The 30-second provider threshold is half of the gateway's
60-second downstream deadline, leaving room to act before requests time out.
The 99% provider success target is an internal objective because AIHUB does
not control provider availability.

## Measured baseline

Measured at `2026-10-25T02:44:43Z` from Production `usage_records`, using
successful rows from the preceding 30 days and all four graded operations:

| Samples | Gateway overhead p50 | Gateway overhead p95 |
| ------: | -------------------: | -------------------: |
|     572 |                 7 ms |               697 ms |

The measurement query is:

```sql
SELECT
  count(*) AS sample_count,
  percentile_cont(0.50) WITHIN GROUP (
    ORDER BY GREATEST(total_ms - COALESCE(downstream_ms, 0), 0)
  ) AS p50_gateway_ms,
  percentile_cont(0.95) WITHIN GROUP (
    ORDER BY GREATEST(total_ms - COALESCE(downstream_ms, 0), 0)
  ) AS p95_gateway_ms
FROM usage_records
WHERE environment = 'production'
  AND outcome = 'success'
  AND created_at >= now() - interval '30 days';
```

This baseline covers metered graded requests; authentication and management
routes are measured by the live journey metrics after rollout, not by
`usage_records`.

## Exact SLIs

Replace `graded_request` with `authentication`, `organization_management`, or
`api_key_management` for the other gateway journeys. The SLO window query uses
`[30d]`; live alerts use the short windows in the next section.

Gateway availability:

```promql
1 - sum(rate(aihub_critical_journey_requests_total{job="aihub-production-app",journey="graded_request",outcome="internal_error"}[30d]))
  / sum(rate(aihub_critical_journey_requests_total{job="aihub-production-app",journey="graded_request",outcome=~"success|internal_error"}[30d]))
```

Gateway overhead latency compliance:

```promql
sum(rate(aihub_gateway_overhead_duration_seconds_bucket{job="aihub-production-app",journey="graded_request",le="1"}[30d]))
  / sum(rate(aihub_gateway_overhead_duration_seconds_count{job="aihub-production-app",journey="graded_request"}[30d]))
```

AI Writing success and latency use
`operation=~"writing\\.task1\\.grade|writing\\.task2\\.grade"`:

```promql
1 - sum(rate(aihub_requests_total{job="aihub-production-app",operation=~"writing\\.task1\\.grade|writing\\.task2\\.grade",outcome="downstream_error"}[30d]))
  / sum(rate(aihub_requests_total{job="aihub-production-app",operation=~"writing\\.task1\\.grade|writing\\.task2\\.grade",outcome=~"success|downstream_error"}[30d]))

sum(rate(aihub_downstream_duration_seconds_bucket{job="aihub-production-app",operation=~"writing\\.task1\\.grade|writing\\.task2\\.grade",le="30"}[30d]))
  / sum(rate(aihub_downstream_duration_seconds_count{job="aihub-production-app",operation=~"writing\\.task1\\.grade|writing\\.task2\\.grade"}[30d]))
```

AI Speaking success and latency use
`operation=~"speaking\\.grading(-json)?"` with the same expressions and
`aihub_downstream_duration_seconds` histogram. These queries make the provider
identity explicit; the operation-to-provider mapping is owned by
`src/catalog/operation-catalog.ts`.

## Burn-rate alerts

Gateway availability and latency, and each provider's success and latency,
use two multi-window pairs against the rolling 30-day error budget:

- Fast burn: 14.4x over 5 minutes **and** 1 hour; critical.
- Sustained burn: 6x over 30 minutes **and** 6 hours; warning.

The alert rules are in `ops/monitoring/alert.rules.yml`, with executable
examples in `alert.rules.test.yml`. Provider rules name AI Writing or AI
Speaking. No traffic produces no ratio and does not burn the request-based
budget; edge availability is monitored separately.

## Error-budget policy

If any rolling 30-day Production objective falls below its target, the
repository maintainer and incident commander, `@lengocanh2005it`, pauses new
feature merges to `main`. Only fixes that restore reliability, security, or
data integrity may merge until every affected SLO is back at target. The
maintainer records the decision and recovery evidence on the active incident
or reliability issue. This is a human-reviewed release policy; it is not
enforced by a GitHub branch rule.

See the [SLO alert runbook](aihub-observability.md#slo-alerts) for response
steps and the [alert catalog](alert-catalog.md) for the configured route.
