# ADR-0144: Evaluate in-process Singleflight request coalescing

- Status: Proposed; implementation and concurrency evidence are recorded under [#1214](https://github.com/AiHub-Ecosystem/aihub-be/issues/1214), but adoption by read endpoints remains a separate decision
- Date: 2026-11-01
- Related: [#1214](https://github.com/AiHub-Ecosystem/aihub-be/issues/1214), [ADR-0091](0091-bounded-cancellable-jwks-resolution.md), [ADR-0114](0114-bounded-identity-cache-tiers.md)

## Context

Concurrent cache misses can cause identical reads to fan out to PostgreSQL or an upstream service. API-key lookup and JWKS resolution already coalesce work under their own domain-specific rules, but the repository has no reusable utility for other read paths to evaluate.

## Decision

Add a framework-neutral `Singleflight<K, V>` utility. Within one instance, the first `run(key, work)` call stores and returns the work Promise; calls with the same key return that same Promise while it is pending. Both fulfillment and rejection remove the entry, so failures reach every waiter and a later call can retry. Cleanup checks Promise identity before deleting to avoid removing a newer flight for the same key.

The utility does not cache settled values, coordinate Node processes or worker threads, impose a capacity, or choose keys. Callers own key isolation, cancellation policy, and bounds. Endpoint adoption is deferred until an evaluation confirms that a caller's existing cache and authorization semantics permit coalescing.

## Consequences

The utility can prevent duplicate in-flight work for requests handled by the same instance and key. It does not reduce work across application instances, and coalescing is unsafe when a key omits inputs that affect the result. Tests prove one loader call for 100 simultaneous same-key requests, shared rejection for all waiters, and cleanup that permits retry.
