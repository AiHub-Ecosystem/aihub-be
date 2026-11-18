# Email dispatch port split

## Context

Issue [#1338](https://github.com/AiHub-Ecosystem/aihub-be/issues/1338) asks to narrow the email outbox store dependencies and divide `EmailDeliveryPoller.dispatch` into named steps. The current store contract spans claim, attempt outcomes, maintenance sweeps, failure reporting, and WAL reads. The Postgres adapter can continue implementing the complete store.

Issue #1338 was blocked by #1311; #1311 is closed on the current `main`.

## Decision

- Define role-based application ports for claim, attempt outcomes, maintenance sweeps, failure reports, and WAL state/queue reads.
- Keep `PostgresEmailDispatchStore` as the single adapter implementing the required roles.
- Narrow the poller, maintenance collaborator, and WAL consumer to the role ports they use. Keep test doubles limited to their consumer's required methods.
- Give store roles named port files. Keep shared record/status types separate from the request writer, payload cipher, credential-actionability, and store contracts so consumers can import only the role they need.
- Refactor `dispatch` into named steps for payload reading, credential actionability, rendering, attempt reservation/provider send, and outcome translation; keep each step to a screen or less.

## Alternatives

- Use only one combined port per consumer. This reduces declarations, but can still couple claim, attempt, sweep, and reporting operations in consumers that span multiple roles.
- Keep the existing broad store port and extract only private dispatch methods. This would leave the test-double and dependency-coupling problem from #1338 unresolved.

## Behavior and verification

This is a seam-only refactor. Preserve policy, branch order, public behavior, metrics and labels. Keep existing assertions unchanged; run the focused poller, maintenance, store, and outbox specs, then `bun run check:changed` and `bun run verify`.
