# ADR-0104: Observe shared-host and dependency health

- Status: Proposed; shared-host owners, database role/security, alert policy, resource budgets, and monitoring-stack source ownership are not approved
- Date: 2026-10-15
- Related issues: [#474](https://github.com/AiHub-Ecosystem/aihub-be/issues/474), [#237](https://github.com/AiHub-Ecosystem/aihub-be/issues/237), [#291](https://github.com/AiHub-Ecosystem/aihub-be/issues/291), [#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298), [#362](https://github.com/AiHub-Ecosystem/aihub-be/issues/362), [#412](https://github.com/AiHub-Ecosystem/aihub-be/issues/412), [#560](https://github.com/AiHub-Ecosystem/aihub-be/issues/560)
- Related ADRs: [ADR-0103](0103-budget-postgresql-connections-on-shared-cluster.md)

## Context

Read-only inspection on 2026-10-15 found the monitoring stack on `69.62.74.196` and the AIHUB application/shared PostgreSQL host on `76.13.218.96`. The live stack runs Prometheus `v3.13.4`, Grafana `12.4.11`, Tempo `2.10.8`, and Alertmanager `v0.34.1`. The Prometheus target API listed Alertmanager and the three bot jobs only, with no AIHUB targets. Prometheus has no host-published port; Grafana and Alertmanager are bound to loopback. The monitoring configuration is operator-managed outside this repository, and its canonical writable Git worktree is not identified. Do not modify the live configuration until its source-of-truth and ownership boundary are clarified. No host files or services were changed.

On the AIHUB host, `aihub-db` publishes PostgreSQL only on `127.0.0.1:5433`. `dashboard_backend` publishes only `127.0.0.1:8000`, and a host-side request to `/metrics` returned 404. A targeted source scan found dashboard API routes but no Prometheus collector. `s3-vps-watchdog` uses host networking and exposes no observed metrics listener; its visible source surface includes status/certificate checks and `/healthz`. A full source and collection audit remains outstanding. On the monitoring host, an external TCP probe to Redis port `6379` was closed. An unauthenticated `maxmemory` query returned no value, so the Redis endpoint, access policy, configured limit, and owner-approved exporter credentials remain unverified.

A monitoring-host resource snapshot on 2026-10-15 showed 7.8 GiB total memory, 1.9 GiB available, no swap, and 63% root-disk use. Prometheus, Grafana, Tempo, and Alertmanager used about 395 MiB combined at the instant sampled. This is a baseline only; no exporter overhead has been measured against an approved budget.

The prior #474 blocker, #456, is closed. The issue is unblocked, but shared-host notifications (#362), monitoring registration (#237), database role/security (#298), alert ownership and routing (#412), and exporter resource budgets (#327/#114) remain gates. The PostgreSQL threshold of 80% of measured `max_connections` is recorded in proposed ADR-0103; the shared-cluster owner and all application owners have not approved their individual budgets.

## Decision

Keep a versioned candidate monitoring bundle in this repository. Its current images are pinned to node_exporter `v1.12.1`, cAdvisor `v0.60.6`, postgres_exporter `v0.20.1`, Redis exporter `v1.93.0-alpine`, blackbox_exporter `v0.28.0`, and the deployed Prometheus `v3.13.4`. These versions were checked against the upstream projects on this ADR's date; review image security updates before any host rollout.

Exporters bind to an operator-selected, non-public host address. Prometheus on the monitoring host reaches local exporters through the Docker host gateway. It reaches Production exporters through SSH local forwards to their loopback listeners; the SSH forwards bind only to the monitoring Docker bridge gateway. No exporter port is published on a public interface. The live Docker gateway address, network membership, host-key pin, SSH account, and firewall behaviour must be verified by the monitoring and host owners before applying the candidate.

Keep cAdvisor behind the explicit `container-metrics` Compose profile. The Docker socket mounted read-only still grants root-equivalent Docker API access. Do not enable that profile until the shared-host owners accept the access and the metric label filter is confirmed to retain only AIHUB containers. cAdvisor metrics do not retain stopped-container history; its OOM and restart alerts require an on-host rehearsal before being trusted.

Use a separate PostgreSQL monitoring credential file. Do not grant broad `pg_read_all_stats` access merely to enable collection. The database owner and #298 must approve a least-privilege source for activity, lock, database-size, and long-transaction metrics. Keep statement-statistics collection disabled until the shared-cluster restart, per-AIHUB-database extension, normalized-query privacy check, and queryid/database-only export have been coordinated with the cluster owners.

Keep Redis credentials in a host secret file rendered from the approved secret source. Do not put them in the Compose environment file. The exact Redis target and its `maxmemory` policy must be verified with the owner before enabling collection or treating the 80% memory rule as meaningful; the rule has no signal when `maxmemory` is zero.

Version the proposed alert expressions with the exporter metrics. The 80% disk threshold and 14-day certificate window come from #474; the 80% PostgreSQL connection threshold comes from #560. Memory pressure at 10%, Redis at 80% of `maxmemory`, Redis mean command latency at 100 ms, restart count, and clock offset at five seconds are proposals only. #412 must assign severity, owner, notification route, and approved bounds before the rules are installed. The `node_timex_offset_seconds` rule remains inactive until the time collector is available without granting an unapproved `CAP_SYS_TIME` capability.

## Consequences

The repository now has a candidate Compose file, scrape configuration, alert rules, and a runbook. CI can validate Compose syntax and Prometheus configuration/rule syntax. These checks do not establish target reachability, data coverage, owner approval, alert delivery, resource fit, or production state.

The configuration is not deployed. #474 remains open until the source audit, secure scrape path, target metrics, outside port probe, alert catalog/routing, certificate schedule, database permissions, clock signal, and resource measurements have production evidence. See [the observability runbook](../operations/aihub-observability.md).
