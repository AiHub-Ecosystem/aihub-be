# Deploy this Agent configuration outside the repository's application image.
# The role/secret-id files are provisioned through the deployment secret
# channel and must be readable only by the Agent service account.

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path   = "/run/secrets/vault/role_id"
      secret_id_file_path = "/run/secrets/vault/secret_id"
      remove_secret_id_file_after_reading = false
    }
  }
}

# Keep this unauthenticated metrics-only listener inside the container.
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
  source      = "/etc/aihub/vault/runtime-secrets.json.ctmpl"
  destination = "/run/secrets/aihub/runtime-secrets.json"
  perms       = "0600"
}

template {
  source      = "/etc/aihub/vault/connection-secrets.json.ctmpl"
  destination = "/run/secrets/aihub/connection-secrets.json"
  perms       = "0600"
}
