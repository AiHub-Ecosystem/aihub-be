#!/usr/bin/env bash
# Restore rehearsal for the hourly Postgres backup (#281). Run by an operator;
# it changes nothing outside a disposable container.
#
#   ssh <user>@<host> '<app-dir>/scripts/ops/restore-postgres-rehearsal.sh aihub' \
#     < AIHUB-BACKUP-AGE-KEY.txt
#
# The age identity arrives on stdin and is only ever held in memory: it is
# passed to age through a file descriptor and never written to the host's disk.
# The newest hourly backup of the named database is fetched from R2, decrypted,
# restored into a throwaway Postgres container with no network, and its
# per-table row counts are compared with the live database. The result and the
# elapsed time (the measured RTO for this database) are appended to the log.
set -uo pipefail
umask 077

readonly AGE_VERSION=v1.3.2
readonly RCLONE_IMAGE=rclone/rclone:1.75.1@sha256:45401ad7410db1d67ffdb58e19059ad20b0d8e0285a60e38bbec55cc1019c7a5
readonly POSTGRES_IMAGE=${AIHUB_REHEARSAL_POSTGRES_IMAGE:-postgres:16-alpine}
readonly DB_CONTAINER=${AIHUB_BACKUP_DB_CONTAINER:-aihub-db}
readonly CONFIG_FILE=${AIHUB_BACKUP_CONFIG:-$HOME/.aihub-backup.env}
readonly LOG_FILE=${AIHUB_REHEARSAL_LOG:-$HOME/aihub-postgres-restore-rehearsal.log}
readonly TOOLS_DIR=${AIHUB_BACKUP_TOOLS_DIR:-$HOME/.aihub-backup-tools}
readonly DB=${1:-}

log_line() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$1" | tee -a "$LOG_FILE"; }
fail() { log_line "rehearsal $DB failed reason=$1"; exit 1; }

case "$DB" in
  aihub | aihub_sandbox) ;;
  *) printf 'usage: %s aihub|aihub_sandbox  (age identity on stdin)\n' "$0" >&2; exit 2 ;;
esac
[[ ! -t 0 ]] || fail identity_not_on_stdin
identity="$(cat)"
[[ "$identity" == *AGE-SECRET-KEY-* ]] || fail identity_invalid

[[ -f "$CONFIG_FILE" && "$(stat -c %a "$CONFIG_FILE")" == 600 ]] || fail config_missing_or_not_600
# shellcheck disable=SC1090
source "$CONFIG_FILE" || fail config_unreadable
age_bin=${AIHUB_BACKUP_AGE_BIN:-$TOOLS_DIR/age-$AGE_VERSION/age}
[[ -x "$age_bin" ]] || fail age_missing_run_backup_once

tmp_dir="$(mktemp -d)" || fail tmp_dir
container="aihub-restore-rehearsal-$$"
cleanup() {
  sudo -n docker rm -f "$container" >/dev/null 2>&1
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT
chmod 700 "$tmp_dir"
{
  printf 'RCLONE_CONFIG_R2_TYPE=s3\nRCLONE_CONFIG_R2_PROVIDER=Cloudflare\n'
  printf 'RCLONE_CONFIG_R2_ACCESS_KEY_ID=%s\n' "$R2_ACCESS_KEY_ID"
  printf 'RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=%s\n' "$R2_SECRET_ACCESS_KEY"
  printf 'RCLONE_CONFIG_R2_ENDPOINT=https://%s.r2.cloudflarestorage.com\n' "$R2_ACCOUNT_ID"
} >"$tmp_dir/rclone.env"
rclone() { sudo -n docker run --rm --env-file "$tmp_dir/rclone.env" -v "$tmp_dir:/data" "$RCLONE_IMAGE" "$@"; }

started=$SECONDS
object="$(rclone lsf "r2:$R2_BUCKET/hourly/$DB/" 2>/dev/null | sort | tail -n 1)"
[[ -n "$object" ]] || fail no_backup_found
rclone copyto "r2:$R2_BUCKET/hourly/$DB/$object" "/data/backup.age" 2>/dev/null || fail download
"$age_bin" -d -i <(printf '%s\n' "$identity") -o "$tmp_dir/backup.dump" "$tmp_dir/backup.age" ||
  fail decrypt
unset identity

sudo -n docker run -d --name "$container" --network none \
  -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=rehearsal \
  -v "$tmp_dir/backup.dump:/backup.dump:ro" "$POSTGRES_IMAGE" >/dev/null || fail container_start
# The image's entrypoint runs initdb behind a temporary server that already
# answers pg_isready, then restarts it. Wait for the init to finish first.
ready=false
for _ in $(seq 1 90); do
  if sudo -n docker logs "$container" 2>&1 | grep -q 'PostgreSQL init process complete' &&
    sudo -n docker exec "$container" pg_isready -U postgres -d rehearsal >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || fail container_not_ready
sudo -n docker exec "$container" pg_restore -U postgres -d rehearsal --no-owner --no-privileges \
  /backup.dump 2>"$tmp_dir/restore.err" || fail "restore_$(tail -n 1 "$tmp_dir/restore.err" | tr -cd '[:alnum:]_ ' | tr ' ' '_' | cut -c1-120)"

count_sql="SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', tablename, schemaname, tablename), ' UNION ALL ' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'"
counts() { # <container> <user expression> <database>
  local query
  query="$(sudo -n docker exec "$1" sh -c "psql -U \"$2\" -d \"$3\" -Atc \"\$0\"" "$count_sql")" || return 1
  sudo -n docker exec "$1" sh -c "psql -U \"$2\" -d \"$3\" -At -F ' ' -c \"\$0 ORDER BY t\"" "$query"
}
counts "$container" postgres rehearsal >"$tmp_dir/restored.txt" || fail count_restored
# shellcheck disable=SC2016
counts "$DB_CONTAINER" '$POSTGRES_USER' "$DB" >"$tmp_dir/live.txt" || fail count_live

export LC_ALL=C
sort -o "$tmp_dir/restored.txt" "$tmp_dir/restored.txt"
sort -o "$tmp_dir/live.txt" "$tmp_dir/live.txt"
tables="$(wc -l <"$tmp_dir/restored.txt")"
missing="$(join -v 2 "$tmp_dir/restored.txt" "$tmp_dir/live.txt" | wc -l)"
# A restored table may hold fewer rows than the live one: the backup is up to
# an hour old. More rows than live, or a table the backup lacks, is a failure.
ahead="$(join "$tmp_dir/restored.txt" "$tmp_dir/live.txt" | awk '$2 > $3' | wc -l)"
behind="$(join "$tmp_dir/restored.txt" "$tmp_dir/live.txt" | awk '$2 < $3 { printf "%s:%d ", $1, $3 - $2 }')"
result=ok
(( missing == 0 && ahead == 0 && tables > 0 )) || result=mismatch
log_line "rehearsal $DB result=$result object=$object tables=$tables missing_tables=$missing tables_ahead_of_live=$ahead seconds=$((SECONDS - started)) rows_behind_live=${behind:-none}"
[[ "$result" == ok ]]
