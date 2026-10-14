# ADR-0086: Trust the single nginx hop for caller IPs

- Status: Accepted; authentication email dimensions amended by [ADR-0096](0096-authentication-rate-limits-by-caller-and-address.md); runtime trust configuration and deployment verification clarified by #496
- Date: 2026-10-09
- Related: [#139](https://github.com/AiHub-Ecosystem/aihub-be/issues/139), [ADR-0079](0079-managed-nginx-configuration-on-shared-vps.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md)

## Context

The managed production and Sandbox nginx configs append nginx's observed `$remote_addr` to `X-Forwarded-For` with `$proxy_add_x_forwarded_for`. The effective VPS configuration was checked on 2026-10-09; it has no active `real_ip_header`, `set_real_ip_from`, or `real_ip_recursive` directives. Fastify had proxy trust disabled, so requests reaching the app shared the socket peer address for IP-scoped auth counters.

The app listens on its container interface and its host ports bind to loopback. Docker maps the production port to container `172.16.7.4`; the host route to that address uses source `172.16.7.1`, the current `aihub-production_backend` gateway. The app also shares Docker networks with internal services, which can call it directly from their own container addresses.

## Decision

Configure the app's Fastify adapter to trust only the immediate socket peer `172.16.7.1`. Fastify 5.12.5 deliberately disables hop-count-only trust, so `trustProxy: 1` would ignore forwarded addresses. With the host Docker gateway trusted, the rightmost forwarded address is the caller address nginx observed and appended. Resolve authentication environment from the `Host` header rather than Fastify's proxy-aware `request.hostname`. Both managed nginx configs overwrite `X-Forwarded-Host` with the routed `$host` as defense in depth. Use Fastify's `request.ip` as the common IP value for local-auth and API-key failure counters. Do not trust an unbounded proxy chain or parse `X-Real-IP` separately.

Keep `/ready` tied to the raw socket peer so it remains private when reached through a proxy. Web Session routes continue to see the BFF as their network caller; end-user-aware BFF limits remain with #436.

## Consequences

- Public callers receive separate IP-scoped auth and API-key failure budgets. Existing thresholds and IP windows stay unchanged; authentication email dimensions follow ADR-0096.
- A caller-supplied left side of `X-Forwarded-For` cannot choose the public caller's bucket because nginx appends its observed address and Fastify only accepts forwarded addresses from the host gateway.
- Environment binding uses nginx's routed `Host`, not `X-Forwarded-Host`, so caller-supplied proxy headers cannot switch the authentication environment.
- Direct container peers are not trusted to supply forwarded addresses; their socket address remains their bucket. If Docker recreates the backend network with another gateway, update the trusted peer before rollout or public requests will again share the socket-peer bucket.
- The API-key failure counter existed in production by at least 2026-09-14; local-auth IP limits were added on 2026-09-19. With proxy trust disabled, those callers shared the app's socket-peer bucket during that exposure window, so one caller's failures could consume the shared budget for others.

## Runtime and deployment amendment for #496 (2026-10-14)

Read the single trusted peer from the required `AIHUB_TRUSTED_PROXY_IP` runtime
setting and validate it as an IP literal before Nest starts. Do not retain a
source-code fallback. Production, Sandbox, and staging must set the exact
immediate nginx peer; development and test must also declare their own value.
Fastify trusts that one IP only.

Keep the shared `backend` network external to Compose at the fixed name
`aihub-production_backend`. Compose previously attempted to replace the live
network when its IPAM declaration changed, but Production, Sandbox, and Vault
Agent were attached during the migration preflight. Create the external network
with subnet `172.16.7.0/24` and gateway `172.16.7.1`; the blue-green helper
checks the live network and `AIHUB_TRUSTED_PROXY_IP` before any Compose
operation. CI verifies the runtime value and external network name. Production
and Sandbox share this network; the external database network is not trusted.
A topology change must update the network and trusted peer together before
rollout.

After each enabled tier is cut over, GitHub Actions requests the public
`/docs` route and joins its AIHUB-generated `X-Request-Id` to the application
completion event and AIHUB nginx access record. `/health` remains the health
check, but it is intentionally excluded from completion events. The IP proof
passes only when the application reports `client_ip_source: nginx` and its
`client_ip` matches nginx's observed `client_ip`. Wait up to ten seconds for
both records; missing or mismatched evidence fails the gate and rolls back only
that tier. Actions output reports pass/fail without either address. Production
is checked before Sandbox; a Sandbox failure does not roll back a passing
Production release, consistent with ADR-0085.
