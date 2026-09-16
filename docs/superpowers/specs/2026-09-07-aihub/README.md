# AIHUB — Architecture Design (Foundation for Deliverable 2)

> **Status:** Approved following the brainstorm on 2026-09-07.
> **Context:** Answers the original brainstorm brief (removed from repo) — the A–P output structure originates from §16 of that brief; refer to git history if needed.
> **Does not replace:** `../../../aihub_long_term_architecture.md` (target architecture) and `../../../aihub_deliverable_1_api_contract_schema.md` (contract). This document serves as the **implementation strategy** to transition from D1 to D2.

Scaffold status: [Clean Architecture and agent workflow design](12-agent-workflow-and-clean-architecture-design.md) is implemented in the initial NestJS/Fastify source scaffold.

## Table of Contents

| File                                                                                                     | Content                                                                                                        | Brief Section |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------- |
| [01-context-and-stack.md](01-context-and-stack.md)                                                       | Settled constraints, real AI Writing survey, executive recommendation, tech stack matrix, architecture diagram | A, B, C       |
| [02-request-lifecycle.md](02-request-lifecycle.md)                                                       | 17-step pipeline, NestJS mapping, 3 sample lifecycles                                                          | D             |
| [03-database.md](03-database.md)                                                                         | 5-table DDL, indexes, idempotency race conditions, 8 pruned tables                                             | E             |
| [04-redis.md](04-redis.md)                                                                               | Key inventory, rate limits, concurrency limits, quotas, behavior on Redis failure                              | F             |
| [05-auth-identity.md](05-auth-identity.md)                                                               | API keys, user assertions, JWKS/SSRF, internal JWTs, key rotation, authorization                               | G             |
| [06-routing-adapter.md](06-routing-adapter.md)                                                           | Operation catalog, canonical schemas, adapter interface, dispatcher, internal contract                         | H             |
| [07-reliability-and-errors.md](07-reliability-and-errors.md)                                             | Timeouts, retries, circuit breakers, idempotency, 18 error codes                                               | I, J          |
| [08-metering-and-observability.md](08-metering-and-observability.md)                                     | Metering, billing, reconciliation, logs/metrics/alerts                                                         | K, L          |
| [09-security.md](09-security.md)                                                                         | 19-item threat model prioritized by Must/Should/Later                                                          | M             |
| [10-deployment-roadmap.md](10-deployment-roadmap.md)                                                     | Docker Compose stack, deployment, backups, scaling triggers, 6 phases, testing, ADRs                           | N, O          |
| [11-open-questions.md](11-open-questions.md)                                                             | 5 open questions, changes to feed back to D1, alignment with principles                                        | P             |
| [12-agent-workflow-and-clean-architecture-design.md](12-agent-workflow-and-clean-architecture-design.md) | Agent workflow, source-of-truth hierarchy, clean architecture scaffold                                         | —             |
| [13-quota-reconciliation.md](13-quota-reconciliation.md)                                                 | Issue #53: durable usage reconciliation for Redis quota counters                                               | —             |

## Executive Recommendation

**AIHUB is a modular monolith built with NestJS + Fastify, executing the entire data plane without an Envoy or Kong proxy in front.**

Core rationale: Everything AIHUB performs is **application business logic masquerading as proxy routing**. Verifying JWTs against per-tenant JWKS endpoints, evaluating `entitlement ∩ api_key_scope`, mapping canonical requests to distinct proprietary downstream contracts, minting scoped internal JWTs — none of this is "pure proxying". Placing Kong or Envoy in front merely introduces a second configuration plane to maintain, ultimately requiring the same business logic to be rewritten in Lua or WASM.

Postgres is the single source of truth for the control plane. Redis acts purely as a cache and transient counter — **if Redis fails, AIHUB experiences degraded latency and loses partial rate-limiting defenses, but never returns corrupted results and never permits an unauthorized request**. No queues and no object storage in the MVP; both enter alongside the Speaking service.

Four areas received disproportionate architectural investment beyond conventional "MVP" standards because they are prohibitively expensive to retrofit later: **tenant isolation**, **API contracts**, **metering**, and **authentication**. Everything else is stripped to the minimum viable execution surface, paired with clear quantitative triggers for future upgrades.

The entire system runs on a **single VPS via Docker Compose**, comprising 8 containers, costing ~€15/month. This is chosen not out of frugality, but because for a 2–3 person engineering team without dedicated DevOps, every added infrastructure dependency is an operational liability at 3 AM.

## Reading by Role

- **Ready to write code immediately:** [01](01-context-and-stack.md) → [03](03-database.md) → [06](06-routing-adapter.md) → [10](10-deployment-roadmap.md#n6-phases)
- **Security review:** [05](05-auth-identity.md) → [09](09-security.md)
- **Track open questions & D1 feedback loop:** [11](11-open-questions.md#q-changes-to-feed-back-to-d1)
- **Modify workflow or source layout:** [12](12-agent-workflow-and-clean-architecture-design.md)
- **Hand-off to AI Writing team:** [06 §H.5](06-routing-adapter.md#h5-internal-contract-modify-writing-without-breaking-existing-app) + [01 §0.1](01-context-and-stack.md#01-current-state-of-ai-writing-live-survey)
