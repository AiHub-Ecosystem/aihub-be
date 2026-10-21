# ADR-0118: A Postgres outage answers a bounded, retryable 503

- Status: Proposed
- Date: 2026-10-21
- Related: [#328](https://github.com/AiHub-Ecosystem/aihub-be/issues/328), [#372](https://github.com/AiHub-Ecosystem/aihub-be/issues/372), [ADR-0116](0116-post-result-grading-completion-timing.md)
- Amends: `07-reliability-and-errors.md` (adds §I.8 and the `DATABASE_UNAVAILABLE` row)

## Context

The reliability spec had no row for Postgres being down or slow. The #328
fault-injection tests found two gaps:

- A refused or dropped connection reached the exception filter as a raw
  driver error and answered `500 INTERNAL_ERROR` with `retryable: false`, so a
  client was told not to retry a transient outage. Only statement and lock
  timeouts mapped to `503 DATABASE_UNAVAILABLE`.
- `statement_timeout` and `lock_timeout` are enforced by the server. A server
  that stopped answering an open connection left the query waiting until the
  operating system gave up on the socket, with no bound AIHUB controls.

## Decision

- Every request-path pool sets the client-side `query_timeout` to its
  `statement_timeout` plus 1 s. New connections keep `connectionTimeoutMillis`
  of 1 s.
- When a request fails because Postgres refused, dropped, or did not answer a
  connection, AIHUB answers `503 DATABASE_UNAVAILABLE`, `retryable: true`,
  with `retry_after_ms: 1000` and `Retry-After`. The filter recognizes this
  only from Prisma, driver-adapter, or node-postgres errors, so another
  dependency's socket failure is never reported as a database outage.
- A cached API key keeps authenticating for the rest of its cache TTL during
  an outage, as it does today. A cache miss reaches Postgres and gets the 503.
- The response logs `postgres_unavailable` without the driver message.

## Consequences

A Postgres outage now looks like every other dependency outage to a client:
a fast, retryable 503 with a retry hint, inside a stated bound. A query that
legitimately runs close to its `statement_timeout` keeps a 1 s margin before
the client gives up. Revocation during an outage still takes up to the
API-key cache TTL to apply, which #372 may revisit.
