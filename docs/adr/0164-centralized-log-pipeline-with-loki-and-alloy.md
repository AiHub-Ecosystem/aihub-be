# ADR-0164: Centralized log pipeline with Loki and Alloy

- Status: Accepted; the owner approved this decision in session on 2026-11-13.
- Date: 2026-11-13
- Amends: [ADR-0093](0093-correlate-request-completion-with-ingress-logs.md) — adds a maximum age to the existing size-bounded log policy; [ADR-0126](0126-self-hosted-monitoring-recovers-without-history.md) — adds Loki history loss and the log pipeline to the recovery scope
- Related: [#1793](https://github.com/AiHub-Ecosystem/aihub-be/issues/1793), [#601](https://github.com/AiHub-Ecosystem/aihub-be/issues/601), [#234](https://github.com/AiHub-Ecosystem/aihub-be/issues/234), [#237](https://github.com/AiHub-Ecosystem/aihub-be/issues/237), [#871](https://github.com/AiHub-Ecosystem/aihub-be/issues/871), [#968](https://github.com/AiHub-Ecosystem/aihub-be/issues/968)

## Context

AIHUB currently has no centralized log store. Operators can search the
size-bounded Docker logs, AIHUB-specific Nginx access logs, and best-effort
deploy snapshots on the application host with
[`request-log-lookup.sh`](../../scripts/ops/logs/request-log-lookup.sh).
Replacing a container can remove the only live copy. Loki is listed in the
stack specification but is not deployed. Metrics scrape directly to
Prometheus, and application traces export directly to Tempo under ADR-0063.

The local application and Nginx logs contain personal and tenant-linked
identifiers. The app container limit is 3 × 10 MB per container; the AIHUB
Nginx log rotates at 10 MiB with four generations. Both age limits currently
vary with volume. Deploy snapshots are capped at 20 MB per app container and
have a best-effort 30-day cleanup. Issue #601 tracks maximum-age enforcement.

## Decision

1. **Pipeline.** Use Loki on the Grafana monitoring host as the historical
   store. Run Grafana Alloy on the Production/Sandbox application host to ship
   only AIHUB Production and Sandbox application container logs and
   AIHUB-specific Nginx access logs. Do not collect unrelated containers or
   the shared Nginx access log.
2. **Operator access and investigation.** Keep Grafana and these logs
   operator-only; customers receive no Grafana or Loki access. Loki is the
   primary historical search path. Keep `request-log-lookup.sh` as the local
   fallback. Document the request-ID path from Loki to the matching Tempo
   trace and usage record. This decision adds no per-Organization dashboards.
3. **Data boundary.** Retain the existing application and Nginx field
   allowlists. Do not ship request bodies, query values, headers, or raw
   downstream responses. Logs may still contain client IP, request and trace
   IDs, Organization/API-key IDs, and a path that can include a username;
   access is therefore restricted to operators.
4. **Retention.** Set a maximum age of 30 days for every copy: Loki, Docker
   application logs, AIHUB Nginx access logs, and `deploy-logs/` snapshots.
   Existing size limits remain in force and may expire records earlier.
   Thirty days is the maximum investigation window, not a minimum availability
   promise. It supports delayed incident discovery while limiting retention of
   personal data. Enforce the age limit on each local source under #601; the
   current Docker and Nginx rotations do not yet enforce it.
5. **Recovery.** Keep Loki data on the monitoring host without an off-host
   backup. Losing that host loses retained Loki history. Extend ADR-0126's
   four-hour clean-host recovery objective to include a ready Loki, a healthy
   Alloy log path from Production/Sandbox, and a searchable controlled log
   record. Historical log restoration remains outside the objective.
6. **Configuration and deployment gate.** Keep non-secret Loki, Alloy, and
   Grafana datasource configuration in the private
   [aihub-monitoring-config repository](https://github.com/AiHub-Ecosystem/aihub-monitoring-config);
   keep credentials in Vault. Before any Production deployment:
   - measure a representative seven-day byte volume for each selected source
     and project the 30-day Loki storage requirement;
   - set and record hard CPU, memory, and disk caps for Loki and Alloy,
     including the alert and full-disk behavior;
   - create a linked implementation issue and verify the configuration,
     retention enforcement, and recovery steps against those limits.

   The 2026-11-13 monitoring-host observation was 7.76 GiB total RAM, 1.96
   GiB available RAM, 60% root-disk use, and 41.8 GB free. This is a dated
   baseline, not an approved resource budget; remeasure before deployment.
   No numeric Loki or Alloy cap is approved by this ADR.

7. **Unchanged telemetry paths.** Metrics continue directly to Prometheus.
   Traces continue directly to Tempo; Alloy does not receive traces or
   implement tail-based sampling. ADR-0063 remains in force, and #871/#968
   retain their separate scope.

## Options rejected

- **A. Do nothing:** rejected because the existing local lookup cannot provide
  reliable historical search after container replacement.
- **C. Use Alloy for logs, metrics, and traces:** rejected because the current
  direct metrics and trace paths work, while changing trace routing or adding
  tail sampling would expand this decision into ADR-0063 and #871/#968.

## Consequences

Operators can search logs retained for up to a 30-day maximum and correlate a
request ID with trace and usage evidence. Retention may expire earlier, and loss
of the host removes Loki history. The logs remain operator-only
because they include personal and tenant-linked identifiers. Loki adds storage
and recovery work on an already shared host, so deployment remains blocked
until the seven-day measurement and hard resource caps are recorded and
reviewed. Until #601's local age enforcement is deployed and verified, existing
Docker, Nginx, and snapshot copies can exceed the newly accepted 30-day maximum.
