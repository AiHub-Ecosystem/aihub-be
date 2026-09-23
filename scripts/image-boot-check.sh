#!/usr/bin/env bash
# Boots a built production image with throwaway configuration and waits for
# its own health check. Answers one question: does this artifact start.
# See docs/operations/ci-boot-check.md for what it does and does not prove.
#
#   scripts/image-boot-check.sh <image>
set -euo pipefail

image="${1:?usage: scripts/image-boot-check.sh <image>}"
timeout_seconds="${BOOT_CHECK_TIMEOUT_SECONDS:-90}"
container="aihub-boot-check-$$"
config_dir="$(mktemp -d)"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$config_dir"
}
trap cleanup EXIT

node "$(dirname "$0")/ci-boot-config.cjs" "$config_dir"
# The image runs as uid 10001; the mounted files must be readable by it.
chmod 0755 "$config_dir"
chmod 0644 "$config_dir"/*

# Git Bash on Windows hands Docker POSIX temp paths it cannot open.
host_dir="$config_dir"
if command -v cygpath >/dev/null 2>&1; then
  host_dir="$(cygpath -w "$config_dir")"
  export MSYS_NO_PATHCONV=1
fi

# The Dockerfile's own health check, polled every 2s instead of every 30s: the
# same command production uses, at a cadence a CI job can afford, during its
# start period too. The start period itself still applies, so probes before
# the server listens do not count against it.
docker run --detach --name "$container" \
  --env-file "$host_dir/boot.env" \
  --volume "$host_dir:/run/secrets/aihub:ro" \
  --health-interval 2s \
  --health-start-interval 2s \
  "$image" >/dev/null

started=$SECONDS
while true; do
  # A failed inspect still falls through to the log tail below.
  state="$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container" 2>&1)" ||
    state="inspect failed: $state"
  case "$state" in
    "running healthy")
      echo "image boot check: healthy after $((SECONDS - started))s"
      exit 0
      ;;
    exited* | dead* | "running unhealthy" | "inspect failed"*)
      break
      ;;
  esac
  if ((SECONDS - started >= timeout_seconds)); then
    echo "image boot check: not healthy within ${timeout_seconds}s" >&2
    break
  fi
  sleep 1
done

echo "image boot check: failed ($state); last 100 log lines:" >&2
# Every value in the configuration is fake, so the log cannot carry a real
# secret; the tail is still bounded.
docker logs --tail 100 "$container" >&2 || true
exit 1
