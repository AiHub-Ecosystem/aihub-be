# AIHUB Sandbox runtime identity. It can read only Sandbox runtime secrets.
path "secret/data/aihub/sandbox/ai-speaking" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/ai-writing" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/resend" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/user-access-jwt" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/seaweedfs" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/database" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/redis" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/sandbox-assertion" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/email-outbox" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/web-session" {
  capabilities = ["read"]
}

path "secret/data/aihub/sandbox/auth-mfa" {
  capabilities = ["read"]
}
