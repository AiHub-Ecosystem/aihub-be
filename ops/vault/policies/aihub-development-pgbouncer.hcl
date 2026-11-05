# Only the PgBouncer Agent can read the database credential bundle.
path "secret/data/aihub/development/database-pooler" {
  capabilities = ["read"]
}
