# Email dispatch port split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #1338 by splitting email dispatch store contracts by role and extracting the poller's dispatch stages without changing runtime behavior.

**Architecture:** Application contracts define claim, attempt outcome, sweep, failure-report, and WAL-read roles. `PostgresEmailDispatchStore` remains one adapter implementing the needed roles; consumers depend on only their role or consumer-specific composition. `EmailDeliveryPoller.dispatch` remains the behavior owner and composes named steps implemented by its poller-local collaborator, keeping the poller below the 500-code-line ceiling.

**Tech Stack:** TypeScript, Bun, Jest, NestJS, PostgreSQL.

## Global Constraints

- Preserve existing Auth runtime behavior during structural changes.
- Application code owns use cases, policies, commands, result types, and ports; infrastructure implements application ports and points inward.
- Keep every hand-written source file at 500 code lines or fewer.
- Keep each Auth feature-layer folder at 20 direct entries or fewer.
- Preserve existing assertions, metric names, and metric labels.
- Run `bun run check:changed` after each edit batch; run `bun run verify` once at the end.

---

## File map

**Create**

- `src/modules/auth/email-delivery/application/email-delivery-request.types.ts` — shared request status, error/cancellation vocabularies, records, and store input/output types.
- `src/modules/auth/email-delivery/application/email-payload-cipher.port.ts` — payload cipher interface, context, and cipher errors.
- `src/modules/auth/email-delivery/application/email-credential-actionability.port.ts` — credential state and actionability interface.
- `src/modules/auth/email-delivery/application/email-dispatch-store.port.ts` — role ports and the narrow poller, maintenance, and WAL-read contracts.

**Modify**

- `src/modules/auth/email-delivery/application/email-delivery-request.port.ts` — keep the request-writer contract and established import seam; re-export focused contracts with named sections.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller.ts` — consume focused types and extract the named dispatch steps.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller-dispatch-steps.ts` — implement the named dispatch steps without expanding the already-at-ceiling poller file.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller.types.ts` — keep the poller options and dispatch outcome contract separate from stage implementation.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller-maintenance.ts` — depend on maintenance-only store roles.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller-claim.ts` — depend only on the claim role.
- `src/modules/auth/email-delivery/application/poller/email-delivery-poller.spec-support.ts` — implement the poller's contract without WAL-read stubs.
- `src/modules/auth/email-delivery/infrastructure/outbox-store/postgres-email-dispatch-store.ts` — implement the role interfaces in one class.
- `src/modules/auth/email-delivery/infrastructure/outbox-store/email-outbox-wal.consumer.ts` — depend only on queued-ID and dispatch-state reads.
- `src/modules/auth/email-delivery/infrastructure/postgres-email-credential.repository.ts` — import the focused actionability contract.
- `src/modules/auth/email-delivery/infrastructure/payload-cipher/email-payload-cipher.ts` — import the focused cipher contract.
- `src/modules/auth/email-delivery/application/send-policy/email-delivery-outcome.policy.ts` — import the focused credential-state and request types.
- `src/modules/auth/email-delivery/email-delivery.module.ts` — import the cipher contract from its focused file.
- `test/db/auth/email-outbox-poller.spec.ts` — keep the unreachable-store test double on the poller's contract, without unrelated WAL-read methods.

Cross-module consumers continue using the existing `email-delivery-request.port.ts` seam; do not create a new Identity-to-Auth private-layer dependency.

## Task 1: Split the application store contracts

**Tests:** Run the existing poller, store, request-writer, and outbox specs before editing. Keep their assertions unchanged.

**Interfaces:**

- `EmailDispatchClaimPort`: `claim(ClaimEmailDeliveryRequestsInput): Promise<readonly EmailDeliveryRequestRecord[]>`.
- `EmailDispatchAttemptOutcomePort`: `reserveAttempt`, `releaseUnspentAttempt`, `markProviderAccepted`, `markFailed`, `markCancelled`, `recordFailedAttempt`, and `releaseDeferred`.
- `EmailDispatchSweepPort`: `cancelStale` and `failExhausted`.
- `EmailDispatchFailureReportPort`: `claimUnreportedFailures`, `markFailureReported`, and `releaseFailureNotification`.
- `EmailDispatchWalReadPort`: `queuedIds` and `readDispatchState`.
- `EmailDispatchPollerPort` composes claim, attempt-outcome, sweep, and failure-report roles because the poller constructs and calls its maintenance collaborator.
- `EmailDispatchMaintenancePort` composes only attempt-outcome, sweep, and failure-report roles.

- [x] **Step 1: Run baseline specs**

Run:

```powershell
bun run test -- ./src/modules/auth/email-delivery/application/poller/email-delivery-poller.dispatch.spec.ts
bun run test -- ./src/modules/auth/email-delivery/infrastructure/outbox-store/postgres-email-dispatch-store.spec.ts
bun run test -- ./src/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository.spec.ts
bun run test -- ./src/modules/auth/email-delivery/application/outbox/email-outbox.spec.ts
```

Expected: all pass before edits.

- [x] **Step 2: Move shared declarations into focused files**

Move existing declarations without changing definitions. Keep `email-delivery-request.port.ts` as the established application-port facade with named re-export sections; keep the request writer there.

- [x] **Step 3: Add role interfaces**

Declare the seven interfaces above in `email-dispatch-store.port.ts`. Define `EmailDispatchPollerPort` and `EmailDispatchMaintenancePort` as `extends` compositions of the listed roles. Define `EmailDispatchWalReadPort` with only `queuedIds` and `readDispatchState`; do not include provider mutations or maintenance methods.

- [x] **Step 4: Narrow consumers and adapter**

Use `EmailDispatchPollerPort` in `EmailDeliveryPoller`, `EmailDispatchMaintenancePort` in maintenance, `EmailDispatchClaimPort` in the claim helper, and `EmailDispatchWalReadPort` in the WAL consumer. Make `PostgresEmailDispatchStore` implement the role interfaces while retaining its single implementation. Remove `readDispatchState`, `queuedIds`, and `readWalSlotHealth` stubs from the poller `FakeStore`; retain concrete WAL health access on the Postgres adapter.

- [x] **Step 5: Check focused tests and changed-file gates**

Run all four baseline specs again, then `bun run check:changed`.

Expected: behavior specs and all changed-file gates pass; no existing assertion changes.

## Task 2: Compose dispatch from named steps

**Files:** `src/modules/auth/email-delivery/application/poller/email-delivery-poller.ts`; regression tests remain in `email-delivery-poller*.spec.ts`.

- [x] **Step 1: Keep the existing dispatch specs as the behavior contract**

Run:

```powershell
bun run test -- ./src/modules/auth/email-delivery/application/poller/email-delivery-poller.dispatch.spec.ts
bun run test -- ./src/modules/auth/email-delivery/application/poller/email-delivery-poller.resend-handoff.spec.ts
```

Expected: both pass before extraction. Do not rewrite assertions to match implementation details.

- [x] **Step 2: Extract the named stages in existing order**

Keep `dispatch` as orchestration over named poller-local steps for payload reading, credential actionability, message rendering, attempt reservation/provider send, and provider outcome translation. Implement those steps in `EmailDeliveryPollerDispatchSteps`: the existing poller is already at the source-size ceiling, so inlining the extracted logic would violate ADR-0110. Retain the existing result union, time reads, catch scopes, circuit transitions, rate/budget reservations, and store calls. Keep each step to a screen or less; split a step further only if needed to meet that limit.

- [x] **Step 3: Re-run dispatch regression specs**

Run the two specs from Step 1 and `bun run check:changed`.

Expected: all pass with their assertions unchanged.

## Task 3: Final verification and commit

**Files:** only issue #1338 implementation files and its plan/design notes.

- [x] **Step 1: Review the diff**

Run `git diff --check` and inspect `git diff`. Confirm no metric names/labels or existing assertions changed and no unrelated files entered the diff.

- [x] **Step 2: Run full verification**

Run:

```powershell
bun run verify
```

Expected: all required verification gates pass.

- [x] **Step 3: Commit**

Stage only the plan/design docs and issue #1338 source changes. Commit with:

```powershell
git commit -m "refactor(auth): split email dispatch store ports"
```
