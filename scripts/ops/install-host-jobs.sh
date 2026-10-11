#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP_DIR=${APP_DIR:?APP_DIR is required}
APP_DIR="$(cd -- "$APP_DIR" && pwd -P)"
if [[ ! "$APP_DIR" =~ ^/[A-Za-z0-9_./\ -]+$ ]]; then
  printf 'APP_DIR contains characters that cron cannot safely represent\n' >&2
  exit 1
fi

command=${1:-install}
candidate_dir="$APP_DIR/.aihub-host-jobs-candidate"
candidate_wrapper="$candidate_dir/host-scheduled-job.sh"
candidate_template="$candidate_dir/aihub.crontab"
wrapper="$APP_DIR/scripts/ops/host-scheduled-job.sh"
template="$APP_DIR/ops/host-jobs/aihub.crontab"
state_dir="$APP_DIR/.aihub-host-jobs-state"
tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT
current="$tmp_dir/current"
filtered="$tmp_dir/filtered"
next="$tmp_dir/next"
readback="$tmp_dir/readback"
had_crontab=false

read_crontab() {
  if crontab -l >"$current" 2>"$tmp_dir/crontab.err"; then
    had_crontab=true
  else
    local code=$?
    if [[ "$code" != 1 || -s "$current" ]]; then
      cat "$tmp_dir/crontab.err" >&2
      return "$code"
    fi
    had_crontab=false
  fi
}

filter_managed_crontab() {
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
  ' "$1" >"$2" || {
    printf 'existing crontab has malformed AIHUB markers\n' >&2
    return 1
  }
}

verify_crontab() {
  crontab -l >"$readback" || return 1
  cmp -s "$1" "$readback"
}

restore_suspended_crontab() {
  if [[ -f "$state_dir/crontab-present" ]]; then
    crontab "$state_dir/crontab" || return 1
    if crontab -l >"$readback" 2>/dev/null; then
      cmp -s "$state_dir/crontab" "$readback"
    else
      local code=$?
      [[ "$code" == 1 && ! -s "$state_dir/crontab" && ! -s "$readback" ]]
    fi
  else
    crontab -r >/dev/null 2>&1 || true
    if crontab -l >"$readback" 2>/dev/null; then
      [[ ! -s "$readback" ]]
    else
      [[ "$?" == 1 && ! -s "$readback" ]]
    fi
  fi
}

case "$command" in
  suspend)
    [[ ! -e "$state_dir" ]] || {
      printf 'a previous AIHUB host-job suspension still needs recovery\n' >&2
      exit 1
    }
    read_crontab
    filter_managed_crontab "$current" "$filtered"
    : >"$next"
    if [[ -s "$filtered" ]]; then
      cat "$filtered" >"$next"
      printf '\n' >>"$next"
    fi
    mkdir "$state_dir"
    install -m 600 "$current" "$state_dir/crontab"
    if [[ "$had_crontab" == true ]]; then
      : >"$state_dir/crontab-present"
      chmod 600 "$state_dir/crontab-present"
    fi
    if ! crontab "$next" || ! verify_crontab "$next"; then
      if restore_suspended_crontab; then
        rm -rf -- "$state_dir"
      else
        printf 'could not restore the saved crontab; backup retained at %s\n' "$state_dir" >&2
      fi
      printf 'could not suspend AIHUB host jobs\n' >&2
      exit 1
    fi
    command -v pgrep >/dev/null || {
      printf 'pgrep is required to drain scheduled host jobs before deployment\n' >&2
      if restore_suspended_crontab; then rm -rf -- "$state_dir"; fi
      exit 1
    }
    app_dir_pattern="${APP_DIR//./\\.}"
    job_pattern="$app_dir_pattern/scripts/ops/host-scheduled-job\\.sh|(^|/)aihub-ops-job\\.sh([[:space:]]|$)|(^|/)aihub-avatar-sweep\\.sh([[:space:]]|$)"
    drain_deadline=$((SECONDS + 900))
    while pgrep -f "$job_pattern" >/dev/null; do
      if ((SECONDS >= drain_deadline)); then
        printf 'scheduled host jobs did not drain within 15 minutes\n' >&2
        if restore_suspended_crontab; then rm -rf -- "$state_dir"; fi
        exit 1
      fi
      sleep 1
    done
    printf 'suspended and drained AIHUB host jobs\n'
    exit 0
    ;;
  restore)
    [[ -d "$state_dir" ]] || {
      printf 'no suspended AIHUB host-job schedule to restore\n'
      exit 0
    }
    if ! restore_suspended_crontab; then
      printf 'could not restore the saved crontab; backup retained at %s\n' "$state_dir" >&2
      exit 1
    fi
    rm -rf -- "$state_dir"
    printf 'restored the previous AIHUB host-job crontab\n'
    exit 0
    ;;
  install) ;;
  *)
    printf 'usage: %s [install|suspend|restore]\n' "$0" >&2
    exit 2
    ;;
esac

[[ -s "$candidate_wrapper" && -s "$candidate_template" ]] || {
  printf 'scheduled-job wrapper or crontab template is missing\n' >&2
  exit 1
}
bash -n "$candidate_wrapper"

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
    printf 'scheduled host job activation failed; restoring the suspended state\n' >&2
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

read_crontab || exit $?
filter_managed_crontab "$current" "$filtered"

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
  printf 'candidate scheduled-job smoke failed before wrapper promotion\n' >&2
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
if [[ -d "$state_dir" ]]; then
  rm -rf -- "$state_dir"
fi
printf 'installed AIHUB scheduled jobs from %s\n' "$APP_DIR"
