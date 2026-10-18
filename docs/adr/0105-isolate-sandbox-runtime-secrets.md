# ADR-0105: Isolate Sandbox runtime secrets from Production

- Status: Accepted for the #351 cutover requested on 2026-10-17; live verification remains pending
- Date: 2026-10-17
- Related issues: [#351](https://github.com/AiHub-Ecosystem/aihub-be/issues/351), [#442](https://github.com/AiHub-Ecosystem/aihub-be/issues/442)
- Amends: [ADR-0013](0013-vault-runtime-secret-management.md) and [ADR-0017](0017-sandbox-environment-boundary.md)

## Context

The Production and Sandbox applications previously mounted the same Vault
Agent-rendered directory. The Sandbox process could read Production credentials
even when its runtime selected Sandbox database and Redis values. That made the
Sandbox credential boundary depend on application behavior rather than access
control.

## Decision

Give Production and Sandbox separate Vault policies, AppRoles, Agents, role ID
files, and rendered directories. Each policy grants read access only to its
own `secret/data/aihub/<tier>/` bundles. Production cannot read the Sandbox
assertion signing bundle; Sandbox cannot read any Production bundle.

Production database and Redis bundles contain only `url`. Sandbox database
contains its Sandbox `url` and the least-privilege Production control-plane
reader URL; Sandbox Redis contains only its own `url`. The runtime template
maps these into scope-specific fields, and the application loader rejects
fields from the other tier. The Sandbox signing key exists only at
`secret/aihub/sandbox/sandbox-assertion`.

Sandbox credentials must be distinct and restricted to Sandbox data and
resources. This includes a login limited to `aihub_sandbox`, a Redis ACL user
limited to Sandbox keys and commands (logical database `/1` alone is not an
isolation boundary), and a storage identity limited to Sandbox buckets. The
Sandbox Redis URL carries `keyPrefix=aihub-sandbox:`; the shared client factory
applies it to commands, and the Redis ACL allows only `aihub-sandbox:*`. This
keeps Production keys inaccessible even while a newly authenticated connection
is still on Redis's default database. Use a Sandbox User Access JWT signing key.
Use a separate Resend key when the provider supports it; otherwise do not copy
the Production key and keep Sandbox email delivery disabled until it can be
isolated. Provider credentials follow the same rule: a Sandbox process must
not receive a Production credential.

## Consequences

The cutover requires a Sandbox maintenance window to stop the old Sandbox
containers before they are recreated with the isolated Agent mount. Production
remains available. The Sandbox service stays disabled during the Production
code release and is brought back only after the Sandbox Agent passes Vault
policy, mount, and health checks.

`pnpm vault:smoke` verifies each AppRole's readable paths and cross-tier denials
without printing secret values. `blue-green-host.sh check-vault-agent <tier>`
verifies the running Agent's tier, role ID mount, rendered directory, file
permissions, rendered bundles, recent authentication, and health. The cutover is
complete only after both application tiers pass `ops/status.sh` and the
Sandbox-specific database, Redis, and storage grants are verified on their
services. Repository tests and policy checks do not prove those live grants.
