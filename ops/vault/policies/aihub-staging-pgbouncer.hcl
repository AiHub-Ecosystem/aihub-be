# Only the PgBouncer Agent can read the database credential bundle.
path "secret/data/aihub/staging/database-pooler" {
  capabilities = ["read"]
}
