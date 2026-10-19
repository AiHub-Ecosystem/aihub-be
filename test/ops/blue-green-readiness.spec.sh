#!/usr/bin/env bash
# Keeps deployment readiness compatible with existing images during script-path moves.
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repository_root"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_equals() {
  [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"
}

assert_fails() {
  if "$@" >/dev/null 2>&1; then
    fail "expected failure: $*"
  fi
}

extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' scripts/ops/blue-green/blue-green-host.sh
}

for function_name in container_probe_path container_ready probe_container_dependencies; do
  definition="$(extract "$function_name")"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done

current_probe=/app/scripts/ops/monitoring/probe-runtime-dependencies.cjs
legacy_probe=/app/scripts/ops/probe-runtime-dependencies.cjs
available_probe=current
observed_paths="$test_root/observed-paths"

sudo() {
  [[ "$1" == -n && "$2" == docker && "$3" == exec ]] || fail "unexpected sudo call: $*"
  if [[ "$5" == test && "$6" == -f ]]; then
    case "$7:$available_probe" in
      "$current_probe:current" | "$legacy_probe:legacy") return 0 ;;
      *) return 1 ;;
    esac
  fi
  [[ "$5" == node ]] || fail "unexpected docker command: $*"
  printf '%s\n' "${@: -1}" >>"$observed_paths"
}

assert_equals "$(container_probe_path app-container)" "$current_probe" "current image probe"
assert_equals "$(container_probe_path app-container false)" "$current_probe" "strict current probe"
probe_container_dependencies app-container
container_ready app-container healthy
[[ "$(cat "$observed_paths")" == "$current_probe
$current_probe" ]] || fail "current image checks did not use its probe"

: >"$observed_paths"
available_probe=legacy
assert_equals "$(container_probe_path app-container true)" "$legacy_probe" "legacy image probe"
assert_fails container_probe_path app-container false
probe_container_dependencies app-container true
container_ready app-container healthy
[[ "$(cat "$observed_paths")" == "$legacy_probe
$legacy_probe" ]] || fail "legacy image checks did not use its probe"

available_probe=missing
assert_fails container_probe_path app-container true
assert_fails probe_container_dependencies app-container

printf 'blue-green readiness spec: current and legacy probe paths pass\n'
