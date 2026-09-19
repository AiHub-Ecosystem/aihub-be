# AIHUB staging runtime identity. This policy is intentionally read-only.
path "secret/data/aihub/staging/ai-speaking" {
  capabilities = ["read"]
}

path "secret/data/aihub/staging/ai-writing" {
  capabilities = ["read"]
}

path "secret/data/aihub/staging/resend" {
  capabilities = ["read"]
}

path "secret/data/aihub/staging/user-access-jwt" {
  capabilities = ["read"]
}

path "secret/data/aihub/staging/seaweedfs" {
  capabilities = ["read"]
}
