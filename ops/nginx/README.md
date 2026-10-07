# Managed nginx configuration

`aihub-api.conf` and `sandbox.conf` are the only AIHUB nginx configs in source.
The mixed host file remains operator-owned and is intentionally not captured or
synced from this repository. See [the VPS runbook](../../docs/operations/deploy-vps.md#managed-nginx-configuration)
for the one-time supervised migration and helper bootstrap.

The operator installs `aihub-nginx-apply` as root-owned
`/usr/local/sbin/aihub-nginx-apply` and grants the deploy user one exact
`NOPASSWD` sudoers entry for that no-argument path. CD stages config data in
`/var/lib/aihub-nginx-staging`; the helper only changes the two allowlisted
AIHUB files, validates with `nginx -t`, reloads on success, and restores the
previous files on failure. The operator must review and install helper updates;
CD never installs or updates its own privileged helper.

Run `bash ops/nginx/check-gzip.sh` with nginx installed to prove the two
Speaking grading locations compress the captured verdict fixture and that
`Vary: Accept-Encoding` is present, while an unrelated API path stays
uncompressed.
