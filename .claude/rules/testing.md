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
- Do not put a database-backed test anywhere but `test/db/`. That directory is the only path the default Jest config ignores, so a spec placed elsewhere makes the fast lane require PostgreSQL. Run it with `pnpm test:db`; it stays out of `pnpm verify` on purpose.
- Reach for the database lane only for behaviour a real engine settles: partial unique indexes, upsert guards, constraint rejection, row locks under concurrency. Everything else stays a unit test.
