# ADR-0170: Require a Secret ID for runtime Vault AppRole logins

- Status: Superseded by ADR-0171
- Date: 2026-11-16
- Supersedes: [ADR-0013](0013-vault-runtime-secret-management.md) authentication consequences
- Related: [#431](https://github.com/AiHub-Ecosystem/aihub-be/issues/431), [#193](https://github.com/AiHub-Ecosystem/aihub-be/issues/193), [#414](https://github.com/AiHub-Ecosystem/aihub-be/issues/414)

## Context

The runtime AppRole had `bind_secret_id=false`, so the role ID alone could read
every runtime bundle from any container whose request reached Vault through the
shared Docker gateway. The source CIDR cannot distinguish containers on that
host. The earlier one-use Secret ID design in ADR-0013 and #193 did not match
the provisioned role or current Agent configuration.

## Decision

- Require `bind_secret_id=true` for the runtime AppRole and require both the
  role ID and a Secret ID at login.
- Give the runtime Secret ID no expiry and unlimited uses so Vault Agent can
  re-authenticate unattended after a restart or token revocation. Keep the
  observed Vault-side CIDR restriction as defense in depth.
- Store the Secret ID in an operator-provisioned file mounted only into Vault
  Agent. Do not expose it to application containers or CD.
- Limit each runtime role to 12 login requests per minute with a one-minute
  block. Rate-limit quota administration remains in the operator session.
- On compromise, provision replacement role credentials, install both files,
  restart and verify Agent authentication, then revoke the old Secret ID.

## Consequences

- Agent restarts remain unattended, while possession of the role ID alone no
  longer grants access to production bundles.
- The durable Secret ID is a standing credential and must be protected like a
  secret. The login quota bounds repeated login attempts but does not alert on
  a single successful login from a host container.
- #193's one-use Secret ID minting proposal is retired; #414's memory-only
  rendering decision remains separately blocked on Vault startup/recovery
  policy in #798.

## Rollback

Do not restore role-ID-only login. If the Agent cannot authenticate with the
new files, restore a verified replacement Secret ID or roll back the Agent
configuration while keeping `bind_secret_id=true`; rotate credentials if the
Secret ID may have been exposed.
