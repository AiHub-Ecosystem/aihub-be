#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:?APP_DIR is required}
APP_DIR="$(cd -- "$APP_DIR" && pwd -P)"
if [[ ! "$APP_DIR" =~ ^/[A-Za-z0-9_./\ -]+$ ]]; then
  printf 'APP_DIR contains characters that cron cannot safely represent\n' >&2
  exit 1
fi

wrapper="$APP_DIR/scripts/ops/host-scheduled-job.sh"
template="$APP_DIR/ops/host-jobs/aihub.crontab"
[[ -s "$wrapper" && -s "$template" ]] || {
  printf 'scheduled-job wrapper or crontab template is missing\n' >&2
  exit 1
}
chmod 755 "$wrapper"
bash -n "$wrapper"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
current="$tmp_dir/current"
filtered="$tmp_dir/filtered"
next="$tmp_dir/next"
readback="$tmp_dir/readback"

if crontab -l >"$current" 2>"$tmp_dir/crontab.err"; then
  :
else
  code=$?
  if [[ "$code" != 1 || -s "$current" ]]; then
    cat "$tmp_dir/crontab.err" >&2
    exit "$code"
  fi
fi

awk '
  /^# BEGIN AIHUB MANAGED JOBS$/ {
    if (inside || seen_begin) invalid = 1
    seen_begin = 1
    inside = 1
    next
  }
  /^# END AIHUB MANAGED JOBS$/ {
    if (!inside || seen_end) invalid = 1
    seen_end = 1
    inside = 0
    next
  }
  inside { next }
  /\/aihub-ops-job\.sh([[:space:]]|$)/ { next }
  /\/aihub-avatar-sweep\.sh([[:space:]]|$)/ { next }
  { print }
  END { if (inside || invalid) exit 1 }
' "$current" >"$filtered" || {
  printf 'existing crontab has malformed AIHUB markers\n' >&2
  exit 1
}

if [[ -s "$filtered" ]]; then
  cat "$filtered" >"$next"
  printf '\n' >>"$next"
fi
awk -v app_dir="$APP_DIR" '
  {
    if ($0 ~ /@AIHUB_APP_DIR@/) {
      gsub(/@AIHUB_APP_DIR@/, app_dir)
      replaced++
    }
    print
  }
  END { if (replaced == 0) exit 1 }
' "$template" >>"$next" || {
  printf 'crontab template did not contain the deployment path token\n' >&2
  exit 1
}

crontab "$next"
crontab -l >"$readback"
if ! cmp -s "$next" "$readback"; then
  printf 'installed crontab differs from the versioned AIHUB schedule\n' >&2
  exit 1
fi
printf 'installed AIHUB scheduled jobs from %s\n' "$APP_DIR"
