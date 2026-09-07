---
paths:
  - "**/*.spec.ts"
  - "test/**"
---

# Testing rules

- Write the smallest behavior test before implementation and keep the focused test green while refactoring.
- Prefer pure unit tests for domain, catalog, contracts, redaction, and adapters.
- Do not call real Postgres, Redis, JWKS endpoints, or AI services from unit tests.
- Test public state and boundary outputs rather than private call ordering.
- Add an architecture regression test or rule whenever a new layer boundary is introduced.
