#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
app_dir="${APP_DIR:-$(cd -- "$script_dir/../../.." && pwd -P)}"
log_dir="$app_dir/deploy-logs"
[[ -d "$log_dir" ]] || exit 0
if [[ -L "$log_dir" ]]; then
  printf 'Refusing symlink deploy-log directory.\n' >&2
  exit 1
fi

cutoff="$(date -u -d '28 days ago' +%Y-%m-%dT%H:%M:%S)"
shopt -s dotglob nullglob
snapshot_files=("$log_dir"/*.log)
for log_file in "${snapshot_files[@]}"; do
  if [[ -L "$log_file" ]]; then
    rm -f -- "$log_file"
    continue
  fi
  [[ -f "$log_file" ]] || continue

  temp_file="$(mktemp "$log_dir/.prune-XXXXXX.log")"
  trap '[[ -z "${temp_file:-}" ]] || rm -f -- "$temp_file"' EXIT
  if ! awk -v cutoff="$cutoff" '
    /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ {
      if (substr($0, 1, 19) >= cutoff) print
    }
  ' "$log_file" >"$temp_file"; then
    printf 'Could not prune deploy-log snapshot.\n' >&2
    exit 1
  fi

  if [[ -s "$temp_file" ]]; then
    chmod 0600 "$temp_file"
    mv -f -- "$temp_file" "$log_file"
    temp_file=""
    trap - EXIT
  else
    rm -f -- "$temp_file" "$log_file"
    temp_file=""
    trap - EXIT
  fi
done

printf 'pruned deploy-log snapshots\n'
