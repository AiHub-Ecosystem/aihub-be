# ADR-0147: Let GradedPipelineEngine own the graded execution lifecycle

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-03 in [#1514](https://github.com/AiHub-Ecosystem/aihub-be/issues/1514).
- Date: 2026-11-03
- Amends: [ADR-0058](0058-concurrency-permit-is-acquired-and-released-by-one-unit.md) (concurrency permit ownership only)
- Related: [#1499](https://github.com/AiHub-Ecosystem/aihub-be/issues/1499), [#1514](https://github.com/AiHub-Ecosystem/aihub-be/issues/1514)

## Context

Issue #1514 asks the application layer to own graded admission, concurrency
leasing, dispatch, idempotency replay, and background completion. ADR-0058
instead requires a single presentation interceptor to acquire and release each
concurrency permit. The old request-property handoff was also removed under
#1499, so the application engine now receives typed request-scoped inputs and
owns the permit lifecycle.

## Decision

- `GradedPipelineEngine` owns admission, concurrency acquisition, dispatch,
  replay lookup, failure cleanup, and the permit lifecycle for graded work.
- Presentation validates and decodes HTTP input, then calls the engine through
  an application port with explicit typed context. It does not attach state to
  the Fastify request for the engine to recover later.
- `SuccessEnvelopeInterceptor` owns response envelope construction and
  foreground metering because it has the HTTP status and total response time.
  After metering completes, it signals the typed pipeline completion seam; the
  engine then releases the request's permit and records settled completion.
  Background settlement continues through the lifecycle supplied to the
  idempotency service.
- The interceptor-owned acquisition/release decision in ADR-0058 is superseded
  by this decision for concurrency permit ownership only.
  Admission-before-concurrency remains an observable graded-chain contract and
  is verified by the real HTTP chain test.

## Consequences

The application engine becomes the owner of the graded execution state and no
longer depends on mutable request properties. The presentation response
boundary must keep the completion signal after successful metering; omitting it
would retain the permit until the limiter's lease expires. Engine failure and
background paths still release or retain the permit according to the existing
one-shot lifecycle rules. The AIHUB owner approved this decision on 2026-11-03
in [#1514](https://github.com/AiHub-Ecosystem/aihub-be/issues/1514). ADR-0058
remains active except for concurrency permit ownership, which this ADR amends.

## Implementation evidence

- Implementation: [d5c3be5](https://github.com/AiHub-Ecosystem/aihub-be/commit/d5c3be5f2e27836d6a70fd1eed7e0b641ab22cfc); Jest coverage compatibility follow-up: [23264855](https://github.com/AiHub-Ecosystem/aihub-be/commit/232648553059c979e4ba0af1b41540ee75ba3982).
- Local `bun run verify`: 4,250 passed, 2 skipped, 0 failed.
- [CI](https://github.com/AiHub-Ecosystem/aihub-be/actions/runs/41591317191) and [CD](https://github.com/AiHub-Ecosystem/aihub-be/actions/runs/41592004745) passed.
- `ops/status.sh` on 2026-11-03 reported production and sandbox running revision `2326485`, healthy with readiness 200, dependencies up, zero restarts, and zero errors.
