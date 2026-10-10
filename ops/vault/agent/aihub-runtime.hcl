# Deploy this Agent configuration outside the repository's application image.
# The role-id file is provisioned through the deployment secret channel and
# must be readable only by the Agent service account. The AppRole has
# bind_secret_id=false, so role_id alone is a complete credential and the
# Agent can re-authenticate whenever it is restarted or its token is revoked.

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path = "/run/secrets/vault/role_id"
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
  source      = "/etc/aihub/vault/auth-mfa-secrets.json.ctmpl"
  destination = "/run/secrets/aihub/auth-mfa-secrets.json"
  perms       = "0600"
}

template {
  source      = "/etc/aihub/vault/connection-secrets.json.ctmpl"
  destination = "/run/secrets/aihub/connection-secrets.json"
  perms       = "0600"
}
