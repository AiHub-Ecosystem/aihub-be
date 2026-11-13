#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
rsyslog_config="$repository_root/ops/logs/30-aihub-app-logs.conf"
logrotate_config="$repository_root/ops/logs/aihub-app-logrotate"
root_helper="$repository_root/ops/nginx/aihub-nginx-apply"
test_root="$(mktemp -d)"
trap 'rm -rf -- "$test_root"' EXIT

extract() {
  awk -v name="$1" '
    $0 == name "() {" { printing = 1 }
    printing { print }
    printing && $0 == "}" { exit }
  ' "$2"
}

assert_contains() {
  grep -Fq -- "$2" "$1" || {
    printf 'expected %s to contain: %s\n' "$1" "$2" >&2
    exit 1
  }
}

assert_contains "$rsyslog_config" 'input(type="imtcp" address="127.0.0.1" port="1514" ruleset="aihub-app-logs")'
assert_contains "$rsyslog_config" 'property(name="msg" droplastlf="on")'
assert_contains "$rsyslog_config" 'if $programname == "aihub-production"'
assert_contains "$rsyslog_config" 'file="/var/log/aihub-app-production.log"'
assert_contains "$rsyslog_config" 'if $programname == "aihub-sandbox"'
assert_contains "$rsyslog_config" 'file="/var/log/aihub-app-sandbox.log"'
if grep -Eq 'address="\*"|omfile.*(nginx|/var/log/syslog)' "$rsyslog_config"; then
  printf 'AIHUB receiver must stay loopback-only and write only AIHUB files\n' >&2
  exit 1
fi

for directive in 'daily' 'maxsize 10M' 'maxage 28' 'rotate 2' 'ifempty' \
  'create 0640 syslog adm' 'systemctl kill --signal=HUP rsyslog.service'; do
  assert_contains "$logrotate_config" "$directive"
done

app_logs_sha="$(sha256sum "$rsyslog_config" | cut -d ' ' -f 1)"
app_logrotate_sha="$(sha256sum "$logrotate_config" | cut -d ' ' -f 1)"
assert_contains "$root_helper" "readonly APP_LOGS_SHA256=$app_logs_sha"
assert_contains "$root_helper" "readonly APP_LOGROTATE_SHA256=$app_logrotate_sha"
assert_contains "$root_helper" "printf 'AIHUB_HOST_CONFIG_VERSION=2\\n'"
eval "$(extract has_active_rsyslog_include "$root_helper")"
printf '# $IncludeConfig /etc/rsyslog.d/*.conf\n' >"$test_root/commented.conf"
if has_active_rsyslog_include "$test_root/commented.conf"; then
  printf 'commented rsyslog include was accepted\n' >&2
  exit 1
fi
printf '$IncludeConfig /etc/rsyslog.d/*.conf\n' >"$test_root/active.conf"
if ! has_active_rsyslog_include "$test_root/active.conf"; then
  printf 'active rsyslog include was rejected\n' >&2
  exit 1
fi
assert_contains "$root_helper" "timeout 1 bash -c 'exec 3<>/dev/tcp/127.0.0.1/1514'"
assert_contains "$root_helper" 'systemctl is-active --quiet rsyslog.service'

printf 'AIHUB app-log sink config checks passed\n'
