#!/bin/sh
# Default-deny for published container ports (#464).
#
#   docker-user-guard.sh plan|apply|watch|remove <allowlist>...
#
# Docker writes its own iptables rules, so a `ports:` line in any project's
# compose file publishes that port to the internet past ufw. This guard puts
# one chain in front of Docker's forwarding rules:
#
#   IPv4, DOCKER-USER: traffic arriving on the public interface reaches a
#   container only if its original destination port is on an allowlist, so a
#   new `ports:` entry exposes nothing until someone also edits the list.
#   IPv6: with Docker's IPv6 off, docker-proxy answers published ports on
#   [::] through INPUT instead, so each published port that is not on the
#   allowlist is dropped there. The list is re-read on every pass.
#
# Host processes (sshd, nginx, anything outside Docker) are not filtered.
# The allowlist names every port that may be public, host processes too, so
# the external probe (scripts/ops/monitoring/probe-public-ports.sh) reads the
# same file.
#
# Runs in a container with the host's network and NET_ADMIN
# (ops/firewall/guard.compose.yml). `watch` re-applies every minute, which
# also restores the jump if Docker or someone else rewrites DOCKER-USER, and
# a reboot starts it again through the container's restart policy. `plan`
# changes nothing and prints which published ports the rules would cut off.
# `remove` takes every rule out again.
set -eu

readonly CHAIN=AIHUB-PUBLIC-INGRESS
readonly IFACE="${AIHUB_PUBLIC_INTERFACE:-eth0}"
readonly INTERVAL="${AIHUB_GUARD_INTERVAL_SECONDS:-60}"

mode=${1:-}
[ $# -ge 2 ] || { echo 'usage: docker-user-guard.sh plan|apply|watch|remove <allowlist>...' >&2; exit 2; }
shift

# The host runs the nf_tables backend; rules written through the legacy one
# would sit in tables the host never reads.
case "$(iptables -V)" in
  *nf_tables*) ;;
  *) echo "refusing: iptables is not the nf_tables backend: $(iptables -V)" >&2; exit 1 ;;
esac

# "<proto>/<port> <source>" per allowlist entry; source is "-" when absent.
allowed() {
  sed -e 's/#.*//' -- "$@" | awk 'NF {
    src = "-"
    for (i = 2; i <= NF; i++) if ($i ~ /^from=/) src = substr($i, 6)
    print $1, src
  }' | sort -u
}

# "<proto>/<port>" for each port Docker publishes on a non-loopback address.
published() {
  { iptables -t nat -S DOCKER 2>/dev/null || true; ip6tables -t nat -S DOCKER 2>/dev/null || true; } |
    awk '/-j DNAT/ && !/ -d (127\.|::1)/ {
      proto = ""; port = ""
      for (i = 1; i < NF; i++) {
        if ($i == "-p") proto = $(i + 1)
        if ($i == "--dport") port = $(i + 1)
      }
      if (proto != "" && port != "") print proto "/" port
    }' | sort -u
}

ipv4_rules() {
  echo '*filter'
  echo ":$CHAIN - [0:0]"
  echo "-A $CHAIN ! -i $IFACE -j RETURN"
  echo "-A $CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  allowed "$@" | while read -r entry src; do
    case "$src" in *:*) continue ;; esac
    source_match=
    [ "$src" = - ] || source_match="-s $src "
    echo "-A $CHAIN ${source_match}-p ${entry%/*} -m conntrack --ctorigdstport ${entry#*/} --ctdir ORIGINAL -j RETURN"
  done
  echo "-A $CHAIN -j DROP"
  echo COMMIT
}

ipv6_rules() {
  echo '*filter'
  echo ":$CHAIN - [0:0]"
  echo "-A $CHAIN ! -i $IFACE -j RETURN"
  echo "-A $CHAIN -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
  allowed_entries=$(allowed "$@" | awk '$2 == "-" { print $1 }')
  for entry in $(published); do
    printf '%s\n' "$allowed_entries" | grep -qx "$entry" && continue
    echo "-A $CHAIN -p ${entry%/*} -m conntrack --ctorigdstport ${entry#*/} --ctdir ORIGINAL -j DROP"
  done
  echo COMMIT
}

ensure_jump() {
  "$1" -C "$2" -j "$CHAIN" 2>/dev/null || "$1" -I "$2" 1 -j "$CHAIN"
}

apply() {
  ipv4_rules "$@" | iptables-restore --noflush
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
  ensure_jump iptables DOCKER-USER
  ipv6_rules "$@" | ip6tables-restore --noflush
  ensure_jump ip6tables INPUT
  if ip6tables -n -L DOCKER-USER >/dev/null 2>&1; then ensure_jump ip6tables DOCKER-USER; fi
}

remove() {
  for tool in iptables ip6tables; do
    for parent in DOCKER-USER INPUT; do
      while "$tool" -D "$parent" -j "$CHAIN" 2>/dev/null; do :; done
    done
    "$tool" -F "$CHAIN" 2>/dev/null || true
    "$tool" -X "$CHAIN" 2>/dev/null || true
  done
}

plan() {
  echo '# IPv4 rules'
  ipv4_rules "$@"
  echo '# IPv6 rules'
  ipv6_rules "$@"
  echo '# Published ports the IPv4 rules would cut off from the public interface'
  allowed_any=$(allowed "$@" | awk '{ print $1 }')
  for entry in $(published); do
    printf '%s\n' "$allowed_any" | grep -qx "$entry" || echo "$entry"
  done
}

case "$mode" in
  plan) plan "$@" ;;
  apply) apply "$@" ;;
  watch) while :; do apply "$@"; sleep "$INTERVAL"; done ;;
  remove) remove ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
