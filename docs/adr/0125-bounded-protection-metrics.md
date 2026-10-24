# ADR-0125: Protection metrics use bounded labels at their decision seams

- Status: Accepted
- Date: 2026-10-24
- Related issues: [#200](https://github.com/AiHub-Ecosystem/aihub-be/issues/200), [#237](https://github.com/AiHub-Ecosystem/aihub-be/issues/237), [#240](https://github.com/AiHub-Ecosystem/aihub-be/issues/240), [#241](https://github.com/AiHub-Ecosystem/aihub-be/issues/241), [#369](https://github.com/AiHub-Ecosystem/aihub-be/issues/369)

## Context

AIHUB's Production and Sandbox metrics are scraped by the running Prometheus stack. `aihub_redis_unavailable_total{seam}` already exists, while `aihub_rejected_total{reason}` is still due from #200. The metric contract therefore needs bounded, stable labels, and the failure of a best-effort API-key cache invalidation must be visible even though the route preserves its committed customer response.

## Decision

Increment `aihub_rejected_total{reason}` at the admission decision that refuses a request, using exactly `rate_limit`, `quota`, `concurrency`, or `auth`. The `auth` reason covers API-key authentication and operation authorization, including organization suspension, environment or scope denial, and a rejected required Signed User Assertion. It excludes membership authorization on user-management routes, request validation, unmatched routes, downstream failures, and Redis unavailability. The same response may increment `aihub_requests_total` under #240, but neither family counts it twice.

Keep `aihub_redis_unavailable_total` with its existing single `seam` label. Increment once when a request-path protection or cache seam reports a failed Redis operation, including best-effort cache writes and invalidations, without changing the customer response. Use the fixed seam values documented in spec L.2; API-key cache invalidations use `api_key_cache_invalidation_revoke`, `api_key_cache_invalidation_rotate`, or `api_key_cache_invalidation_suspension`, while other API-key cache operation failures use `api_key_cache`. Neither metric may carry organization, user, request, API-key, Signed User Assertion, or essay-content labels.

## Consequences

The existing `seam` label name remains stable, while the action-specific invalidation values make delayed revocation visible without adding another label dimension or metric family. The `auth` signal includes legitimate scope and suspension denials as well as credential failures, so #369's alert threshold must be calibrated against that broader baseline.
