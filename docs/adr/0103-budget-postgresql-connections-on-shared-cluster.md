# ADR-0103: Budget PostgreSQL connections on the shared cluster

- Status: Proposed; numeric budgets and production rollout await fresh measurements and written approval from the shared-cluster owner and every affected application owner
- Date: 2026-10-15; amended 2026-11-05 for [#1589](https://github.com/AiHub-Ecosystem/aihub-be/issues/1589)
- Related issues: [#1589](https://github.com/AiHub-Ecosystem/aihub-be/issues/1589), [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560), [#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298), [#474](https://github.com/AiHub-Ecosystem/aihub-be/issues/474), [#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588), [#903](https://github.com/AiHub-Ecosystem/aihub-be/issues/903), [#412](https://github.com/AiHub-Ecosystem/aihub-be/issues/412)
- Related ADRs: [ADR-0085](0085-per-tier-blue-green-cutover.md), [ADR-0088](0088-prisma-for-control-plane-persistence.md)

## Context

AIHUB uses the shared PostgreSQL cluster while #298 has not chosen a dedicated instance. A read-only production measurement on 2026-10-15 over SSH (`nproc`, `free -h`, `swapon --show`, and `sudo docker exec aihub-db psql`) recorded PostgreSQL 16.15; `max_connections = 100`; `superuser_reserved_connections = 3`; `reserved_connections = 0`; `shared_buffers = 128MB`; `effective_cache_size = 4GB`; and `work_mem = 4MB`. The host reported 2 vCPUs, 7.7 GiB RAM, no swap, and 3.3 GiB available. A later read-only connection-setting check recorded in #560 on 2026-10-28 still reported `max_connections = 100`, three superuser-reserved slots, and zero additional reserved slots. These point-in-time observations are not a current rollout measurement; remeasure before using them to approve caps.

The 2026-10-15 inspection observed 8 `pg_stat_activity` rows, including its own query. A 2026-10-28 snapshot recorded in #560 observed 10 client backends, one active for the inspection and nine idle. Both are point-in-time observations, not application allocations or workload peaks, and neither establishes a safe application budget.

AIHUB owner `@lengocanh2005it` accepted 20 connections of operational/monitoring headroom on 2026-10-15. This is historical approval only under #1589. The derived 77-connection ceiling (`100 - 3 - 0 - 20`) is not a current target. No replacement headroom or numeric application allocation is approved; keep both TBD until current evidence and written owner approvals are recorded.

ADR-0088's earlier three-role calculation was 74 connections per process. A source correction recorded in #560 on 2026-10-25 adds the email-budget pool, bringing the current same-URL maximum to 75 per process, or 225 across three concurrent AIHUB containers if every role URL targets this cluster. These are configured ceilings, not observed use or approved budgets. PgBouncer changes which app-side clients consume PostgreSQL backends, so neither historical process maximum is a target for #1589.

Issue #298 documents direct clients beyond the four AIHUB applications budgeted by #560, including `speaking_app`. Every application and direct pool using this PostgreSQL cluster consumes the same server limit and must be represented in the cluster budget, even if it does not use PgBouncer.

## Decision

Use the shared cluster as the sizing baseline until #298 chooses a dedicated instance. Keep PostgreSQL `max_connections = 100` unchanged until fresh host/server measurements and written approval from the shared-cluster owner justify a change. Do not tune `shared_buffers`, `effective_cache_size`, or `work_mem` without workload evidence and the same written approval.

Prepare a draft target budget before load proof, but do not present a draft number as approved. The 20-connection reserve and 77-connection application ceiling from 2026-10-15 remain historical only. The new operational/monitoring headroom and per-application allocations are TBD until current evidence and written owner approvals are recorded. Do not infer a budget from an equal split, an unused remainder, or a point-in-time connection snapshot.

For every client that reaches this cluster, calculate its maximum over its supported process overlap. The backend budget must satisfy:

`sum(PgBouncer max_db_connections by alias) + sum(explicit direct-client pool maxima) + approved operational headroom <= measured max_connections - configured PostgreSQL reserved slots`.

PgBouncer `max_db_connections` is a hard cap per logical database alias, not a cluster-wide cap. Use an app-specific alias for each AIHUB application/database target that needs its own backend ceiling, and statically verify the sum of all alias caps. `default_pool_size` applies per user/database pool and must not be treated as a global cluster limit. Clients that remain direct must have an explicit pool maximum and an allocation in AIHUB's approved budget; an unknown or unbounded direct client blocks production rollout. Database role separation remains in #298; an alias is a quota boundary, not a security boundary.

Track app-to-PgBouncer client connections separately from PostgreSQL backend sessions. Set explicit app pool limits, sum them across the maximum supported replica overlap, and keep the sum within PgBouncer `max_client_conn`; also bound per-alias client queues with `max_db_client_connections`. PgBouncer's `query_wait_timeout` and the app-side checkout queue need explicit deadlines. A saturated request must return retryable `DATABASE_UNAVAILABLE` within one second end to end across app checkout, client connection establishment, and PgBouncer backend wait. `connectionTimeoutMillis` alone does not establish that end-to-end deadline. A timed-out queued request must not execute later, and no orphan PostgreSQL session may remain.

Deploy one PgBouncer endpoint in the existing production Compose topology, with `pool_mode = transaction`. The PostgreSQL cluster remains external to this Compose project. Document that the single PgBouncer process is a single point of failure, its health and rollback procedure, and the evidence that would trigger a highly available topology. PgBouncer failure or saturation fails closed; applications do not fall back to direct PostgreSQL connections.

Route the four AIHUB runtime applications through PgBouncer. Keep migration and administrative clients on direct database URLs with explicit `max = 1`; use the existing Vault delivery path and do not add a shared static credential to Compose or source. This does not imply distinct PostgreSQL login roles; that remains #298. The three AIHUB applications outside this repository need owner-specific follow-up work. Other cluster clients may remain direct only after their owners provide explicit pool caps and approved budgets.

Derive AIHUB's backend peak from the largest supported overlap, including:

- up to three application containers during cutover;
- two application containers plus a migration connection and any backup that can still be running;
- two application containers plus one scheduled CLI connection.

The backup drain audit in #560 found that suspending scheduled jobs does not prove an already-running PostgreSQL backup has exited. Include that connection in the applicable peak until deployment explicitly drains it. Keep one-connection caps for migration and CLI pools, run only one CLI operator command at a time, and derive each per-process maximum from the approved AIHUB budget.

The CI integration probe uses real PostgreSQL and PgBouncer in transaction mode, verifies Prisma 7.10.1 prepared-statement compatibility with `max_prepared_statements > 0`, and forces app-queue and PgBouncer-backend saturation. Pin the PgBouncer version/configuration exercised by the probe. Prove the one-second retryable failure, no late execution, and no orphan server session. Before rollout, staging must demonstrate the approved client/backend caps, all supported overlap cases, bounded queues, and recovery after saturation.

Export PgBouncer client, backend, and waiting-queue metrics and add an alert; #412 settles alert thresholds after staging evidence. Keep #474's PostgreSQL connection metric/alert and verify both layers. Update the reliability-maturity topology only from measured deployed state, not from the proposed configuration.

## Consequences

No numeric per-app cap or new operational headroom is approved by this amendment. Production rollout and closure of #1589 remain gated on fresh cluster measurements, written budgets for every client of the cluster, bounded direct-client pools, one written AIHUB approval of the complete table, staging evidence, PgBouncer/application pool metrics and alerts, and production verification. This repository can implement only its AIHUB application slice; #1589 stays open until the three other AIHUB integrations and all direct-client budgets are accounted for.

For Prisma 7, transaction pooling must be tested with a compatible pinned PgBouncer release and prepared-statement support enabled (`max_prepared_statements > 0`); Prisma migration tooling stays on a direct URL. See [Prisma's PgBouncer guidance](https://docs.prisma.io/docs/orm/v7/prisma-client/setup-and-configuration/databases-connections/pgbouncer) and [PgBouncer configuration](https://www.pgbouncer.org/config.html).
