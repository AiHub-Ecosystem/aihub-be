# Graded-request module ownership and Nest import direction

Relates to: [ADR-0106](0106-cross-module-imports-are-forbidden-outside-published-seams.md), [ADR-0156](0156-restricted-cross-module-edges.md), [ADR-0147](0147-graded-pipeline-engine-owns-execution-lifecycle.md), [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md).

The Gateway module previously played two conflicting roles: a toolbox of admission and counter primitives consumed across modules, and the orchestrator of graded requests driving Metering and Idempotency. This produced bidirectional dependencies and split modules (`DispatchAttemptModule`, `MonthlyBillableUsageModule`, and `GatewayGradedRequestModule`) introduced solely to prevent Nest dependency cycles.

This decision settles module ownership by domain semantics and enforces a one-directional Nest import hierarchy.

## Ownership decisions

1. **Metering owns the Quota counter.** The Quota counter port (`QuotaCounterPort`, `QuotaCounterOverwritePort`, `QuotaCounterSeedPort`), the UTC quota period helpers, the Redis counter, seeder, and reconciliation counter move to Metering under `src/modules/metering/application/quota/` and `src/modules/metering/infrastructure/quota/`. Metering manages its own Redis client via `createRedisClient` behind a narrow interface. The Redis key format `aihub:v1:quota:<org>:<month>` remains unchanged. Metering publishes a public facade (`src/modules/metering/public/quota-counter.ts`) exposing month key derivation, period helpers, and the seed-port token.
2. **Gateway owns admission primitives.** Rate limiting, concurrency limiting, retry budgeting, and the Postgres-backed sandbox dispatch budget stay in Gateway. Gateway also owns graded admission (`RedisGradedAdmission`) and `RateLimitGuard`.
3. **Gateway owns graded-request orchestration and response envelope.** Gateway owns execution lifecycle end to end. `SuccessEnvelopeInterceptor` moves to Gateway (`src/modules/gateway/presentation/success-envelope.interceptor.ts`). It completes request metering through Metering public facades and the finalizer port before signaling pipeline completion, preserving the ADR-0147 ordering contract.

## Module dependency direction

Dependency direction at the Nest module layer becomes strictly hierarchical:

- `GatewayModule` imports `MeteringModule` and `IdempotencyModule`.
- `IdentityModule` imports `GatewayModule`.
- AI Service modules (`WritingModule`, `SpeakingModule`) import `GatewayModule`.
- `MeteringModule` imports neither `GatewayModule` nor `IdentityModule`.

Cycle-breaking split modules are eliminated:

- `DispatchAttemptModule` and `MonthlyBillableUsageModule` are folded into `MeteringModule`.
- `GatewayGradedRequestModule` is folded into `GatewayModule`.

No production file under `src/modules/metering/` imports from `@/modules/gateway/`.

## Accepted residual

Identity↔Gateway TypeScript imports in both directions remain accepted residuals under ADR-0106 seams:

- Gateway imports identity guards (`ApiKeyGuard`, `UserIdentityGuard`) and identity types.
- Identity imports `RateLimitGuard` and the sandbox dispatch budget facade.

All cross-module imports continue crossing published seams (exported guards, `public/` facades, application port types).

- Status: Accepted
- Related issue: [#1576](https://github.com/AiHub-Ecosystem/aihub-be/issues/1576)
- Related: [ADR-0061](0061-one-module-owns-the-metering-record-and-its-completion.md), [ADR-0106](0106-cross-module-imports-are-forbidden-outside-published-seams.md), [ADR-0147](0147-graded-pipeline-engine-owns-execution-lifecycle.md), [ADR-0156](0156-restricted-cross-module-edges.md)
