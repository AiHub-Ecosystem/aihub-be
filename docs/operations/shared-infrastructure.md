# Shared infrastructure register

This register is partial; #362 remains open until the other dependencies and
their notification agreements are recorded.

Ports each host may serve to the internet, with their owners, are in
`ops/firewall/<host>.allow`; see [Public ports](public-ports.md) (#464).

| Dependency                                                          | Operator / patch owner | Contact            | Change notice                                                                                                                                                                                                                   | AIHUB impact when unavailable                                               | Recovery owner | Patch review                                                                                                               |
| ------------------------------------------------------------------- | ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Prometheus, Grafana, Alertmanager, and Tempo on the monitoring host | AIHUB operator         | `@lengocanh2005it` | Record stack restarts, upgrades, and configuration changes in the relevant GitHub issue before applying them. The notification agreement for shared-host OS and network maintenance is unconfirmed and remains tracked by #362. | Metrics dashboards, trace queries, and alert notifications are unavailable. | AIHUB operator | Check upstream support status and security releases monthly; prioritize security fixes after validating the configuration. |

On 2026-10-15, #456 was applied on the shared monitoring host. The stack now
runs exact image tags: Grafana `12.4.11`, Prometheus `v3.13.4`, Tempo `2.10.8`,
and Alertmanager `v0.34.1`. Grafana publishes only `127.0.0.1:3100`; an
external HTTP probe timed out, and the Docker port mapping confirms loopback
only. The Grafana admin password was rotated after closing public access, and
anonymous access and sign-up are disabled.

Operators reach Grafana through an SSH local forward:

```sh
ssh -L 3100:127.0.0.1:3100 <operator>@<monitoring-host>
```

Then open `http://127.0.0.1:3100` locally. The monitoring host configuration
and rotated credential remain in the host deployment directory; the credential
is not recorded here.

## Target access after #237

The accepted target replaces the SSH-only Grafana path after the domain records
and TLS virtual hosts are deployed and verified:

- `https://grafana.<approved-domain>` proxies to `127.0.0.1:3100` and still
  requires Grafana authentication.
- `https://otel.<approved-domain>/v1/traces` proxies only OTLP/HTTP traces to
  Tempo's private receiver and accepts only the fixed Production egress IP.

Do not expose Grafana or Tempo container ports directly. Until this target is
live, continue using the SSH local forward above. Keep the virtual hosts,
allowlists, certificate renewal, and expiry probes in the monitoring
configuration repository; the exact DNS names are still pending the domain
team.

Upstream version policies:

- [Grafana support policy](https://grafana.com/docs/grafana/latest/upgrade-guide/when-to-upgrade/)
- [Prometheus LTS policy](https://prometheus.io/docs/introduction/release-cycle/)
- [Tempo version recommendations](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/recommended-versions/)
- [Alertmanager releases](https://github.com/prometheus/alertmanager/releases)
