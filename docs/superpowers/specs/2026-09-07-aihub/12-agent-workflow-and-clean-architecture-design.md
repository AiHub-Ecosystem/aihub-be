# 12 — Agent Workflow & Clean Architecture Scaffold Design

← [Mục lục](README.md)

> **Status:** Implemented in the initial NestJS/Fastify source scaffold. Update this
> document when the shared agent workflow or source-layout rules change.
>
> **Purpose:** Adapt the proven agent/code organization pattern from `casso-ledger` to AIHUB without copying its monorepo or accounting-specific rules.

## 1. Goal

AIHUB needs two aligned structures:

1. A Claude/Codex workflow that keeps architecture rules close to the files they protect.
2. A backend source layout that makes the public gateway, identity, downstream adapters and control-plane persistence testable without framework leakage.

The existing AIHUB architecture and API specs remain the business/technical source of truth. This document only defines how those decisions are organized for implementation.

## 2. Source-of-truth hierarchy

```text
Public/API behavior       → AIHUB Deliverable 1 contract
Runtime architecture      → docs/superpowers/specs/2026-09-07-aihub/01–11
Agent workflow            → AGENTS.md + .claude/
Hard-to-reverse decisions → docs/adr/
Short project glossary    → CONTEXT.md (created when domain terms are resolved)
```

Do not copy the existing architecture specs into `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, or ADRs. Those files should point to the canonical documents and record only rules or decisions that agents need repeatedly.

## 3. Repository shape

AIHUB starts as a single NestJS application, not a pnpm/Turborepo monorepo.

```text
aihub-be/
├── CLAUDE.md                 # imports AGENTS.md; Claude-specific pointers only
├── AGENTS.md                 # shared workflow and project rules
├── .claude/
│   ├── agents/               # role ownership and tool boundaries
│   ├── commands/             # repeatable repo workflows
│   ├── rules/                # path-scoped engineering rules
│   └── skills/               # reusable AIHUB-specific reviews/flows
├── src/
│   ├── common/               # genuinely cross-cutting code only
│   ├── catalog/              # typed operation catalog; source of routing metadata
│   ├── contracts/            # canonical and internal schemas
│   ├── modules/
│   │   ├── identity/
│   │   ├── gateway/
│   │   ├── metering/
│   │   └── idempotency/
│   └── downstream/           # adapter registry, dispatcher and service adapters
├── test/                     # integration/e2e tests
└── docs/
    ├── adr/
    └── superpowers/specs/
```

The first scaffold creates only the seams needed for the first Writing vertical slice. It does not create empty modules for Speaking, Reading, billing or async jobs.

## 4. Clean Architecture rules

Each business or policy module uses four layers when it has behavior in that layer:

```text
domain/           pure entities, value objects, policies and domain errors
application/      use cases and ports; no concrete framework/SDK integrations
infrastructure/   PostgreSQL, Redis, HTTP, JWKS and other adapters
presentation/     controllers, guards, DTO/schema validation and composition wiring
```

Allowed dependency direction:

```text
presentation → application → domain
infrastructure → application
domain → nothing outside domain
```

Rules specific to AIHUB:

- Domain/application code never reads raw headers or environment variables directly.
- Organization identity is normalized once into `RequestContext`; downstream code consumes that context.
- `DownstreamAdapter` functions are pure: they map requests/responses and never perform I/O.
- `Dispatcher` and concrete HTTP clients own network I/O, timeout, cancellation and downstream error translation.
- Adapter code receives a downstream path, never a client-controlled host or URL.
- `organization_id` is explicit in every control-plane lookup and user-scoped operation.
- Raw API keys, user assertions, essay content and internal tokens never enter logs.
- Redis is cache/ephemeral protection only; PostgreSQL remains the durable source of truth.
- Cross-module infrastructure imports are forbidden; use an application port.
- Explicit domain-to-persistence mappers are required; unsafe casts are not an escape hatch.

Modules without meaningful domain behavior may keep a smaller shape. Empty four-layer folders are not required.

## 5. AIHUB boundary mapping

### `common/`

Only shared primitives: configuration loading, errors, request context, logging/redaction, observability and low-level utilities. Organization-specific policy belongs in a module, not here.

### `catalog/` and `contracts/`

`catalog/operations.ts` is the typed source of operation path, scope, identity requirement, execution mode, body limit and timeout. TypeBox schemas live in `contracts/`. Neither is a database-driven routing table.

### `identity/`

Owns API-key authentication, environment binding, user-assertion verification, JWKS caching and effective-scope calculation. The application layer exposes ports; PostgreSQL/Redis/JWKS clients live in infrastructure.

### `gateway/`

Owns the public request pipeline and orchestration. Controllers remain thin. Authorization, idempotency, rate/concurrency/quota checks and dispatch are invoked through application services or guards, not implemented inside controllers.

### `downstream/`

Owns adapter registry, pure request/response mappers, internal JWT dispatch and the shared HTTP client. The first Writing adapters are the only concrete downstream implementations in the initial scaffold.

### `metering/` and `idempotency/`

Own durable application policies and ports. PostgreSQL repositories implement persistence; the response path records usage before returning, while metering failure never changes an already-successful business response.

## 6. Claude/Codex organization

### Path-scoped rules

Create only rules that protect recurring boundaries:

```text
.claude/rules/common.md
.claude/rules/domain.md
.claude/rules/application.md
.claude/rules/infrastructure.md
.claude/rules/presentation.md
.claude/rules/module-wiring.md
.claude/rules/typescript.md
.claude/rules/testing.md
.claude/rules/security.md
```

Rules must name the protected paths and give concrete forbidden/required examples. They must not repeat all architecture prose.

### Role agents

Use ownership boundaries similar to `casso-ledger`, adapted to AIHUB:

```text
api              → presentation, catalog/contracts HTTP surface
identity         → authentication, JWKS, authorization policy
downstream       → adapters, dispatcher and internal contract
infrastructure   → PostgreSQL, Redis, config and migrations
testing          → unit/integration/e2e tests and verification
```

Each role declares owned paths and paths it must not edit. There is no frontend agent until a frontend exists.

### Commands and skills

Start with the smallest useful set:

```text
commands: scaffold-module, new-endpoint, domain-check, test, typecheck, review
skills:   clean-architecture-review, domain-check, new-module, new-endpoint
```

Commands orchestrate repeatable checks; skills explain reasoning-heavy work. Do not create a command for a one-line shell alias.

## 7. Initial scaffold boundary

The scaffold is successful when it provides:

- NestJS/Fastify bootstrap and strict TypeScript configuration.
- One typed operation catalog and canonical schema seam.
- Request context/error envelope seams.
- Clean Architecture module and DI wiring examples.
- A pure adapter test fixture seam.
- Verification commands that can run before downstream integration is complete.

It deliberately does not implement:

- the unknown real Writing grading response mapping;
- Speaking/Reading, object storage or async jobs;
- dynamic DB routing configuration;
- billing/subscription tables;
- Kubernetes, service mesh or a dedicated proxy/data plane.

The real Writing response fixture remains the gate for completing `parseResponse`.

## 8. Verification

Before claiming the scaffold is complete:

1. TypeScript compilation succeeds.
2. Focused catalog/schema/adapter tests pass.
3. Architecture checks reject forbidden layer imports.
4. No secret, raw credential or essay content appears in test/log fixtures.
5. The working tree and generated file list match the scoped scaffold.

## 9. Deliberate non-copy from `casso-ledger`

- No monorepo or frontend structure yet.
- No accounting rules, VND money rules, RBAC roles or Casso integrations.
- No machine-local `.claude/settings.local.json` or scheduled-task lock.
- No broad agent fleet before there are owned source paths.

This keeps the useful enforcement pattern while preserving AIHUB's smaller MVP scope.
