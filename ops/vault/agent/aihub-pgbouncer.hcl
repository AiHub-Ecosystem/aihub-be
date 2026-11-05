auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path = "/run/secrets/vault/role_id"
    }
  }
}

listener "tcp" {
  address     = "127.0.0.1:8220"
  tls_disable = true
  role        = "metrics_only"
}

telemetry {
  disable_hostname          = true
  prometheus_retention_time = "1m"
}

template {
  source      = "/etc/aihub/vault/pgbouncer.ini.ctmpl"
  destination = "/run/secrets/pgbouncer/pgbouncer.ini"
  perms       = "0600"
}

template {
  source      = "/etc/aihub/vault/pgbouncer-userlist.txt.ctmpl"
  destination = "/run/secrets/pgbouncer/userlist.txt"
  perms       = "0600"
}

template {
  source      = "/etc/aihub/vault/pgbouncer-metrics-credentials.json.ctmpl"
  destination = "/run/secrets/pgbouncer/metrics-credentials.json"
  perms       = "0600"
}
