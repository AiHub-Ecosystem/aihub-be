#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

helper="$repository_root/scripts/ops/speaking/speaking-gateway-smoke.sh"
fake_bin="$test_root/bin"
scratch="$test_root/scratch"
mkdir -p "$fake_bin" "$scratch"
printf '%s\n' 'test-api-key' >"$test_root/api-key"
printf 'user"\\id\n' >"$test_root/user-identity"
: >"$test_root/audio.wav"

cat >"$fake_bin/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

config=''
response=''
while (($#)); do
  case "$1" in
    --config) config=$2; shift 2 ;;
    --output) response=$2; shift 2 ;;
    --write-out) shift 2 ;;
    *) shift ;;
  esac
done

grep -Fqx -- 'header = "X-API-Key: test-api-key"' "$config"
grep -Fqx -- 'header = "X-User-Identity: user\"\\id"' "$config"
if grep -Fq -- 'X-User-Assertion:' "$config"; then
  exit 1
fi
printf '%s\n%s\n' "$config" "$response" >"$AIHUB_SMOKE_CAPTURE_FILE"
: >"$response"
printf '200'
STUB
chmod +x "$fake_bin/curl"

capture_file="$test_root/captured-paths"
output="$(PATH="$fake_bin:$PATH" \
  TMPDIR="$scratch" \
  AIHUB_API_KEY_FILE="$test_root/api-key" \
  AIHUB_USER_IDENTITY_FILE="$test_root/user-identity" \
  AIHUB_SMOKE_CAPTURE_FILE="$capture_file" \
  bash "$helper" "$test_root/audio.wav")"
[[ "$output" == 'HTTP_STATUS=200' ]] || fail "unexpected helper output: $output"

mapfile -t generated_files <"$capture_file"
[[ ${#generated_files[@]} -eq 2 ]] || fail 'curl stub did not capture both temporary files'
for generated_file in "${generated_files[@]}"; do
  [[ ! -e "$generated_file" ]] || fail 'temporary curl file was not removed'
done
[[ -z "$(find "$scratch" -mindepth 1 -print -quit)" ]] || fail 'scratch directory is not empty'

printf 'too-many-lines\nsecond-line\n' >"$test_root/user-identity"
rm -f "$capture_file"
if PATH="$fake_bin:$PATH" \
  TMPDIR="$scratch" \
  AIHUB_API_KEY_FILE="$test_root/api-key" \
  AIHUB_USER_IDENTITY_FILE="$test_root/user-identity" \
  AIHUB_SMOKE_CAPTURE_FILE="$capture_file" \
  bash "$helper" "$test_root/audio.wav" >/dev/null 2>&1; then
  fail 'multi-line identity was accepted'
fi
[[ ! -e "$capture_file" ]] || fail 'curl was called with a multi-line identity'

printf 'speaking gateway smoke spec: ok\n'
