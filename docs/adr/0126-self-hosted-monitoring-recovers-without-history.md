# ADR-0126: Self-hosted monitoring recovers without historical telemetry

- Status: Accepted
- Date: 2026-10-24
- Related: [ADR-0063](0063-request-tracing-through-otlp.md), #237, #412, #456, #481, #826

## Context

AIHUB's application and monitoring services run on separate hosts. Prometheus and Tempo keep their data in local volumes, while the shared monitoring configuration has no dependable clean-host recovery path. The team needs to restore alert coverage after a monitoring-host loss without treating operational telemetry as durable customer or billing evidence.

## Decision

- Keep non-secret monitoring configuration (Compose, Prometheus and Alertmanager configuration, Grafana provisioning and dashboards, and Tempo configuration) in a dedicated version-controlled repository outside application working trees. Keep receiver credentials in Vault or the host's secret environment file, never in that repository.
- Do not back up Prometheus or Tempo data volumes off-host. If the monitoring host is lost, all retained telemetry history is lost. At this decision date, the shared Prometheus retention is 30 days, the AIHUB Prometheus retention is 14 days/512 MB, and Tempo block retention is 48 hours; these settings bound live history, not recoverability.
- Restore live monitoring within four hours of declaring monitoring-host loss. The RTO is met when expected scrape targets are healthy, alert rules are loaded and evaluating, both HTTPS routes are ready, Grafana authentication works, Tempo is ready, and a controlled Sandbox alert reaches its configured route. Historical data restoration is outside this RTO.
- Serve Grafana UI at `https://grafana.<approved-domain>` through the existing host Nginx with TLS; Grafana login remains required, with anonymous access and sign-up disabled. Serve OTLP/HTTP at `https://otel.<approved-domain>/v1/traces` through a separate TLS virtual host. Its reverse-proxy route accepts only the fixed Production egress IP (Production and Sandbox share that host) and forwards to Tempo's loopback receiver. Do not expose the Grafana or Tempo container ports directly, and do not accept OTLP from arbitrary Internet clients.
- Keep the exact DNS names, Nginx virtual hosts, TLS renewal setup, and certificate probes in the monitoring configuration repository. The DNS records must point to the monitoring host; until the records and routes are deployed and verified, Grafana remains reachable through its current SSH tunnel and the application leaves `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` empty.
- Keep the trace-all policy and no-collector-in-the-application-stack decision from ADR-0063. #968 measures tracing overhead and receiver-outage behavior; #237 owns the deployed path and its live evidence.
- Revisit the self-hosted choice if #481 selects a hosted monitoring service. #826 owns the monitoring-host reboot drill; this ADR's RTO covers clean-host recovery.

## Consequences

The monitoring stack can be rebuilt from configuration and credentials without restoring historical metrics or traces. A monitoring-host loss permanently removes the retained telemetry history, and the four-hour recovery objective must be demonstrated in a clean-host rehearsal.
