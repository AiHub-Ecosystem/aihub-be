---
paths:
  - "src/**/application/**"
---

# Application layer rules

- Application code owns use cases, policies, commands, result types, and ports.
- Size a boundary to the need. Two ports and separate DTOs only when an implementation will actually be swapped; a port interface inside the same feature when the swap is plausible; nothing, with the decision recorded, when it may never arise.
- In Identity, keep each feature's use cases, ports, policies, and specs in `src/modules/identity/<feature>/application/`; use the existing feature folder when extending it.
- Depend on domain types and application-owned port interfaces, never concrete Postgres, Redis, HTTP, JWT, or Nest providers.
- Accept `RequestContext` and explicit organization identity; never accept a raw Fastify request or arbitrary header map.
- Keep orchestration small and deterministic. Mapping to transport schemas belongs at the boundary.
- Use an explicit error code for each expected failure; do not leak adapter errors or raw downstream bodies.
