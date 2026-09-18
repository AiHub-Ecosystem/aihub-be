# ADR-0017: Sandbox as a hostname-bound fourth environment

- Status: Accepted
- Related issues: #47, #50

AIHUB treats `sandbox` as a fourth request environment with its own API hostname, alongside `production`, `staging`, and `development`. `production` remains mandatory; the other tiers are optional and an unset tier is absent from the hostname map. On the production VPS, host nginx explicitly serves only the configured production and sandbox hosts; it never uses a wildcard, catch-all, or on-demand TLS. Hostnames must be unique after normalization, and host configuration changes reload nginx.

Sandbox is an identity, metering, and request-control boundary. #50 strengthens
the data boundary with a second application container, a separate database in
the existing Postgres instance, and Redis logical database `/1`; downstream
services and the deployment runtime credential realm remain shared. Its
controls are the sandbox organization, environment-bound API keys, issuer
binding, rate limit, and concurrency ceiling. Monthly quota and hard-stop
enforcement are tracked separately in #51. The sandbox ingress hostname is
`sandbox.aihubproduction.com`; the sandbox organization's issuer remains the
stable identity URI `https://sandbox.aihubproduction.com`.

Local `localhost` remains the development-only convenience host, but public placeholder hostnames are never added to the map when their variables are absent. Host settings accept normalized hostnames only and fail closed on duplicates. Host configuration is independent of sandbox assertion-mint configuration: an unconfigured mint route is `404`, while environment binding remains available to authenticated operations. The CLI accepts only the four canonical environment names; the existing text-array schema remains extensible and unknown legacy values fail closed. `sandbox` is not a deployment secret realm, and cross-environment enforcement covers every API-key route, including assertion minting; infrastructure probes and documentation routes are outside that matrix.

The production Compose stack may know about configured staging/development hosts for resolver compatibility while deliberately public-serving only production and sandbox through the host nginx configuration; another deployment or proxy owns the other tiers. Nginx receives an explicit production-plus-optional-sandbox server configuration and reloads when that list changes. The sandbox profile uses the same image and downstream credentials as production but requires its own database URL, Redis URL, and loopback port. Verification covers boot guards, normalized host collisions, resolver absence, CLI validation, nginx configuration rendering, cross-environment rejection at the application boundary, and absence of sandbox rows from the production database; the edge may reject an unknown host with its own 421/404 response.

## Update for #50 (2026-09-18)

The implementation follows the live VPS topology rather than the issue's older
Caddy wording. Host nginx already owns ports 80/443 and serves unrelated sites,
so the isolated sandbox is published through a second nginx server block to the
`app-sandbox` loopback port. No second Postgres or Redis service is introduced;
the durable boundary is the `aihub_sandbox` database and Redis `/1` is only
cache/counter separation.

## Deployment correction (2026-09-16)

The proxy parts of this record were wrong about the deployment they described.

The production VPS terminates TLS with **host nginx**, not with a containerized
proxy service. Attempting to start the old proxy failed a release by binding
port 80 against nginx. The VPS is shared: nginx serves eleven sites and around
twenty containers from several unrelated projects sit behind it, so the Compose
stack cannot own those ports.

The obsolete proxy service and its deployment file have been removed rather than
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

The sandbox ingress hostname recorded above is also superseded: it is
`sandbox.aihubproduction.com`, not `sandbox-api.aihubproduction.com`. Nothing
had been published under either name when this changed, so the cost was a
string in three documents.

It now matches the sandbox organization's issuer exactly. That is deliberate
and harmless — the issuer is compared as an opaque string and its key set is
registered inline, so nothing ever fetches it — and it follows the OIDC
convention of an issuer naming its own host. The one consequence worth
knowing: the issuer URI now resolves to the gateway, so probing it returns a
404 rather than failing to resolve.
