# 07 — Reliability & Unified Error Model

← [Table of Contents](README.md) · [06 — Routing & Adapter](06-routing-adapter.md)

# I. Reliability

## I.1 Cascading Timeout Budgets

```
Caddy                     120s     must always EXCEED upstream application limits
 └─ AIHUB op.timeoutMs     60s     grading    (generation: 10s / 30s)
     └─ undici headers/bodyTimeout = remainder of the allocated budget
         └─ x-request-deadline header -> informs AI Writing how much time remains
```

The overall deadline is computed **exactly once** upon request arrival (`ctx.deadlineMs`); all subsequent pipeline steps deduct elapsed time from this single budget. Timeouts are never configured independently — otherwise, cumulative retries would easily breach the global client timeout.

Customer-facing integration docs must state explicitly: _Grading requests may take up to 60 seconds; client-side timeouts must be configured to at least 90 seconds._ If not documented in advance, clients will set default 30s timeouts and experience artificial client-side drops.

<a id="i2-retry--phân-biệt-chưa-gửi-và-không-biết"></a>
<a id="i2-retries-distinguishing-untransmitted-from-unknown-state"></a>

## I.2 Retries — Distinguishing "Untransmitted" from "Unknown State"

This principle governs our entire retry strategy, and **it does not depend purely on HTTP status codes**:

```
ECONNREFUSED / DNS resolution failure / TCP handshake reset
  -> Request NEVER reached the downstream AI Service -> Safe to retry, even expensive generative POSTs

Timeout after request dispatch / connection reset mid-flight
  -> UNKNOWN whether the model began inference -> Default: DO NOT retry
```

| Failure Scenario                         | Retry?                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| Connection failure (`ECONNREFUSED`, DNS) | Yes, maximum 2 attempts                                                        |
| `503` with valid `Retry-After`           | Yes, 1 attempt, if remaining deadline allows                                   |
| `502`, `500`                             | 1 attempt for `GET` operations only; POST never retried blindly                |
| Timeout after dispatch                   | **No** — see [§I.5](#i5-timeouts-and-idempotency-keys-avoiding-double-charges) |
| Any `4xx` client error                   | Never — retrying client errors is useless                                      |
| Circuit breaker open                     | No, fail immediately with 503                                                  |

### Backoff Strategy: Full Jitter

```ts
const delay = Math.random() * Math.min(2_000, 200 * 2 ** attempt);
if (Date.now() + delay + expectedMs > ctx.deadlineMs) throw lastError; // abandon if budget exhausted
```

Full jitter (randomized uniformly **from 0**) instead of fixed exponential plus jitter: when AI Writing recovers from an outage, synchronous retries would hammer it back down. Randomizing from zero disperses retry spikes evenly.

Max 1–2 retries + circuit breakers limits downstream load amplification to at most 2x.

<a id="i3-circuit-breaker--opossum-key-theo-operation"></a>
<a id="i3-circuit-breaker-opossum-keyed-by-operation"></a>

## I.3 Circuit Breaker — `opossum`, Keyed by Operation

```ts
new CircuitBreaker(call, {
  errorThresholdPercentage: 50,
  volumeThreshold: 20, // do not trip on initial low-sample blips
  resetTimeout: 30_000, // wait 30s before sending a probe canary request
  timeout: false, // undici handles network timeouts; avoid duplicate timers
});
```

**Never roll custom circuit breakers.** Correct breakers require rolling statistical windows and a half-open state that permits strictly **one** trial request through. Custom implementations frequently leak hundreds of concurrent requests in half-open state, crashing recovering services immediately.

**Keyed by `operation`, not by `downstream`.** If `/grading-feedback-task1` is failing while `/generate-question-task1` is healthy, a service-wide breaker would needlessly take down question generation. Same amount of code, vastly superior fault isolation.

**Only 5xx / timeouts / transport connection faults count as failures.** `4xx` responses from downstream **never** count — the service is healthy; the client simply submitted invalid parameters. Counting 4xx errors would allow a single client sending invalid payloads to trip the circuit breaker and knock out service for **all other customers**.

Open breaker → `503 AI_SERVICE_UNAVAILABLE`, with `retry_after_ms` indicating time until the next exploratory probe.

## I.4 Idempotency — Full Lifecycle

```
fingerprint = sha256( canonicalJSON(validatedBody) + actorId )
```

Hashing occurs **after validation and canonical normalization** (keys sorted alphabetically), never on raw request bytes — otherwise whitespace discrepancies cause false `409` conflicts. `actorId` is incorporated because identical keys used across two different students represent distinct business operations.

State machine and race handling: see [03 §E.4](03-database.md#e4-handling-idempotency-race-conditions-without-distributed-locks).

### 4xx Errors PURGE the Idempotency Record

```ts
if (status >= 400 && status < 500) await idem.delete(key);
```

If a client sends an invalid payload, fixes their typo, and retries with the same idempotency key: persisting the 4xx failure would permanently lock them into `409 IDEMPOTENCY_CONFLICT`. **No model costs were incurred for 4xx requests**, so there is nothing financial to protect. Purging allows immediate re-submission.

24-hour retention per D1 §26; nightly cron cleans `DELETE WHERE expires_at < now()`.

<a id="i5-timeout--idempotency-key-không-mất-tiền-hai-lần"></a>
<a id="i5-timeouts-and-idempotency-keys-avoiding-double-charges"></a>

## I.5 Timeouts & Idempotency Keys: Avoiding Double Charges

Direct consequence of [06 §H.7](06-routing-adapter.md#h7-client-aborts-mid-request-financial-handling), resolving our thorniest edge case.

When an operation times out and the request **carried an `Idempotency-Key`**:

```
1. Return 504 AI_SERVICE_TIMEOUT immediately to the client
2. BUT do not abort the downstream AI Writing call — allow it to finish in background
3. Upon downstream completion -> write result to idempotency_records, state = completed
4. When the client retries with the same key -> return the cached result WITHOUT calling the model again
```

The monetary charge was already incurred on the initial dispatch. Aborting mid-stream loses both the money and the output, forcing the client's retry to spend tokens all over again. **Allowing it to complete charges the customer exactly once.**

Safety boundary: background execution is strictly aborted if it exceeds `2 × timeoutMs`, and terminates on process recycling during deployments. If aborted, the record expires and allows clean retry — worst-case single charge, never stuck.

Requests without an idempotency key are aborted immediately to conserve tokens.

## I.6 Bulkheads & Load Shedding

Handled naturally via architecture documented in [04 — Redis](04-redis.md):

- Per-organization concurrency limits (Redis sorted set) — prevents single-tenant monopolization.
- Local in-memory backstop `GLOBAL_MAX_INFLIGHT` — protects gateway processes during Redis outages.
- Undici pool `connections: 64` per downstream — establishes hard ceilings on concurrent load to AI Writing.

---

# J. Unified Error Model

## J.1 Error Response Envelope

```json
{
  "error": {
    "code": "AI_SERVICE_TIMEOUT",
    "message": "AI service did not respond in time",
    "request_id": "req_01J8...",
    "retryable": true,
    "retry_after_ms": 2000
  }
}
```

**Never leaked externally:** stack traces, internal URLs, database error messages, upstream model/provider identities, raw downstream vendor exceptions.

<a id="j2-danh-sách-mã-lỗi-v1"></a>
<a id="j2-error-code-inventory-v1"></a>

## J.2 Error Code Inventory v1

| HTTP Status | Error Code                      | Condition                                       | Retryable                 |
| ----------: | ------------------------------- | ----------------------------------------------- | ------------------------- |
|         400 | `INVALID_REQUEST`               | Schema violation, unknown properties            | No                        |
|         401 | `UNAUTHORIZED`                  | Missing or invalid API key                      | No                        |
|         401 | `USER_ASSERTION_REQUIRED`       | User-scoped operation lacks user assertion      | No                        |
|         401 | `INVALID_USER_ASSERTION`        | Bad signature, expired, or invalid claims       | No                        |
|         403 | `FORBIDDEN`                     | Insufficient scopes / entitlements              | No                        |
|         403 | `ENVIRONMENT_NOT_ALLOWED`       | API key not authorized for this environment     | No                        |
|         404 | `NOT_FOUND`                     | Endpoint or resource does not exist             | No                        |
|         409 | `IDEMPOTENCY_CONFLICT`          | Reused key with divergent payload or in-flight  | No                        |
|         413 | `PAYLOAD_TOO_LARGE`             | Exceeds operation `maxBodyBytes`                | No                        |
|         429 | `RATE_LIMITED`                  | Breached AIHUB per-minute rate limit            | Yes                       |
|         429 | `CONCURRENCY_LIMIT`             | Too many simultaneous in-flight requests        | Yes (immediate)           |
|         429 | `QUOTA_EXCEEDED`                | Monthly allocated quota depleted                | Next month                |
|         502 | `AI_SERVICE_ERROR`              | Downstream returned 5xx                         | Potentially               |
|         502 | `AI_SERVICE_CONTRACT_VIOLATION` | Downstream returned unparseable shape           | No                        |
|         503 | `AI_SERVICE_UNAVAILABLE`        | Downstream unreachable or circuit breaker open  | Yes                       |
|         503 | `AI_SERVICE_THROTTLED`          | Downstream or underlying LLM provider throttled | Yes                       |
|         503 | `IDENTITY_PROVIDER_UNAVAILABLE` | Unable to fetch customer's JWKS keys            | Yes                       |
|         504 | `AI_SERVICE_TIMEOUT`            | Operation exceeded deadline budget              | Only with Idempotency-Key |

### Six Error Codes Added Beyond Initial D1 Specs

Added to D1 §25 prior to freezing: `USER_ASSERTION_REQUIRED`, `ENVIRONMENT_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `CONCURRENCY_LIMIT`, `AI_SERVICE_CONTRACT_VIOLATION`, `IDENTITY_PROVIDER_UNAVAILABLE`.

Most critical addition: **`AI_SERVICE_CONTRACT_VIOLATION`**. When AI Writing silently alters its response schema without notifying us, this must be distinguished from transient infrastructure failure. Grouping it under `AI_SERVICE_ERROR` prompts operators to chase phantom network bugs when the real cause was an unannounced downstream deploy.

**`IDENTITY_PROVIDER_UNAVAILABLE`** is also distinct: this is neither a client authentication error (returning 401 would prompt useless client key rotation) nor a failure of the AI service itself.

### Preserving D1's Disambiguation Principles

```
Client breaches AIHUB rate limit     -> 429 RATE_LIMITED
Organization exhausts quota           -> 429 QUOTA_EXCEEDED
Downstream AI Service / LLM throttled -> 503 AI_SERVICE_THROTTLED   ← NEVER return 429
```

Sending 429 when downstream LLMs throttle leads customers to believe they breached their own contract tier, prompting them to needlessly attempt client-side backoff.

## J.3 Centralized Error Handling

```
Global ExceptionFilter
 ├─ AihubError            -> uses explicitly mapped code/status
 ├─ Fastify schema error  -> INVALID_REQUEST + JSON path to invalid property
 ├─ undici / opossum error-> DownstreamErrorMapper (shared across all adapters)
 └─ Unhandled exceptions  -> INTERNAL_ERROR + full internal stack logging
```

**Controllers never craft custom error responses. Adapters never throw raw HTTP exceptions.**

<a id="j4-internal-downstream-error-us08"></a>

## J.4 Internal Downstream Error Telemetry (US08)

Internal logs retain comprehensive diagnostics for AIHUB developers, and **strictly here**:

```json
{
  "request_id": "req_01J8...",
  "ai_service": "ai-writing",
  "downstream_status": 503,
  "downstream_error_code": "MODEL_NOT_READY",
  "downstream_message": "Model worker unavailable",
  "downstream_ms": 30120,
  "private_endpoint": "/grading-feedback-task1"
}
```

**`downstream_error_code` and `downstream_message` are illustrative examples.** The live AI Writing service returns raw `{"detail": "..."}` without error codes, so `HttpOperationDispatcher` records `null` for both fields today. Populating them accurately requires a standardized downstream error contract, followed by fixture capture and implementing `parseError` in `DownstreamAdapter`. See `docs/aihub_deliverable_1_api_contract_schema.md` US10.

---

→ Next: [08 — Metering & Observability](08-metering-and-observability.md)
