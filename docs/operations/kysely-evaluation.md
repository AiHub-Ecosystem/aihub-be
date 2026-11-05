# Kysely evaluation for complex reads

Status: prototype evaluation for [#1018](https://github.com/AiHub-Ecosystem/aihub-be/issues/1018). This is a recommendation, not an accepted change to the persistence standard or authorization to replace a production query.

## Scope

The spike reproduces the quota reconciliation aggregate in `src/modules/metering/infrastructure/billing/postgres-quota-reconciliation.repository.ts`. The existing implementation sends its reviewed SQL through Prisma `$queryRawUnsafe`. The prototype in `src/modules/metering/infrastructure/billing/kysely-quota-reconciliation.ts` builds an equivalent typed query with Kysely and compiles it to parameterized SQL. Both paths use the same `pg` pool shape; `createKyselyQuotaClient` accepts a pool created by `createPostgresPool`, so no additional connection budget or error handler is introduced.

`prisma-kysely@3.2.1` is a second generator in `prisma/schema.prisma`. It writes `dist/generated/kysely/types.ts` during the existing `prisma generate` step. The generated `DB` type contains the schema's tables and columns; no hand-written table definition or second schema exists. `bun run arch-check` rejects `kysely` and `@kysely-types/*` imports outside `infrastructure/`, matching ADR-0090. The focused spec asserts that the typed query uses the expected tables, joins, filters, aggregate, and bound date parameters, and that its execution borrows a connection from `createPostgresPool`.

Run the prototype and measurement with `bun run benchmark:kysely-spike`. The benchmark uses a stub pool that returns the same 100 rows for both modes; the two modes are verified to return equal rows before timing. It measures query construction plus driver handoff, alternating mode order across five passes of 5,000 queries. Peak RSS is sampled during the same workload in a fresh process for each mode. Type-check measurements spawn `tsc6` five times per scope.

## Findings

Measured 2026-11-05 on Node 24.21.0, Windows x64. The Docker daemon and a disposable PostgreSQL 16 instance were unavailable, so query latency excludes PostgreSQL execution time. The measurements describe client overhead on one developer machine, not a production capacity estimate.

| Mode               | Query p50 / p95 (ms) | p50 across passes (ms) | Peak RSS (MiB) |
| ------------------ | -------------------: | ---------------------: | -------------: |
| Prisma raw SQL     |      0.0001 / 0.0003 |          0.0001–0.0002 |           63.1 |
| Kysely             |      0.0151 / 0.0264 |          0.0133–0.0156 |           84.4 |
| Kysely import only |                  n/a |                    n/a |           62.4 |

| Type-check scope                         | Median (s) |                       Samples (s) |
| ---------------------------------------- | ---------: | --------------------------------: |
| Whole project with Kysely                |      10.60 |   9.88, 9.96, 10.62, 10.60, 11.59 |
| Whole project without Kysely spike files |      11.44 | 10.71, 11.44, 10.14, 13.53, 12.84 |

| Focused type-check        | Median (ms) |            Samples (ms) |
| ------------------------- | ----------: | ----------------------: |
| Generated Kysely DB types |         693 | 693, 705, 685, 726, 682 |
| Empty type-check baseline |         438 | 432, 438, 439, 437, 447 |

The focused median is about 255 ms above an empty `tsc6` invocation. Whole-project samples overlap between 9.88 s and 13.53 s across both scopes, so they do not show a repeatable type-check regression. Kysely's import alone adds about 1 MiB RSS; about 21 MiB more follows repeated query construction and execution in the stub workload.

## Compatibility and developer experience

Kysely 0.29.8 accepts the shared `pg.Pool` through `PostgresDialect`. `prisma-kysely` generated the schema types without a database connection and supports Prisma 7. Its generated `Timestamp` and `Buffer` types follow the `pg` values the repository already maps. The typed builder catches wrong table and column names at compile time; complex `FILTER`, CTE, and `SKIP LOCKED` clauses still need SQL fragments or raw SQL. The prototype's `sql.ref` fragment keeps column names typed while leaving the aggregate expression readable.

ADR-0088 is the active control-plane persistence standard. It says every production `postgres-*` implementation uses Prisma and requires a recorded exception for a repository outside Prisma; it also rejects TypedSQL because `prisma generate --sql` needs a live database. `prisma-kysely` avoids that live-database dependency, but adding a second query builder still expands the number of SQL-generation paths and the build's generator surface. The stack spec lists Kysely as a rejected DB access option. This evaluation follows ADR-0088 and does not amend or supersede it.

The generator also required a small change to `scripts/generate/generate-prisma-client.mjs`: Prisma resolves generator providers through PATH, while that script invokes the Prisma CLI directly with Node. Adding the local `node_modules/.bin` directory to the generator's PATH fixed the Windows `spawn prisma-kysely ENOENT` failure. A production adoption would carry that build dependency and a second generated artifact.

## Recommendation

Retain Prisma generated-client queries and the existing reviewed `$queryRawUnsafe` statements for production. Do not adopt Kysely for the measured analytical query: the typed builder costs about 0.015 ms at p50 on the stub path and about 21 MiB peak RSS in its workload process, while the current raw SQL statement is already one parameterized round trip with a fixed, tested row contract. Neither the client overhead nor the developer-experience gain addresses a measured database bottleneck.

Revisit only when a PostgreSQL 16 benchmark on a production-sized dataset shows a real query bottleneck attributable to Prisma or raw `pg`, and when a follow-up issue owns an ADR amendment with explicit generator, transaction, timeout, and row-mapping rules. That follow-up must compare end-to-end database latency and peak RSS under the shared pool budget in #560 and ADR-0103. The prototype files remain a bounded evaluation seam and are not wired into a module composition root or CLI.

## Conflicts and limits

- The issue asks for `pnpm verify`; the repository now uses Bun ([ADR-0139](../adr/0139-bun-is-the-package-manager-node-stays-the-runtime.md)), so `bun run verify` is the equivalent gate.
- The issue references raw `pg` production queries; ADR-0088 states that no production repository has a separate raw `pg` query path. Complex SQL currently runs through Prisma's raw path on the shared `pg` pool.
- The Docker daemon was unavailable, so no PostgreSQL 16 end-to-end latency or query-plan comparison was measured. The stub benchmark holds row delivery constant and cannot estimate database-side cost.
- The RSS probes sample each process every 100 queries rather than tracing the whole process tree continuously; treat them as sampled process peaks, not a complete memory profile.
