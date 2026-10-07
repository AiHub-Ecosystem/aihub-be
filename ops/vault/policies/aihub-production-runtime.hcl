# AIHUB production runtime identity. This policy is intentionally read-only.
path "secret/data/aihub/production/ai-speaking" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/ai-writing" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/resend" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/user-access-jwt" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/seaweedfs" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/database" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/redis" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/sandbox-assertion" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/email-outbox" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/web-session" {
  capabilities = ["read"]
}
