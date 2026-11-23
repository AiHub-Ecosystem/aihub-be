# ADR-0182: Keep security decisions on the PostgreSQL writer

- Status: Accepted; implementation pending
- Date: 2026-11-23
- Related: [#372](https://github.com/AiHub-Ecosystem/aihub-be/issues/372), [#2020](https://github.com/AiHub-Ecosystem/aihub-be/issues/2020)

## Context

`CONTROL_PLANE_READ_DATABASE_URL` can point at a read replica. The
`CONTROL_PLANE_READ` client currently supplies API-key status and Organization
Identity Configuration reads used for authorization, as well as audit reads.
API-key authentication also has the existing authenticated cache tiers and
freshness limits accepted by ADR-0114/0174. No replica-lag freshness bound is
defined or observable, so a replica can return revoked authorization data or
stale identity policy on a durable lookup.

## Decision

- Route API-key status and Organization Identity Configuration reads used for
  authorization through the PostgreSQL writer.
- Keep the existing authenticated API-key cache tiers and TTLs. This decision
  selects the writer for durable cache-miss and force-fresh lookups; it does not
  remove the bounded cache policy accepted by ADR-0114/0174.
- Allow audit and other UX reads to use a replica only after its freshness
  bound is measured and observable. Until then, use the writer.
- Do not fall back to a replica for a security decision when the writer is
  unavailable.

## Consequences

Authorization follows current revocation and identity-policy state, at the
cost of additional reads on the writer. #2020 owns the routing change and tests;
it must check pool budgets against #560 before adding another database pool.
This ADR records the target policy, not implementation evidence.
