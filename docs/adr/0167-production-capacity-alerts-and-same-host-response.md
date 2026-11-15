# ADR-0167: Production capacity alerts and same-host response

- Status: Accepted
- Date: 2026-11-14
- Related: [#581](https://github.com/AiHub-Ecosystem/aihub-be/issues/581), [#327](https://github.com/AiHub-Ecosystem/aihub-be/issues/327), [#412](https://github.com/AiHub-Ecosystem/aihub-be/issues/412), [#474](https://github.com/AiHub-Ecosystem/aihub-be/issues/474), [#475](https://github.com/AiHub-Ecosystem/aihub-be/issues/475), [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560), [#588](https://github.com/AiHub-Ecosystem/aihub-be/issues/588), [#894](https://github.com/AiHub-Ecosystem/aihub-be/issues/894), [#900](https://github.com/AiHub-Ecosystem/aihub-be/issues/900)
- Related ADRs: [ADR-0011](0011-docker-compose-single-vps.md), [ADR-0103](0103-budget-postgresql-connections-on-shared-cluster.md), [ADR-0165](0165-production-availability-and-single-host-risk.md)

## Context

Issue #581 asks what AIHUB does as demand approaches the current Production capacity ceiling. Production uses a shared 2-vCPU host. The internal Production SLO remains 99.5%; there is no customer availability SLA, and loss of the whole host remains best-effort recovery under ADR-0165. Issue #475 has not decided a customer SLA.

The #327 baseline recorded on 2026-10-21 ran three repetitions on separate 4-vCPU GitHub-hosted runners, with AIHUB capped at 1.5 CPU and 768 MiB. Its first observed ceiling was the downstream connection pool at 16 offered RPS; the 96-RPS overload stage peaked at 309 MiB RSS without restarts. The run explicitly does not establish capacity for the shared 2-vCPU Production host. Since that run, downstream pool limits, adaptive concurrency/admission, Speaking job reservations, and Production pooler configuration have changed. Those are benchmark invalidation inputs in [the capacity benchmark procedure](../operations/capacity-benchmark.md), so its numbers cannot set current Production thresholds.

Current metrics provide several early signals: `aihub_process_cpu_seconds_total`; app-container memory usage relative to `container_spec_memory_limit_bytes`; `aihub_downstream_pool_queued`; `aihub_postgres_pool_waiting`; and PostgreSQL connection use compared with the written AIHUB budget once #560 approves it. Request rate provides workload context. A `429` or OOM event confirms that capacity is already near or beyond a limit. The existing `AIHUBProcessCpuNearLimit` alert at 1.2 CPU for five minutes remains a useful CPU alert, but it is not a complete capacity policy. The #560 database budget and #412 alert routing/policy are still open.

## Decision

- Use CPU, app memory/limit, downstream queue, PostgreSQL pool waiting, and approved PostgreSQL connection budget as a multi-signal capacity trigger. Interpret request rate as context; treat `429` and OOM as late confirmation, not early warning.
- Do not set numeric Production capacity thresholds from the 2026-10-21 #327 run. Rerun the full benchmark on isolated staging that matches the 2-vCPU Production host, the 1.5-CPU/768-MiB AIHUB limits, current code and pool/admission configuration, and representative grading, authentication, and overlapping scheduled-job workloads. Run three repetitions. Never generate benchmark load against Production. Set database thresholds only after #560 has an approved connection budget.
- Keep at least 20% headroom below each safe ceiling measured by that representative benchmark. Record the run date and workload with every resulting threshold. Until that evidence exists, the numeric thresholds are unapproved.
- When a leading signal exceeds its measured early-warning threshold for five minutes, create a ticket while there is time to prepare a same-host resize. Page only when remaining measured headroom is insufficient for the rehearsed end-to-end resize lead time plus the safety margin. Measure and rehearse that lead time before enabling the page condition. Issue #412 owns the alert catalog, notification route, and implementation policy.
- The ticket prompts a human capacity review and preparation to increase the current host's capacity. The repository maintainer/service owner approves any cost-bearing resize; an operator performs it. Do not resize automatically. Multi-host deployment, asynchronous grading under #401, and changes to Organization limits or pricing under #398/#76 require separate decisions.
- No approved numeric demand-growth forecast exists. Use rolling 30-day Production demand as the baseline, and review this decision before 2026-12-14 or when a new contract or material demand change occurs.
- This policy does not create a customer availability promise. Keep the internal SLO and single-host risk accepted by ADR-0165 until #475 decides otherwise.

## Consequences

AIHUB now has a human response policy for capacity pressure, but it does not yet have approved numeric Production thresholds or an enabled ticket/page policy. The #581 decision is not operationally complete until the representative staging benchmark is recorded, #560 approves the database budget, #412 configures the ticket and page, and the host-resize lead time is rehearsed. Keep #581 open until those conditions are evidenced. Until then, the existing CPU and saturation alerts remain partial signals and do not establish a Production capacity budget.

The policy chooses same-host capacity increase as the first response for the current topology. It makes no claim that this action provides host availability or removes the accepted single-host failure risk.
