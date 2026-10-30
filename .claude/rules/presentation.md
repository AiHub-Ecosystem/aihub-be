---
paths:
  - "src/**/presentation/**"
  - "src/**/*.controller.ts"
---

# Presentation layer rules

- Validate public input at the boundary with the operation's canonical TypeBox schema.
- Parse JSON bodies with `parseRequestBody`; pass the whole `request.query` object through `parseRequestQuery` with a closed TypeBox object schema. Avoid named `@Query('field')` because it cannot reject undeclared names; document any justified bypass with `arch-check: <reason>`.
- In Identity, keep controllers, guards, decorators, and their specs in `src/modules/identity/<feature>/presentation/`; use `shared/presentation/` for cross-cutting request context and access-control code.
- For routes without a shared graded-request orchestrator, build a `RequestContext` from already-validated authentication and request metadata.
- For graded routes, validate and decode operation-specific HTTP input at the presentation boundary, then map it and normalized request metadata into a typed application input. The gateway application orchestrator builds the `RequestContext` and owns grading execution flow; never pass a raw Nest/Fastify request or headers into application code.
- Controllers are thin: resolve the operation, validate/decode its transport input, call an application port, and map the result/error to the public envelope.
- Do not call Postgres, Redis, JWKS, or downstream HTTP clients directly from a controller.
- Do not expose internal IDs, scopes, raw assertions, internal tokens, or raw downstream responses in public responses.
- Adding `limit` or `cursor` to a response array that already exists turns the complete collection into one page. That is breaking in meaning even though the OpenAPI diff is additive, so the change summary cites [ADR-0134](../../docs/adr/0134-bounding-an-existing-collection-is-a-breaking-change-accepted-once-under-v1.md) and its evidence. A new collection route is paginated from its first release.
