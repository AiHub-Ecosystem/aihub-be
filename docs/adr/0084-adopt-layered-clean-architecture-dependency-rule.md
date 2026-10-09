# ADR-0084: Adopt a layered Clean Architecture dependency rule

- Status: Accepted
- Date: 2026-10-09

## Context

The layering rule for AIHUB has been in force since the 2026-09-07 design spec, which states the four layers and the allowed dependency direction in `docs/superpowers/specs/2026-09-07-aihub/12-agent-workflow-and-clean-architecture-design.md` §4. It is enforced today by this repository's own dependency rules and architecture check. It was never recorded as an ADR, so it appears in neither `docs/adr/` nor this log's supersession chain.

Two consequences follow from that gap. A reader working from `docs/agents/domain.md` is told to read the ADRs touching an area before changing it, and the root architecture decision is not among them. And the rule cannot be superseded or amended by number: ADR-0066 and ADR-0082 changed it — ADR-0066 replaced a plain prohibition on cross-module infrastructure imports with a public-seam rule, and ADR-0082 reordered Identity files feature-first under the same layers — without either record naming the decision they amended.

`AGENTS.md` describes the layering, but it is agent guidance that is rewritten whenever the harness changes, not a decision with a status and a successor. It is a copy of the rule, not its record.

## Decision

Each business or policy module that has behaviour in a layer uses one of four layers: `domain/` for pure entities, value objects, policies and domain errors; `application/` for use cases and ports; `infrastructure/` for PostgreSQL, Redis, HTTP and JWKS adapters; `presentation/` for controllers, guards, DTO and schema validation, and composition wiring. A module with no behaviour in a layer does not create an empty folder for it.

Dependencies point inward. `presentation → application → domain`; `infrastructure → application`, implementing the ports the application declares; `domain` imports nothing outside `domain`. Concrete infrastructure is bound by a module composition root — a `*.module.ts`, or `src/cli` for the Operator surface — and by nothing else.

This is a layering decision, not a directory-shape decision. ADR-0082 groups Identity feature-first under `src/modules/identity/<feature>/<layer>/`; that grouping is the current arrangement of the layers, not a second architecture. The two rules compose, and a future change to either should amend the other by number rather than restate it.

## Considered Options

Leaving the rule in the spec and `AGENTS.md` was rejected. The spec is dated design input that the repository already supersedes in places, and `AGENTS.md` is regenerated with the harness. Either can change the rule's wording without anyone deciding to change the rule, and neither can carry a status.

Adding a dedicated `clean-architecture` agent skill was rejected. The rule is already enforced by this repository's tooling, so a skill would restate it in a second place with nothing keeping the two in sync, which is the failure this ADR exists to remove.

## Consequences

A reader entering the repository now finds the root architecture decision alongside the 83 records that refine it, and later refinements can cite it by number. The rule's enforcement is already in place, so acceptance changes no code and no import.

The layering is fixed at module boundaries, so a module that genuinely needs to cross from `presentation` to an adapter has to declare a port rather than import one. That is the accepted cost and is unchanged from today.

The entry-count limits in ADR-0082 remain documented conventions rather than automated checks. This ADR does not change that.

## Confirmation

The dependency rule is held by machine checks, not by this record. `.dependency-cruiser.cjs` forbids `domain → application|infrastructure|presentation`, `application → infrastructure|presentation`, `application → @nestjs`, `presentation → infrastructure`, `infrastructure → presentation`, and any non-infrastructure module code importing a module's `infrastructure/`; it also forbids circular and unresolvable imports. `scripts/checks/check-architecture.mjs` adds the operation-catalog completeness check, the ban on host literals under `src/downstream/`, the confinement of `process.env` reads to the configuration boundary, the confinement of Vault-specific code to the Secrets module's infrastructure, and the requirement that a controller validates a request body through `parseRequestBody` rather than TypeBox directly.

On 2026-10-09 `pnpm arch-check` reported no dependency violations across 573 modules and 2,223 dependencies. `.github/workflows/ci.yml` runs `pnpm arch-check` as its own step, and `package.json` includes it in `pnpm verify`.

The remaining AIHUB-specific rules in the spec's §4 — normalizing organization identity once into `RequestContext`, keeping downstream adapters pure, letting the dispatcher own network I/O and error translation, making `organization_id` explicit in every control-plane lookup, keeping API keys, user assertions and essay content out of logs, confining Redis to cache and protection state, and requiring explicit domain-to-persistence mappers instead of unsafe casts — remain convention. No check in this repository enforces them. They are listed here so that the unverified ones are visible as unverified, and `docs/agents/domain.md` already warns that ADR claims about the world are only true as of their date.

## Recording note

This record is Accepted because the layering was implemented and enforced before it was written down: acceptance is a statement about the present state rather than an authorisation for future change. The repository owner accepted it on 2026-10-09. No related issue exists for this record. If the rule is later changed, amend or supersede this record by number rather than editing the layering in place, and keep `.dependency-cruiser.cjs` and the spec in step with whatever this record says.
