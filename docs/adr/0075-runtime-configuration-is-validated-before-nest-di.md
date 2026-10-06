# ADR-0075: Runtime configuration is validated before Nest DI

- Status: Accepted
- Date: 2026-10-06
- Related issue: [#308](https://github.com/AiHub-Ecosystem/aihub-be/issues/308)

AIHUB needs one typed contract for its Nest application's environment variables, but some consumers run before the Nest container exists. OpenTelemetry starts during module import so it can instrument Redis, Postgres, and HTTP clients; request logging and identity startup checks also need configuration before `NestFactory.create()`. Moving those consumers to `ConfigService` would either delay instrumentation or move safety checks past provider construction.

Use one TypeBox-backed schema and validate one environment snapshot in the pre-DI configuration boundary. That boundary is the only application code that reads `process.env`; it supplies the validated snapshot to early consumers and to typed `@nestjs/config` registrations for DI. Module configuration uses `registerAs`/`ConfigType` projections of the same snapshot, not a second schema or validation pass. The validator therefore runs before OpenTelemetry import-time setup rather than relying on `ConfigModule`'s later `validate` hook; `@nestjs/config` is the DI surface. Vault remains the source of runtime secret values, loaded through the existing secrets boundary.

The schema owns environment-variable metadata and is checked against the two example files and the generated CI boot environment. The CI generator continues to own fake values. `NODE_ENV` remains the mode selector, with staging using production requirements and existing runtime-scope conditions preserved. This resolves the initial #308 preference for no configuration framework in favor of `@nestjs/config` for typed DI, while preserving early startup validation and instrumentation.
