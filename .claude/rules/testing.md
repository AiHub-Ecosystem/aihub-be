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
- Exception, scoped to the graded-request chain: asserting its step order is allowed, because the order decides which refusal a caller observes and is therefore public behaviour, not a private detail. Its test must run the real chain over HTTP, and the exception is recorded in [ADR-0057](../../docs/adr/0057-graded-request-order-is-a-declared-contract.md). It does not extend to any other ordering assertion.
- Add an architecture regression test or rule whenever a new layer boundary is introduced.
- Do not put a database-backed test anywhere but `test/db/`. That directory is the only path the default Jest config ignores, so a spec placed elsewhere makes the fast lane require PostgreSQL. Run it with `pnpm test:db`; it stays out of `pnpm verify` on purpose.
- The database lane runs `FLUSHDB` on Redis database 14 (`SANDBOX_TEST_REDIS_URL`, default `127.0.0.1:6379`), and `pnpm test:tenant-isolation` does the same on database 15 (`TENANT_ISOLATION_REDIS_URL`). Point both at a throwaway Redis before running either on a machine whose Redis is not AIHUB's alone.
- The layer rules in `.dependency-cruiser.cjs` cover spec files, except `module-code-no-infrastructure-import`. A spec that imports concrete infrastructure (a Postgres repository, an S3 adapter) cannot sit in `presentation/` or `application/`; Identity specs stay in the owning feature's `infrastructure/` folder, and other modules follow their existing test location.
- Identity specs stay beside their feature layer; keep cross-module integration and database specs under `test/`.
- Reach for the database lane only for behaviour a real engine settles: partial unique indexes, upsert guards, constraint rejection, row locks under concurrency. Everything else stays a unit test.
