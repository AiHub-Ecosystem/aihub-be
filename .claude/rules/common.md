---
paths:
  - "src/common/**"
---

# Common layer rules

- Keep this layer limited to genuinely cross-cutting primitives: errors, request context, redaction, and transport-neutral utilities.
- Do not place organization policy, operation-specific behavior, or a repository in `src/common`.
- Explicitly named boundary bindings may import their framework; keep them isolated from the framework-neutral contracts beside them.
- Common code must not read raw headers, environment variables, Postgres, Redis, or downstream services unless the file is an explicit boundary adapter. Runtime configuration owns environment reads before Nest starts; common code consumes the validated configuration. `scripts/checks/architecture/check-architecture.spec.ts` pins that no common files read the environment directly.
- A metric family, header, or lookup that one module owns lives in that module and registers on the shared `registry` from there (#1830). Email delivery metrics live under `modules/auth/email-delivery/infrastructure/metrics/`, critical-journey metrics in `modules/metering/presentation/`, downstream breaker and concurrency metrics in `modules/gateway/infrastructure/dispatch/`, the retired-major `410` in `modules/metering/presentation/`, and the Customer Web client-secret header in `modules/auth/web-sessions/public/`. `customer-web-base-url.ts` lives in `src/config/` because configuration validation and the email composer share one rule.
- Reuse the shared error envelope and `RequestContext`; do not create module-specific duplicates.
- Reuse an existing `ErrorCode` where its meaning fits. A new one turns the CI job `Customer Web contract` red until `AiHub-Frontend` `dev` lists it in `data/aihub-contract/error-code-policy.json` (`messages` for its own copy, `safeGenericCodes` for the generic fallback), and a red CI on `main` skips deployment. Merge that Frontend change before pushing the code.

## What stays in `src/common` (#1830)

Each item below was reviewed for module ownership and kept, for the reason given.

- `errors/error-code.ts`, `errors/error-registry.ts`: one public error vocabulary. `src/catalog`, `src/openapi`, `src/downstream`, and the shared error envelope read it, and `src/catalog`, `src/downstream`, and `common` import no module (`common-no-business-module-import`), so per-module codes could not be merged back into one registry. The Customer Web contract check pins the single list.
- `errors/upload-errors.ts`: its builders take the `ErrorCode` as a parameter and carry no module vocabulary. Avatar, Speaking, and Writing share them, and no one of the three owns them.
- `http/shutdown-budget.ts`: the budget is derived from the largest timeout in `src/catalog`, not from a module constant; ADR-0143 and the Speaking timing amendment raise catalog values, and `background-work-drain.ts` in `common/http` consumes the result.
- Subfolders `errors/`, `postgres/`, `redis/`, `cache/`, `counts/`, `ids/`, `serialization/`, `time/`, `security/`, `request-context/`, and the root utilities (`background-work-tracker`, `is-record`, `jittered-timer`, `singleflight`, `stable-offset`) are already grouped by concern and hold transport-neutral primitives. They are explicitly exempt from further regrouping; `http/` and `observability/` regrouping is #1729.
