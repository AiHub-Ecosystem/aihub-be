# ADR-0088: Prisma is the control-plane persistence standard

- Status: Accepted
- Date: 2026-10-10
- Supersedes: [ADR-0071](0071-drizzle-for-control-plane-persistence.md)
- Related issues: [#395](https://github.com/AiHub-Ecosystem/aihub-be/issues/395), [#246](https://github.com/AiHub-Ecosystem/aihub-be/issues/246), [#39](https://github.com/AiHub-Ecosystem/aihub-be/issues/39), [#40](https://github.com/AiHub-Ecosystem/aihub-be/issues/40), [#81](https://github.com/AiHub-Ecosystem/aihub-be/issues/81), [#383](https://github.com/AiHub-Ecosystem/aihub-be/issues/383), [#227](https://github.com/AiHub-Ecosystem/aihub-be/issues/227)
- Related: [ADR-0083](0083-email-delivery-transaction-handle-lifetime.md)

## Context

ADR-0071 chose Drizzle after comparing raw `pg`, Drizzle, and TypeORM. Prisma was not evaluated, and the runtime spec rejected it on an unmeasured claim that it "struggles with" `text[]`, `ON CONFLICT`, partial indexes, and BRIN. Adoption stayed small: on 2026-10-10, 7 files import Drizzle, all in Identity, against 32 `postgres-*` implementations and 35 SQL migrations. The owner wants one schema file as the source of truth, migrations generated from it, a generated typed client, and a stack the expected contributors already know.

## Decision

Prisma replaces Drizzle as the control-plane persistence standard. The decision is final; it is not gated on a spike. The first slice is a tracer that proves how each constraint below is met, and its benchmark is appended to this record. The one exit is the runtime fit: if `@prisma/adapter-pg` cannot run on the existing `pg` pool, so that #81 and #383 no longer apply, stop and reopen #395.

**Endpoint.** Every `postgres-*` implementation uses Prisma: the generated client where it can express the query, `$queryRawUnsafe` with an explicit result row type for row-returning SQL it cannot express (row locks and their order, `SKIP LOCKED`, `FILTER (WHERE …)` aggregates), and `$executeRawUnsafe` for statements without a consumed result. The exact SQL is preserved and issued through the Prisma client or transaction. `pg_advisory_xact_lock` uses `$executeRawUnsafe`: Prisma 7.10's query path cannot deserialize PostgreSQL's `void` result. No production repository has a separate raw `pg` query path, and `drizzle-orm` and `@nestjs/drizzle` are removed. A repository that stays outside Prisma needs its own recorded exception in this file.

**Client and version.** Stay on Prisma 7.10.0 GA, whose client has no Rust query engine, through `@prisma/adapter-pg` on a `pg` pool. One `PrismaClient` exists per distinct connection URL in a process: runtime (`DATABASE_URL`), control-plane write, and control-plane read. URLs that are equal share one instance and one pool. CLI commands call the same factory with an explicit URL. Pool metrics are labelled by connection role instead of by module.

**TypedSQL.** TypedSQL is not adopted. On Prisma 7 it is a preview feature, and `prisma generate --sql` needs a live database to infer result types. That would add a database dependency to static, unit, and build jobs, including the database-free Docker build stage, changing the build and deploy contract. Repositories instead preserve their exact SQL through Prisma `$queryRawUnsafe` and declare explicit result row types, following the existing Identity and Auth row-mapping pattern. No-result writes use `$executeRawUnsafe`; the Sandbox dispatch budget's advisory lock also uses it because Prisma 7.10 cannot deserialize the PostgreSQL `void` result returned by `$queryRawUnsafe`.

**Prisma 8.** Defer the upgrade until a GA release. The schema uses `@db.*`
attributes (including `@db.Timestamptz(6)` and `@db.Date`) and `type: Brin`;
Prisma 8 moves database types into type position. Calls using `.take(n)` and
`.skip(n)` become `.limit(n)` and `.offset(n)`, and raw SQL changes from
`db.sql.raw` to `db.raw.sql`. Release candidates changed incompatibly between
rc.9 and rc.14. GA partial and unique indexes do not justify production use of
an RC; see [the upgrade notes](../database.md#upgrading-to-prisma-8).

`idempotency_records` remains `@@ignore` because it has no addressable unique
identifier. Its conflict insert uses `$queryRawUnsafe` with an explicit result
row type, retaining the existing conflict target and `DO NOTHING` behavior.

**Transactions.** Prisma owns transactions. Each module's transaction runner moves to an interactive `$transaction`, Identity first. During the transition the existing `query(text, values)` seam is reimplemented on `tx.$queryRawUnsafe`, so repositories that have not moved share the same transaction as those that have, and the Email Delivery writer keeps the caller-owned handle that ADR-0083 defines. The ADR-0083 guard — expire the handle when the callback settles, drain in-flight calls, then commit or roll back — is preserved. The seam is removed as each module completes. Interactive transactions set `maxWait: 1_000` and `timeout: 5_000` explicitly in one place; #383 owns tightening them.

**Test-only compatibility exceptions.** Production module wiring injects Prisma directly. Identity and Auth query-shaped clients remain at their existing source paths only because unchanged database-lane specs construct them; no production module may construct or inject them. Identity's fixture APIs are used by ten database-lane specs (`invitation-email-outbox`, `operator-api-key`, `organization-api-key`, `organization-creation`, `organization-first-owner`, `organization-invitation`, `organization-membership-list`, `organization-membership-mutation`, `organization-rename`, and `organization-status`), with additional unchanged specs using the historical `createIdentityDrizzleClient` name. Auth's fixture API is used by the Auth database-lane specs, including the failure-injection wrapper in `web-session-store.spec.ts`. Moving these APIs into `test/` would require editing acceptance specs, so their query-shaped surface remains test-only. The unchanged `test/db/idempotency.spec.ts` constructs `PostgresIdempotencyRepository` with a `PostgresIdempotencyClient` backed by its test-owned `pg.Pool`; this is the sole test path that issues repository SQL directly through `pg`. Production Idempotency injects Prisma. `src/common/postgres/postgres-pool.ts` is the only runtime source file that imports `pg`; it is the shared instrumented pool factory used by the shared Prisma client factory.

**Schema and migrations.** `schema.prisma` is created by `prisma db pull` against a database built from all existing migrations, then renamed to match the current TypeScript names. Partial indexes use Prisma 7's `partialIndexes` preview feature and BRIN uses the native `Brin` type. Objects the schema cannot declare (triggers and `CHECK` constraints) live only in SQL, each with a `///` comment in the schema naming its migration. Prisma generates new migration SQL (`prisma migrate diff … --script`) into `database/migrations/`, where it is reviewed and hand-edited as needed. The existing runner (`scripts/cli/migrate.mjs`, `schema_migrations`) keeps applying migrations, so Production and Sandbox need no baseline and the runtime image gains no Prisma CLI. `scripts/checks/check-migrations.mjs` keeps enforcing expand-only. CI adds a drift check: apply every migration to an empty database, then require an empty `migrate diff` against `schema.prisma`.

**Build and boundaries.** The generated client is written outside `src/`, ignored by Git, and generated before `type-check` and the SWC build. `prisma` is a development dependency used only in the build stage. Only `**/infrastructure/**` may import the generated client, and `pnpm arch-check` enforces it. Infrastructure maps rows to application port types; Prisma types never reach application or domain code.

**Order.** (1) Tracer: the 7 Drizzle files in Identity, the Identity transaction runner, `postgres-organization-invitation.repository.ts`, and the idempotency `ON CONFLICT` statement; Drizzle is removed in this slice so the repository never carries two ORMs. (2) Idempotency (#39). (3) The remaining modules one slice each, with the lock-heavy repositories (`auth-mfa`, `local-auth`, the email outbox claim, the Sandbox dispatch budget) last.

## Consequences

- The spec rows that rejected Prisma (`01-context-and-stack.md`, `03-database.md` §E.1) now name Prisma.
- #246 is answered by the endpoint above. #39 moves to Prisma, #40 takes the migration workflow above, and #81 closes as the shared client lands slice by slice.
- `$queryRawUnsafe` returns `bigint`, `numeric`, `bytea`, and timestamp values differently from `pg`. Each slice relies on its existing repository and integration specs to catch the difference in its row mapping.
- Migration SQL is still reviewed by hand; generation removes the second hand-maintained copy of the schema, not the review.

## Runtime fit

Settled in #81. `@prisma/adapter-pg` runs on the existing `pg` pool: `PrismaPg`
takes a `pg.Pool` directly, so `createPostgresPool` keeps building it and the
driver adapter issues its statements through that pool's own connections. A
generated-client query, an interactive `$transaction`, and the pool's own
`totalCount`/`idleCount` accounting were each checked against a real PostgreSQL
16 database built from the migration history; the adapter opened no connection
of its own. #81 and #383 therefore still apply: one pool per distinct connection
URL, carrying over the existing `max`, connection timeout, and idle timeout, and
the server-side statement and lock timeouts #383 plans.

`PrismaPg` reads the pool positionally — `new PrismaPg(pool)` — not as
`{ pool }`. The second shape is silently ignored and the adapter then builds
its own pool against a default host, which surfaces as `ECONNREFUSED` rather
than as a configuration error.

## Benchmark

Run `pnpm build`, set `DB_LANE_ADMIN_URL` to the disposable PostgreSQL admin
URL on `localhost:5433/postgres`, then run
`pnpm benchmark:control-plane`. The harness compares raw `pg`, Drizzle, and
Prisma on PostgreSQL 16 with a pool of 10, 100,000 API keys, 1,000,000 usage
rows, and 100 organizations. For each implementation it runs two 5-second
passes at 50 operations per second for API-key lookup, durable Metering insert,
lookup followed by insert, and the request/token aggregate. Pass order is
reversed on the second pass. The harness confirms equal fixture outputs before
timing and reports p50/p95 latency, completed rate, statement round trips, and
failures. The aggregate uses the same parameterized SQL in all three modes so
this measurement compares database-client overhead; production repositories
follow the Prisma raw-query endpoint above where the generated client cannot
express the query.

The table records the range across the two passes. Latencies are milliseconds;
each completed-rate cell shows raw `pg` / Drizzle / Prisma operations per second.

| Operation               | Round trips (pg / Drizzle / Prisma) |         Raw pg p50 / p95 |         Drizzle p50 / p95 |          Prisma p50 / p95 | Completed rate/s (pg / Drizzle / Prisma) |
| ----------------------- | ----------------------------------: | -----------------------: | ------------------------: | ------------------------: | ---------------------------------------: |
| API-key lookup          |                           1 / 1 / 2 |    1.57–2.34 / 2.04–2.80 |     1.78–2.38 / 2.32–3.07 |     2.94–2.97 / 3.90–4.83 |  50.08–50.16 / 50.11–50.13 / 50.06–50.10 |
| Durable Metering insert |                           1 / 1 / 1 |    2.63–2.80 / 3.32–3.63 |     2.79–3.07 / 3.64–3.86 |     3.47–3.68 / 4.38–5.59 |  50.06–50.17 / 50.08–50.09 / 50.13–50.16 |
| Lookup then insert      |                           2 / 2 / 3 |  3.97–4.28 / 5.02–115.25 |     4.38–4.39 / 5.36–6.01 |     5.88–6.27 / 7.17–7.79 |        50.06–50.13 / 50.06 / 49.99–50.06 |
| Request/token aggregate |                           1 / 1 / 1 | 9.83–10.43 / 11.50–13.12 | 10.06–10.60 / 11.79–12.49 | 10.46–10.49 / 12.06–12.55 |        49.99–50.05 / 50.04 / 50.03–50.08 |

All scheduled operations completed without failures and the three modes returned
equal fixture outputs. Prisma's API-key lookup uses two statements because the
selected organization relation is fetched separately by the client. One raw
`pg` lookup-then-insert pass had a 115.25 ms p95 while the other pass was about
5 ms; treat that isolated tail as local-run noise. These short, single-host
measurements are descriptive, not a capacity estimate or a performance gate.
Production repositories use the Prisma endpoint above, preserving unsupported
queries as SQL with explicit result row types.

## Considered options

- **Keep Drizzle and finish it (ADR-0071).** Rejected by the owner: Drizzle had reached 7 of 32 implementations, so switching cost about what finishing would, and Prisma's schema-first workflow and team familiarity were preferred.
- **Prisma for schema and migrations only, queries unchanged.** Rejected: queries would keep hand-written or Drizzle types next to `schema.prisma`, restoring the two sources of truth this change removes, and the typed client would go unused.
- **`prisma migrate deploy` with a baseline.** Rejected: it needs a `prisma/migrations` layout, a baseline of every existing migration on Production and Sandbox, the Prisma CLI in the migration container, and a rewritten expand-only check, while the existing runner already applies generated SQL.
- **Keep transactions on `pg` until a whole module moves.** Rejected: Prisma cannot join a transaction opened on a `pg` client, so migrated repositories could not write inside the transactions they belong to.
