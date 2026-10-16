# ADR-0103: Budget PostgreSQL connections on the shared cluster

- Status: Proposed; the numeric allocation awaits written approval from the shared-cluster owner and every application owner
- Date: 2026-10-15
- Related issues: [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560), [#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298), [#474](https://github.com/AiHub-Ecosystem/aihub-be/issues/474), [#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588)
- Related ADRs: [ADR-0085](0085-per-tier-blue-green-cutover.md), [ADR-0088](0088-prisma-for-control-plane-persistence.md)

## Context

AIHUB currently uses the shared PostgreSQL cluster while #298 has not chosen a dedicated instance. A read-only production measurement on 2026-10-15 over SSH (`nproc`, `free -h`, `swapon --show`, and `sudo docker exec aihub-db psql`) recorded PostgreSQL 16.15; `max_connections = 100`; `superuser_reserved_connections = 3`; `reserved_connections = 0`; `shared_buffers = 128MB`; `effective_cache_size = 4GB`; and `work_mem = 4MB`. The host reported 2 vCPUs, 7.7 GiB RAM, no swap, and 3.3 GiB available. This confirms the earlier `max_connections` and `shared_buffers` values (#299, 2026-10-06); available memory is a point-in-time value and differs from the earlier ~3.5 GB snapshot (#474, 2026-10-09).

The same inspection observed 8 `pg_stat_activity` rows, including the inspection query itself: one idle connection to each of `aihub` and `aihub_sandbox`, plus five background entries without a database. This is a point-in-time observation, not an application allocation or a workload peak. Neither the earlier 19-connection snapshot nor this measurement establishes a safe per-application budget.

Set 20 connections aside as operational/monitoring headroom, accepted by AIHUB owner `@lengocanh2005it` on 2026-10-15. With the measured `max_connections = 100`, three `superuser_reserved_connections`, and zero `reserved_connections`, the aggregate budget for the four applications must not exceed 77 (`100 - 3 - 0 - 20`). Recalculate this ceiling whenever PostgreSQL settings change. This headroom is a policy reserve, not a measured workload requirement; the per-application allocations remain open until the application owners approve them.

ADR-0088 records current application pool maxima of 74 connections per process when the three roles share a URL. ADR-0085 allows up to three AIHUB application containers during a blue-green cutover, so 222 is the source-derived theoretical maximum for that configuration, not an observed connection count or an approved target. #588 needs #560's approved budget before it can set numeric admission/general pool maxima.

## Decision

Use the current shared cluster as the sizing baseline. If #298 selects a dedicated AIHUB instance, recalculate this decision for that instance. Least-privilege roles and broader database security remain outside #560.

Record current PostgreSQL settings and host capacity from dated measurements. Keep `shared_buffers`, `effective_cache_size`, and `work_mem` unchanged unless workload evidence supports a change and the shared-cluster owner approves it in writing. Name the approving owner for any cluster-wide change.

Do not infer an application's allocation by dividing `max_connections`, subtracting a point-in-time connection count, or assigning the unused remainder. Obtain written owner approval for a maximum budget for each of the four applications, and for operational/monitoring headroom. Record the approver, date, evidence source, and amount. The sum of application budgets and agreed headroom must fit within the measured `max_connections` after subtracting the configured PostgreSQL reserved slots.

Derive AIHUB's peak from the largest supported overlap, summing every pool maximum that targets this cluster in each process:

- up to three application containers during cutover;
- two application containers plus one migration connection; or
- two application containers plus one scheduled CLI connection.

Require each CLI and migration pool to cap at one concurrent PostgreSQL connection. The relevant code surfaces are `scripts/cli/cli.mjs`, the Operator CLI clients in `src/cli/operator-*.ts` through `src/modules/persistence/infrastructure/prisma-client.ts`, and `scripts/cli/migrate.mjs`. Only one CLI operator command may run at a time. Scheduled jobs are suspended during deployment; migrations finish before the candidate container starts. Do not add CLI or migration headroom to the three-container scenario when deployment does not overlap those activities. The historical 74-connection process maximum is not the target; derive the per-process pool maxima from the approved AIHUB budget and these overlap scenarios.

The PostgreSQL metric and cluster-wide alert belong to #474. Alert when total connections reach 80% of the measured `max_connections`; verify the deployed metric and alert before closing #560. #456 is closed; #474 remains open pending its monitoring acceptance criteria.

## Consequences

No numeric application allocation or new pool maximum is approved by this proposal. The cluster owner and all application owners must provide written budgets, current server and host values must be measured, and the #474 alert must be deployed and verified before #560 is complete. #588 may implement its pool separation, but its numeric maxima and closure remain gated on the approved AIHUB budget recorded by #560.
