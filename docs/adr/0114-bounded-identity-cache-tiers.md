# ADR-0114: Keep local identity cache tiers inside existing validity ceilings

- Status: Implemented and deployed under [#402](https://github.com/AiHub-Ecosystem/aihub-be/issues/402): bounded API-key L1 and JWKS last-good cache tiers; probabilistic early refresh remains deferred.
- Date: 2026-10-19
- Related: [#402](https://github.com/AiHub-Ecosystem/aihub-be/issues/402), [#75](https://github.com/AiHub-Ecosystem/aihub-be/issues/75), [ADR-0091](0091-bounded-cancellable-jwks-resolution.md)

## Context

Redis outages and cache expiry can send concurrent API-key lookups to Postgres and JWKS lookups to an Organization's identity provider. Process-local cache tiers can reduce that fanout, but must preserve #75's 60-second API-key revocation and suspension ceiling and must not verify with keys from a replaced Organization Identity Configuration.

## Decision

### API keys

Use a bounded process-local L1 cache before Redis for ordinary API-key authentication. Cache positive and negative lookups with an absolute expiry that preserves the source entry's remaining lifetime; reads never extend it. Jitter may shorten the existing 60-second positive and 30-second negative TTLs, but never lengthen them. Revocation purges the local entry in the current process and the Redis entry; copies in other processes expire at the same original deadline. Concurrent ordinary cache misses for one key hash share one Postgres lookup per process. `forceFresh` requests bypass both cache tiers and single-flight.

### JWKS

Keep a bounded process-local last-good JWKS per Organization and configuration version. A replaced configuration version cannot use an older entry. Keep the existing 15-minute fresh and 24-hour stale ceilings, with jitter only shortening them. When an entry is stale but still valid, serve it immediately and start one background refresh per Organization in the process when ADR-0091's eight-Organization cap admits it; do not queue when the cap is full. After a failed refresh, retry no sooner than five minutes while continuing to serve the stale value until its stale deadline. An unknown `kid` still uses the synchronous forced-refresh path when the cooldown permits; during cooldown it fails fast without another remote fetch. If Redis is unavailable, use a valid local entry; a cold or expired cache follows ADR-0091's bounded remote-resolution behavior.

### Bounds and telemetry

Implement local cache tiers with bounded maps and fixed entry limits and TTLs; do not import the old transitive `lru-cache`. Bound per-Organization cooldown state as well, so the new refresh policy does not repeat the unbounded-map issue tracked by #268. Count JWKS refresh failures and coalesced waits on `/metrics`, as #402 requires.

## Consequences

Memory use stays bounded, and evictions may cause another backend lookup. A process-local API-key copy cannot extend the existing 60-second authorization lease; another process may retain it only until that same absolute deadline. During a JWKS refresh cooldown, an assertion using a newly introduced `kid` may fail quickly until a synchronous refresh is allowed.

The bounded API-key L1 and JWKS last-good cache tiers described here are implemented and deployed under #402. Probabilistic early refresh remains a deferred follow-up, with its revisit trigger recorded in the #402 discussion.
