#!/usr/bin/env bash
# Exercises scripts/ops/monitoring/probe-public-ports.sh with a stubbed
# docker that answers like nmap's grepable output: only allowed ports
# record success, a port that is neither allowed nor pending records failure
# and logs the port, a pending port is tolerated, a scan that sees no
# allowed port fails, and IPv6 addresses are scanned with -6.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
script="$repository_root/scripts/ops/monitoring/probe-public-ports.sh"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

assert_contains() {
  grep -Fq -- "$2" "$1" || { printf 'expected %s to contain: %s\n' "$1" "$2" >&2; cat "$1" >&2; exit 1; }
}

cat >"$test_root/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE_DOCKER_ARGV"
line='Host: 192.0.2.1 ()	Ports: '
for port in $FAKE_OPEN; do line+="$port/open/tcp//x///, "; done
printf '# Nmap done\n%s\n' "${line%, }"
STUB
chmod 755 "$test_root/docker"

cat >"$test_root/test.allow" <<'EOF'
# comment
tcp/22  operator: sshd
tcp/443 operator: nginx
tcp/6379 from=192.0.2.9/32 operator: one source
EOF

run_probe() {
  local name=$1
  shift
  rm -rf -- "$test_root/metrics"
  : >"$test_root/argv"
  AIHUB_PUBLIC_PORTS_DOCKER="$test_root/docker" \
    AIHUB_HOST_JOB_METRICS_DIR="$test_root/metrics" \
    AIHUB_PUBLIC_PORTS_LOG="$test_root/$name.log" \
    AIHUB_PUBLIC_PORTS_PENDING="$test_root/pending" \
    FAKE_DOCKER_ARGV="$test_root/argv" \
    bash "$script" test "$test_root/test.allow" "$@"
}

: >"$test_root/pending"

FAKE_OPEN='22 443 6379' run_probe clean 192.0.2.1 2001:db8::1
[[ -f "$test_root/metrics/public-ports-test-success.prom" ]] || { echo 'expected success metric' >&2; exit 1; }
assert_contains "$test_root/metrics/public-ports-test-success.prom" 'aihub_host_job_max_age_seconds{task="public-ports-test"} 10800'
assert_contains "$test_root/argv" ' -6 '
[[ ! -e "$test_root/clean.log" ]] || { echo 'a clean run must not log' >&2; exit 1; }

if FAKE_OPEN='22 443 5434' run_probe exposed 192.0.2.1; then
  echo 'an unexpected port must fail' >&2
  exit 1
fi
[[ -f "$test_root/metrics/public-ports-test-failure.prom" ]] || { echo 'expected failure metric' >&2; exit 1; }
assert_contains "$test_root/exposed.log" 'reason=unexpected_open_port address=192.0.2.1 ports=tcp/5434'

printf 'tcp/5434 # waiting for its owner\n' >"$test_root/pending"
FAKE_OPEN='22 443 5434' run_probe pending 192.0.2.1
[[ -f "$test_root/metrics/public-ports-test-success.prom" ]] || { echo 'a pending port must not fail' >&2; exit 1; }

if FAKE_OPEN='' run_probe blind 192.0.2.1; then
  echo 'a scan that sees no allowed port must fail' >&2
  exit 1
fi
assert_contains "$test_root/blind.log" 'reason=scan_saw_no_expected_port'

echo 'probe-public-ports: ok'
