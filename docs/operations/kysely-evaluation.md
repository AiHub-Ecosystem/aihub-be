# Kysely evaluation for complex reads

Status: prototype evaluation for [#1018](https://github.com/AiHub-Ecosystem/aihub-be/issues/1018). This is a recommendation, not an accepted change to the persistence standard or authorization to replace a production query.

## Scope

The spike reproduces the quota reconciliation aggregate in `src/modules/metering/infrastructure/billing/postgres-quota-reconciliation.repository.ts`. The existing implementation sends its reviewed SQL through Prisma `$queryRawUnsafe`. The prototype in `src/modules/metering/infrastructure/billing/kysely-quota-reconciliation.ts` builds an equivalent typed query with Kysely and compiles it to parameterized SQL. Both paths use the same `pg` pool shape; `createKyselyQuotaClient` accepts a pool created by `createPostgresPool`, so no additional connection budget or error handler is introduced.

`prisma-kysely@3.2.1` is a second generator in `prisma/schema.prisma`. It writes `dist/generated/kysely/types.ts` during the existing `prisma generate` step. The generated `DB` type contains the schema's tables and columns; no hand-written table definition or second schema exists. `bun run arch-check` rejects `kysely` and `@kysely-types/*` imports outside `infrastructure/`, matching ADR-0090. The focused spec asserts that the typed query uses the expected tables, joins, filters, aggregate, and bound date parameters, and that its execution borrows a connection from `createPostgresPool`.

Run the stub measurement with `bun run benchmark:kysely-spike` and the PostgreSQL 16 measurement with `DB_LANE_ADMIN_URL=<disposable local admin URL> bun run benchmark:kysely-database`. The stub benchmark returns the same 100 rows for both modes; the database benchmark creates a disposable database from all 60 repository migrations and seeds 100 organizations with 100,000 usage rows. Both benchmarks verify equal rows before timing and alternate mode order. The database benchmark compares Prisma raw SQL, raw `pg`, and Kysely on one `createPostgresPool` with `max: 10`, five passes of 30 queries per mode. The stub benchmark measures query construction plus driver handoff across five passes of 5,000 queries and samples peak RSS in a fresh process per mode. Its Prisma baseline child never imports or constructs Kysely, so the RSS comparison has a genuine baseline. Type-check measurements spawn `tsc6` five times per scope.

## Findings

Measured 2026-11-05 on Node 24.21.0, Windows x64, with PostgreSQL 16.15 in a disposable local container. The measurements describe one developer machine, not a production capacity estimate.

PostgreSQL 16.15, 100 organizations, 100,000 usage rows, shared pool of 10, equal rows across all modes. Two independent runs with the same fixture:

| Mode       | Run 1 p50 / p95 (ms) | Run 1 pass p50 range (ms) | Run 2 p50 / p95 (ms) | Run 2 pass p50 range (ms) |
| ---------- | -------------------: | ------------------------: | -------------------: | ------------------------: |
| Prisma raw |        34.31 / 56.32 |               32.19–40.79 |        47.41 / 88.98 |               43.05–51.65 |
| Raw `pg`   |        34.87 / 57.28 |               32.00–36.95 |        42.95 / 79.17 |               39.92–49.54 |
| Kysely     |        35.68 / 47.78 |               34.49–37.45 |        45.63 / 77.64 |               40.71–54.03 |

In run 1 the three end-to-end p50 values are within 1.37 ms; in run 2 the order changes and all pass-p50 ranges overlap between 32.00 ms and 54.03 ms. Query execution dominates client overhead on this dataset, so neither run establishes a Kysely latency advantage or a Prisma bottleneck.

Stub-pool client overhead, sampled peak RSS, and type-check timings:

| Mode               | Query p50 / p95 (ms) | p50 across passes (ms) | Peak RSS (MiB) |
| ------------------ | -------------------: | ---------------------: | -------------: |
| Prisma raw SQL     |      0.0001 / 0.0004 |          0.0001–0.0003 |           50.3 |
| Kysely             |      0.0165 / 0.0348 |          0.0305–0.0371 |           79.8 |
| Kysely import only |                  n/a |                    n/a |           62.2 |

| Type-check scope                         | Median (s) |                       Samples (s) |
| ---------------------------------------- | ---------: | --------------------------------: |
| Whole project with Kysely                |      17.91 | 92.35, 17.91, 16.52, 18.35, 14.10 |
| Whole project without Kysely spike files |      14.79 | 14.79, 10.94, 13.98, 15.64, 24.96 |

| Focused type-check        | Median (ms) |                Samples (ms) |
| ------------------------- | ----------: | --------------------------: |
| Generated Kysely DB types |         994 | 1,662, 1,115, 925, 880, 994 |
| Empty type-check baseline |         536 |     532, 536, 568, 537, 526 |

The focused median is about 458 ms above an empty `tsc6` invocation. One whole-project sample took 92.35 s on this host; the remaining samples overlap across both scopes, so whole-project timing does not show a repeatable type-check regression. With Kysely loaded only in its own RSS child processes, importing and constructing it adds about 12 MiB, and repeated query construction and execution reaches about 30 MiB above the Prisma baseline.

## Compatibility and developer experience

Kysely 0.29.8 accepts the shared `pg.Pool` through `PostgresDialect`. `prisma-kysely` generated the schema types without a database connection and supports Prisma 7. Its generated `Timestamp` and `Buffer` types follow the `pg` values the repository already maps. The typed builder catches wrong table and column names at compile time; complex `FILTER`, CTE, and `SKIP LOCKED` clauses still need SQL fragments or raw SQL. The prototype's `sql.ref` fragment keeps column names typed while leaving the aggregate expression readable.

ADR-0088 is the active control-plane persistence standard. It says every production `postgres-*` implementation uses Prisma and requires a recorded exception for a repository outside Prisma; it also rejects TypedSQL because `prisma generate --sql` needs a live database. `prisma-kysely` avoids that live-database dependency, but adding a second query builder still expands the number of SQL-generation paths and the build's generator surface. The stack spec lists Kysely as a rejected DB access option. This evaluation follows ADR-0088 and does not amend or supersede it.

The generator also required a small change to `scripts/generate/generate-prisma-client.mjs`: Prisma resolves generator providers through PATH, while that script invokes the Prisma CLI directly with Node. Adding the local `node_modules/.bin` directory to the generator's PATH fixed the Windows `spawn prisma-kysely ENOENT` failure. A production adoption would carry that build dependency and a second generated artifact.

## Recommendation

Retain Prisma generated-client queries and the existing reviewed `$queryRawUnsafe` statements for production. Do not adopt Kysely for the measured analytical query: PostgreSQL 16.15 shows overlapping p50 ranges for Prisma raw SQL, raw `pg`, and Kysely, while the typed builder adds about 0.017 ms of construction overhead and about 30 MiB sampled peak RSS above the isolated baseline in the stub workload. The existing raw SQL statement is already one parameterized round trip with a fixed, tested row contract. Neither the type-safety gain nor the measured client overhead addresses a database bottleneck.

Revisit only when a production-sized, concurrent workload shows a repeatable query bottleneck attributable to Prisma or raw `pg`, and when a follow-up issue owns an ADR amendment with explicit generator, transaction, timeout, and row-mapping rules. That follow-up must compare end-to-end latency and peak RSS under the shared pool budget in #560 and ADR-0103. The prototype files remain a bounded evaluation seam and are not wired into a module composition root or CLI.

## Conflicts and limits

- The issue asks for `pnpm verify`; the repository now uses Bun ([ADR-0139](../adr/0139-bun-is-the-package-manager-node-stays-the-runtime.md)), so `bun run verify` is the equivalent gate.
- The issue references raw `pg` production queries; ADR-0088 states that no production repository has a separate raw `pg` query path. Complex SQL currently runs through Prisma's raw path on the shared `pg` pool.
- The database benchmarks are two single-host runs with 100,000 usage rows and 30 sequential queries per pass; they are not production-sized or concurrent-load benchmarks. No query-plan comparison was recorded.
- The RSS probes sample each process every 100 queries rather than tracing the whole process tree continuously; treat them as sampled process peaks, not a complete memory profile.
