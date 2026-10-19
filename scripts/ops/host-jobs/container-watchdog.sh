#!/usr/bin/env bash
# Runs every minute from the managed crontab (#396). Docker restarts a
# container whose process exits, never one that stays unhealthy, so this
# restarts an AIHUB app container that Docker reports unhealthy, at most
# RESTART_LIMIT times in RESTART_WINDOW_SECONDS, and then leaves it for the
# still-unhealthy alert. It also writes, for the node-exporter textfile
# collector, what Docker and the kernel reported since the last run:
# unhealthy transitions, OOM kills, exits nobody asked for, and its own
# restarts.
# Runbook: docs/operations/container-watchdog.md.
set -uo pipefail
umask 077

readonly PROJECT=${AIHUB_COMPOSE_PROJECT:-aihub-production}
readonly METRICS_DIR=${AIHUB_HOST_JOB_METRICS_DIR:-$HOME/.aihub-host-job-metrics}
readonly STATE_DIR=${AIHUB_CONTAINER_WATCHDOG_STATE_DIR:-$HOME/.aihub-container-watchdog}
readonly LOG_FILE=${AIHUB_CONTAINER_WATCHDOG_LOG:-$HOME/aihub-container-watchdog.log}
readonly RESTART_LIMIT=3
readonly RESTART_WINDOW_SECONDS=3600
readonly STOP_TIMEOUT_SECONDS=30
readonly MAX_AGE_SECONDS=300
# An event series is dropped this long after its last event, so the state
# does not grow with every deployed revision.
readonly EVENT_RETENTION_SECONDS=604800
# vault-agent is watched but never restarted: Agent restarts stay
# operator-managed (deploy-vps.md), so it reaches the still-unhealthy alert.
readonly WATCHED_SERVICES=' app app-slot-b app-sandbox app-sandbox-slot-b vault-agent '
readonly RESTARTABLE_SERVICES=' app app-slot-b app-sandbox app-sandbox-slot-b '

log_line() {
  printf '%s container-watchdog %s\n' "$(date -u +%FT%TZ)" "$1" >>"$LOG_FILE" || true
}

# Same textfile format as host-scheduled-job.sh, read by the
# AIHUBScheduledJobFailed and AIHUBScheduledJobMissed rules.
record_job_result() {
  local outcome=$1 file="$METRICS_DIR/container-watchdog-$1.prom"
  {
    printf 'aihub_host_job_last_%s_timestamp_seconds{task="container-watchdog"} %s\n' "$outcome" "$(date +%s)"
    if [[ "$outcome" == success ]]; then
      printf 'aihub_host_job_max_age_seconds{task="container-watchdog"} %s\n' "$MAX_AGE_SECONDS"
    fi
  } >"$file.tmp" && chmod 644 "$file.tmp" && mv -f -- "$file.tmp" "$file" || {
    rm -f -- "$file.tmp"
    log_line "metrics_write_failed outcome=$outcome"
  }
}

if ! mkdir -p -- "$STATE_DIR" "$METRICS_DIR" "$HOME/.aihub-host-job-locks" || ! chmod 755 "$METRICS_DIR"; then
  log_line 'failed reason=directory_unavailable'
  exit 1
fi
exec 9>"$HOME/.aihub-host-job-locks/container-watchdog.lock" || exit 1
flock -n 9 || exit 0

docker=(timeout --signal=TERM --kill-after=5s 30s sudo -n docker)
status=0
now=$(date +%s)
since=$(cat "$STATE_DIR/events-until" 2>/dev/null) || since=$((now - 120))
[[ "$since" =~ ^[0-9]+$ ]] || since=$((now - 120))
synthetic_events=

if ! containers=$("${docker[@]}" ps -a --no-trunc --filter "label=com.docker.compose.project=$PROJECT" \
  --format '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.Label "org.opencontainers.image.revision"}}|{{.Status}}'); then
  log_line 'failed reason=docker_ps'
  record_job_result failure
  exit 1
fi

gauges=
agent=
apps=()
declare -A by_id=()
while IFS='|' read -r id name service revision state; do
  [[ -n "$name" && "$WATCHED_SERVICES" == *" $service "* ]] || continue
  by_id[$id]="$name|$service||$revision"
  [[ "$state" == Up* ]] || continue
  if [[ "$service" == vault-agent ]]; then
    agent=$name
  else
    apps+=("$name|${revision:-unknown}")
  fi
  unhealthy=0
  if [[ "$state" == *'(unhealthy)'* ]]; then
    unhealthy=1
    if [[ "$RESTARTABLE_SERVICES" == *" $service "* ]]; then
      history="$STATE_DIR/restarts-$name"
      recent=$(awk -v cutoff=$((now - RESTART_WINDOW_SECONDS)) '$1 > cutoff' "$history" 2>/dev/null)
      if (($(grep -c . <<<"$recent") >= RESTART_LIMIT)); then
        log_line "restart_skipped name=$name revision=${revision:-unknown} reason=limit restarts=$RESTART_LIMIT window_seconds=$RESTART_WINDOW_SECONDS"
      elif timeout --signal=TERM --kill-after=5s $((STOP_TIMEOUT_SECONDS + 60))s \
        sudo -n docker restart -t "$STOP_TIMEOUT_SECONDS" "$name" >/dev/null 2>&1; then
        printf '%s\n' "$recent" "$now" | grep . >"$history"
        synthetic_events+="watchdog_restart|-|$name|$service||$revision|$now"$'\n'
        log_line "restarted name=$name revision=${revision:-unknown} reason=unhealthy"
        unhealthy=0
      else
        log_line "restart_failed name=$name revision=${revision:-unknown}"
        status=1
      fi
    fi
  fi
  gauges+="$name|$revision|$unhealthy"$'\n'
done <<<"$containers"

# A die that follows a stop request (deploy, docker restart, compose down) is
# expected; any other die is reported as an exit with its code.
# ponytail: the daemon replays only its last 256 events, about two minutes
# under healthcheck exec traffic, so events during a longer gap (CD suspends
# this cron while it deploys) are not seen.
events_read=1
if ! events=$("${docker[@]}" events --since "$since" --until "$now" \
  --filter type=container --filter "label=com.docker.compose.project=$PROJECT" \
  --filter event=die --filter event=stop --filter event=health_status \
  --format '{{.Action}}|{{.Actor.ID}}|{{index .Actor.Attributes "name"}}|{{index .Actor.Attributes "com.docker.compose.service"}}|{{index .Actor.Attributes "exitCode"}}|{{index .Actor.Attributes "org.opencontainers.image.revision"}}|{{.Time}}'); then
  log_line 'failed reason=docker_events'
  status=1
  events=
  events_read=0
fi

# OOM kills come from the kernel log, not Docker's oom event: on this host's
# cgroup v2 Docker reported one of three OOM kills in the #396 drill, and
# cAdvisor none. The kernel names the container's cgroup by its full ID.
if kernel_ooms=$(journalctl -k -q --no-pager -o short-unix --since "@$since" --until "@$now" |
  sed -n 's/^\([0-9]*\)\..*oom-kill:.*task_memcg=[^,]*docker-\([0-9a-f]\{64\}\)\.scope.*/\1 \2/p'); then
  while read -r time id; do
    [[ -n "$id" && -n "${by_id[$id]:-}" ]] && synthetic_events+="kernel_oom|$id|${by_id[$id]}|$time"$'\n'
  done <<<"$kernel_ooms"
else
  log_line 'failed reason=kernel_log'
  status=1
  events_read=0
fi

# Secret delivery (#825). The app reads the rendered bundle once at start, and
# Vault Agent rewrites a file only when its content changes, so a file's age
# does not show whether rendering still works, and the Agent's own metrics are
# kept for one minute. This records the last run at which rendering could
# succeed: Vault answered unsealed and the Agent logged no error since the
# previous run. It also flags an app started before the bundle last changed.
secret_lines=
if [[ -n "$agent" ]]; then
  reason=ok
  vault_code=0
  "${docker[@]}" exec "$agent" vault status >/dev/null 2>&1 || vault_code=$?
  case "$vault_code" in
    0) ;;
    2) reason=vault_sealed ;;
    *) reason=vault_unreachable ;;
  esac
  if ! agent_log=$("${docker[@]}" logs --since "$since" --until "$now" "$agent" 2>&1); then
    reason=agent_unavailable
  elif [[ "$reason" == ok ]] && grep -q '\[ERROR\]' <<<"$agent_log"; then
    reason=agent_error
  fi
  healthy_file="$STATE_DIR/secret-delivery-healthy"
  if [[ "$reason" == ok || ! -s "$healthy_file" ]]; then
    printf '%s\n' "$now" >"$healthy_file"
  fi
  previous_reason=$(cat "$STATE_DIR/secret-delivery-reason" 2>/dev/null)
  if [[ "$reason" != "${previous_reason:-ok}" ]]; then
    log_line "secret_delivery reason=$reason"
  fi
  printf '%s\n' "$reason" >"$STATE_DIR/secret-delivery-reason"
  secret_lines+="aihub_secret_delivery_last_healthy_timestamp_seconds $(cat "$healthy_file")"$'\n'
  secret_lines+="aihub_secret_delivery_healthy{reason=\"$reason\"} $([[ "$reason" == ok ]] && echo 1 || echo 0)"$'\n'

  if modified=$("${docker[@]}" exec "$agent" sh -c 'stat -c %Y /run/secrets/aihub/*.json' | sort -n | tail -n 1) &&
    [[ "$modified" =~ ^[0-9]+$ ]]; then
    secret_lines+="aihub_runtime_secrets_modified_timestamp_seconds $modified"$'\n'
    for app in "${apps[@]}"; do
      started=$("${docker[@]}" inspect -f '{{.State.StartedAt}}' "${app%%|*}") &&
        started=$(date -d "$started" +%s) || continue
      secret_lines+="aihub_runtime_secrets_restart_required{name=\"${app%%|*}\",revision=\"${app#*|}\"} $((modified > started ? 1 : 0))"$'\n'
    done
  else
    log_line 'failed reason=secret_bundle_stat'
    status=1
  fi
fi

touch "$STATE_DIR/events"
if ! GAUGES="$gauges" awk -F'|' -v watched="$WATCHED_SERVICES" -v now="$now" -v keep="$EVENT_RETENTION_SECONDS" \
  -v state_out="$STATE_DIR/events.next" '
  function clean(value) { gsub(/[^A-Za-z0-9_.-]/, "_", value); return value }
  FILENAME == ARGV[1] { count[$1 FS $2 FS $3 FS $4] = $5; last[$1 FS $2 FS $3 FS $4] = $6; next }
  index(watched, " " $4 " ") == 0 { next }
  $1 == "stop" { stopped[$2] = 1; next }
  { lines[++n] = $0 }
  END {
    printf "" > state_out
    for (i = 1; i <= n; i++) {
      split(lines[i], f, FS)
      code = ""
      if (f[1] == "kernel_oom") event = "oom"
      else if (f[1] == "health_status: unhealthy") event = "unhealthy"
      else if (f[1] == "watchdog_restart") event = "watchdog_restart"
      else if (f[1] == "die" && !(f[2] in stopped)) { event = "exit"; code = clean(f[5]) }
      else continue
      key = clean(f[3]) FS (f[6] == "" ? "unknown" : clean(f[6])) FS event FS code
      count[key]++
      if (f[7] + 0 > last[key] + 0) last[key] = f[7]
    }
    for (key in count) {
      if (now - last[key] > keep) continue
      split(key, k, FS)
      print key FS count[key] FS last[key] > state_out
      labels = sprintf("name=\"%s\",revision=\"%s\",event=\"%s\",exit_code=\"%s\"", k[1], k[2], k[3], k[4])
      printf "aihub_container_events_total{%s} %d\n", labels, count[key]
      printf "aihub_container_last_event_timestamp_seconds{%s} %d\n", labels, last[key]
    }
    close(state_out)
    rows = split(ENVIRON["GAUGES"], g, "\n")
    for (i = 1; i <= rows; i++) {
      if (split(g[i], f, FS) != 3) continue
      printf "aihub_container_unhealthy{name=\"%s\",revision=\"%s\"} %d\n", clean(f[1]), (f[2] == "" ? "unknown" : clean(f[2])), f[3]
    }
  }
' "$STATE_DIR/events" <(printf '%s\n%s' "$events" "$synthetic_events") >"$METRICS_DIR/container-watchdog-containers.prom.tmp"; then
  log_line 'failed reason=metrics_render'
  rm -f -- "$METRICS_DIR/container-watchdog-containers.prom.tmp" "$STATE_DIR/events.next"
  record_job_result failure
  exit 1
fi
mv -f -- "$STATE_DIR/events.next" "$STATE_DIR/events"
if ((events_read)); then printf '%s\n' "$now" >"$STATE_DIR/events-until"; fi
printf '%s' "$secret_lines" >>"$METRICS_DIR/container-watchdog-containers.prom.tmp"
chmod 644 "$METRICS_DIR/container-watchdog-containers.prom.tmp"
mv -f -- "$METRICS_DIR/container-watchdog-containers.prom.tmp" "$METRICS_DIR/container-watchdog-containers.prom"

if [[ "$status" == 0 ]]; then
  record_job_result success
else
  record_job_result failure
fi
exit "$status"
