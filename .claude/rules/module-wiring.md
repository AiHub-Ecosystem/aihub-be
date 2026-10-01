---
paths:
  - "src/**/*.module.ts"
  - "src/app.module.ts"
---

# Module wiring rules

- Nest modules are composition roots: bind application ports to infrastructure implementations here and nowhere else.
- A module's public seam is its Nest `exports:` array. Before changing or ruling on a cross-module import, read the target module's `exports:` and confirm the symbol is listed: an exported guard is used deliberately and is not a coupling bug.
- A Nest decorator is seam even when no `exports:` array lists it: `GradedRequest` and `RequireOperation` are applied, not resolved, so they compose across modules by import and belong to no DI container.
- Import module public APIs, not another module's infrastructure classes or private files.
- The dependency-cruiser rule [ADR-0066](../../docs/adr/0066-cross-module-imports-are-checked-not-yet-forbidden.md) reports every other cross-module import as a warning rather than an error. It reads each module's `exports:` array from source and exempts the file declaring an exported symbol, so publishing a guard makes it reachable; it matches by file path, so the exemption covers that file rather than one symbol.
- Keep the dependency direction `presentation -> application -> domain` and `infrastructure -> application`.
- Avoid circular module imports. If two modules need a behavior, define one application port at the owning boundary.
- Do not register speculative Speaking, Reading, billing, or async modules without an externally observable behavior.
