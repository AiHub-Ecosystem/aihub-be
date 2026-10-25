# Vault-backed runtime secrets

Production uses Vault Agent-rendered files. Local development and tests may use
an explicit `.env` source; production and staging never fall back to it.

## Source selection

AIHUB supports two explicit sources:

- `AIHUB_RUNTIME_SECRET_SOURCE=env` — development/test only.
- `AIHUB_RUNTIME_SECRET_SOURCE=agent-file` plus
  `AIHUB_RUNTIME_SECRETS_FILE=<agent-rendered JSON path>` — downstream AI,
  Resend, JWT, and SeaweedFS credentials.
- `AIHUB_RUNTIME_CONNECTION_SECRETS_FILE=<agent-rendered JSON path>` —
  database, Redis, and sandbox signing material. The process bootstrap selects
  the production or sandbox connection before Nest wiring.
- `AIHUB_AUTH_MFA_SECRETS_FILE=<agent-rendered JSON path>` — the separately
  rendered TOTP secret keyring. It stays outside the existing strict runtime
  JSON document so an N-1 image can keep reading its unchanged schema.

If a required bundle is missing or malformed, startup fails closed. A process
that has already loaded a valid snapshot keeps using its in-memory snapshot
during a temporary Vault/Agent outage; it does not read Vault per request.

## Migration sequence

1. Apply the matching policy from `ops/vault/policies/` with an operator
   session. Never use the AIHUB runtime identity for policy administration.
2. Create the KV v2 bundles: `ai-speaking`, `ai-writing`, `seaweedfs`,
   `resend`, `user-access-jwt`, `database`, `redis`, and `sandbox-assertion`.
   Before deploying an MFA writer, also provision `email-outbox`, `web-session`,
   and `auth-mfa`; the latter contains `current_key_id` and a JSON string of
   key IDs mapped to 32-byte base64 keys.
3. Provision the environment AppRole and configure Vault Agent to render all
   three files under the AIHUB service account.
4. Set the rendered-file paths in the deployment config channel. Do not put
   runtime credential values in `.env.production`.
5. Start one instance and run the opt-in AppRole smoke test. Verify health,
   Speaking/Writing dispatch, authentication, and redacted logs. The N-1 image
   ignores the new standalone MFA file and ignores the two new outbox kinds via
   the already-deployed unknown-kind reader; only the MFA writer release emits
   those kinds.
6. Roll the change across the deployment only after the first instance is
   healthy, then remove the migrated long-lived credentials from deployment
   environments.

## Rotation and rollback

Rotation is startup-only:

1. Write the replacement credential to a new KV version while the old one is
   still valid.
2. Confirm Agent renders the new snapshot without printing it.
3. Restart instances gradually and run health plus one safe downstream request.
4. Retire the old credential only after every instance is healthy. For the
   `email-outbox` keyring, distribute the new version to every instance while
   keeping the old version current; only then switch the current version and
   restart all instances. Retain an old key while queued ciphertext uses it or
   while an active recipient counter uses its version:

   ```sql
   SELECT split_part(payload_ciphertext, '.', 2) AS key_version,
          count(*) AS queued_requests
   FROM email_delivery_requests
   WHERE status = 'queued'
     AND payload_ciphertext IS NOT NULL
     AND split_part(payload_ciphertext, '.', 1) IN ('v1', 'v2')
     AND split_part(payload_ciphertext, '.', 2) <> ''
   GROUP BY 1
   ORDER BY 1;

   SELECT key_version, count(*)
   FROM auth_email_recipient_rate_limits
   WHERE expires_at > now()
   GROUP BY key_version;
   ```

   Run both queries against the Production and Sandbox outbox databases. Remove
   an old key only when the first query has no row for that version and the
   second query has no active counter for it. The queries expose versions and
   counts only. The application deletes expired counters at startup and hourly;
   wait for cleanup as well as expiry before removing a version. At startup, the
   scheduler logs queued versions missing from its keyring before its first pass;
   restore the version and restart before that pass so the queued messages can
   still be dispatched.

   This retention rule is enforced, not remembered: an instance that boots with
   a keyring missing a version whose counters are still inside their 24-hour
   window refuses to start (#1130), with a log line naming each dropped key
   version and the time its windows expire. An instance that boots while the
   database is unreachable still serves health - the image-boot contract - but
   its keyring gate stays unresolved, one error line is logged, and no outbox
   pass runs until the counter table becomes readable and the gate passes, so
   the ceiling is never reset either way; the queue-age alert is what surfaces
   a stuck gate. If a restart fails with
   `email outbox keyring no longer retains key versions with live
authentication-email recipient windows`, restore the dropped version to the
   keyring and restart, or wait for the named expiry and let the hourly
   cleanup delete the counters before pruning again. A pruned-version restart
   never silently resets the per-recipient ceiling.

Rollback restores the previous approved KV versions, restarts Vault Agent and
the application, and repeats the same checks. It never reintroduces a
production `.env` fallback. Hot reload, per-request Vault reads, and automatic
rotation orchestration remain out of scope.

## Failure matrix

| Condition                                  | Expected behavior                                           |
| ------------------------------------------ | ----------------------------------------------------------- |
| Missing Agent file before startup          | Production refuses to start                                 |
| Malformed or incomplete bundle             | Production refuses to start with a safe configuration error |
| Vault unavailable after snapshot load      | Current process keeps its in-memory snapshot                |
| Local explicit `env` source                | Allowed in development/test only                            |
| Root or non-expiring root-derived identity | Forbidden for AIHUB runtime                                 |

## Manual smoke test

Run only from a Vault CLI session authenticated as the generated non-root
AppRole. It reads required data paths, checks exact read-only capabilities, and
confirms unrelated paths and metadata are denied without printing values:

```powershell
$env:AIHUB_VAULT_SMOKE_ALLOW = 'true'
$env:AIHUB_VAULT_SMOKE_AUTH_METHOD = 'approle'
$env:AIHUB_VAULT_ENVIRONMENT = 'production'
pnpm vault:smoke
```
