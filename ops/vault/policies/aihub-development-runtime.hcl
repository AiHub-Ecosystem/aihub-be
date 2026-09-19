# AIHUB development runtime identity. This policy is intentionally read-only.
path "secret/data/aihub/development/ai-speaking" {
  capabilities = ["read"]
}

path "secret/data/aihub/development/ai-writing" {
  capabilities = ["read"]
}

path "secret/data/aihub/development/resend" {
  capabilities = ["read"]
}

path "secret/data/aihub/development/user-access-jwt" {
  capabilities = ["read"]
}

path "secret/data/aihub/development/seaweedfs" {
  capabilities = ["read"]
}
