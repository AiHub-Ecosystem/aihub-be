#!/usr/bin/env bash
# Hourly encrypted dump of the AIHUB databases to off-host object storage (#281).
#
# For each database: `pg_dump -Fc` inside the `aihub-db` container, encrypted on
# the host with `age` to a public key, then copied to Cloudflare R2 with
# `rclone`. The private key never reaches this host, so a backup read off the
# bucket or the host is useless without it.
#
# Layout in the bucket, pruned by R2 lifecycle rules rather than by this script
# (spec 10 §N.4: 48 hourly, 30 daily, 12 monthly):
#   hourly/<db>/<db>-<UTC stamp>.dump.age    every run
#   daily/<db>/<db>-<UTC stamp>.dump.age     the 00 UTC run
#   monthly/<db>/<db>-<UTC stamp>.dump.age   the 00 UTC run on day 01
#
# Configuration lives in a mode-0600 file on the host, never in the repository:
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, AGE_RECIPIENT
# One log line per database; the exit status is non-zero when any database fails.
set -uo pipefail
umask 077

readonly AGE_VERSION=v1.3.2
readonly AGE_TARBALL_SHA256=cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10
readonly RCLONE_IMAGE=rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5
readonly DB_CONTAINER=${AIHUB_BACKUP_DB_CONTAINER:-aihub-db}
readonly DATABASES=(aihub aihub_sandbox)
readonly STEP_TIMEOUT_SECONDS=900
readonly CONFIG_FILE=${AIHUB_BACKUP_CONFIG:-$HOME/.aihub-backup.env}
readonly LOG_FILE=${AIHUB_BACKUP_LOG:-$HOME/aihub-postgres-backup.log}
readonly TOOLS_DIR=${AIHUB_BACKUP_TOOLS_DIR:-$HOME/.aihub-backup-tools}
# Tests pin the clock; production uses the current time.
readonly NOW=${AIHUB_BACKUP_NOW:-now}

# Last stderr line of a failed step, printable characters only. pg_dump, age,
# and rclone do not print credentials, and the rclone secret travels in a file.
reason_of() {
  [[ -s "$1" ]] || { printf 'none'; return; }
  tail -n 1 "$1" | tr -cd '[:print:]' | tr ' ' '_' | cut -c1-200
}

log_line() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$LOG_FILE" >/dev/null || {
    printf 'cannot append backup log: %s\n' "$LOG_FILE" >&2
    exit 1
  }
}

fail() {
  log_line "backup failed reason=$1"
  exit 1
}

: >>"$LOG_FILE" || { printf 'cannot write backup log: %s\n' "$LOG_FILE" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || fail flock_unavailable
command -v timeout >/dev/null 2>&1 || fail timeout_unavailable

lock_dir="$HOME/.aihub-host-job-locks"
mkdir -p -- "$lock_dir" && chmod 700 "$lock_dir" || fail lock_directory_unavailable
exec 9>"$lock_dir/backup.lock" || fail lock_file_unavailable
if ! flock -n 9; then
  log_line 'backup skipped reason=already_running'
  exit 0
fi

[[ -f "$CONFIG_FILE" ]] || fail config_missing
[[ "$(stat -c %a "$CONFIG_FILE")" == 600 ]] || fail config_not_mode_600
# shellcheck disable=SC1090
source "$CONFIG_FILE" || fail config_unreadable
for name in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET AGE_RECIPIENT; do
  [[ -n "${!name:-}" ]] || fail "config_missing_$name"
done
[[ "$AGE_RECIPIENT" == age1* ]] || fail config_invalid_AGE_RECIPIENT

# A static, checksum-verified age binary in the operator's home: the host has
# no package manager access, and an unverified download must never run.
age_bin=${AIHUB_BACKUP_AGE_BIN:-$TOOLS_DIR/age-$AGE_VERSION/age}
if [[ ! -x "$age_bin" ]]; then
  mkdir -p -- "$TOOLS_DIR/age-$AGE_VERSION" || fail age_install_directory
  tarball="$TOOLS_DIR/age-$AGE_VERSION.tar.gz"
  curl -fsSL --max-time 120 -o "$tarball" \
    "https://github.com/FiloSottile/age/releases/download/$AGE_VERSION/age-$AGE_VERSION-linux-amd64.tar.gz" ||
    fail age_download
  printf '%s  %s\n' "$AGE_TARBALL_SHA256" "$tarball" | sha256sum -c --status - || {
    rm -f -- "$tarball"
    fail age_checksum_mismatch
  }
  tar -xzf "$tarball" -C "$TOOLS_DIR/age-$AGE_VERSION" --strip-components=1 age/age ||
    fail age_extract
  rm -f -- "$tarball"
fi

tmp_dir="$(mktemp -d)" || fail tmp_dir
trap 'rm -rf -- "$tmp_dir"' EXIT
chmod 700 "$tmp_dir"

# rclone reads its remote from the environment; the file keeps the secret off
# the command line and out of the process list.
rclone_env="$tmp_dir/rclone.env"
{
  printf 'RCLONE_CONFIG_R2_TYPE=s3\n'
  printf 'RCLONE_CONFIG_R2_PROVIDER=Cloudflare\n'
  printf 'RCLONE_CONFIG_R2_ACCESS_KEY_ID=%s\n' "$R2_ACCESS_KEY_ID"
  printf 'RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=%s\n' "$R2_SECRET_ACCESS_KEY"
  printf 'RCLONE_CONFIG_R2_ENDPOINT=https://%s.r2.cloudflarestorage.com\n' "$R2_ACCOUNT_ID"
  printf 'RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true\n'
} >"$rclone_env"

rclone() {
  timeout --signal=TERM --kill-after=10s "${STEP_TIMEOUT_SECONDS}s" \
    sudo -n docker run --rm --env-file "$rclone_env" \
    -v "$tmp_dir:/data:ro" "$RCLONE_IMAGE" "$@"
}

stamp="$(date -u -d "$NOW" +%Y%m%dT%H%M%SZ)" || fail clock
hour="$(date -u -d "$NOW" +%H)"
day="$(date -u -d "$NOW" +%d)"
prefixes=(hourly)
if [[ "$hour" == 00 ]]; then
  prefixes+=(daily)
  [[ "$day" == 01 ]] && prefixes+=(monthly)
fi

status=0
for db in "${DATABASES[@]}"; do
  name="$db-$stamp.dump.age"
  file="$tmp_dir/$name"
  started=$SECONDS
  timeout --signal=TERM --kill-after=10s "${STEP_TIMEOUT_SECONDS}s" \
    sudo -n docker exec "$DB_CONTAINER" \
    sh -c 'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$1"' sh "$db" \
    2>"$tmp_dir/dump.err" |
    "$age_bin" -r "$AGE_RECIPIENT" -o "$file" 2>"$tmp_dir/age.err"
  codes=("${PIPESTATUS[@]}")
  if [[ "${codes[0]}" != 0 || "${codes[1]}" != 0 || ! -s "$file" ]]; then
    log_line "backup $db failed step=dump dump_exit=${codes[0]} encrypt_exit=${codes[1]} error=$(reason_of "$tmp_dir/dump.err")"
    status=1
    continue
  fi
  bytes="$(stat -c %s "$file")"
  first="${prefixes[0]}/$db/$name"
  if ! rclone copyto "/data/$name" "r2:$R2_BUCKET/$first" 2>"$tmp_dir/upload.err"; then
    log_line "backup $db failed step=upload bytes=$bytes error=$(reason_of "$tmp_dir/upload.err")"
    status=1
    continue
  fi
  for prefix in "${prefixes[@]:1}"; do
    if ! rclone copyto "r2:$R2_BUCKET/$first" "r2:$R2_BUCKET/$prefix/$db/$name" \
      2>"$tmp_dir/copy.err"; then
      log_line "backup $db failed step=copy prefix=$prefix error=$(reason_of "$tmp_dir/copy.err")"
      status=1
    fi
  done
  rm -f -- "$file"
  log_line "backup $db exit=0 bytes=$bytes seconds=$((SECONDS - started)) prefixes=$(IFS=,; printf '%s' "${prefixes[*]}") object=$name"
done

exit "$status"
