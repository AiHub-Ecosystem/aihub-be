# ADR-0086: Trust the single nginx hop for caller IPs

- Status: Accepted
- Date: 2026-10-09
- Related: [#139](https://github.com/AiHub-Ecosystem/aihub-be/issues/139), [ADR-0079](0079-managed-nginx-configuration-on-shared-vps.md), [ADR-0081](0081-aihub-owned-customer-web-web-sessions.md)

## Context

The managed production and Sandbox nginx configs append nginx's observed `$remote_addr` to `X-Forwarded-For` with `$proxy_add_x_forwarded_for`. The effective VPS configuration was checked on 2026-10-09; it has no active `real_ip_header`, `set_real_ip_from`, or `real_ip_recursive` directives. Fastify had proxy trust disabled, so requests reaching the app shared the socket peer address for IP-scoped auth counters.

The app listens on its container interface and its host ports bind to loopback. Docker maps the production port to container `172.16.7.4`; the host route to that address uses source `172.16.7.1`, the current `aihub-production_backend` gateway. The app also shares Docker networks with internal services, which can call it directly from their own container addresses.

## Decision

Configure the app's Fastify adapter to trust only the immediate socket peer `172.16.7.1`. Fastify 5.12.5 deliberately disables hop-count-only trust, so `trustProxy: 1` would ignore forwarded addresses. With the host Docker gateway trusted, the rightmost forwarded address is the caller address nginx observed and appended. Both managed nginx configs overwrite `X-Forwarded-Host` with the routed `$host`, so a caller cannot use the newly trusted proxy to choose the authentication environment. Use Fastify's `request.ip` as the common IP value for local-auth and API-key failure counters. Do not trust an unbounded proxy chain or parse `X-Real-IP` separately.

Keep `/ready` tied to the raw socket peer so it remains private when reached through a proxy. Web Session routes continue to see the BFF as their network caller; end-user-aware BFF limits remain with #436.

## Consequences

- Public callers receive separate IP-scoped auth and API-key failure budgets. Existing thresholds, windows, email dimensions, and counter behavior stay unchanged.
- A caller-supplied left side of `X-Forwarded-For` cannot choose the public caller's bucket because nginx appends its observed address and Fastify only accepts forwarded addresses from the host gateway.
- A caller-supplied `X-Forwarded-Host` cannot override the routed `Host` and change environment binding at the app.
- Direct container peers are not trusted to supply forwarded addresses; their socket address remains their bucket. If Docker recreates the backend network with another gateway, update the trusted peer before rollout or public requests will again share the socket-peer bucket.
- The API-key failure counter existed in production by at least 2026-09-14; local-auth IP limits were added on 2026-09-19. With proxy trust disabled, those callers shared the app's socket-peer bucket during that exposure window, so one caller's failures could consume the shared budget for others.
