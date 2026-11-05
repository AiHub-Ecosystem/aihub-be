# Only the PgBouncer Agent can read the database credential bundle.
path "secret/data/aihub/production/database-pooler" {
  capabilities = ["read"]
}
