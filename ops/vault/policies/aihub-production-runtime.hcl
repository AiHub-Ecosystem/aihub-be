# AIHUB production runtime identity. This policy is intentionally read-only.
path "secret/data/aihub/production/ai-speaking" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/ai-writing" {
  capabilities = ["read"]
}

path "secret/data/aihub/production/seaweedfs" {
  capabilities = ["read"]
}
