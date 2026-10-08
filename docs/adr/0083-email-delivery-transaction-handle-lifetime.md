# ADR-0083: Opaque transaction handle for Email Delivery writes

- Status: Accepted
- Date: 2026-10-08
- Related issue: [#335](https://github.com/AiHub-Ecosystem/aihub-be/issues/335)
- Amends: [ADR-0074](0074-transactional-email-outbox.md) (transaction-handle boundary)

## Decision

The Email Delivery Request writer receives an opaque, Email Delivery-specific handle representing its caller-owned PostgreSQL transaction; application callers do not receive a SQL-shaped query API, while PostgreSQL adapters retain internal query access. The shared Identity transaction runner invalidates the handle as soon as its callback settles, rejects later calls with a deterministic infrastructure error before reaching the driver, and drains calls that started while the callback was active before committing or rolling back. Any query failure rolls back; if the callback itself fails, its error remains primary after in-flight calls settle. The invitation and Email Delivery Request continue to commit or roll back together.

The Auth call sites adapt to the same writer contract and preserve their caller-owned transaction, but this decision adds no lifetime guard to transaction runners outside Identity. The handle remains PostgreSQL-specific; no portable transaction framework or public error code is introduced.

## Consequences

The Identity runner cannot release its pooled client while a query it started is still in flight. Misuse of an expired handle has a deterministic internal failure, while existing public error translation remains unchanged. Other module transaction runners retain their current lifecycle behavior.
