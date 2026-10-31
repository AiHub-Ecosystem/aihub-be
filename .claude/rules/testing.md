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
- Do not put a database-backed test anywhere but `test/db/`. The default Bun test command and Jest config both exclude that path, so a spec placed elsewhere makes the fast lane require PostgreSQL. Run it with `pnpm test:db`; it stays out of `pnpm verify` on purpose.
- `pnpm test:db` and `pnpm test:tenant-isolation` claim a session-level PostgreSQL advisory lock in the server's `postgres` database before generating clients or running Jest. They refuse while another database lane on that PostgreSQL server holds it; the lock stays with the connection for the full run and PostgreSQL releases it when that session ends, including after a killed process. The wrapper forwards Jest's exit code and closes the lock session. Because the claim precedes Jest, a refused run cannot reach the lane's Redis flush.
- `pnpm test:db` and `pnpm test:tenant-isolation` verify the local Postgres service ownership marker before creating or dropping lane databases. Their Redis-flushing suites verify the marker in Redis database 0 before running `FLUSHDB` on database 14 (`SANDBOX_TEST_REDIS_URL`, default `127.0.0.1:6379`) or database 15 (`TENANT_ISOLATION_REDIS_URL`). The local Compose healthchecks create these markers; custom URLs must point to a dedicated service with the documented markers in `docs/database.md`.
- The layer rules in `.dependency-cruiser.cjs` cover spec files, except `module-code-no-infrastructure-import`. A spec that imports concrete infrastructure (a Postgres repository, an S3 adapter) cannot sit in `presentation/` or `application/`; Identity specs stay in the owning feature's `infrastructure/` folder, and other modules follow their existing test location.
- Identity specs stay beside their feature layer; keep cross-module integration and database specs under `test/`.
- A `Proxy` that stands in for a client or handle gets a spec for each trap it defines (`get`, `has`, `ownKeys`, `set`), run with a lifecycle property (`then`, `close`, `onModuleDestroy`) and with an ordinary one. Frameworks probe a provider through `in` as well as through property reads, so a trap covered by only one of the two fails in production.
- Reach for the database lane only for behaviour a real engine settles: partial unique indexes, upsert guards, constraint rejection, row locks under concurrency. Everything else stays a unit test.
