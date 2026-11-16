# ADR-0171: Vault runtime login requires a Secret ID as well as the role ID

- Status: Accepted
- Date: 2026-11-16
- Related issue: [#431](https://github.com/AiHub-Ecosystem/aihub-be/issues/431)
- Related: [ADR-0013](0013-vault-runtime-secret-management.md), [ADR-0056](0056-customer-sandbox-test-tier.md), [#193](https://github.com/AiHub-Ecosystem/aihub-be/issues/193), [#390](https://github.com/AiHub-Ecosystem/aihub-be/issues/390), [#414](https://github.com/AiHub-Ecosystem/aihub-be/issues/414)
- Supersedes: [ADR-0170](0170-vault-runtime-approle-secret-id.md)
- Amends: [ADR-0013](0013-vault-runtime-secret-management.md) (AppRole auto-auth mechanism and its one-use Secret ID rotation statement)

## Context

ADR-0013 put Vault AppRole auto-auth in the Vault Agent and kept the NestJS
process away from AppRole login. The provisioner set `bind_secret_id=false` with
`bound_cidr_list=<docker gateway>`. That makes the role ID a complete
credential: any container on the shared host reaches Vault from the same NATed
gateway and can log in with a copied role ID, then read every production bundle
— the control-plane database URL, the User Access JWT signing key, the outbox
keys, the AI Service token, and the storage credential (#431, TM-OP-02). The
CIDR is a network boundary, not per-container isolation; #390 narrows who shares
the address but does not replace a per-Agent credential. Logins are also not
rate-limited or alerted.

ADR-0013 further says the one-use AppRole Secret ID must be rotated when the
Agent container is recreated. The provisioned role has no Secret ID at all, so
that sentence conflicts with the running mechanism, with `ops/vault/README.md`,
and with `docs/operations/deploy-vps.md`. #193 treated the obsolete one-use
premise as a reason for CD to mint a Secret ID per deploy; that proposal was
never implemented and is retired here.

## Decision

1. The Production and PgBouncer AppRoles use `bind_secret_id=true`. The Secret
   ID has `secret_id_ttl=0` and `secret_id_num_uses=0`, so it is durable and the
   Agent re-authenticates after a restart or a revoked token.
   `secret_id_bound_cidrs` remains as a second, off-host boundary.
2. `ops/vault/provision-runtime-secrets.mjs` mints each Secret ID with
   `vault write -wrap-ttl=5m -f`, unwraps it in the operator session, and writes
   the value directly to `AIHUB_VAULT_SECRET_ID_FILE` (or
   `AIHUB_PGBOUNCER_VAULT_SECRET_ID_FILE`). Neither the wrapping token nor the
   Secret ID is printed.
3. The Agent mounts both the role ID and the Secret ID from the deployment
   secret channel: mode `0600`, owned by `10001:10001`. CD does not mint, store,
   or rotate either credential.
4. On role ID or Secret ID compromise, rotate the AppRole and install both
   replacement files before restarting its Agent. A one-use Secret ID is never
   reintroduced.
5. Each runtime and PgBouncer AppRole has a per-role login quota of 12 requests
   per minute with a one-minute block, written to `sys/quotas/rate-limit` with
   `role=`. That parameter works in Vault Community Edition; only `group_by`
   modes are Enterprise. The Secret ID prevents an unauthorized login from
   succeeding, and the audit device records every attempt. The
   failed-runtime-login query is an operator-run detection rule in
   `ops/vault/README.md` and `docs/operations/vault-runtime-secrets.md`. It is
   not a Prometheus alert: Vault audit records are not shipped to Loki today,
   and adding that pipeline belongs to the monitoring repository. The catalog
   entry stays unrouted until the prerequisite exists.
6. #193's CD-minting proposal is retired. #414's memory-only delivery is
   unaffected, but its "role-ID-only authentication" premise is removed.

## Consequences

- A container on the shared host with the role ID and the gateway address
  cannot log in. A rehearsal must confirm this on the host before the issue
  closes; this repository change is not by itself production evidence.
- Agent restart, token revocation, and sealed-Vault recovery use the same
  re-authentication path; no operator mints a credential for a restart.
- Two files must be rotated together, and both are in the deployment secret
  channel rather than in the image or the repository.
- The one-use Secret ID sentence in ADR-0013 no longer describes the runtime.
  The earlier "no Agent secret_id" statements in the runbooks are replaced.
- The quota refuses a burst of login attempts. A single attempt is visible only
  when an operator runs the detection query or when Vault audit logs are shipped
  to the monitoring stack.

## Rollout and verification

Follow the Vault template cutover procedure: stage the role and both credential
files, then restart the Agent before merging the new templates. Validate Compose
interpolation, run the opt-in AppRole smoke test without printing values, and
confirm both Agents render their snapshots. Do not claim the rehearsal or alert
delivery has run from this repository.
