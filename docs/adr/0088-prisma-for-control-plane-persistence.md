# ADR-0088: Prisma is the control-plane persistence standard

- Status: Accepted
- Date: 2026-10-10
- Supersedes: [ADR-0071](0071-drizzle-for-control-plane-persistence.md)
- Amends: [ADR-0083](0083-email-delivery-transaction-handle-lifetime.md) (the lifetime guard now also covers the Auth transaction runner)
- Related issues: [#395](https://github.com/AiHub-Ecosystem/aihub-be/issues/395), [#246](https://github.com/AiHub-Ecosystem/aihub-be/issues/246), [#39](https://github.com/AiHub-Ecosystem/aihub-be/issues/39), [#40](https://github.com/AiHub-Ecosystem/aihub-be/issues/40), [#81](https://github.com/AiHub-Ecosystem/aihub-be/issues/81), [#383](https://github.com/AiHub-Ecosystem/aihub-be/issues/383), [#227](https://github.com/AiHub-Ecosystem/aihub-be/issues/227), [#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588), [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560)

## Context

ADR-0071 chose Drizzle after comparing raw `pg`, Drizzle, and TypeORM. Prisma was not evaluated, and the runtime spec rejected it on an unmeasured claim that it "struggles with" `text[]`, `ON CONFLICT`, partial indexes, and BRIN. Adoption stayed small: on 2026-10-10, 7 files import Drizzle, all in Identity, against 32 `postgres-*` implementations and 35 SQL migrations. The owner wants one schema file as the source of truth, migrations generated from it, a generated typed client, and a stack the expected contributors already know.

## Decision

Prisma replaces Drizzle as the control-plane persistence standard. The decision is final; it is not gated on a spike. The first slice is a tracer that proves how each constraint below is met, and its benchmark is appended to this record. The one exit is the runtime fit: if `@prisma/adapter-pg` cannot run on the existing `pg` pool, so that #81 and #383 no longer apply, stop and reopen #395.

**Endpoint.** Every `postgres-*` implementation uses Prisma: the generated client where it can express the query, `$queryRawUnsafe` with an explicit result row type for row-returning SQL it cannot express (row locks and their order, `SKIP LOCKED`, `FILTER (WHERE …)` aggregates), and `$executeRawUnsafe` for statements without a consumed result. The exact SQL is preserved and issued through the Prisma client or transaction. `pg_advisory_xact_lock` uses `$executeRawUnsafe`: Prisma 7.10's query path cannot deserialize PostgreSQL's `void` result. No production repository has a separate raw `pg` query path, and `drizzle-orm` and `@nestjs/drizzle` are removed. A repository that stays outside Prisma needs its own recorded exception in this file.

**Raw SQL exceptions.** The generated client issues plain reads, inserts, updates, and deletes (Avatar, Speaking audio uploads, Auth, the Identity key, Organization, and invitation repositories, Metering's usage insert and dispatch outcome, the Sandbox budget's counts and reservations). A statement stays SQL only for one of these reasons, and a new one needs its reason added here:

| Reason                                                                       | Statements                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prisma has no lock clause, and the lock order is the deadlock contract       | `FOR UPDATE`, `FOR SHARE`, `SKIP LOCKED` in Identity, Auth, the Speaking upload completion, and usage retention                                                                                                                                                                                                         |
| `pg_advisory_xact_lock` returns `void`, which Prisma 7.10 cannot deserialize | the Sandbox dispatch budget's lock                                                                                                                                                                                                                                                                                      |
| The exact aggregate decides billing or evidence                              | `FILTER (WHERE …)` aggregates, `CASE`/`EXISTS` aggregation, and the CTE delete in Metering                                                                                                                                                                                                                              |
| The database clock is the contract                                           | the dispatch attempt insert (`clock_timestamp()`)                                                                                                                                                                                                                                                                       |
| The conflict target or predicate decides replay versus reject                | the Avatar insert (`ON CONFLICT (user_account_id)`), every Idempotency statement (the table is `@@ignore`), the identity-config conditional upsert (`IS DISTINCT FROM` and a cache-version bump), the invitation membership upsert (role precedence)                                                                    |
| One statement is the measured contract on the hot path                       | the API-key lookup: the generated client issues two statements and costs about 1.2 ms at p50 (see Benchmark)                                                                                                                                                                                                            |
| Callers script or pause by SQL text                                          | the membership repository, the Organization audit-event insert and read, and the active-account lookup: the pausing client holds a transaction after the statement whose text it names, and the membership unit spec scripts statements in order. These statements are shared, so the text they match is their contract |

**Client and version.** Stay on Prisma 7.10.0 GA, whose client has no Rust query engine, through `@prisma/adapter-pg` on a `pg` pool. One `PrismaClient` exists per distinct connection URL in a process: runtime (`DATABASE_URL`), control-plane write, and control-plane read. URLs that are equal share one instance and one pool. CLI commands call the same factory with an explicit URL. Pool metrics are labelled by connection role instead of by module.

**Pool size and labels.** A role holds the sum of the pools of the modules it serves, so merging roles into one pool keeps the concurrency they had apart: `runtime` 44 (Auth 10, Idempotency 10, Metering 10, Avatar 5, Speaking audio 5, Sandbox budget 4), `control-plane` 20 (the Identity write pool and the one transaction runner that replaces the Identity repositories' own clients), and `control-plane-read` 10. A Production tier whose three URLs are equal opens one pool of 74; a tier that separates the runtime database opens pools of 44 and 30. The Identity module had opened six clients of its own on top of its read and write pools, which now count once. Watch `aihub_postgres_pool_waiting` after the first deploy; #383 owns tuning. A shared pool is one series for its counts, labelled by the first role to claim it (`runtime`), and `aihub_postgres_pool_role{pool, role}` lists every role the pool serves, so a dashboard can join the two without summing one pool three times.

### Request-admission bulkhead amendment (2026-10-15; #588)

This amendment narrows the one-pool-per-distinct-URL rule above: a process may use separately bounded admission and general pools for the same database URL. Request admission covers the API-key lookup and, when a Signed User Assertion is supplied, the Organization Identity Configuration read needed to verify it. Audit and operator-facing reads, background work, and other non-admission statements use general capacity. The two pools are reported independently through the existing PostgreSQL pool total, idle, and waiting metrics; one physical pool contributes one sample.

**Capacity gate.** The combined maximum across every pool in one process must fit the AIHUB connection budget agreed in #560, including the processes running concurrently during a deploy and CLI/migration headroom. The historical `74` maximum above describes the current allocations; it is not an approved target for the bulkhead. The admission/general maxima remain unset until #560 records the shared-cluster budget. #588 may settle and implement the separation, but cannot be considered complete until the budget and resulting numeric maxima are recorded here.

**Latency contract.** In the database lane, hold every general-pool connection on a row lock and show the API-key lookup uses admission capacity and completes within 100 ms end to end, including pool acquisition. This is the acceptance threshold for this isolation scenario; the low-load benchmark below remains descriptive and is not a substitute for the test.

This separation protects admission from saturation of AIHUB's general pool. It does not protect against exhausting the shared PostgreSQL server's total connections or from contention that directly blocks admission statements; #560 and #383 own those boundaries.

**TypedSQL.** TypedSQL is not adopted. On Prisma 7 it is a preview feature, and `prisma generate --sql` needs a live database to infer result types. That would add a database dependency to static, unit, and build jobs, including the database-free Docker build stage, changing the build and deploy contract. Repositories instead preserve their exact SQL through Prisma `$queryRawUnsafe` and declare explicit result row types, following the existing Identity and Auth row-mapping pattern. No-result writes use `$executeRawUnsafe`; the Sandbox dispatch budget's advisory lock also uses it because Prisma 7.10 cannot deserialize the PostgreSQL `void` result returned by `$queryRawUnsafe`.

`idempotency_records` remains `@@ignore` because it has no addressable unique
identifier. Its conflict insert uses `$queryRawUnsafe` with an explicit result
row type, retaining the existing conflict target and `DO NOTHING` behavior.

**Transactions.** Prisma owns transactions. Each module's transaction runner moves to an interactive `$transaction`, Identity first. A repository takes the Prisma client and nothing else, and the Email Delivery writer keeps the caller-owned handle that ADR-0083 defines. The ADR-0083 guard — expire the handle when the callback settles, drain in-flight calls, then commit or roll back — is preserved, and one implementation in the persistence module now serves Identity and Auth. It tracks raw statements and model-delegate calls alike, so a query through the generated client cannot outlive the callback. ADR-0083 left runners outside Identity on their existing lifecycle; Prisma's interactive transaction releases its connection at commit, so Auth's runner takes the same guard rather than leave an unawaited statement to fail inside the driver. A constraint failure of a model operation is reported by Prisma's code (`P2002`), and callers branch on the SQLSTATE a raw statement throws, so Auth's runner translates `P2002`, `P2003`, and `P2034` to `23505`, `23503`, and `40001`. Interactive transactions set `maxWait: 1_000` and `timeout: 5_000` explicitly in one place; #383 owns tightening them.

**Test-only compatibility exceptions.** Production module wiring injects Prisma directly, and a repository takes the Prisma client only: there is no query-shaped branch in Identity, Auth, or Idempotency. The database-lane fixtures (`createPostgresIdentityClient`, `createPostgresAuthClient`, `createPostgresIdempotencyClient`) are Prisma clients that add `query` and `transaction` helpers for assertions, and no production module may construct them. A spec that scripts statements or injects a failure by SQL text adapts a fake with `prismaFromQueryFake`, or puts a hook in front of the real client with `interceptStatements`; both live under `src/modules/persistence/testing/`, which production code cannot import. Four more factories remain because the unchanged database-lane specs call them by name, each built by `createFixturePrismaClient` in the persistence module: `createAvatarQueryClient` (`test/db/avatar.spec.ts`), `createPostgresMeteringClient` (`dispatch-attempt-evidence.spec.ts` and the tenant-isolation Idempotency spec), `createSpeakingAudioQueryClient` (`speaking-audio-upload.spec.ts`), and the `string` form of the `PostgresSandboxDispatchBudget` constructor (`sandbox-dispatch-budget.spec.ts`, which also calls `onModuleDestroy`). Production wiring passes the shared client and never takes these paths. `integration-test` is the pool label they use. `src/common/postgres/postgres-pool.ts` is the only runtime source file that imports `pg`; it is the shared instrumented pool factory used by the shared Prisma client factory, and the database-lane specs keep their own `pg.Pool` for assertions and resets.

**Schema and migrations.** `schema.prisma` is created by `prisma db pull` against a database built from all existing migrations, then renamed to match the current TypeScript names. Partial indexes use Prisma 7's `partialIndexes` preview feature and BRIN uses the native `Brin` type. Objects the schema cannot declare (triggers and `CHECK` constraints) live only in SQL, each with a `///` comment in the schema naming its migration. Migrations use Prisma's standard `prisma/migrations/<name>/migration.sql` layout and `prisma.config.ts` declares the path. Prisma generates new SQL (`prisma migrate diff … --script`) there, where it is reviewed and hand-edited as needed. The existing runner (`scripts/cli/migrate.mjs`, `schema_migrations`) keeps applying migrations; it maps each directory name to the existing `<name>.sql` history key, so Production and Sandbox need no baseline and the runtime image gains no Prisma CLI. `scripts/checks/check-migrations.mjs` keeps enforcing expand-only. CI replays every migration into a disposable shadow database, then requires an empty `migrate diff` against `schema.prisma`.

### Migration layout follow-up (2026-10-12)

The migration files moved from flat `database/migrations/*.sql` files into Prisma's standard directory layout. The custom runner and `schema_migrations` remain the deployment mechanism; existing history keys are unchanged, and `prisma migrate deploy` is still not used. This adopts Prisma's file convention without baselining or replaying Production and Sandbox history.

**Build and boundaries.** The generated client is written outside `src/`, ignored by Git, and generated before `type-check` and the SWC build. `prisma` is a development dependency used only in the build stage. `@prisma/client` declares the CLI as an optional peer, which pnpm would resolve to that dev dependency and keep in the production tree, so `.pnpmfile.cjs` drops the peer and the Dockerfile copies it with the lockfile; `pnpm why prisma --prod` prints nothing. Only `**/infrastructure/**` may import the generated client, and `pnpm arch-check` enforces it for static imports, re-exports, `import()`, and `require()`, including the persistence module's own application and public folders. Other modules reach the persistence seam through `persistence.module.ts`, the module file the cross-module rule already allows. Infrastructure maps rows to application port types; Prisma types never reach application or domain code.

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

### Request and operator timeouts (#383; 2026-10-17)

The shared request pools set `statement_timeout` to 4 seconds, `lock_timeout`
to 1 second, and `idle_in_transaction_session_timeout` to 10 seconds. The
control-plane management context has a 5-second request deadline, and its
interactive transaction has `maxWait: 1_000` and `timeout: 5_000`; a 4-second
statement cap leaves one second for rollback and connection release, while the
one-second lock cap prevents a blocked statement from consuming that budget.
The 10-second idle-transaction cap is twice the interactive transaction limit,
so it catches a transaction abandoned outside the normal runner without
terminating a bounded transaction. These values are applied once by the shared
pool factory. `#588` separately owns reserving admission capacity.

Operator work uses a separate explicit profile: 5-minute statements,
30-second lock waits, and 60-second idle transactions. The Prisma-backed
operator factory and raw `pg` CLI and migration pools set that profile so
cleanup, reconciliation, and migration commands do not inherit request limits.
PostgreSQL statement and lock timeout errors map to retryable
`DATABASE_UNAVAILABLE` responses; the structured log records only the timeout
kind and never the SQL or its parameters.

## Benchmark

Run `pnpm build`, set `DB_LANE_ADMIN_URL` to the disposable PostgreSQL admin
URL on `localhost:5433/postgres`, then run `pnpm benchmark:control-plane`. The
harness compares three modes on PostgreSQL 16 with a pool of 10, 100,000 API
keys, 1,000,000 usage rows, and 100 organizations: raw `pg`, the Prisma generated
client, and Prisma's raw path issuing the same SQL as raw `pg` (the path the
API-key lookup and the aggregates take in production). For each mode it runs two
5-second passes at 50 operations per second for API-key lookup, durable Metering
insert, lookup followed by insert, and the request/token aggregate. Pass order is
reversed on the second pass. The harness confirms equal fixture outputs before
timing and reports p50/p95 latency, completed rate, statement round trips, and
failures. The aggregate uses the same parameterized SQL in every mode, so that
row compares database-client overhead.

The table records the range across the two passes, in milliseconds.

| Operation               | Round trips (pg / Prisma client / Prisma raw SQL) |         Raw pg p50 / p95 |  Prisma client p50 / p95 | Prisma raw SQL p50 / p95 | Completed rate/s (pg / client / raw SQL) |
| ----------------------- | ------------------------------------------------: | -----------------------: | -----------------------: | -----------------------: | ---------------------------------------: |
| API-key lookup          |                                         1 / 2 / 1 |   1.69–1.88 / 2.39–10.72 |    2.96–3.08 / 4.24–4.65 |    1.71–1.90 / 2.23–2.61 |  50.06–50.19 / 50.07–50.16 / 50.10–50.12 |
| Durable Metering insert |                                         1 / 1 / 1 |    2.49–2.63 / 3.47–4.08 |    3.20–3.26 / 4.38–4.60 |    2.54–2.75 / 3.26–3.90 |  50.09–50.11 / 50.05–50.09 / 50.04–50.15 |
| Lookup then insert      |                                         2 / 3 / 2 |  3.74–4.88 / 5.25–451.32 |    5.23–5.25 / 7.15–7.40 |    4.15–4.32 / 5.71–6.32 |  50.07–50.09 / 50.07–50.15 / 50.00–50.05 |
| Request/token aggregate |                                         1 / 1 / 1 | 9.64–11.02 / 13.37–23.96 | 9.97–10.20 / 12.34–12.49 | 9.86–10.40 / 12.14–18.95 |        50.10 / 50.07–50.08 / 49.99–50.06 |

All scheduled operations completed without failures and the three modes returned
equal fixture outputs. The generated client's API-key lookup uses two statements
because the selected organization relation is fetched separately, which costs
about 1.2 ms at p50; Prisma's raw path matches raw `pg`, so the lookup stays one
SQL statement. One raw `pg` lookup-then-insert pass had a 451 ms p95 while the
other pass was about 5 ms; treat that isolated tail as local-run noise. These
short, single-host measurements are descriptive, not a capacity estimate or a
performance gate.

### Drizzle comparison

Drizzle was removed from the dependency tree in #525, so the harness no longer
carries a Drizzle mode. This is the run recorded while it did, with the same
dataset and rate; each completed-rate cell shows raw `pg` / Drizzle / Prisma
client operations per second.

| Operation               | Round trips (pg / Drizzle / Prisma) |         Raw pg p50 / p95 |         Drizzle p50 / p95 |          Prisma p50 / p95 | Completed rate/s (pg / Drizzle / Prisma) |
| ----------------------- | ----------------------------------: | -----------------------: | ------------------------: | ------------------------: | ---------------------------------------: |
| API-key lookup          |                           1 / 1 / 2 |    1.57–2.34 / 2.04–2.80 |     1.78–2.38 / 2.32–3.07 |     2.94–2.97 / 3.90–4.83 |  50.08–50.16 / 50.11–50.13 / 50.06–50.10 |
| Durable Metering insert |                           1 / 1 / 1 |    2.63–2.80 / 3.32–3.63 |     2.79–3.07 / 3.64–3.86 |     3.47–3.68 / 4.38–5.59 |  50.06–50.17 / 50.08–50.09 / 50.13–50.16 |
| Lookup then insert      |                           2 / 2 / 3 |  3.97–4.28 / 5.02–115.25 |     4.38–4.39 / 5.36–6.01 |     5.88–6.27 / 7.17–7.79 |        50.06–50.13 / 50.06 / 49.99–50.06 |
| Request/token aggregate |                           1 / 1 / 1 | 9.83–10.43 / 11.50–13.12 | 10.06–10.60 / 11.79–12.49 | 10.46–10.49 / 12.06–12.55 |        49.99–50.05 / 50.04 / 50.03–50.08 |

## Considered options

- **Keep Drizzle and finish it (ADR-0071).** Rejected by the owner: Drizzle had reached 7 of 32 implementations, so switching cost about what finishing would, and Prisma's schema-first workflow and team familiarity were preferred.
- **Prisma for schema and migrations only, queries unchanged.** Rejected: queries would keep hand-written or Drizzle types next to `schema.prisma`, restoring the two sources of truth this change removes, and the typed client would go unused.
- **`prisma migrate deploy` with `_prisma_migrations`.** Rejected: it needs a baseline of every existing migration on Production and Sandbox, the Prisma CLI in the migration container, and a rewritten expand-only check, while the existing runner already applies generated SQL.
- **Keep transactions on `pg` until a whole module moves.** Rejected: Prisma cannot join a transaction opened on a `pg` client, so migrated repositories could not write inside the transactions they belong to.
