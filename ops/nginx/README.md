# Managed nginx configuration

`aihub-api.conf` and `sandbox.conf` are the AIHUB virtual hosts. The separate
`00-aihub-log-format.conf` defines their minimal access-log format in nginx's
`http` context, and `aihub-access-logrotate` bounds its local rolling log. The
mixed host file remains operator-owned and is intentionally not captured or
synced from this repository. See [the VPS runbook](../../docs/operations/deploy-vps.md#managed-nginx-configuration)
for the one-time supervised migration and helper bootstrap.

The operator installs `aihub-nginx-apply` as root-owned
`/usr/local/sbin/aihub-nginx-apply` and grants the deploy user one exact
`NOPASSWD` sudoers entry for that no-argument path. CD stages fixed config data
in `/var/lib/aihub-nginx-staging`; the helper manages the two AIHUB virtual
hosts, their log-format include, both AIHUB logrotate policies, and the
AIHUB-only rsyslog receiver. It creates or tightens the active log files
without truncating them, validates logrotate, rsyslog, and nginx, restarts
rsyslog only when its config changes, and restores the previous config files
on failure. The deploy script requires helper version 2 before it changes
application containers. The operator must review and install helper updates;
CD never installs or updates its own privileged helper.

The helper pins each staged logrotate and rsyslog file's SHA-256 because the
policies and service restart run as root. Changing one of those files also
requires an operator-reviewed helper update. If a later config step fails, the
helper restores its managed config files but keeps the active logs and their
restrictive permissions; it never truncates or deletes log records during
rollback.

Production and Sandbox app containers send only their JSON message payloads to
the TCP receiver on `127.0.0.1:1514`. The fixed `aihub-production` and
`aihub-sandbox` tags route to separate files; other tags are discarded. Docker's remote log cache is disabled, and each app container uses a bounded
16 MiB non-blocking buffer. A full buffer can drop new messages. `docker logs`
is therefore unavailable for these app containers; use
`scripts/ops/logs/request-log-lookup.sh` to search the local files and any
legacy `json-file` containers during migration. The 10 MiB app-logrotate
threshold runs on the daily timer; it is not a hard disk ceiling. #1904 tracks
local rsyslog capacity enforcement.

AIHUB access records contain the Unix timestamp, observed address, upstream
`X-Request-Id`, method, `$uri` without a query string, and status. The timestamp
allows daily byte totals to be grouped by UTC date without retaining raw lines.
Both AIHUB
hosts use `/var/log/aihub-access.log`; the shared `/var/log/nginx/access.log`
and other sites are not changed. Rotation runs daily with numeric archive
names to keep existing `.1` and `.2.gz` generations in the same retention
chain. It keeps the existing 10 MiB `maxsize` threshold and four rotated
generations; `maxage 28` removes older segments on the daily run. `ifempty`
ensures cleanup also runs when the active file is empty. A segment contains at
most one day's records, and the daily cleanup can run up to one day after a
segment reaches the 28-day cutoff, so a record expires within 30 days when the
host's daily logrotate timer is running. The four-generation count limit can
expire records sooner; the active file may exceed 10 MiB between host logrotate
runs. Date-stamped daily filenames are not enabled because they would exclude
the current numeric archives from rotation and age cleanup. The helper creates
the active file as
`root:adm` mode `0640` (or tightens those permissions without truncating it),
and logrotate preserves that mode for new active files. The rotation policy
uses `su root adm` because this host's shared `/var/log` directory is group
writable.

Run `bash ops/nginx/check-gzip.sh` with nginx, logrotate, and sudo installed to
prove the access-log fields and query redaction, validate rotation syntax, and
check the two Speaking grading locations against the captured verdict fixture.
It also verifies that `/metrics` is served only through the loopback scrape
listeners and remains unavailable on both public hosts, with the Sandbox block
exercised alongside the API block.
