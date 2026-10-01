---
paths:
  - "src/**/*.module.ts"
  - "src/app.module.ts"
---

# Module wiring rules

- Nest modules are composition roots: bind application ports to infrastructure implementations here and nowhere else.
- A module's public seam is its Nest `exports:` array. Before changing or ruling on a cross-module import, read the target module's `exports:` and confirm the symbol is listed: an exported guard is used deliberately and is not a coupling bug.
- Import module public APIs, not another module's infrastructure classes or private files.
- The dependency-cruiser rule [ADR-0066](../../docs/adr/0066-cross-module-imports-are-checked-not-yet-forbidden.md) reports every other cross-module import as a warning rather than an error, because it matches by file path and cannot read an `exports:` array.
- Keep the dependency direction `presentation -> application -> domain` and `infrastructure -> application`.
- Avoid circular module imports. If two modules need a behavior, define one application port at the owning boundary.
- Do not register speculative Speaking, Reading, billing, or async modules without an externally observable behavior.
