# 04 — Redis Design

← [Table of Contents](README.md) · [03 — Database](03-database.md)

> Governing principle for this entire document (brief §17.8):
>
> **Redis is never the source of truth. When Redis dies, AIHUB slows down and loses part of its protective shielding — but it never returns corrupted results and never permits a request that should have been rejected for authorization reasons.**

## F.1 Key Inventory

Prefix `aihub:v1:` — evolving the cache schema later only requires bumping to `v2`, avoiding manual cleanup of stale keys.

| Key                             | Type    | TTL            | Source of Truth        | When Redis Dies                                                        |
| ------------------------------- | ------- | -------------- | ---------------------- | ---------------------------------------------------------------------- |
| `v1:key:<sha256hex>`            | JSON    | 60s            | Postgres               | Falls through directly to Postgres                                     |
| `v1:key:miss:<sha256hex>`       | `1`     | 30s            | Postgres               | Same as above                                                          |
| `v1:jwks:<org_id>`              | JSON    | 15m            | Customer JWKS endpoint | Fetches directly (with SSRF guards)                                    |
| `v1:authfail:<ip>`              | counter | 300s           | —                      | **Fail open** + emit alert                                             |
| `v1:rl:<key_id>:<minute>`       | counter | 120s           | —                      | Graded: **fail closed** (503); other: local backstop                   |
| `v1:inflight:<org_id>`          | zset    | self-cleaning  | —                      | **Fail closed** (503) until it recovers                                |
| `v1:quota:<org_id>:<YYYY-MM>`   | counter | 40 days        | `usage_records`        | Graded: **fail closed** (503); other: unverified, or 503 for hard stop |
| `v1:org-retry:{org_id}:first`   | zset    | 120s           | —                      | **Fail closed** (refuse) until it recovers                             |
| `v1:org-retry:{org_id}:repeats` | zset    | 120s           | —                      | **Fail closed** (refuse) until it recovers                             |
| `v1:org-retry:{org_id}:seen`    | zset    | 24h, refreshed | —                      | **Fail closed** (refuse) until it recovers                             |

**Zero keys dedicated to idempotency.** The brief suggested "Redis + durable fallback"; this design eliminates Redis from that path entirely. Postgres's `ON CONFLICT` handles race conditions natively ([03 §E.4](03-database.md#e4-handling-idempotency-race-conditions-without-distributed-locks)), and introducing Redis would create dual sources of truth for the one mechanism that must never desynchronize.

The retry-budget ledger is the one structure here whose size follows traffic. `seen` remembers each Organization, operation, and Idempotency-Key for 24 hours so a repeat can be classified, and is capped at 10,000 remembered keys per Organization ([ADR-0113](../../../adr/0113-organization-and-service-retry-budgets.md)). At the ceiling the oldest members are dropped, so a dropped key's next request counts as a first attempt: the budget becomes more permissive for an old key but never refuses a first attempt it could not classify. The cap is a memory safety bound, not a capacity promise — with `maxmemory-policy noeviction` (§F.6) an unbounded ledger would fail every Redis write on the instance, not only this one.

<a id="f2-rate-limit-fixed-window-không-lua"></a>
<a id="f2-rate-limit-fixed-window-without-lua"></a>

## F.2 Rate Limiting: Fixed Window, No Lua

```ts
const bucket = `v1:rl:${keyId}:${Math.floor(Date.now() / 60000)}`;
const n = await redis.incr(bucket);
if (n === 1) await redis.expire(bucket, 120);
if (n > org.rate_limit_rpm)
  throw new RateLimitedError({ retryAfterMs: msToNextMinute() });
```

```
Trade-off: fixed window -> maximum burst of 2x rate_limit_rpm across minute boundaries.
Upgrade to GCRA / sliding window via Lua script if customers raise fairness concerns,
or if rate limits become contractual SLA commitments.
```

We accept the potential 2x burst because the purpose of rate limiting here is **to prevent runaway clients from knocking over downstream AI services**, not sub-second precision fairness. A 2x spike over one second will not crash the downstream. A sliding window requires custom Lua scripts — adding testing and debugging overhead that is not justified at Stage A.

## F.3 Concurrency Limiting — More Critical Than Rate Limiting

Brief §15 observed: _"AI requests exhibit high latency and hold open connections, so concurrency is often far more critical than raw RPS."_ Consequently: **RPM rate limits provide almost zero protection for downstream systems**.

Example: A customer sends 60 requests/minute (well within limit), but each request takes 30 seconds to run → at any given time, ~30 requests hang open against AI Writing. Three such customers will collapse AI Writing — **even though none of them ever breached their rate limits**.

```ts
const k = `v1:inflight:${orgId}`;
await redis.zremrangebyscore(k, 0, Date.now() - 120_000); // prune stale/dead requests
if ((await redis.zcard(k)) >= org.max_concurrent)
  throw new ConcurrencyLimitError();
await redis.zadd(k, Date.now(), requestId);
try {
  /* invoke downstream */
} finally {
  await redis.zrem(k, requestId);
}
```

We utilize a sorted set (zset) instead of `INCR`/`DECR` because sorted sets are **self-healing**: if a worker process crashes mid-execution, `finally` never runs, `DECR` is permanently lost, and counters drift upwards until that organization is indefinitely locked out. `zremrangebyscore` cleans up zombie entries older than 120 seconds automatically.

Default `max_concurrent = 20`/org → triggers `429 CONCURRENCY_LIMIT` with a short `retry_after_ms` (~500ms).

<a id="f4-quota"></a>

## F.4 Quota Management

```
Hot path:       INCR v1:quota:<org>:<YYYY-MM>  -> compare against monthly_request_quota
Nightly job:    SELECT count(*) FROM usage_records
                WHERE organization_id=$1 AND created_at >= <start of month>
                -> SET overwrite to reconcile Redis counter
```

The Redis counter acts as a **fast gating heuristic**; `usage_records` is the definitive number used for invoicing. The nightly job reconciles the counter against truth, ensuring any intraday drift never impacts billing.

**A missing counter is never zero usage (#371).** The shared Redis can lose a key to a restart, eviction, or `FLUSHDB` (#348). When the current month's key is absent, admission rebuilds it from `usage_records` with the reconciliation job's filter and writes it with `SET NX`, so concurrent requests seed it once (one durable read per process, the first writer across processes). `aihub_quota_counter_seeds_total{outcome}` counts each rebuild. If the durable read fails, the request is admitted as `quota_unverified`, or refused with retryable `503 REDIS_UNAVAILABLE` for a hard-stop Organization. A post-result increment never recreates a missing counter at 1; it leaves the rebuild to the next admission.

Exceeded quota → `429 QUOTA_EXCEEDED`, with `retry_after_ms` calculated to the start of the next calendar month.

<a id="f5-redis-chết-thì-sao--quyết-định-từng-mục"></a>
<a id="f5-what-happens-when-redis-dies-item-by-item-decisions"></a>

## F.5 What Happens When Redis Dies — Item-by-Item Decisions

| Lost Capability          | Selected Behavior                                                                             | Rationale                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| API key cache            | Fallback to Postgres                                                                          | Completely correct, only slightly higher latency. Postgres easily handles 50 RPS           |
| Brute-force protection   | **Allow through** + emit alert                                                                | 256-bit entropy keys cannot be brute-forced during a transient Redis outage                |
| Rate limiting            | Graded: **refuse** 503; other: **allow through** + local backstop                             | ADR-0116 for graded routes; a non-graded route keeps a process-local ceiling               |
| Concurrency limiting     | **Refuse** 503 `REDIS_UNAVAILABLE`                                                            | ADR-0116: no permit without a verified Redis decision; permits exist only on graded routes |
| Quotas                   | Graded: **refuse** 503; other: **allow through** + `quota_unverified`, or 503 for a hard stop | See detailed justification below; #373 for the hard-stop answer                            |
| JWKS cache               | Fetch directly from upstream                                                                  | Slower, but fully secure                                                                   |
| **Auth & Authorization** | **Zero Redis dependency**                                                                     | No branch ever allows "Redis is down, so grant access"                                     |

The last line represents an absolute boundary: failing open on rate limiting risks _money_; failing open on authorization risks _customer data_.

> **Amended for graded routes by [ADR-0116](../../../adr/0116-post-result-grading-completion-timing.md).** Grading admission (rate limit, Organization retry budget, quota) and the concurrency permit now run as verified Redis decisions. A Redis error or ambiguous result refuses with retryable `503 REDIS_UNAVAILABLE` (`retry_after_ms: 1000`); no local counter admits a graded request, so the per-process backstop below applies only to non-graded rate limiting and to local-auth rate limits. A post-result quota increment failure still marks usage `quota_unverified`. The fault-injection tests in `test/db/tenant-isolation/fault-injection/` (#328) cover every row of this table as amended.

### Why Quotas Fail Open

**Allowing a request through can be corrected post-facto; rejecting it cannot.**

Every request that passes through is recorded durably in `usage_records` in Postgres. A Redis failure does not destroy that record. The following morning, operators know precisely which org exceeded their allowance by how much, and can decide whether to invoice the overrun or forgive it — **a decision made with full data, not in the dark at 3 AM**.

Rejecting requests does the opposite: a student attempts to submit an essay, receives an error, contacts the teacher, who escalates to the school administration, who escalates to us. No operational action can undo that reputational damage — destroying customer trust just to protect small token costs.

Quantifying real downside exposure:

```
Non-graded route, Redis down -> local per-minute rate ceiling remains active
Graded route, Redis down -> refused with 503 REDIS_UNAVAILABLE (ADR-0116), so no unmetered grading
```

A few tens of dollars in AI model fees in exchange for 10 minutes of zero customer rejection. That trade-off is overwhelmingly favorable.

### Opt-In Hard Stop Switch

```sql
ALTER TABLE organizations
  ADD COLUMN hard_stop_on_quota boolean NOT NULL DEFAULT false;
```

```ts
// Redis unreachable + quota cannot be verified:
if (org.hard_stop_on_quota) throw redisUnavailable(); // fail closed: retryable 503, 1 s hint (#373)
metering.flag("quota_unverified"); // for everyone else: allow and flag
```

Defaults to `false` across all organizations; enabled specifically for accounts whose enterprise contracts mandate strict hard-cap spending limits. A single boolean column, three lines of code, avoiding lock-in to a blunt one-size-fits-all policy.

### Prerequisite: Failing Open Must Be Noisy

Otherwise, failing open becomes a silent leakage vector:

- Connection dropped to Redis → alert fires immediately, no threshold delay.
- `usage_records.metering_status = 'quota_unverified'` flagged on every request during that outage window.
- The nightly reconciliation job in [§F.4](#f4-quota) automatically highlights all organizations with overruns.

### Local In-Memory Backstop

Mitigates the risk of failing open where AIHUB still fails open. A non-graded route's rate limiter keeps a coarse per-key, per-minute counter in each process, and local-auth rate limits keep their own bounded fallback. Neither is shared across replicas.

The process-wide in-flight backstop (`GLOBAL_MAX_INFLIGHT = 200`) is gone: under ADR-0116 a graded request never runs without a verified Redis permit, so a Redis outage refuses grading instead of capping it.

## F.6 Two Operational Details Frequently Missed

### `commandTimeout` Is Mandatory

```ts
new Redis({
  commandTimeout: 100,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
```

The gateway client (graded admission, concurrency, retry budgets) uses `commandTimeout: 200` and `connectTimeout: 1000`, calibrated from the Production app-to-Redis round trip; the identity and auth clients keep 100 ms.

A **hung** Redis is far more dangerous than a **dead** Redis. A dead Redis triggers an immediate connection refusal and activates fallback logic. A hung Redis without timeouts causes every incoming request to hang indefinitely — turning a Redis hiccup into a total system stall. `enableOfflineQueue: false` forces commands to error immediately rather than accumulating in Node RAM.

### `maxmemory-policy noeviction`, NOT `allkeys-lru`

All keys declare explicit TTLs, so memory consumption is naturally bounded and minimal (tens of megabytes). With `allkeys-lru`, Redis might silently evict the quota counter of an organization nearing its ceiling — **resetting their quota back to 0**. Under `noeviction`, an out-of-memory condition cleanly triggers write errors, which are caught and handled by the fail-open paths in [§F.5](#f5-what-happens-when-redis-dies-item-by-item-decisions). Alert configured at 75% maxmemory.

### Persistence: Unnecessary

Every state maintained in Redis can be reconstructed from Postgres. Enabling an RDB snapshot every 15 minutes provides warm restarts; disable AOF entirely — there is nothing here that justifies disk `fsync` overhead.

---

→ Next: [05 — Auth & Identity](05-auth-identity.md)
