# 10 — Deployment, Roadmap, Testing, ADR

← [Table of Contents](README.md) · [09 — Security](09-security.md)

# N. Deployment

## N.1 Compose Stack

```
nginx       :80 :443, host TLS termination, load balances app-1/app-2
app-1       aihub application, replica 1
app-2       aihub application, replica 2
postgres    16, dedicated persistent volume, NOT exposed to host ports
redis       noeviction, 15-minute RDB snapshot, NOT exposed to host ports
prometheus  scrapes app-1, app-2 /metrics
loki        ingests JSON logs via docker log driver
grafana     dashboards + alert routing
```

8 containers running on a single **4 vCPU / 8GB RAM** VPS (e.g. Hetzner CPX31 ~€15/month).

Two application replicas are configured **not for peak throughput**, but for zero-downtime rolling deployments and single-process crash isolation.

## N.2 Graceful Shutdown — Critical for Long-Running AI Inference

```yaml
stop_grace_period: 90s
```

```ts
process.on("SIGTERM", async () => {
  await fastify.close(); // stop accepting new traffic, finish in-flight requests
  await Promise.all([pg.end(), redis.quit()]);
});
```

Grading requests can take up to 60 seconds. Docker's default shutdown behavior sends `SIGKILL` after **10 seconds** — meaning naive deployments sever student grading evaluations mid-stream **after token fees have already been billed**. These two lines of configuration prevent deployments from causing customer-visible errors.

## N.3 Rolling Deployment Script

```bash
docker compose pull app-1 app-2
for c in app-1 app-2; do
  docker compose up -d --no-deps "$c"
  until curl -sf "http://$c:3000/health"; do sleep 2; done   # wait until healthy before rolling next
done
```

The deployment waits for each application health check before rotating an upstream; host nginx continues serving the existing upstream during rollout. **Kubernetes is not required to achieve zero-downtime rolling deployments.**

CI: GitHub Actions compiles image → pushes to GHCR → executes deployment script via SSH.

Database migrations execute **prior** to app deployment, following the strict **expand-only** pattern:

```
PERMITTED:  CREATE TABLE, ADD nullable column, CREATE INDEX CONCURRENTLY
FORBIDDEN:  DROP COLUMN, RENAME column, ADD NOT NULL without DEFAULT
```

Dropping columns requires a separate, dedicated cleanup deployment scheduled days later.

## N.4 Backup Strategy — The Most Common Point of Failure

Self-hosting Postgres for a commercial application → **this is the single largest operational risk in the entire architecture**.

```bash
# Hourly cron execution
pg_dump -Fc aihub | age -r "$BACKUP_PUBKEY" > /tmp/aihub-$(date +%FT%H).dump.age
rclone copy /tmp/aihub-*.age r2:aihub-backups/
# Retention: retain 48 hourly, 30 daily, and 12 monthly snapshots
```

**Hourly rather than daily**, because losing 24 hours of `usage_records` wipes out 24 hours of verifiable billing ledger. Control plane database volume is minimal (hundreds of megabytes), making hourly dumps virtually free.

**Quarterly restoration rehearsals, tracked by calendar.** An unverified backup that has never undergone successful restoration is not a backup — it is merely blind hope. This is the only recommendation across this specification suite proposed for a **calendar schedule** rather than codebase automation.

<a id="n5-trigger-rời-khỏi-kiến-trúc-này"></a>
<a id="n5-triggers-to-exit-this-architecture"></a>

## N.5 Triggers to Exit This Architecture

Documented explicitly to prevent premature, speculative refactoring:

| Migration Path                        | Trigger Threshold                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Dedicated VPS for Postgres            | Database CPU > 60% sustained, or application/DB disk I/O contention                                        |
| Managed PostgreSQL                    | Operating overhead becomes unmanageable, or high-availability failover is required                         |
| Multi-node cluster with dedicated LB  | Sustained traffic > 300 RPS or > 1,000 concurrent connections                                              |
| Kubernetes                            | ≥ 3 independent microservices requiring decoupled deploy pipelines **and** dedicated DevOps staffing       |
| Re-evaluate Go / dedicated data plane | p99 gateway overhead > 50ms while CPU is underutilized; or streaming SSE becomes mandatory; or > 1,000 RPS |
| Apache Kafka                          | Deferred indefinitely until a third event consumer requires event log replay                               |
| Partitioning `usage_records`          | > ~50 million rows, or retention cleanup queries take more than several minutes                            |
| HashiCorp Vault / SOPS                | ≥ 3 deployment environments, or team member departures, or formal compliance audits                        |
| Tempo / Jaeger tracing                | ≥ 3 chained downstream services in a single request flow, or async workers in Phase 4                      |
| Sliding window / GCRA rate limiting   | Customer disputes regarding minute-boundary burst fairness, or contractual SLA mandates                    |

<a id="n6-phases"></a>

## N.6 Implementation Phases

### Phase 0 — Freeze D1 · _1 week, concurrent_

Lock in canonical schemas ([06 §H.2](06-routing-adapter.md#h2-canonical-schemas)), 18 unified error codes ([07 §J.2](07-reliability-and-errors.md#j2-error-code-inventory-v1)), operation catalog ([06 §H.1](06-routing-adapter.md#h1-operation-catalog-typed-code)), internal contract for Writing team ([06 §H.5](06-routing-adapter.md#h5-internal-contract-modify-writing-without-breaking-existing-app)).

Prerequisite for all subsequent work. Detailed change list: [11 §Q](11-open-questions.md#q-changes-to-feed-back-to-d1).

### Phase 1 — Core Gateway Proxy · _~3 weeks_

4 Writing operations; API key authentication + CLI; catalog + adapter + dispatcher; complete error handling; `usage_records` persistence; Docker Compose + host nginx + backups; **rate limiting + idempotency**.

> **Milestone:** Customers invoke `/v1/ielts/writing/task1/grade` with real API keys, and retry storms never trigger double token billing.

**Rate limiting and idempotency are pulled forward from Phase 3.** Rationale: Phase 1 exposes our most expensive endpoint (`writing.*.grade`) to paying traffic. Without these guards, client-side retry bugs double-bill inference costs.

Implementation overhead is negligible — rate limiting is `INCR` + `EXPIRE` (~15 lines, [04 §F.2](04-redis.md#f2-rate-limit-fixed-window-without-lua)), idempotency is one table with `ON CONFLICT` (~60 lines, [03 §E.4](03-database.md#e4-handling-idempotency-race-conditions-without-distributed-locks)). ~2 days of effort allowing Phase 1 to onboard production traffic safely.

**Decoupling from Writing deployment schedules:** AI Writing currently uses `HTTPBearer` with static tokens. In Phase 1, the dispatcher forwards a token supplied via environment variable (`DOWNSTREAM_AI_WRITING_TOKEN`); Phase 2 swaps this for self-signed internal JWTs. Phase 1 runs against AI Writing **exactly as it operates today**, needing only real response fixtures for `parseResponse`.

### Phase 2 — Identity & Security Perimeter · _2 weeks_

User assertions + JWKS fetching + SSRF protection; internal JWT minting + JWKS endpoint + key rotation; Writing returns `usage` payloads; AIHUB adopts dedicated Writing token.

> **Milestone:** Metering reflects real token metrics, and customers can only route traffic through AIHUB.

**Excludes migrating Writing into private networking.** Writing continues to serve Wispace directly. That migration moves to Phase 5 based on Wispace's product timeline.

### Phase 3 — Hardening & Observability · _1–2 weeks_

Concurrency limits, monthly quotas, circuit breakers, backoff retries; Prometheus/Loki/Grafana + alerts; load testing to baseline `rate_limit_rpm` and `max_concurrent`.

> **Milestone:** A single runaway tenant cannot degrade service for others.

_(Rate limiting and idempotency were completed in Phase 1.)_

**Total duration for Phases 1–3 ≈ 6–7 weeks**, aligning with the 1–2 month D2 delivery window.

### Phase 4 — Async Pipeline & Speaking

`jobs` table in Postgres (source of truth), BullMQ backed by existing Redis, `assets` table + Cloudflare R2 presigned uploads, `GET /v1/jobs/{id}`, webhook notifications with exponential backoff retries.

### Phase 5 — Horizontal Scale-Out

Triggered exclusively upon hitting the thresholds documented in [§N.5](#n5-triggers-to-exit-this-architecture).

<a id="n7-testing-strategy"></a>

## N.7 Testing Strategy

| Test Type                                                 | Scope                                                                                                          | Target Phase |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------ |
| Golden adapter fixtures                                   | `buildRequest` / `parseResponse` — JSON in, JSON out, **zero mocks**                                           | Phase 1      |
| Unit tests: error mapper, scope resolver, `splitEnvelope` | Pure functional logic                                                                                          | Phase 1      |
| Schema conformance                                        | All request/response schemas tested against valid and invalid payloads                                         | Phase 1      |
| **Redaction tests**                                       | Assert logs never leak API keys, assertions, or student essay text                                             | Phase 1      |
| Integration: auth pipeline                                | Invalid/expired/unauthorized keys; malformed assertion `iss`/`alg`/`exp` claims                                | Phase 2      |
| **JWKS key rotation**                                     | Validate all 5 steps in [05 §G.8](05-auth-identity.md#g8-aihub-jwks-and-key-rotation) with zero request errors | Phase 2      |
| Idempotency concurrency                                   | Concurrent duplicate requests with matching key → exactly **1** downstream execution                           | Phase 3      |
| Fault injection                                           | Downstream 500 / timeout / connection drop; simulated Redis crash                                              | Phase 3      |
| Load testing                                              | Calibrate `rate_limit_rpm` and `max_concurrent` against actual Writing capacity                                | Phase 3      |

### Do We Need Consumer-Driven Contract Testing (Pact)?

**Not yet.** With both services maintained internally, edge JSON Schema validation (`InternalResponseSchema`) combined with golden fixtures catches the exact class of bugs Pact targets, with zero added infrastructure.

Revisit if AI services are maintained by **external organizations** — where Pact provides value by breaking _their_ CI build when breaking changes are introduced.

### Postman Collection for D2

Per D1 §G, minimum 15 automated test cases. Generated directly from OpenAPI specs (which are generated from TypeBox) rather than maintained by hand.

---

# O. Architectural Decision Records (ADR)

| ADR | Title                                                | Core Rationale to Preserve                                                                   |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 001 | NestJS + Fastify; avoid Envoy/Kong as data plane     | AIHUB logic is application business logic masquerading as proxy routing                      |
| 002 | PostgreSQL for control plane; 5 tables instead of 13 | Specific pruned tables and exact triggers for reintroduction                                 |
| 003 | API key format + SHA-256 hashing                     | **Why we avoid** bcrypt/argon2 slow hashes                                                   |
| 004 | Signed User Assertions + JWKS verification           | `UNIQUE(issuer)`; strict TTL caps; algorithm allowlisting                                    |
| 005 | Internal EdDSA JWT + key rotation                    | Per-service `aud` targeting; zero-downtime 5-step rotation                                   |
| 006 | Scoped role of Redis                                 | **Fail open during Redis outages** — passing a request can be reconciled, blocking cannot    |
| 007 | Postgres-backed idempotency                          | `ON CONFLICT` replaces distributed locks; background execution prevents double token charges |
| 008 | Operation catalog in code, not DB                    | SSRF defense-in-depth + static compiler type-checking                                        |
| 009 | Pure functional adapters without I/O                 | Enables golden fixture testing without mocks                                                 |
| 010 | Meter both request counts and token metrics          | Unfinalized pricing models; historical telemetry cannot be retroactively generated           |
| 011 | Docker Compose on single VPS                         | Explicit exit triggers in [§N.5](#n5-triggers-to-exit-this-architecture)                     |
| 012 | Omission of distributed tracing in Stage A           | Retain W3C `traceparent` headers for future collector integration                            |

ADRs 003, 006, and 007 are the most vital to document first — each represents a **counter-intuitive** engineering decision that future contributors might casually "fix" back into a flawed state if the underlying reasoning is lost.

---

→ Next: [11 — Open Questions](11-open-questions.md)
