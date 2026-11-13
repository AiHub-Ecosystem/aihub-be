#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
prune_script="$repository_root/scripts/ops/logs/prune-deploy-log-snapshots.sh"
mkdir -p "$repository_root/temp"
test_root="$(mktemp -d "$repository_root/temp/deploy-log-prune.XXXXXX")"
trap 'rm -rf -- "$test_root"; rmdir "$repository_root/temp" 2>/dev/null || true' EXIT

app_dir="$test_root/app"
log_dir="$app_dir/deploy-logs"
mkdir -p "$log_dir"
old_timestamp="$(date -u -d '29 days ago' +%Y-%m-%dT%H:%M:%S).000000000Z"
recent_timestamp="$(date -u -d '27 days ago' +%Y-%m-%dT%H:%M:%S).000000000Z"
printf '%s {"record":"old"}\n' "$old_timestamp" >"$log_dir/old.log"
printf '%s {"record":"recent"}\nunparseable old record\n' "$recent_timestamp" \
  >"$log_dir/recent.log"
printf 'no parseable records\n' >"$log_dir/broken.log"

APP_DIR="$app_dir" bash "$prune_script" >"$test_root/output.log"
test ! -e "$log_dir/old.log"
test ! -e "$log_dir/broken.log"
grep -Fq '"record":"recent"' "$log_dir/recent.log"
if grep -Fq 'unparseable' "$log_dir/recent.log"; then
  printf 'snapshot pruner retained a line without a Docker timestamp\n' >&2
  exit 1
fi
if grep -Fq 'old' "$log_dir/recent.log"; then
  printf 'snapshot pruner retained an over-age record\n' >&2
  exit 1
fi
if grep -Eiq 'old|recent|unparseable' "$test_root/output.log"; then
  printf 'snapshot pruner printed record contents\n' >&2
  exit 1
fi

printf 'deploy-log snapshot pruner CLI tests passed\n'
