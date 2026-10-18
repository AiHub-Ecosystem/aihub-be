#!/usr/bin/env bash
# Exercises scripts/ops/backup-postgres.sh with stubbed sudo, docker, age, and
# flock: prefixes by UTC hour and day, one log line per database, a failed
# dump that fails the run, a missing configuration, and no secret in the log.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
script="$repository_root/scripts/ops/backup-postgres.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

bin_dir="$test_root/bin"
home_dir="$test_root/home"
mkdir -p "$bin_dir" "$home_dir"

assert_contains() {
  grep -Fq -- "$2" "$1" || { printf 'expected %s to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; }
}
assert_not_contains() {
  if grep -Fq -- "$2" "$1"; then printf 'expected %s not to contain: %s\n' "$1" "$2" >&2; exit 1; fi
}

cat >"$bin_dir/sudo" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == -n ]] && shift
exec "$@"
STUB
cat >"$bin_dir/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
# docker exec <container> sh -c '...pg_dump...' sh <db>  -> a fake dump on stdout
# docker run --rm --env-file <f> -v <dir>:/data:ro <image> copyto <src> <dst>
cat >"$bin_dir/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  exec)
    db="${*: -1}"
    [[ "$db" == "${FAKE_DUMP_FAIL:-none}" ]] && { echo "pg_dump: database \"$db\" is broken" >&2; exit 1; }
    printf 'PGDMP fake dump of %s\n' "$db"
    ;;
  run)
    env_file= mount=
    while [[ "$1" != copyto ]]; do
      case "$1" in
        --env-file) env_file=$2; shift ;;
        -v) mount=${2%%:/data:ro}; shift ;;
      esac
      shift
    done
    grep -q '^RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=' "$env_file" || exit 3
    src=$2 dst=$3
    if [[ "$src" == /data/* ]]; then
      [[ -s "$mount/${src#/data/}" ]] || exit 4
    fi
    printf '%s -> %s\n' "$src" "$dst" >>"$FAKE_RCLONE_CALLS"
    ;;
  *) exit 9 ;;
esac
STUB
cat >"$bin_dir/age" <<'STUB'
#!/usr/bin/env bash
# age -r <recipient> -o <file>
out=
while (( $# )); do [[ "$1" == -o ]] && out=$2; shift; done
{ printf 'age-encrypted:'; cat; } >"$out"
STUB
chmod 755 "$bin_dir"/*

config="$home_dir/.aihub-backup.env"
cat >"$config" <<'CONF'
R2_ACCOUNT_ID=acct123
R2_ACCESS_KEY_ID=AKIDTEST
R2_SECRET_ACCESS_KEY=super-secret-value
R2_BUCKET=aihub-backups
AGE_RECIPIENT=age1testrecipient
CONF
chmod 600 "$config"

run_backup() {
  PATH="$bin_dir:$PATH" HOME="$home_dir" \
    AIHUB_BACKUP_AGE_BIN="$bin_dir/age" \
    AIHUB_BACKUP_LOG="$test_root/backup.log" \
    FAKE_RCLONE_CALLS="$test_root/rclone.calls" \
    "$@" bash "$script"
}

# An ordinary hour: both databases, hourly prefix only.
: >"$test_root/rclone.calls"
run_backup env AIHUB_BACKUP_NOW=2026-10-18T13:47:00Z
assert_contains "$test_root/backup.log" 'backup aihub exit=0'
assert_contains "$test_root/backup.log" 'backup aihub_sandbox exit=0'
assert_contains "$test_root/backup.log" 'prefixes=hourly object=aihub-20261018T134700Z.dump.age'
assert_contains "$test_root/rclone.calls" '/data/aihub-20261018T134700Z.dump.age -> r2:aihub-backups/hourly/aihub/aihub-20261018T134700Z.dump.age'
assert_contains "$test_root/rclone.calls" 'hourly/aihub_sandbox/aihub_sandbox-20261018T134700Z.dump.age'
assert_not_contains "$test_root/rclone.calls" 'daily/'
[[ "$(wc -l <"$test_root/rclone.calls")" == 2 ]]

# 00 UTC on the first day of a month: also copied to daily and monthly.
: >"$test_root/rclone.calls"
run_backup env AIHUB_BACKUP_NOW=2026-11-01T00:47:00Z
assert_contains "$test_root/backup.log" 'prefixes=hourly,daily,monthly'
assert_contains "$test_root/rclone.calls" 'r2:aihub-backups/hourly/aihub/aihub-20261101T004700Z.dump.age -> r2:aihub-backups/daily/aihub/aihub-20261101T004700Z.dump.age'
assert_contains "$test_root/rclone.calls" '-> r2:aihub-backups/monthly/aihub_sandbox/aihub_sandbox-20261101T004700Z.dump.age'

# A failed dump fails the run but does not stop the other database.
: >"$test_root/rclone.calls"
set +e
run_backup env AIHUB_BACKUP_NOW=2026-10-18T14:47:00Z FAKE_DUMP_FAIL=aihub_sandbox
code=$?
set -e
[[ "$code" == 1 ]]
assert_contains "$test_root/backup.log" 'backup aihub_sandbox failed step=dump dump_exit=1'
assert_contains "$test_root/backup.log" 'error=pg_dump:_database_"aihub_sandbox"_is_broken'
assert_contains "$test_root/rclone.calls" 'hourly/aihub/aihub-20261018T144700Z.dump.age'
assert_not_contains "$test_root/rclone.calls" 'aihub_sandbox-20261018T144700Z'

# No credential ever reaches the log.
assert_not_contains "$test_root/backup.log" 'super-secret-value'
assert_not_contains "$test_root/backup.log" 'AKIDTEST'

# A missing configuration fails before any dump.
mv "$config" "$config.away"
set +e
run_backup env AIHUB_BACKUP_NOW=2026-10-18T15:47:00Z
code=$?
set -e
[[ "$code" == 1 ]]
assert_contains "$test_root/backup.log" 'backup failed reason=config_missing'

printf 'postgres backup test passed: prefixes, per-database logging, dump failure, config checks\n'
