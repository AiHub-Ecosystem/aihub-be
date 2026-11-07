# ADR-0009: Downstream adapters are pure functions without I/O

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

Mapping between AIHUB's contracts and each AI service's request/response shapes
is where subtle incompatibilities hide. Testing such mappers against live
services or with mocks would be slow, flaky, and could encode speculation
rather than observed behavior.

## Decision

Downstream adapters are pure functions with zero I/O
([06-routing-adapter §H.3](../superpowers/specs/2026-09-07-aihub/06-routing-adapter.md)):

1. Adapters do not perform HTTP execution. They return a **descriptor** of the
   request; the dispatcher (infrastructure) owns network execution, hosts,
   timeouts, cancellation, internal tokens, and error translation.
2. Adapters therefore have no networking, no database calls, no clock access.
3. Adapters are written **from captured fixtures, not speculation**: a response
   shape without a fixture is not invented — the work stops at the contract
   boundary and surfaces the blocker.

## Consequences

- Golden fixture testing becomes "feed JSON in, assert JSON out" — zero mocks,
  zero network, fully parallel.
- Infrastructure is reduced to humble transport code; all mapping decisions
  are testable as pure data transformations.
- The no-speculation rule is a standing repo rule ("Never invent a downstream
  response shape"); the Writing fixtures live in `test/fixtures/ai-writing/`,
  and Speaking drift is checked by `test/provider-contract-drift.spec.ts`
  against the published provider contract.
