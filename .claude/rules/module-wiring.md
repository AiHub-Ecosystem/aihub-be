---
paths:
  - "src/**/*.module.ts"
  - "src/app.module.ts"
---

# Module wiring rules

- Nest modules are composition roots: bind application ports to infrastructure implementations here and nowhere else.
- Import module public APIs, not another module's infrastructure classes or private files.
- A module's public seam is its `<module>.module.ts` composition root, its `application/**/*.port.ts` contracts, and a presentation primitive that declares `module 'fastify'` ([ADR-0066](../../docs/adr/0066-cross-module-imports-are-checked-not-yet-forbidden.md)). A dependency-cruiser rule reports every other cross-module import as a warning; Nest `exports:` arrays are a real seam the rule cannot read yet, so cross-module guard and interceptor imports are not mistakes by themselves.
- Keep the dependency direction `presentation -> application -> domain` and `infrastructure -> application`.
- Avoid circular module imports. If two modules need a behavior, define one application port at the owning boundary.
- Do not register speculative Speaking, Reading, billing, or async modules without an externally observable behavior.
