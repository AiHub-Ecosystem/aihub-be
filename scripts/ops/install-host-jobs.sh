#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:?APP_DIR is required}
APP_DIR="$(cd -- "$APP_DIR" && pwd -P)"
if [[ ! "$APP_DIR" =~ ^/[A-Za-z0-9_./\ -]+$ ]]; then
  printf 'APP_DIR contains characters that cron cannot safely represent\n' >&2
  exit 1
fi

candidate_dir="$APP_DIR/.aihub-host-jobs-candidate"
candidate_wrapper="$candidate_dir/host-scheduled-job.sh"
candidate_template="$candidate_dir/aihub.crontab"
wrapper="$APP_DIR/scripts/ops/host-scheduled-job.sh"
template="$APP_DIR/ops/host-jobs/aihub.crontab"
[[ -s "$candidate_wrapper" && -s "$candidate_template" ]] || {
  printf 'scheduled-job wrapper or crontab template is missing\n' >&2
  exit 1
}
bash -n "$candidate_wrapper"

tmp_dir="$(mktemp -d)"
wrapper_next="$(mktemp "$wrapper.XXXXXX")"
template_next="$(mktemp "$template.XXXXXX")"
transaction_active=false
had_wrapper=false
had_template=false
had_crontab=false
preserve_backup=false
cleanup() {
  local status=$?
  if [[ "$transaction_active" == true ]]; then
    printf 'scheduled host job activation failed; restoring previous state\n' >&2
    if ! restore_previous; then
      printf 'scheduled host job rollback failed; manual recovery is required\n' >&2
      printf 'previous state backup retained at %s\n' "$tmp_dir" >&2
      preserve_backup=true
      status=1
    fi
  fi
  [[ "$preserve_backup" == true ]] || rm -rf -- "$tmp_dir"
  rm -f -- "$wrapper_next" "$template_next"
  exit "$status"
}
restore_file() {
  local backup="$1" destination="$2" mode="$3" restore_next
  if [[ -e "$backup" ]]; then
    restore_next="$(mktemp "$destination.XXXXXX")" || return 1
    if ! install -m "$mode" "$backup" "$restore_next" || ! mv -f -- "$restore_next" "$destination"; then
      rm -f -- "$restore_next"
      return 1
    fi
  else
    rm -f -- "$destination" || return 1
  fi
  return 0
}
restore_previous() {
  local status=0
  restore_file "$tmp_dir/wrapper.old" "$wrapper" 755 || status=1
  restore_file "$tmp_dir/template.old" "$template" 644 || status=1
  if [[ "$had_crontab" == true ]]; then
    crontab "$current" || status=1
  else
    crontab -r || status=1
  fi
  return "$status"
}
trap cleanup EXIT

current="$tmp_dir/current"
filtered="$tmp_dir/filtered"
next="$tmp_dir/next"
readback="$tmp_dir/readback"

if crontab -l >"$current" 2>"$tmp_dir/crontab.err"; then
  had_crontab=true
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
' "$candidate_template" >>"$next" || {
  printf 'crontab template did not contain the deployment path token\n' >&2
  exit 1
}

if APP_DIR="$APP_DIR" bash "$candidate_wrapper" report; then
  :
else
  code=$?
  printf 'candidate scheduled-job smoke failed; live schedule was not changed\n' >&2
  exit "$code"
fi

if [[ -e "$wrapper" ]]; then
  cp -p -- "$wrapper" "$tmp_dir/wrapper.old"
fi
if [[ -e "$template" ]]; then
  cp -p -- "$template" "$tmp_dir/template.old"
fi
install -m 755 "$candidate_wrapper" "$wrapper_next"
install -m 644 "$candidate_template" "$template_next"

transaction_active=true
mv -f -- "$wrapper_next" "$wrapper"
mv -f -- "$template_next" "$template"
crontab "$next"
crontab -l >"$readback"
if ! cmp -s "$next" "$readback"; then
  printf 'installed crontab differs from the versioned AIHUB schedule\n' >&2
  exit 1
fi
if "$wrapper" report; then
  :
else
  code=$?
  printf 'installed scheduled-job smoke failed\n' >&2
  exit "$code"
fi
transaction_active=false
printf 'installed AIHUB scheduled jobs from %s\n' "$APP_DIR"
