# AIHUB Vault bootstrap

This directory contains the non-secret Vault policy and Agent template used by
AIHUB. It never contains a Vault address, token, role ID, secret ID, or runtime
credential.

## KV paths

The existing KV v2 mount is the source of runtime secrets:

```text
secret/aihub/{environment}/ai-speaking
secret/aihub/{environment}/ai-writing
secret/aihub/{environment}/seaweedfs
```

The first two bundles are required by the current gateway. SeaweedFS is
reserved for the future audio-asset integration and may be absent until that
consumer is deployed.

## Policy bootstrap

Run these commands from an operator-controlled session, never from AIHUB and
never with the application machine identity:

```powershell
vault policy write aihub-development-runtime ops/vault/policies/aihub-development-runtime.hcl
vault policy write aihub-staging-runtime ops/vault/policies/aihub-staging-runtime.hcl
vault policy write aihub-production-runtime ops/vault/policies/aihub-production-runtime.hcl
```

Provision one AppRole per environment with a short token TTL and a bounded
maximum TTL. Deliver the Role ID and one-time Secret ID to Vault Agent through
the deployment secret channel; never commit or paste them into an issue.

The AppRole policy must be read-only and must not receive `root`, `sys`, auth
management, write, delete, or broad-list capabilities. Revoke bootstrap/root
sessions after provisioning and verify the resulting identity with a manual
smoke test.

## Agent template

`templates/runtime-secrets.json.ctmpl` renders the JSON shape consumed by the
AIHUB runtime-secret provider. Set `AIHUB_VAULT_ENVIRONMENT` in the Agent
process and render the file to the path configured by
`AIHUB_RUNTIME_SECRETS_FILE`.

The rendered file must be readable only by the AIHUB service account. Its
directory must not be world-readable, and the file must not be copied into
application logs, images, backups, or source control.

## Safe verification

Use the repository's opt-in `pnpm vault:smoke` command only with a dedicated,
non-root AppRole identity. It reports path access and policy failures without
printing Vault responses or secret values. It is not part of CI or the default
verification loop.
