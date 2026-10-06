---
paths:
  - "src/main.ts"
  - "src/app.module.ts"
  - "src/common/**"
  - "src/config/**"
  - "src/modules/**"
  - "src/cli/**"
  - "scripts/ci-boot-config.cjs"
---

# Runtime configuration

- Add every Nest application environment variable to the single TypeBox-backed schema under `src/config`; keep its type, default, requiredness conditions, and secret metadata there.
- For the Nest application, the configuration boundary is the only code that reads `process.env`. Validate one snapshot before OpenTelemetry, request logging, and startup safety checks; pass that snapshot to early consumers and expose typed `@nestjs/config` values for module DI. Do not parse or validate it a second time.
- `src/cli/**` is a separate composition root outside the Nest environment schema. It may read its own process configuration at that boundary, but must pass S3 endpoint, region, and Vault credentials explicitly to the shared client factory; do not start a Nest application context for CLI sweeps.
- Preserve existing optional/default behavior and conditions such as `NODE_ENV` and `AIHUB_RUNTIME_DATABASE_SCOPE`. Production and staging share production requirements. Aggregate boot errors by variable name only; never include values.
- Runtime credentials remain in the existing Vault boundary. The schema may mark a setting sensitive, but it does not load or store Vault values.
- Keep `.env.example`, `.env.production.example`, and the generated CI boot environment checked against the schema. CI owns fake boot values, not the variable contract.
- Build one SeaweedFS client per process through the shared factory in secrets infrastructure. Nest adapters receive the client through `SecretsModule`'s exported seam; CLI composition calls the same factory with explicit inputs. Resolve endpoint, region, and credentials once; storage adapters provide only bucket names. Map per-tier bucket values to the same canonical app-visible variables in deployment configuration.
- Identity request-environment code receives validated values as inputs/providers. Its specs pass configuration explicitly and do not mutate `process.env`.
