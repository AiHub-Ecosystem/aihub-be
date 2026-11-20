# ADR-0174: Bound uncached API-key lookups across the deployment

- Status: Accepted
- Date: 2026-11-19
- Related issue: [#1511](https://github.com/AiHub-Ecosystem/aihub-be/issues/1511), parent [#1426](https://github.com/AiHub-Ecosystem/aihub-be/issues/1426)
- Amends: [ADR-0006](0006-redis-scoped-role-fail-open.md) brute-force outage row; [ADR-0114](0114-bounded-identity-cache-tiers.md) negative-entry cardinality
- Related: [ADR-0096](0096-authentication-rate-limits-by-caller-and-address.md), [ADR-0103](0103-budget-postgresql-connections-on-shared-cluster.md), [#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588), [#501](https://github.com/AiHub-Ecosystem/aihub-be/issues/501)

## Context

API-key authentication gates a Postgres lookup only per client IP: 20 failure
counts in five minutes, held in a Redis counter. Every daemon-minted API key is
syntactically valid, so a distributed caller rotating addresses never reaches
that threshold while each distinct key still misses both cache tiers and
queries the `api_keys` table ([#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588)).

Two further gaps sit in the same path. `RedisAuthFailureCounter` answers `0`
for a failed read, and `ApiKeyAuthenticator` swallowed a failed write, so a
Redis outage removed the only bound between an attacker and Postgres. ADR-0006
accepted that fail-open trade-off on the argument that 256-bit keys cannot be
brute-forced; it did not weigh the connection-pool exhaustion #588 describes.

## Decision

**Deployment-wide lookup budget.** One Redis token bucket at
`aihub:v1:key:lookup-budget` refills at 100 uncached lookups per second and
holds a burst of 50 across every process sharing that Redis. Redis `TIME` keeps
the shared bucket aligned across application hosts. Ordinary misses and the
fresh reads that Sandbox and grading authorization already make
([ADR-0114](0114-bounded-identity-cache-tiers.md)) both spend from it, because
both are uncached reads of `api_keys`. A request that is over budget is refused
with retryable `429 RATE_LIMITED` and `Retry-After` before a pool client is
acquired. A key served from the positive cache spends nothing and is never
gated, so an admitted customer's traffic is unaffected by a miss flood.

The 100 RPS ceiling and burst of 50 are initial admission limits, not measured
Postgres capacity or an approved connection budget. ADR-0103 requires
representative staging evidence before production rollout; validate this limit
against grading reads and supported process overlap before deploying it.

**Negative-cache cardinality.** New negative API-key lookups stay in the
existing process-local L1, which is capped at 1,024 entries with jittered TTLs
no longer than 30 seconds. No new negative Redis entries are written, so their
Redis cardinality is zero and cannot grow if the shared budget key is evicted.
Existing negative Redis entries from earlier releases are still read and
expire under their existing TTL; positive Redis entries are unchanged.

**Redis outage.** Neither gap fails open any more. A failed counter read or
write uses the process-local count for that address, so an address this process
already saw cross the threshold is still refused before Postgres. The lookup
budget uses a stricter process-local bucket of 5 lookups per second with a burst
of 5 when Redis cannot spend the shared one. Both local maps are bounded (10,000
addresses; one budget counter), so an outage costs bounded memory. Same-key
requests coalesced into one in-flight Postgres read spend only one lookup
allowance. This amends ADR-0006's "brute-force protection: allow through +
alert" row for the API-key lookup path; the row still applies where a key is
already cached.

**Telemetry.** Refusals record `aihub_rejected_total{reason="rate_limit"}` or
`reason="auth"` and the existing `aihub_redis_unavailable_total{seam="auth_failure_counter"}`.
Labels are fixed strings; no key, key hash, or client address is logged or
tagged.

## Consequences

- With Redis healthy, a miss flood can no longer occupy more than 100 Postgres
  lookups per second after its initial 50-request burst, whatever the number of
  source addresses.
- Miss traffic that belongs to a real customer whose positive entry expired
  shares the budget with an attacker's probes, so a sustained flood can delay
  those first requests until tokens refill. The ceiling has not been load
  validated; staging must establish its effect on customer traffic.
- During a Redis outage each process enforces the stricter budget alone, so the
  deployment-wide ceiling becomes `processes × 5` lookups per second plus
  `processes × 5` burst capacity. A recovery returns admission to the shared
  bucket.
- Local counts do not persist across a restart; a fresh process starts at zero
  for addresses it has not yet seen, which the shared counter covers while
  Redis is healthy.

## Acceptance boundaries

- A distinct, well-formed, unknown key is refused before Postgres once the
  shared budget is spent, with `429 RATE_LIMITED` and `Retry-After`.
- A key served from the positive cache authenticates during an active miss
  flood and spends no budget.
- Sandbox and `forceFresh` lookups spend the same budget.
- A Redis failure yields a bounded local budget and a real local failure count,
  never an unbounded fallthrough to Postgres.
- No log or metric carries a key, key hash, or client address.
