# Canary: AI Writing Contract

Runbook for the synthetic canary check that probes both AI Writing grading
endpoints and detects response-shape drift before a customer's request hits it.

## Overview

AI Writing is an external service maintained by a separate team with no
integration in this repo's CI. A breaking change to its response shape
causes `AI_SERVICE_CONTRACT_VIOLATION` on every real request — the canary
catches that within the run interval instead of reactively from a customer.

## Script

```sh
pnpm canary:ai-writing
# or directly:
tsx scripts/ops/canary-ai-writing.ts
```

**Source:** [`scripts/ops/canary-ai-writing.ts`](../../scripts/ops/canary-ai-writing.ts)

## Environment variables

| Variable                      | Required | Description                                                                                          |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `DOWNSTREAM_AI_WRITING_URL`   | Yes      | Base URL of AI Writing (origin only, e.g. `https://api.wispace.app`)                                 |
| `AIHUB_RUNTIME_SECRET_SOURCE` | Yes      | `env` for local development/test or `agent-file` for Dev/Staging/Production                          |
| `AIHUB_RUNTIME_SECRETS_FILE`  | Agent    | Path to the Vault Agent-rendered JSON when the source is `agent-file`                                |
| `CANARY_WEBHOOK_URL`          | No       | HTTP POST target for failure payloads. Unset → log the payload at info level, do not fail the script |

## Operations

Each run probes both grading endpoints in sequence:

| Operation             | Endpoint                       |
| --------------------- | ------------------------------ |
| `writing.task1.grade` | `POST /grading-feedback-task1` |
| `writing.task2.grade` | `POST /grading-feedback-task2` |

Both are run even if one fails. Fixed known-good inputs from
`test/fixtures/ai-writing/` are used.

## Recommended interval: every 6 hours

**Rationale:**

- Each run makes 2 grade calls. Downstream grade calls cost real model spend
  (16–18 s of AI processing each).
- 6 h catches a deploy-boundary drift well before any customer encounters it,
  while spending only 1/6 the grade quota of hourly.
- Operators can tighten to 1 h if the team ships multiple times per day.

**~60 s total soft budget** per run (2 × 30 s timeout, sequential).

## Exit codes

| Code | Meaning                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Both grading probes passed. Healthy signal.                                                                                                                                                    |
| `1`  | **Drift** — at least one `AI_SERVICE_CONTRACT_VIOLATION`. AI Writing shipped a breaking shape change.                                                                                          |
| `2`  | **Unverified** — transport error, timeout, HTTP 5xx or 429 on at least one. No contract violation; may be transient infra noise.                                                               |
| `3`  | **Webhook delivery failed** — canary ran and found failures, but the POST to `CANARY_WEBHOOK_URL` did not succeed (5 s timeout, one attempt, no retry). The underlying result is still logged. |

> [!IMPORTANT]
> Cron must alert on **both a non-zero exit and a missed run**.
>
> - Non-zero exit = the canary ran and found something.
> - Missed run = the canary stopped running (dead process, misconfigured cron,
>   deployment gone wrong). This is the dead-man's-switch pattern: exit 0 plus
>   the structured log line is the healthy signal; absence of that signal is itself
>   an alert condition.

## Success observability

On exit 0 the script emits one structured JSON line to stdout:

```json
{
  "event": "canary_ai_writing",
  "outcome": "ok",
  "run_id": "01J8...",
  "results": [
    { "operation": "writing.task1.grade", "downstream_ms": 16821 },
    { "operation": "writing.task2.grade", "downstream_ms": 17204 }
  ]
}
```

## Webhook payload (on non-ok outcomes)

```json
{
  "event": "canary_ai_writing",
  "run_id": "01J8...",
  "outcome": "drift",
  "checked_at": "2026-09-10T16:00:00.000Z",
  "failures": [
    {
      "operation": "writing.task1.grade",
      "class": "AI_SERVICE_CONTRACT_VIOLATION",
      "detail": "AI_SERVICE_CONTRACT_VIOLATION"
    }
  ]
}
```

`detail` contains only `AppError.code` plus the HTTP status. It never carries
`cause.message` — on the contract-violation path that field can contain a
fragment of the raw downstream body (same leak class as issue #17).

The canary resolves its bearer token through the same startup-only runtime
secret provider as the Gateway. It never reads `DOWNSTREAM_AI_WRITING_TOKEN`
directly, so a Dev/Staging/Production Agent-file cutover applies to the canary
as well.

## Failure class taxonomy

| class                           | Meaning                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `AI_SERVICE_CONTRACT_VIOLATION` | Response shape rejected by the adapter — **drift**, action required |
| `http_5xx`                      | HTTP 5xx from AI Writing — transient, may clear next run            |
| `http_429`                      | Rate limited — check token / request volume                         |
| `timeout`                       | No response within 30 s                                             |
| `transport`                     | Network-level error before any HTTP response                        |

## Dead-man's-switch

The cron monitor (e.g., Grafana OnCall, Healthchecks.io, or a simple
Prometheus `absent()` on the last-run metric) is the operator's
responsibility. Do **not** build heartbeat storage in AIHUB for this — that
is Phase 4 `webhook_endpoints` territory.

## Testing

```sh
pnpm test -- scripts/ops/canary-ai-writing.spec.ts
```

The spec uses MockAgent (undici) to replay both fixture responses without
any real network calls. Three scenarios: all pass, one drift, one 5xx.
