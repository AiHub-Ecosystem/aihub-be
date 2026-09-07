---
paths:
  - "src/**/*.module.ts"
  - "src/app.module.ts"
---

# Module wiring rules

- Nest modules are composition roots: bind application ports to infrastructure implementations here and nowhere else.
- Import module public APIs, not another module's infrastructure classes or private files.
- Keep the dependency direction `presentation -> application -> domain` and `infrastructure -> application`.
- Avoid circular module imports. If two modules need a behavior, define one application port at the owning boundary.
- Do not register speculative Speaking, Reading, billing, or async modules without an externally observable behavior.
