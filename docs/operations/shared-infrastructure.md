# Shared infrastructure register

This register is partial; #362 remains open until the other dependencies and
their notification agreements are recorded.

Ports each host may serve to the internet, with their owners, are in
`ops/firewall/<host>.allow`; see [Public ports](public-ports.md) (#464).

| Dependency                                                          | Operator / patch owner | Contact            | Change notice                                                                                                                                                                                                                   | AIHUB impact when unavailable                                               | Recovery owner                                                                                                                                                                                             | Patch review                                                                                                               |
| ------------------------------------------------------------------- | ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Prometheus, Grafana, Alertmanager, and Tempo on the monitoring host | AIHUB operator         | `@lengocanh2005it` | Record stack restarts, upgrades, and configuration changes in the relevant GitHub issue before applying them. The notification agreement for shared-host OS and network maintenance is unconfirmed and remains tracked by #362. | Metrics dashboards, trace queries, and alert notifications are unavailable. | AIHUB operator; see the [monitoring-host recovery runbook](aihub-observability.md#clean-host-recovery-runbook) and joint-host-loss work in [#454](https://github.com/AiHub-Ecosystem/aihub-be/issues/454). | Check upstream support status and security releases monthly; prioritize security fixes after validating the configuration. |

On 2026-10-15, #456 was applied on the shared monitoring host. The stack now
runs exact image tags: Grafana `12.4.11`, Prometheus `v3.13.4`, Tempo `2.10.8`,
and Alertmanager `v0.34.1`. Grafana publishes only `127.0.0.1:3100`; an
external HTTP probe timed out, and the Docker port mapping confirms loopback
only. The Grafana admin password was rotated after closing public access, and
anonymous access and sign-up are disabled.

The normal Grafana route is HTTPS. If the public route is unavailable, an
operator with host SSH access can use this local forward as a fallback:

```sh
ssh -L 3100:127.0.0.1:3100 <operator>@<monitoring-host>
```

Then open `http://127.0.0.1:3100` locally. The monitoring host configuration
and rotated credential remain in the host deployment directory; the credential
is not recorded here.

## Monitoring host access (#237)

The deployed Grafana and OTLP routes are `https://grafana.aihubproduction.com`
and `https://otel.aihubproduction.com/v1/traces`. Grafana requires login;
OTLP accepts only the shared Production/Sandbox egress `76.13.218.96/32`.
Tempo and Grafana container ports remain bound to loopback. The host-loss
procedure and its unverified four-hour RTO are documented in the
[monitoring-host recovery runbook](aihub-observability.md#clean-host-recovery-runbook);
#454 tracks the joint host-loss rehearsal. The monitoring-host operator is
AIHUB operations; notification for shared-host OS and network maintenance
remains unconfirmed in #362.

Upstream version policies:

- [Grafana support policy](https://grafana.com/docs/grafana/latest/upgrade-guide/when-to-upgrade/)
- [Prometheus LTS policy](https://prometheus.io/docs/introduction/release-cycle/)
- [Tempo version recommendations](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/recommended-versions/)
- [Alertmanager releases](https://github.com/prometheus/alertmanager/releases)
