# Managed nginx configuration

`aihub-api.conf` and `sandbox.conf` are the AIHUB virtual hosts. The separate
`00-aihub-log-format.conf` defines their minimal access-log format in nginx's
`http` context, and `aihub-access-logrotate` bounds its local rolling log. The
mixed host file remains operator-owned and is intentionally not captured or
synced from this repository. See [the VPS runbook](../../docs/operations/deploy-vps.md#managed-nginx-configuration)
for the one-time supervised migration and helper bootstrap.

The operator installs `aihub-nginx-apply` as root-owned
`/usr/local/sbin/aihub-nginx-apply` and grants the deploy user one exact
`NOPASSWD` sudoers entry for that no-argument path. CD stages config data in
`/var/lib/aihub-nginx-staging`; the helper only changes the two AIHUB virtual
hosts, their log-format include, and the AIHUB logrotate file. It also creates
or tightens the active access log without truncating it. It validates the
logrotate config with `logrotate --debug` and nginx with `nginx -t`, reloads on
success, and restores the previous config files on failure. The operator must
review and install helper updates; CD never installs or updates its own
privileged helper.

The helper pins the staged logrotate file's SHA-256 because `postrotate` runs
as root. Changing that file also requires an operator-reviewed helper update.
If a later config step fails, the helper restores its managed config files but
keeps the active log and its restrictive permissions; it never truncates or
deletes log records during rollback.

AIHUB access records contain the observed address, the upstream
`X-Request-Id`, method, `$uri` without a query string, and status. Both AIHUB
hosts use `/var/log/aihub-access.log`; the shared `/var/log/nginx/access.log`
and other sites are not changed. Rotation uses a 10 MiB size threshold and
keeps four rotated files, compressed after the first rotation. This is a
size-based window, not a fixed number of days; the active file can exceed the
threshold between host logrotate runs. The helper creates the active file as
`root:adm` mode `0640` (or tightens those permissions without truncating it),
and logrotate preserves that mode for new active files. The rotation policy
uses `su root adm` because this host's shared `/var/log` directory is group
writable.

Run `bash ops/nginx/check-gzip.sh` with nginx, logrotate, and sudo installed to
prove the access-log fields and query redaction, validate rotation syntax, and
check the two Speaking grading locations against the captured verdict fixture.
