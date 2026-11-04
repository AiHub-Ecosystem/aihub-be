# Secret scanning

Gitleaks v8.30.1 scans staged changes before commit and scans pull-request or
main-push commit ranges in CI. CI fetches full history so the selected range is
available. Both scans use `.gitleaks.toml` and redact findings. The CI scan also
runs on manual dispatch; without a commit range it scans full history.

Install the matching Gitleaks release from the
[official v8.30.1 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)
and make `gitleaks` available on `PATH`. The pre-commit hook fails if Gitleaks is
missing. The CI installer verifies the official Linux archive checksum.

Run the staged scan manually with:

```sh
gitleaks git --staged --config .gitleaks.toml --redact --no-banner
```

Run a full-history scan with:

```sh
gitleaks detect --source . --config .gitleaks.toml --redact --no-banner
```

There is no baseline. This configuration returns zero findings on the current
full Git history after its scoped allowlists.

## Detection rules and allowlists

The configuration extends Gitleaks default rules and adds rules for AIHUB API
keys (`aihub_sk_`, `aihub_sandbox_`, and `aihub_prod_`) and Vault AppRole role
and secret IDs.

Each rule-scoped allowlist names its path and reason:

- `.pnpm-store` contains third-party package files accidentally committed in
  `1a37902` and removed in `8f531d5`. Its exception requires both the original
  commit and the `.pnpm-store` path.
- The named MFA specs use the public RFC 6238 TOTP test vector. Its exception
  matches only the known historical commits and those spec paths; new commits in
  the same files remain scanned.
- The Postman API-key rule exception matches only the two public collection
  variable names in their introduction commit; later changes to those files stay
  scanned, and AIHUB key detection remains active.
- `.env.production.example` allows only its documented private-key placeholder.
- The sandbox assertion spec's historical private keys were test-only and
  never used by a deployment. Their exception is limited to three historical
  commits and the old and current spec paths. The current spec generates its key
  at test runtime.
- The auth identity spec's one fixed API-key format example is not a credential.

History rewrite decision: deferred. The `.pnpm-store` files were removed in
`8f531d5`; rewriting history would change descendant commit hashes and is
outside this issue.

## GitHub controls

Read-only repository API check on 2026-11-03 reports this repository as public,
with secret scanning and push protection enabled. Non-provider pattern scanning
is disabled. GitHub's custom-pattern API returns `Feature not available` for
both this repository and its organization, so the AIHUB-specific GitHub custom
patterns cannot be published with the current account configuration. Gitleaks
continues to detect those formats in local hooks and CI. Recheck the GitHub
feature before claiming platform-level AIHUB pattern coverage.

## When a secret is detected

1. Notify the repository owner or security contact immediately. Do not paste a
   secret into a GitHub issue, pull request, comment, or chat.
2. Revoke or rotate the credential at its source. For an AIHUB API key, revoke
   the old key and issue a replacement. For a Vault credential, follow the
   [Vault runtime-secret runbook](../../ops/vault/README.md) and the
   [deployment runbook](deploy-vps.md).
   A compromised AppRole role ID requires rotating that AppRole, installing the
   replacement role ID in the matching tier's host secret file, and restarting
   its Agent. See [credential-specific rotation tracking in #365](https://github.com/AiHub-Ecosystem/aihub-be/issues/365)
   for related procedures and known gaps.
3. Remove the exposed value from the current tree. If it entered Git history,
   coordinate history cleanup with the repository owner. Deleting the line does
   not revoke the credential.
4. After confirming the old credential no longer works, resolve its GitHub
   secret-scanning alert as revoked. Resolve a false positive only with a
   documented reason.
