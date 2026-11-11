#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:?APP_DIR is required}
command=${1:-finish}
state_dir="$APP_DIR/.aihub-host-jobs-state"
metrics_dir=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/.aihub-host-job-metrics}
suspension_metric="$metrics_dir/host-jobs-suspended.prom"
reason=deployment_unresolved

report_suspension() {
  if [[ -e "$state_dir" || -L "$state_dir" ]]; then
    mkdir -p -- "$metrics_dir" && chmod 755 "$metrics_dir" || return 0
    local now tmp
    if [[ -e "$suspension_metric" ]]; then
      [[ "$reason" == mixed_revisions ]] || return 0
      now=$(awk '$1 == "aihub_host_jobs_suspended_since_timestamp_seconds" { print $2; exit }' "$suspension_metric")
      [[ "$now" =~ ^[0-9]+$ ]] || now=$(date +%s)
    else
      now=$(date +%s)
    fi
    tmp="$suspension_metric.tmp"
    {
      printf 'aihub_host_jobs_suspended{reason="%s"} 1\n' "$reason"
      printf 'aihub_host_jobs_suspended_since_timestamp_seconds %s\n' "$now"
    } >"$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$suspension_metric" || rm -f -- "$tmp"
  else
    rm -f -- "$suspension_metric" "$suspension_metric.tmp"
  fi
}
trap report_suspension EXIT

if [[ "$command" == report ]]; then
  exit 0
fi
[[ "$command" == finish ]] || {
  printf 'usage: %s [finish|report]\n' "$0" >&2
  exit 2
}

deploy_outcome=${2:?deployment outcome is required}
target_sha=${3:?target revision is required}
[[ "$deploy_outcome" == success || "$deploy_outcome" == failure ]] || {
  printf 'deployment outcome must be success or failure\n' >&2
  exit 2
}
[[ "$target_sha" =~ ^[a-f0-9]{40}$ ]] || {
  printf 'target revision is invalid; AIHUB host jobs remain suspended\n' >&2
  exit 1
}

cd "$APP_DIR"
state="$(./scripts/ops/blue-green/blue-green-host.sh status)"
if grep -Eq '^pending=' <<<"$state" || grep -Fxq 'sandbox enabled but not routed' <<<"$state"; then
  printf 'deployment state is unresolved; AIHUB host jobs remain suspended; recover deployment state before restoring the schedule\n' >&2
  exit 1
fi
if grep -Eq '^caller_ip_gate=' <<<"$state"; then
  printf 'caller-IP deployment gate remains unresolved; AIHUB host jobs remain suspended; re-run CD to resolve it\n' >&2
  exit 1
fi
if ! grep -Eq '^production active_slot=' <<<"$state" || ! grep -Eq '^sandbox (active_slot=|disabled$)' <<<"$state"; then
  printf 'could not resolve every AIHUB tier; host jobs remain suspended\n' >&2
  exit 1
fi

active_shas=()
revision_summary=
while IFS= read -r line; do
  if [[ "$line" =~ ^(production|sandbox)[[:space:]]active_slot= ]]; then
    tier_name="${BASH_REMATCH[1]}"
    if [[ "$line" =~ [[:space:]]sha=([^[:space:]]+) ]]; then
      active_shas+=("${BASH_REMATCH[1]}")
      revision_summary+="$tier_name=${BASH_REMATCH[1]:0:12} "
    else
      printf 'an active AIHUB tier revision is missing; host jobs remain suspended\n' >&2
      exit 1
    fi
  fi
done <<<"$state"
if (( ${#active_shas[@]} == 0 )); then
  printf 'no active AIHUB tier revisions were reported; host jobs remain suspended\n' >&2
  exit 1
fi
for sha in "${active_shas[@]}"; do
  if [[ ! "$sha" =~ ^[a-f0-9]{40}$ ]]; then
    printf 'an active AIHUB tier revision is unknown; host jobs remain suspended\n' >&2
    exit 1
  fi
  if [[ "$sha" != "${active_shas[0]}" ]]; then
    reason=mixed_revisions
    printf 'active AIHUB tiers run mixed revisions (%starget=%s); host jobs remain suspended until CD retry aligns tiers\n' \
      "$revision_summary" "${target_sha:0:12}" >&2
    exit 1
  fi
done

installer=${AIHUB_HOST_JOB_INSTALLER:-"$APP_DIR/scripts/ops/host-jobs/install-host-jobs.sh"}
if [[ "${active_shas[0]}" == "$target_sha" ]]; then
  "$installer" install
elif [[ "$deploy_outcome" == success ]]; then
  printf 'successful deployment does not expose the target revision; AIHUB host jobs remain suspended\n' >&2
  exit 1
else
  "$installer" restore
fi
