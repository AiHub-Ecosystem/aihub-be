#!/usr/bin/env bash
# External port probe (#464). Run hourly from a host other than the one being
# probed, so the scan crosses the internet the way an attacker's would: the
# monitoring host probes Production, and Production probes the monitoring host.
#
#   probe-public-ports.sh <label> <allowlist> <address>...
#
# Every open TCP port on each address must appear in the allowlist
# (ops/firewall/<label>.allow) or in the host-local pending file, which lists
# known exposures still waiting for their owners. Keeping that list off the
# repository keeps unfixed exposures out of a public tree. Anything else is
# logged and recorded as a failure in the scheduled-job format under the task
# public-ports-<label>, so AIHUBScheduledJobFailed fires on an unexpected
# port and AIHUBScheduledJobMissed on a probe that stopped running.
#
# The scan is a rate-limited connect scan. A SYN scan at nmap's -T4 missed
# open ports on 2026-10-19, so speed is traded for a complete answer: about
# 7 minutes per address.
set -uo pipefail
umask 077
# comm needs both inputs sorted in the same collation.
export LC_ALL=C

readonly LABEL=${1:?label}
readonly ALLOWLIST=${2:?allowlist}
shift 2
(( $# )) || { echo 'usage: probe-public-ports.sh <label> <allowlist> <address>...' >&2; exit 2; }

readonly PENDING=${AIHUB_PUBLIC_PORTS_PENDING:-$HOME/.aihub-public-ports-$LABEL.pending}
readonly METRICS_DIR=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/.aihub-host-job-metrics}
readonly LOG_FILE=${AIHUB_PUBLIC_PORTS_LOG:-$HOME/aihub-public-ports.log}
readonly NMAP_IMAGE=instrumentisto/nmap:7.95@sha256:3cca6ece8de5a571c956022ec6c2cf343da8c4416fa36e1891e8c33623cfc845
readonly TASK=public-ports-$LABEL
# Three missed hourly runs: cron stopped, or the probing host is down.
readonly MAX_AGE_SECONDS=10800
# Production's account may run Docker only through sudo; the monitoring
# host's account is in the docker group.
if [[ -n "${AIHUB_PUBLIC_PORTS_DOCKER:-}" ]]; then
  read -r -a docker <<<"$AIHUB_PUBLIC_PORTS_DOCKER"
elif sudo -n docker version >/dev/null 2>&1; then
  docker=(sudo -n docker)
else
  docker=(docker)
fi

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

# Only failures are logged, so the file grows with incidents, not with time.
log_line() {
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$TASK" "$1" >>"$LOG_FILE"
}

fail() {
  log_line "failed $1"
  record_result failure
  exit 1
}

# First field of each non-comment line, e.g. tcp/443.
expected_ports() {
  local file
  for file in "$@"; do
    [[ -f "$file" ]] || continue
    sed -e 's/#.*//' -- "$file" | awk 'NF { print $1 }'
  done | sort -u
}

[[ -f "$ALLOWLIST" ]] || fail reason=allowlist_missing
expected="$(expected_ports "$ALLOWLIST" "$PENDING")"

unexpected=()
for address in "$@"; do
  family=()
  [[ "$address" == *:* ]] && family=(-6)
  if ! output="$(timeout 30m "${docker[@]}" run --rm --network host "$NMAP_IMAGE" "${family[@]}" \
    -Pn -n -sT --max-rate 300 --max-retries 2 -p- --open -oG - "$address" 2>/dev/null)"; then
    fail "reason=scan_failed address=$address"
  fi
  open="$(grep -oE '[0-9]+/open/tcp' <<<"$output" | awk -F/ '{ print "tcp/" $1 }' | sort -u)"
  # A scan that sees none of the allowed ports was blocked or broken, not clean.
  [[ -n "$(comm -12 <(printf '%s\n' "$open") <(printf '%s\n' "$expected"))" ]] ||
    fail "reason=scan_saw_no_expected_port address=$address"
  extra="$(comm -23 <(printf '%s\n' "$open") <(printf '%s\n' "$expected") | paste -sd, -)"
  [[ -n "$extra" ]] && unexpected+=("address=$address ports=$extra")
done

(( ${#unexpected[@]} == 0 )) || fail "reason=unexpected_open_port ${unexpected[*]}"
record_result success
