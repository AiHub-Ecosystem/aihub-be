# ADR-0017: Sandbox as a hostname-bound fourth environment

- Status: Accepted
- Related issue: #47

AIHUB treats `sandbox` as a fourth request environment with its own API hostname, alongside `production`, `staging`, and `development`. `production` remains mandatory; the other tiers are optional and an unset tier is absent from the hostname map. In the production Compose deployment, Caddy explicitly serves only the configured production and sandbox hosts; it never uses a wildcard, catch-all, or on-demand TLS. Hostnames must be unique after normalization, and host configuration changes recreate or reload Caddy.

Sandbox is an identity, metering, and request-control boundary, not a second deployment or secret realm in this issue. Sandbox traffic uses the same application, Postgres, Redis, downstream services, and deployment runtime credentials; its current controls are the sandbox organization, environment-bound API keys, issuer binding, rate limit, and concurrency ceiling. Monthly quota and hard-stop enforcement are tracked separately in #51. The sandbox ingress hostname is `sandbox-api.aihubproduction.com`; the sandbox organization's issuer remains the stable identity URI `https://sandbox.aihubproduction.com`.

Local `localhost` remains the development-only convenience host, but public placeholder hostnames are never added to the map when their variables are absent. Host settings accept normalized hostnames only and fail closed on duplicates. Host configuration is independent of sandbox assertion-mint configuration: an unconfigured mint route is `404`, while environment binding remains available to authenticated operations. The CLI accepts only the four canonical environment names; the existing text-array schema remains extensible and unknown legacy values fail closed. `sandbox` is not a deployment secret realm, and cross-environment enforcement covers every API-key route, including assertion minting; infrastructure probes and documentation routes are outside that matrix.

The production Compose stack may know about configured staging/development hosts for resolver compatibility while deliberately public-serving only production and sandbox through its Caddy domain list; another deployment or proxy owns the other tiers. Caddy receives an explicit production-plus-optional-sandbox list and is recreated or reloaded when that list changes. The current deployment shares database rows until the future separate sandbox application/database boundary in #50, which depends on this issue. Verification covers boot guards, normalized host collisions, resolver absence, CLI validation, Compose/Caddy rendering, and cross-environment rejection at the application boundary; the edge may reject an unknown host with its own 421/404 response.

## Correction (2026-09-16)

The Caddy parts of this record were wrong about the deployment they described.

The production VPS terminates TLS with **host nginx**, not with the Compose
`caddy` service, which had never run there. Attempting to start it failed a
release by binding port 80 against nginx. The VPS is shared: nginx serves eleven
sites and around twenty containers from several unrelated projects sit behind
it, so the Compose stack cannot own those ports.

The `caddy` service and `ops/deploy/Caddyfile` have been removed rather than
documented as unused. The comment in `cd.yml` had already said the VPS owned
80/443, and that was not enough to stop this — configuration that looks live and
is not will be edited again by the next person who reads it.

Everything else in this record stands. The application-side decisions — the
fourth `sandbox` environment, production being the only mandatory tier, absent
tiers being unresolvable, boot-time host validation, CLI environment
exclusivity, and cross-host rejection at the authentication boundary — are
unaffected: they never depended on which proxy was in front. What changes is
where a hostname is published, which is now an nginx server block and a certbot
certificate, described in `docs/operations/deploy-vps.md`.
