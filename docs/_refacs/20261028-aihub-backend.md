# Refactoring Analysis: AIHUB Backend

> **Date**: 2026-10-28  
> **Scope**: Repository-wide inventory with detailed review of email delivery, local authentication, and the Operator CLI; sampled hotspots rather than a line-by-line read of all files. The detailed reads prioritized email delivery, the Operator CLI, and local authentication; other tooling such as the capacity benchmark was inventoried but not deeply reviewed.  
> **Analyzed by**: AI-assisted refactoring analysis (Martin Fowler catalog)  
> **Language/Stack**: TypeScript, Node.js, NestJS/Fastify, PostgreSQL  
> **Test coverage**: Focused unit and database suites exist for the reviewed areas. Coverage percentages were not inspected; no tests were run.

---

## Executive Summary

The repository has clear module boundaries and its automated architecture and source-size rules pass. The most concrete maintenance cost is the long email outbox dispatch method, where payload eligibility, reservations, provider calls, and durable outcome transitions are sequenced in one method. The Operator CLI and local-auth service are also change hubs, though both already expose seams that allow incremental refactoring without changing public behavior.

| Severity      | Count |
| ------------- | ----- |
| Critical (P0) | 0     |
| High (P1)     | 1     |
| Medium (P2)   | 2     |
| Low (P3)      | 0     |
| **Total**     | **3** |

### Top Opportunities

| #   | Finding                                                              | Location                                                                       | Effort      | Impact                                                                          |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------- |
| 1   | Split the outbox dispatch phases into named functions                | `src/modules/auth/email-delivery/application/email-delivery-poller.ts:246-505` | Moderate    | Makes ordering-sensitive retry and delivery transitions easier to review.       |
| 2   | Move remaining inline CLI operations behind the existing runner seam | `scripts/cli/cli.mjs:594-793,1173-1265`                                        | Moderate    | Keeps the command entry point from owning several operation implementations.    |
| 3   | Narrow the local-auth implementation by workflow                     | `src/modules/auth/local-credentials/application/local-auth.service.ts:111-562` | Significant | Reduces the number of unrelated auth paths and dependencies a change must scan. |

---

## Findings

### P1 — High

#### F1: The outbox dispatch path is one long, ordering-sensitive function

- **Smell**: Long Function; complex conditional flow
- **Category**: Bloater
- **Location**: `src/modules/auth/email-delivery/application/email-delivery-poller.ts:246-505`
- **Severity**: High
- **Impact**: `dispatch` is about 260 lines. It opens the sealed payload, checks credentials, renders the message, acquires the provider permit, reserves rate and daily budget, records the attempt, sends the request, and maps provider responses to durable state. Those steps have ordering constraints: the credential is checked again after waits, and the durable attempt is reserved before contacting the provider. A change to one retry branch therefore requires tracing several reservation and cleanup paths. This code is also active: the file had 17 commits in the last 30 days.

**Current code** (simplified from the method):

```typescript
delivery = readEmailPayload(this.cipher, request);
// credential and message checks
sendPermit = await this.providerOutageCircuit.acquireSendPermit();
// rate and daily-budget reservations
await this.store.reserveAttempt({
  id: request.id,
  attemptedAt: now,
  owner: this.options.owner,
});
response = await this.deliver(request, message);
if (response.status === 429) {
  // update circuit and release the unspent attempt
}
```

**Recommended refactoring**: Split Phase and Extract Function, keeping the current sequence visible.

**After** (structural sketch; preserve the existing result types and side-effect order):

```typescript
private async dispatch(request: EmailDeliveryRequestRecord) {
  const prepared = await this.prepareDelivery(request, this.now());
  if (prepared.kind !== 'ready') return prepared.outcome;
  const attempt = await this.reserveAttempt(request, prepared);
  if (attempt.kind !== 'ready') return attempt.outcome;
  return this.sendAndRecord(request, prepared, attempt);
}
```

**Rationale**: The class already delegates maintenance transitions to `EmailDeliveryPollerMaintenance` and message variants to `EmailKindHandlerRegistry`. Extracting the remaining phases within this class reuses those boundaries and makes each branch easier to verify without introducing a new abstraction layer. Reuse the existing focused suites: `email-delivery-poller.dispatch.spec.ts`, `email-delivery-poller.terminal-failures.spec.ts`, `email-delivery-poller.handoff-expiry.spec.ts`, and `test/db/auth/email-outbox-poller.spec.ts`.

---

### P2 — Medium

#### F2: The CLI file mixes command routing with command implementations

- **Smell**: Large Module; Divergent Change
- **Category**: Change Preventer
- **Location**: `scripts/cli/cli.mjs:77-199,594-793,1173-1265`
- **Severity**: Medium
- **Impact**: This 1,291-line entry point contains the command parser, identity/JWKS option validation, database setup, direct Organization/API-key/identity operations, and a 22-branch command map. Many newer commands use `cliRunnerDescriptor` and implementations under `src/cli`, while `org:create`, `key:create`, `key:revoke`, `identity:set`, and `idempotency:cleanup` remain implemented inline. The mixed path makes it harder to know where a command's behavior belongs. The file changed in 16 commits in the last 30 days, so the routing surface is frequently touched.

**Recommended refactoring**: Move Function into the existing `src/cli` runner pattern one command at a time. Keep `pnpm cli <command>`, argument parsing, output, and failure behavior unchanged. Existing per-command specs live under `test/cli/`.

**Rationale**: `package.json` already exposes this file as the CLI entry point and the descriptor/loader mechanism provides an established seam. Moving operation bodies behind that seam reduces unrelated edits to the dispatcher without adding a new command framework.

#### F3: LocalAuthService coordinates several independent auth workflows

- **Smell**: Large Class; Divergent Change
- **Category**: Bloater
- **Location**: `src/modules/auth/local-credentials/application/local-auth.service.ts:111-562`
- **Severity**: Medium (potential; split incrementally)
- **Impact**: The class has nine public operations spanning registration, verification, resend, password recovery, login, refresh, and logout. Its constructor takes 14 inputs (13 ports/services plus one policy flag). The operations form several dependency clusters, so a change to one path often brings a broad constructor and a 1,418-line unit spec into view. The file changed in nine commits in the last 30 days.

**Recommended refactoring**: Extract cohesive application services for account verification/recovery and session creation/rotation when a feature change needs those boundaries. Keep `LocalAuthServicePort` as the controller-facing contract and let `AuthModule` compose the implementation; do not split every method pre-emptively.

**Rationale**: The presentation layer already consumes `LocalAuthServicePort`, while `AuthModule` constructs the concrete service. That seam permits an internal split without changing HTTP behavior. Because these workflows belong to the same local-auth feature, confirm that changes continue to cross the clusters before taking on the larger extraction.

---

## Coupling Analysis

### Module dependency map

- Business modules follow `presentation -> application -> domain`; infrastructure implements application ports.
- The controller consumes `LocalAuthServicePort`; the auth module wires the concrete service and its ports.
- The email poller consumes focused ports for persistence, sending, outage state, and send budgets.
- The CLI entry point reaches `src/cli` through descriptors for many operations; the remaining inline handlers are the main inconsistency.

### High-risk coupling

| Surface                        | Dependents / dependencies                                                           | Risk                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `LocalAuthService`             | One controller-facing port, 14 constructor inputs, and multiple lifecycle workflows | Medium: internal changes can touch unrelated auth flows and their shared test setup. |
| `EmailDeliveryPoller.dispatch` | Provider, credential, rate-limit, budget, and store ports in one transition path    | High: state changes must remain correctly ordered.                                   |
| `scripts/cli/cli.mjs`          | `pnpm cli` entry point, 22 command branches, inline handlers, and delegated runners | Medium: command implementation ownership is split across two patterns.               |

`pnpm arch-check` passed with no dependency violations across 957 modules and 3,883 dependency edges. The configured circular-dependency rule also passed. No cross-module boundary violation was confirmed.

### Circular dependencies

None detected by the architecture check.

---

## DRY Analysis

- No new high-confidence duplicated code cluster was confirmed in the reviewed email, auth, or CLI paths.
- The repository already maintains `docs/agents/duplication-register.md`; use that register before extracting any shared helper so previously reviewed copies are not reopened without new evidence.
- The email retry delays in the reviewed poller are named constants rather than repeated unexplained literals.
- A whole-repository textual clone scan was not performed.

---

## SOLID Analysis

> **Context**: Applicable. AIHUB uses bounded modules, domain entities, application ports, and infrastructure adapters.

| Principle             | Finding                                                                                                                                             | Location                                                                     | Recommendation                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Single Responsibility | F1: dispatch owns preparation, reservations, provider interaction, and result persistence. F3: local-auth workflows share one concrete service.     | Poller and LocalAuthService                                                  | Extract only the distinct workflow phases; keep current ports and behavior stable. |
| Open/Closed           | Email kinds use `EmailKindHandlerRegistry`, keeping variant rendering/credential behavior out of a repeated conditional in the poller.              | `src/modules/auth/email-delivery/application/email-kind-handler.registry.ts` | Preserve this extension seam.                                                      |
| Liskov Substitution   | No inheritance-related violation found in the sampled areas.                                                                                        | —                                                                            | No change indicated.                                                               |
| Interface Segregation | Ports are separated by persistence, sending, budgets, and auth operations. The broad `LocalAuthServicePort` matches the current controller surface. | Application port files                                                       | Keep that public seam stable during any internal split.                            |
| Dependency Inversion  | The architecture check found no forbidden cross-module imports or cycles.                                                                           | `.dependency-cruiser.cjs` rules                                              | Preserve imports through the existing ports, module roots, and public facades.     |

---

## Suggested Refactoring Order

### Phase 1: Reduce risk in the outbox path

1. Extract the preparation, reservation, and send/result phases from `EmailDeliveryPoller.dispatch` while preserving their order.
2. Reuse the existing unit and database suites listed in F1.

### Phase 2: Reduce dispatcher ownership

1. Move one inline CLI operation behind the existing runner/loader seam.
2. Reuse its existing `test/cli/` spec; repeat only when the move makes a command change simpler.

### Phase 3: Revisit local-auth cohesion

1. Track whether account lifecycle and session changes keep modifying the same implementation and broad test fixture.
2. If that continues, split internal collaborators behind `LocalAuthServicePort`; otherwise leave the class intact.

### Prerequisites

- For code changes, keep CLI commands and HTTP contracts stable.
- Preserve email credential rechecks, provider permit cleanup, attempt reservation, and durable status transitions.
- Run the existing affected specs and repository-required checks after any refactor.

---

## Risks and Caveats

- This was a repository-wide inventory with focused review of high-change and structurally large areas, not a line-by-line audit of all 916 TypeScript files.
- The outbox dispatch sequence is behaviorally sensitive; a careless split could change retries or lose durable failure evidence.
- The local-auth port intentionally exposes the current auth surface; splitting its internal implementation should not force a public API change.
- `pnpm check:file-size` passed. The large `src/config/runtime-configuration.ts`, `src/catalog/public-routes.ts`, and `src/modules/identity/identity.module.ts` are explicit ADR-0110 exemptions for single-schema configuration, catalogues, and composition roots; they were not treated as findings by size alone.
- Performance and security audits are outside this skill's scope. No tests, profiling, runtime inspection, or external scanners were run.
- Source behavior was reviewed at `18aa96b1`. During report preparation, `main` advanced to `80972f7b` through an 18-line documentation-only change in `docs/operations/deploy-vps.md`; no refactoring conclusion depends on that change, and the file was not edited as part of this analysis.

---

## Appendix: Primary Smell Distribution

Each finding is counted once under its primary category; secondary tags may overlap.

| Category               | Count | %        |
| ---------------------- | ----- | -------- |
| Bloaters               | 2     | 67%      |
| Change Preventers      | 1     | 33%      |
| Dispensables           | 0     | 0%       |
| Couplers               | 0     | 0%       |
| Conditional Complexity | 0     | 0%       |
| DRY Violations         | 0     | 0%       |
| **Total**              | **3** | **100%** |
