#!/usr/bin/env bash
# Pins how CD finishes a half-deployed release (#1381, #1382): when Production
# already runs the target revision, `resume production` re-opens the caller-IP
# gate so the lagging Sandbox can be deployed, and only then. The functions are
# lifted out of the deploy script and run against fixtures, so no Docker,
# nginx or sudo is needed.
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

assert_allowed() {
  assert_gate_transition >/dev/null 2>&1 || fail "$1 should be allowed"
}

assert_refused() {
  if assert_gate_transition >/dev/null 2>&1; then
    fail "$1 should be refused"
  fi
}

# Prints one top-level function definition: from `name() {` to the first `}`
# in column 0.
extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

for function_name in write_gate clear_gate gate_state assert_gate_transition \
  resume_production; do
  definition="$(extract "$function_name" scripts/ops/blue-green/blue-green-host.sh)"
  [[ -n "$definition" ]] || fail "$function_name is missing from blue-green-host.sh"
  eval "$definition"
done

target_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
older_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
production_sha=$target_sha

STATE_DIR="$test_root/state"
GATE_FILE="$STATE_DIR/caller-ip-gate.tsv"
PENDING_FILE="$STATE_DIR/pending.tsv"
API_CONFIG="$test_root/aihub-api.conf"
AIHUB_IMAGE="ghcr.io/example/aihub:$target_sha"
mkdir -p "$STATE_DIR"

# Stand-ins for the Compose and Docker lookups.
active_slot() { printf 'a'; }
service_for_slot() { printf 'app-production'; }
container_id() { printf 'container-1'; }
container_revision() { printf '%s' "$production_sha"; }

reset_state() {
  rm -f -- "$GATE_FILE" "$PENDING_FILE"
  production_sha=$target_sha
  AIHUB_IMAGE="ghcr.io/example/aihub:$target_sha"
}

# A skipped Production cutover wrote no gate, which refused the Sandbox deploy.
reset_state
COMMAND=deploy TIER=sandbox
assert_refused "deploy sandbox with no gate"

# resume is allowed with no gate and for Production only.
COMMAND=resume TIER=production
assert_allowed "resume production with no gate"
COMMAND=resume TIER=sandbox
assert_refused "resume sandbox"
for held in production sandbox; do
  reset_state
  write_gate "$held"
  COMMAND=resume TIER=production
  assert_refused "resume production while the gate is $held"
done

# resume writes the production gate when Production already runs the target,
# and that gate is what lets the Sandbox deploy start.
reset_state
resume_production >/dev/null
assert_equals "$(gate_state)" production "gate after resume"
COMMAND=deploy TIER=sandbox
assert_allowed "deploy sandbox after resume"
COMMAND=finalize TIER=
assert_allowed "finalize after resume"

# resume refuses, and writes nothing, in every unsafe state.
reset_state
printf 'pending\n' >"$PENDING_FILE"
if resume_production >/dev/null 2>&1; then fail "resume ignored a pending rollout"; fi
[[ ! -f "$GATE_FILE" ]] || fail "resume wrote a gate over a pending rollout"

reset_state
production_sha=$older_sha
if resume_production >/dev/null 2>&1; then fail "resume accepted a Production revision that is not the target"; fi
[[ ! -f "$GATE_FILE" ]] || fail "resume wrote a gate for the wrong revision"

reset_state
AIHUB_IMAGE=ghcr.io/example/aihub:latest
if resume_production >/dev/null 2>&1; then fail "resume accepted an image without a commit SHA"; fi
[[ ! -f "$GATE_FILE" ]] || fail "resume wrote a gate without a target SHA"

reset_state
write_gate sandbox
if resume_production >/dev/null 2>&1; then fail "resume replaced an existing gate"; fi
assert_equals "$(gate_state)" sandbox "existing gate after a refused resume"

printf 'PASS\n'
