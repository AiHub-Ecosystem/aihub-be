---
paths:
  - "src/**/presentation/**"
  - "src/**/*.controller.ts"
---

# Presentation layer rules

- Validate public input at the boundary with the operation's canonical TypeBox schema.
- Build a `RequestContext` from already-validated authentication and request metadata; do not pass raw headers into application code.
- Controllers are thin: resolve the operation, call an application port, and map the result/error to the public envelope.
- Do not call Postgres, Redis, JWKS, or downstream HTTP clients directly from a controller.
- Do not expose internal IDs, scopes, raw assertions, internal tokens, or raw downstream responses in public responses.
