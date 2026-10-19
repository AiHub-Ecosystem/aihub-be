#!/usr/bin/env bash
# Exercises scripts/ops/firewall/docker-user-guard.sh inside a throwaway
# container's own network namespace, so the host's rules are never touched:
# plan names only the published ports the allowlist leaves out, apply builds
# the IPv4 default-deny and the IPv6 per-port drops, a second apply adds no
# duplicate jump, and remove leaves nothing behind.
set -euo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

cp "$repository_root/scripts/ops/firewall/docker-user-guard.sh" "$test_root/guard.sh"
cat >"$test_root/public.allow" <<'EOF'
# comment line
tcp/22   operator: sshd
tcp/8080 web: a project that is public on purpose
tcp/6379 from=10.9.9.9/32 operator: one source only
EOF

cat >"$test_root/inner.sh" <<'INNER'
set -eu
apk add --no-cache -q iptables ip6tables >/dev/null
fail() { echo "FAIL: $*" >&2; exit 1; }
has() { printf '%s\n' "$1" | grep -Fq -- "$2" || fail "missing: $2"; }
lacks() { if printf '%s\n' "$1" | grep -Fq -- "$2"; then fail "unexpected: $2"; fi; }

# What Docker leaves behind: DOCKER-USER, and DNAT rules for a public
# database, a loopback-only database, an allowed web port, and the allowed
# single-source Redis port.
iptables -N DOCKER-USER
iptables -t nat -N DOCKER
iptables -t nat -A DOCKER ! -i br0 -p tcp -m tcp --dport 5434 -j DNAT --to-destination 172.16.5.2:5432
iptables -t nat -A DOCKER -d 127.0.0.1/32 ! -i br0 -p tcp -m tcp --dport 5433 -j DNAT --to-destination 172.16.5.3:5432
iptables -t nat -A DOCKER ! -i br0 -p tcp -m tcp --dport 8080 -j DNAT --to-destination 172.16.5.4:80
iptables -t nat -A DOCKER ! -i br0 -p tcp -m tcp --dport 6379 -j DNAT --to-destination 172.16.5.5:6379

guard="sh /t/guard.sh"
plan=$($guard plan /t/public.allow)
cut=$(printf '%s\n' "$plan" | sed -n '/would cut off/,$p')
has "$cut" tcp/5434
lacks "$cut" tcp/5433
lacks "$cut" tcp/8080
lacks "$cut" tcp/6379
lacks "$(iptables -S)" AIHUB-PUBLIC-INGRESS

$guard apply /t/public.allow
$guard apply /t/public.allow
v4=$(iptables -S AIHUB-PUBLIC-INGRESS)
has "$v4" '! -i eth0 -j RETURN'
has "$v4" '--ctstate RELATED,ESTABLISHED -j RETURN'
has "$v4" '-p tcp -m conntrack --ctorigdstport 8080 --ctdir ORIGINAL -j RETURN'
has "$v4" '-s 10.9.9.9/32 -p tcp -m conntrack --ctorigdstport 6379 --ctdir ORIGINAL -j RETURN'
[ "$(printf '%s\n' "$v4" | tail -n 1)" = '-A AIHUB-PUBLIC-INGRESS -j DROP' ] || fail 'IPv4 chain must end in DROP'
[ "$(iptables -S DOCKER-USER | grep -c AIHUB-PUBLIC-INGRESS)" = 1 ] || fail 'one DOCKER-USER jump'
[ "$(iptables -S DOCKER-USER | sed -n 2p)" = '-A DOCKER-USER -j AIHUB-PUBLIC-INGRESS' ] || fail 'jump goes first'

v6=$(ip6tables -S AIHUB-PUBLIC-INGRESS)
has "$v6" '--ctorigdstport 5434 --ctdir ORIGINAL -j DROP'
has "$v6" '--ctorigdstport 6379 --ctdir ORIGINAL -j DROP'
lacks "$v6" 'ctorigdstport 8080'
lacks "$v6" 'ctorigdstport 5433'
[ "$(ip6tables -S INPUT | grep -c AIHUB-PUBLIC-INGRESS)" = 1 ] || fail 'one IPv6 INPUT jump'

$guard remove /t/public.allow
lacks "$(iptables -S)" AIHUB-PUBLIC-INGRESS
lacks "$(ip6tables -S)" AIHUB-PUBLIC-INGRESS
echo 'docker-user-guard: ok'
INNER

docker run --rm --cap-add NET_ADMIN -v "$test_root:/t:ro" alpine:3.22 sh /t/inner.sh
