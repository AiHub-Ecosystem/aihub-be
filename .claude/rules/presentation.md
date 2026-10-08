---
paths:
  - "src/**/presentation/**"
  - "src/**/*.controller.ts"
---

# Presentation layer rules

- Validate public input at the boundary with the operation's canonical TypeBox schema.
- In Identity, keep controllers, guards, decorators, and their specs in `src/modules/identity/<feature>/presentation/`; use `shared/presentation/` for cross-cutting request context and access-control code.
- For routes without a shared graded-request orchestrator, build a `RequestContext` from already-validated authentication and request metadata.
- For graded routes, validate and decode operation-specific HTTP input at the presentation boundary, then map it and normalized request metadata into a typed application input. The gateway application orchestrator builds the `RequestContext` and owns grading execution flow; never pass a raw Nest/Fastify request or headers into application code.
- Controllers are thin: resolve the operation, validate/decode its transport input, call an application port, and map the result/error to the public envelope.
- Do not call Postgres, Redis, JWKS, or downstream HTTP clients directly from a controller.
- Do not expose internal IDs, scopes, raw assertions, internal tokens, or raw downstream responses in public responses.
