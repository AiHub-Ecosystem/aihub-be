---
paths:
  - "src/**/*.module.ts"
  - "src/app.module.ts"
  - "src/**/*.port.ts"
---

# Module wiring rules

- Nest modules are composition roots: bind application ports to infrastructure implementations here and nowhere else.
- `src/cli` is a second composition root, for the Operator surface. A command binding a Postgres client or a repository is doing that job; a command importing a module's application logic is not, and is reported by `no-cli-module-internal-import`.
- A module's public seam is its Nest `exports:` array. Before changing or ruling on a cross-module import, read the target module's `exports:` and confirm the symbol is listed: an exported guard is used deliberately and is not a coupling bug.
- Port names say which kind of port they are. A durable record port is named after the noun it owns (`OrganizationMembershipPort`, `OrganizationApiKeyPort`); when that noun is derived from a verb, suffix it with `Record` (`OrganizationCreationRecordPort`, `OrganizationRenameRecordPort`) so it cannot be mistaken for the use-case port. A use-case port must carry the verb of the operation it performs, leading the name or following the noun (`CreateOrganizationPort`, `RenameOrganizationPort`, `OrganizationMembershipListPort`, `OrganizationMembershipMutationPort`). Two ports covering the same operation must never differ only in word order.
- A Nest decorator is seam even when no `exports:` array lists it: `GradedRequest` and `RequireOperation` are applied, not resolved, so they compose across modules by import and belong to no DI container.
- Import module public APIs, not another module's infrastructure classes or private files.
- A pure function, constant, type, or interface cannot travel through a Nest `exports:` array, because that publishes providers. When another module needs one, the fix is to move the call behind a port, not to register the value as a provider to satisfy the architecture rule (ADR-0066).
- The dependency-cruiser rules in [ADR-0066](../../docs/adr/0066-cross-module-imports-are-checked-not-yet-forbidden.md) fail the architecture check for every cross-module or CLI import outside a published seam. They read each module's `exports:` array from source and exempt the file declaring an exported symbol, so publishing a guard makes it reachable; they match by file path, so the exemption covers that file rather than one symbol.
- Keep the dependency direction `presentation -> application -> domain` and `infrastructure -> application`.
- Avoid circular module imports. If two modules need a behavior, define one application port at the owning boundary.
- Do not register speculative Speaking, Reading, billing, or async modules without an externally observable behavior.
