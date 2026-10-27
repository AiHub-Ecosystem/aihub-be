#!/usr/bin/env bash
# Alert rule drift check (#1016), run every hour from the monitoring host's
# crontab. Rule files reach the monitoring Prometheus by hand, so a rule merged
# to main may never be loaded and nothing would say so. Two checks:
#
# - the host's rules file is byte-for-byte the repository's on main, which
#   catches a copy that was missed;
# - every alert in that file is loaded in Prometheus and nothing else is, which
#   catches a copy that was never reloaded;
# - a recording-rule fingerprint from the loaded rules matches the current
#   file, catching a missed reload when alert names stay the same but an
#   expression, label, or annotation changed.
#
# It only reports. Copying and reloading stay a deliberate operator step
# (docs/operations/aihub-observability.md, "Alert rule changes").
#
# The result is written in the scheduled-job format of host-scheduled-job.sh
# under the task name alert-rule-drift, so AIHUBScheduledJobFailed fires on a
# drift and AIHUBScheduledJobMissed when the check stops running.
set -uo pipefail
umask 077

readonly REPO_RULES_URL=${AIHUB_ALERT_RULES_URL:-https://raw.githubusercontent.com/AiHub-Ecosystem/aihub-be/main/ops/monitoring/alert.rules.yml}
readonly HOST_RULES_FILE=${AIHUB_ALERT_RULES_FILE:-$HOME/aihub-monitoring/ops/monitoring/alert.rules.yml}
readonly PROMETHEUS_URL=${AIHUB_PROMETHEUS_URL:-http://127.0.0.1:9094}
readonly METRICS_DIR=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/aihub-monitoring/host-job-metrics}
readonly LOG_FILE=${AIHUB_ALERT_RULE_DRIFT_LOG:-$HOME/aihub-alert-rule-drift.log}
readonly TASK=alert-rule-drift
# Two hourly runs plus 20 minutes, as for the other hourly jobs.
readonly MAX_AGE_SECONDS=8400

record_result() {
  local outcome=$1 file="$METRICS_DIR/$TASK-$1.prom" tmp
  tmp="$file.tmp"
  if mkdir -p -- "$METRICS_DIR" && chmod 755 "$METRICS_DIR" && {
    printf 'aihub_host_job_last_%s_timestamp_seconds{task="%s"} %s\n' "$outcome" "$TASK" "$(date +%s)"
    if [[ "$outcome" == success ]]; then
      printf 'aihub_host_job_max_age_seconds{task="%s"} %s\n' "$TASK" "$MAX_AGE_SECONDS"
    fi
  } >"$tmp" && chmod 644 "$tmp" && mv -f -- "$tmp" "$file"; then
    return 0
  fi
  rm -f -- "$tmp"
  log_line "metrics_write_failed outcome=$outcome"
}

# Only failures are logged, so the file grows with drifts, not with time.
log_line() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$TASK" "$1" >>"$LOG_FILE"
}

fail() {
  log_line "failed reason=$1"
  record_result failure
  exit 1
}

# Alert names in a rules file, one per line, sorted.
alert_names() {
  grep -oE '^[[:space:]]*- alert:[[:space:]]*[A-Za-z0-9_:]+' "$1" |
    sed -E 's/.*alert:[[:space:]]*//' | sort -u
}

# Names in the first list and not the second, comma-separated, or "none".
only_in() {
  local names
  names="$(comm -23 "$1" "$2" | paste -sd, -)"
  printf '%s' "${names:-none}"
}

work="$(mktemp -d)" || fail tmp_dir
trap 'rm -rf -- "$work"' EXIT

curl -fsS --max-time 20 -o "$work/repo.yml" "$REPO_RULES_URL" 2>/dev/null ||
  fail repo_unreadable
[[ -f "$HOST_RULES_FILE" ]] || fail host_rules_missing

repo_sha="$(sha256sum "$work/repo.yml" | cut -c1-12)"
host_sha="$(sha256sum "$HOST_RULES_FILE" | cut -c1-12)"
alert_names "$work/repo.yml" >"$work/repo.names"
alert_names "$HOST_RULES_FILE" >"$work/host.names"
if [[ "$repo_sha" != "$host_sha" ]]; then
  fail "repo_differs missing_on_host=$(only_in "$work/repo.names" "$work/host.names") extra_on_host=$(only_in "$work/host.names" "$work/repo.names") repo_sha256=$repo_sha host_sha256=$host_sha"
fi

curl -fsS --max-time 10 -o "$work/rules.json" "$PROMETHEUS_URL/api/v1/rules" 2>/dev/null ||
  fail prometheus_unreachable
# The API exposes parsed definitions but not their source file. This fingerprint
# rule is loaded with the alert rules and hashes the complete source file with
# its own value zeroed.
python3 - "$work/rules.json" <<'PY' | tr -d '\r' >"$work/loaded.names" || fail prometheus_answer_unreadable
import json, sys
with open(sys.argv[1], encoding="utf-8") as answer:
    groups = json.load(answer)["data"]["groups"]
for name in sorted({rule["name"] for group in groups for rule in group["rules"] if rule.get("type") == "alerting"}):
    print(name)
PY

not_loaded="$(only_in "$work/host.names" "$work/loaded.names")"
loaded_not_in_file="$(only_in "$work/loaded.names" "$work/host.names")"
if [[ "$not_loaded" != none || "$loaded_not_in_file" != none ]]; then
  fail "not_loaded not_loaded=$not_loaded loaded_not_in_file=$loaded_not_in_file"
fi

fingerprint_result="$(
python3 - "$work/rules.json" "$work/repo.yml" <<'PY'
import hashlib, json, re, sys
try:
    source = open(sys.argv[2], "rb").read()
    marker = re.compile(rb'(?m)^([ \t]*rules_sha256: ")[0-9a-f]{64}(\")(\r?)$')
    normalized, count = marker.subn(lambda match: match.group(1) + b"0" * 64 + match.group(2) + match.group(3), source)
    if count != 1:
        print("repo_fingerprint_missing")
        raise SystemExit(0)
    expected = hashlib.sha256(normalized).hexdigest()
    with open(sys.argv[1], encoding="utf-8") as answer:
        groups = json.load(answer)["data"]["groups"]
    fingerprints = [rule for group in groups for rule in group["rules"] if rule.get("name") == "aihub:alert_rules_fingerprint" and rule.get("type") == "recording"]
    if len(fingerprints) != 1:
        print("loaded_fingerprint_missing")
        raise SystemExit(0)
    actual = fingerprints[0].get("labels", {}).get("rules_sha256")
    if actual != expected:
        print("loaded_definition_differs expected=" + expected + " loaded=" + (actual or "missing"))
    else:
        print("match")
except Exception:
    print("prometheus_answer_unreadable")
PY
)"
case "$fingerprint_result" in
  match) ;;
  prometheus_answer_unreadable) fail prometheus_answer_unreadable ;;
  *) fail "$fingerprint_result" ;;
esac

record_result success
