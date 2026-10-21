# Runtime configuration

Read this before changing `src/config`, an environment file, a Vault-held secret, or the SeaweedFS client.

- The Nest application has one TypeBox-backed environment schema under `src/config`. It owns names, types, defaults, requiredness, and secret metadata; validate one snapshot before pre-DI consumers such as OpenTelemetry, then expose typed configuration through `@nestjs/config` for DI. Direct `process.env` reads stay inside the configuration boundary; this rule does not cover independent CLI and operational scripts.
- Keep Vault as the source for runtime secret values. The schema records sensitivity but never loads or prints secret values. Preserve existing `NODE_ENV` modes and `AIHUB_RUNTIME_DATABASE_SCOPE` conditions; staging follows production rules.
- Check `.env.example`, `.env.production.example`, and the CI boot fixture against the schema. The CI fixture supplies fake values; it does not define configuration metadata.
- Build one SeaweedFS S3 client per process through a shared factory in the secrets infrastructure. Nest modules receive the client through `SecretsModule`'s public seam; the independent CLI composition root calls the factory with explicit configuration and Vault values. Adapters select their bucket; deployment configuration maps tier-specific bucket values to canonical application variable names.
