# ADR-0076: Use Terminus for readiness and Opossum for circuit breakers

- Status: Accepted
- Date: 2026-10-07
- Related: [#199](https://github.com/AiHub-Ecosystem/aihub-be/issues/199), [#323](https://github.com/AiHub-Ecosystem/aihub-be/issues/323), [#324](https://github.com/AiHub-Ecosystem/aihub-be/issues/324)

AIHUB adopts `@nestjs/terminus` for dependency-aware readiness while keeping `/health` as dependency-free liveness, and uses Opossum for per-operation downstream circuit breakers. Terminus readiness reuses existing Postgres pools and Redis; Opossum follows the reliability spec's rolling-window, minimum-volume, single half-open probe, and failure-filter requirements at the dispatch boundary. The evaluation declines `@nestjs/resilience` for now because its version was pre-1.0 and its fit with AIHUB's dispatch-owned breaker and retry ordering has not been demonstrated.
