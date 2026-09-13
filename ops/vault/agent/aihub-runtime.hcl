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

template {
  source      = "/etc/aihub/vault/runtime-secrets.json.ctmpl"
  destination = "/run/secrets/aihub/runtime-secrets.json"
  perms       = "0600"
}
