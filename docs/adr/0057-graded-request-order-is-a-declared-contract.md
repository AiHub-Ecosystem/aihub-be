# ADR-0057: The graded-request order is a declared contract verified against the real chain

- Status: Accepted
- Related issue: #174
- Related: [ADR-0018](0018-monthly-quota-enforcement.md), [ADR-0026](0026-usage-completeness-report-boundary.md)

The order in which a graded request authenticates, resolves the End-User ID, applies rate limits, checks quota, and takes a concurrency slot is a contract, not an incidental arrangement. It was written as a literal guard list on each grading controller, and the only test that examined it rebuilt the chain by hand instead of running the one the application runs, so the order the test asserted was a second copy of the contract rather than evidence of it. We declare the order once, share it by every grading route through a single composite decorator, and assert it against the real chain booted over HTTP, so removing or moving a step fails verification instead of quietly changing production behaviour.

## Considered options

A single exported constant array of guard classes was rejected: any route could still subscript into it (`GRADED_REQUEST_GUARDS[0]`) and the test would stay green, so the declaration would remain advisory. Registering the chain as a global `APP_GUARD` was rejected because identity and sandbox routes deliberately run a different chain. Asserting order by reading Nest's `GUARDS_METADATA` was kept only as a secondary check — it proves wiring, not execution, and a correctly-wired chain can still execute in the wrong order at runtime. A type-level ordering constraint was considered for the data dependencies (guards that read `request.aihubAuth` must run after `ApiKeyGuard`) but deferred: `knip` runs first in `pnpm verify` and a self-referential type graph is easy to satisfy by adding a permissive declaration, which would let a broken chain be quietly declared valid.

## Consequences

This is a deliberate, narrow exception to the rule in `.claude/rules/testing.md` that tests should assert public state and boundary outputs rather than private call ordering. On a graded request the order is not a private detail: it decides whether a caller receives `RATE_LIMITED` or `QUOTA_EXCEEDED`, so it is observable behaviour and belongs under test. The carve-out is scoped to the graded-request chain only; every other test keeps the existing rule. The graded-request set is declared once, separately from the Operation Catalog, because "every public operation" and "every operation that runs the graded chain" are different sets that happen to coincide today. Quota-before-concurrency is not a new rule invented here; it is the ordering already recorded in ADR-0018, and this ADR only makes it executable and verified.
