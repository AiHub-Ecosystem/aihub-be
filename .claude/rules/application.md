---
paths:
  - "src/**/application/**"
---

# Application layer rules

- Application code owns use cases, policies, commands, result types, and ports.
- Depend on domain types and application-owned port interfaces, never concrete Postgres, Redis, HTTP, JWT, or Nest providers.
- Accept `RequestContext` and explicit organization identity; never accept a raw Fastify request or arbitrary header map.
- Keep orchestration small and deterministic. Mapping to transport schemas belongs at the boundary.
- Use an explicit error code for each expected failure; do not leak adapter errors or raw downstream bodies.
