# ADR-0071: Drizzle is the control-plane persistence standard

- Status: Superseded by [ADR-0088](0088-prisma-for-control-plane-persistence.md)
- Date: 2026-10-04
- Related issues: [#37](https://github.com/AiHub-Ecosystem/aihub-be/issues/37), [#38](https://github.com/AiHub-Ecosystem/aihub-be/issues/38), [#39](https://github.com/AiHub-Ecosystem/aihub-be/issues/39), [#40](https://github.com/AiHub-Ecosystem/aihub-be/issues/40), [#9](https://github.com/AiHub-Ecosystem/aihub-be/issues/9)
- Related: [ADR-0016](0016-metering-boundary-and-billing-evidence.md)

## Context

The active architecture specs recommend Drizzle, while the running control plane currently uses parameterized raw `pg` queries, explicit row mapping, and a custom migration runner. Issue #37 asks whether to keep that implementation or establish a long-term database access standard. This choice affects durable identity and metering data, including PostgreSQL-specific behavior that must remain available.

## Decision

Drizzle is the default database access layer for control-plane persistence. Existing repositories move incrementally by vertical slice, starting with the API-key and organization identity-configuration repositories in #38. The rest of Identity and other control-plane repositories move in later slices; this is not a big-bang rewrite.

Queries that need direct PostgreSQL control use Drizzle's SQL API through the same driver and transaction. Migrated repositories do not keep a separate raw `pg` query path. Infrastructure maps database rows to application port types; ORM types do not cross into application or domain layers.

The comparison matrix covers raw `pg`, Drizzle, and TypeORM across performance, type safety, PostgreSQL feature compatibility, and maintenance burden. Representative API-key lookup, durable Metering write, and request/token aggregate queries were measured with raw `pg` and Drizzle on the same schema and PostgreSQL setup; p50/p95 latency, completed rate, and statement round trips are reported below. TypeORM was assessed using available documentation/evidence without a separate prototype. No fixed percentage threshold was imposed. The comparison showed no material regression at the documented Stage A peak of 10-50 RPS, so the migration proceeds with the tracer slice. If representative production/load measurements later show material regression, pause subsequent slices and reconsider the choice.

The database access decision requires preserving the existing migration history. Issue #40 owns the specific migration and CLI workflow, including the choice and configuration of tooling.

## Comparison matrix

| Candidate | Performance                                                                                                                                                                                                     | Type safety                                                                                                                   | PostgreSQL compatibility                                                                                                                                                                                                                                                                                                                                                    | Maintenance and fit                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `pg`  | Measured against Drizzle below. Lowest abstraction, but no material latency advantage at the measured 50 RPS load.                                                                                              | SQL parameters are safe when used correctly, but result shapes and column names are manually maintained.                      | Full feature access through SQL; the current repositories already use arrays, `bytea`, `ON CONFLICT`, and filtered aggregates.                                                                                                                                                                                                                                              | Few dependencies and direct control, balanced by repeated SQL and manual row mapping. It remains viable, but does not match the active architecture recommendation as well as Drizzle. |
| Drizzle   | Measured against raw `pg` below. Lookup/write medians were modestly higher; aggregate was near parity. No material regression was observed at the measured Stage A peak, subject to the benchmark limits below. | Typed schema, query builders, and selected result shapes keep query construction and returned fields aligned with TypeScript. | PostgreSQL dialect covers the required query shapes; the SQL API keeps PostgreSQL-specific expressions on the same pool and transaction. In Drizzle 0.45.3, the harness used `customType` for `bytea`. [PostgreSQL setup](https://orm.drizzle.team/docs/get-started-postgresql#node-postgres), [SQL API](https://orm.drizzle.team/docs/sql).                                | A small query/schema layer fits the existing SQL-centric repositories. It adds a dependency but reduces hand-maintained result mapping.                                                |
| TypeORM   | Not benchmarked; the agreed scope uses existing documentation/evidence rather than a third prototype.                                                                                                           | Typed entities and repository APIs, with runtime entity mapping/hydration.                                                    | PostgreSQL driver documents array, `bytea`, and `jsonb` types; insert/query APIs document conflict handling and index predicates. [PostgreSQL driver](https://typeorm.io/docs/drivers/postgres/), [insert builder](https://dev.typeorm.io/docs/query-builder/insert-query-builder/), [repository API](https://typeorm.io/docs/working-with-entity-manager/repository-api/). | Mature NestJS ecosystem, but its entity/repository abstraction is broader than needed for these SQL-focused persistence adapters. This is a fit judgment, not a benchmark result.      |

### Raw `pg` vs Drizzle benchmark

This is a local comparative check, not a production capacity claim. Both implementations used the same PostgreSQL 16 database, `node-postgres` 8.23.0 pool (max 10), schema, query semantics, and temporary dataset (100,000 API keys and 1,000,000 usage rows). Drizzle was 0.45.3. Each mode had two 5-second passes, scheduled at 50 operations/requests per second; order was raw, Drizzle, Drizzle, raw. Timed scope includes query construction, pool use, and the driver/database round trip, but excludes repository row mapping, HTTP, and application work. Semantic outputs were checked before timing.

| Operation                                          | Statement round trips | Raw `pg` p50 / p95 (ms, range across 2 passes) | Drizzle p50 / p95 (ms, range across 2 passes) | Completed rate |
| -------------------------------------------------- | --------------------: | ---------------------------------------------: | --------------------------------------------: | -------------: |
| API-key lookup                                     |                     1 |                      2.070-2.278 / 2.633-4.416 |                     2.432-2.498 / 3.206-3.251 |          ~50/s |
| Durable Metering insert (`ON CONFLICT DO NOTHING`) |                     1 |                      2.421-2.704 / 3.468-4.524 |                     2.909-2.937 / 3.879-3.907 |          ~50/s |
| Lookup then durable insert, sequential             |                     2 |                      4.525-5.008 / 5.806-9.107 |                     5.399-5.446 / 6.850-6.910 |          ~50/s |
| Request/token aggregate                            |                     1 |                  12.462-16.150 / 24.213-34.757 |                 12.459-13.300 / 18.436-18.909 |          ~50/s |

The measured lookup and insert median overhead was roughly 0.2-0.5 ms per statement; aggregate latency was comparable. Both completed the scheduled 50/s workload. The raw `pg` tail varied between passes, and each pass was short on a temporary local container, so these measurements do not establish production p95 behavior or a general throughput ceiling. They show no material regression at this load, not a universal performance guarantee. TypeORM was not measured.

## Consequences

- New and migrated control-plane repositories use Drizzle, with SQL kept available for PostgreSQL-specific queries.
- The first tracer slice stays limited to the two repositories named above. Remaining Identity repositories need follow-up migration slices.
- Metering remains durable in PostgreSQL and must continue to support its awaited per-request write and request/token aggregates.
- Existing raw `pg` repositories remain in place until their vertical slices move; production schema migration history must remain compatible throughout.

## Considered options

- **Keep raw `pg` as the long-term standard.** Rejected because hand-written query result mapping and SQL typing remain recurring maintenance costs, while the active architecture already recommends Drizzle.
- **Adopt TypeORM.** Rejected because its broader runtime abstraction and NestJS conventions do not provide a stronger fit for this SQL-focused control plane than Drizzle. No separate TypeORM benchmark prototype is required for this decision.
