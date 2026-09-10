# 01 — Context, Current State, and Tech Stack

← [Table of Contents](README.md)

## 0. Settled Constraints

Every decision across this specification suite derives from the following 8 constraints. If a constraint changes, all decisions linked to it must be revisited.

| #   | Constraint                                                              | Primary Impact                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | **Real commercial product**, paying B2B customers                       | Metering/billing is an architectural constraint, not a secondary feature |
| 2   | Only **AI Writing** currently exists; Speaking/Reading are planned      | MVP proxies 1 service, but must prove extensibility                      |
| 3   | Team of **2–3 backend engineers, no dedicated DevOps**                  | Exclude K8s, service mesh, Kafka, Vault at this stage                    |
| 4   | **Self-hosted VPS** infrastructure                                      | Own Postgres/Redis management + take backups seriously                   |
| 5   | **Stage A**: few orgs, 10–50 RPS peak                                   | No partitioning, no autoscaling, no distributed tracing                  |
| 6   | D2 within **1–2 months**, only Writing sync; Speaking immediately after | Async contract frozen early, but implementation deferred                 |
| 7   | Customers **have strong dev teams**                                     | Asymmetric JWKS/JWT feasible from day one                                |
| 8   | **Sales model not finalized**                                           | Record both request counts and tokens from day one                       |
| 9   | **Admin API deferred** — onboard org/key via CLI/manual SQL             | CLI is production code, not disposable scripts                           |

## 0.1 Current State of AI Writing (Live Survey)

Service: `Wispace AI Writing Assistant` — `https://api-ielts-writing.aihubproduction.com`

13 endpoints, flat paths, unversioned, `HTTPBearer` authentication:

```
task 1                        task 2                      shared
/generate-question-task1      /question-generated-task2   /five-minute-grading
/writing-assistant-task1      /writing-assistant-task2    /create-micro-exercise
/vocab-suggestion-task1       /vocab-suggestion-task2     /grading-micro-exercise
/grading-feedback-task1       /grading-feedback-task2
/essay-improvement-task1      /essay-improvement-task2
```

Inputs for the 4 prioritized endpoints (question generation + grading, task 1 & task 2):

| Endpoint                    | Required fields                     | Calls model?           |
| --------------------------- | ----------------------------------- | ---------------------- |
| `/generate-question-task1`  | `topic` (optional, default `""`)    | **No** — reads from DB |
| `/question-generated-task2` | `topic`, `question_type`            | Yes                    |
| `/grading-feedback-task1`   | `question`, `url`, `topic`, `essay` | Yes                    |
| `/grading-feedback-task2`   | `question`, `topic`, `essay`        | Yes                    |

### Four findings that altered the design

1. **Canonical schema in D1 §10 did not match reality.** D1 assumed `content` / `language` / `level`; real grading requires `question` / `topic` / `essay`, and Task 1 requires `url` (chart image). There is no `language` — IELTS is always English. Must rewrite before freezing D1.
2. **Task 1 and Task 2 have fundamentally different shapes** (`url` only exists in Task 1) → split into separate endpoints, see [06 §H.1](06-routing-adapter.md#h1-operation-catalog-typed-code).
3. **`/generate-question-task1` does not invoke a model** → `usage` must be `omit`, not `0`. Precisely the case D1 §15 anticipated, and now there is a concrete example.
4. **Response schema in OpenAPI was `{}`** — completely empty. This was the remaining blocker for Phase 1, see [11 §P.1](11-open-questions.md#p1-real-response-for-grading-feedback-task12-phase-1-blocker).

### Two security issues on the live production service

- **`/five-minute-grading` has no declared security** whereas every other endpoint uses `HTTPBearer`. The service is exposed to the Internet → anyone can invoke it and the team pays for tokens.
- **The entire service is publicly accessible on the Internet — and will remain so for a while.** Writing currently serves another application (Wispace) not routed through AIHUB, so it cannot be closed off yet. The target architecture remains a private network, but that is **future work, not part of Phase 2**.

  Consequence: **The security boundary at this stage is credentials, not network isolation.** As long as AIHUB customers are never issued Writing tokens, AIHUB remains their only gateway. See [09 §M.3](09-security.md#m3-ai-writing-remains-public-conditionally-accepted-risk) for associated prerequisites.

Additionally: `url` in Task 1 is a client-supplied URL that Writing fetches directly → SSRF risk resides on Writing's side. Private IPs must be blocked there, or transitioned to `asset_id` via object storage in Phase 4.

---

## B. Recommended Tech Stack Matrix

| Layer            | Recommended                                | Alternatives Considered       | Rationale                                                                                                                                         |
| ---------------- | ------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | **Node.js 22 LTS + TypeScript**            | Go, Bun                       | At 50 RPS, AI requests are I/O-bound — Node's sweet spot. Go does not justify the learning overhead in Stage A                                    |
| Framework        | **NestJS + Fastify adapter**               | Bare Fastify, Express, Go/chi | NestJS modules map 1-to-1 with §27 target architecture; long-lived product with multiple maintainers → DI + architectural boundaries are worth it |
| Validation       | **TypeBox**                                | Zod, class-validator, raw AJV | Fastify natively executes JSON Schema (compilable). One definition generates three things: TS type + validator + OpenAPI 3.1                      |
| HTTP client      | **undici (Pool)**                          | axios, native fetch, got      | Keep-alive pool, `AbortSignal`, separated headers/body timeouts, ready for streaming                                                              |
| Primary DB       | **PostgreSQL 16**                          | MySQL, distributed SQL        | `text[]`, partial indexes, `ON CONFLICT`, JSONB, BRIN — all heavily utilized in this design                                                       |
| DB access        | **Drizzle**                                | Prisma, TypeORM, Kysely       | Keeps SQL close to the metal; Prisma struggles with array columns, `ON CONFLICT`, partial indexes                                                 |
| Cache / counters | **Redis 7**                                | Memcached, in-memory          | Requires atomic INCR + sorted sets + TTL. Never the source of truth                                                                               |
| Queue            | **None in MVP** → BullMQ in Phase 4        | RabbitMQ, Kafka, SQS          | No async use case yet. BullMQ reuses existing Redis                                                                                               |
| Object storage   | **None in MVP** → Cloudflare R2 in Phase 4 | S3, MinIO, B2                 | R2 does not charge egress — ideal for Speaking audio files                                                                                        |
| Circuit breaker  | **opossum**                                | Custom implementation         | Proper half-open state is hard to write; homegrown implementations easily flood hundreds of requests when service barely recovers                 |
| Proxy / TLS      | **Caddy**                                  | nginx, Traefik                | Automatic TLS, ~5 lines of config, zero cert renewal maintenance                                                                                  |
| Observability    | **Prometheus + Loki + Grafana**            | + Tempo/Jaeger, Datadog       | 3 containers. Drop Tempo in Stage A: with 2 services, `request_id` in logs is sufficient                                                          |
| Deployment       | **Docker Compose on 1 VPS**                | K8s, ECS, Cloud Run           | 2–3 devs without DevOps. Exit trigger documented in [10 §N.5](10-deployment-roadmap.md#n5-triggers-to-exit-this-architecture)                     |
| Secrets          | **`.env` chmod 600**                       | Vault, SOPS, Doppler          | Below threshold. Trigger in [05 §G.9](05-auth-identity.md#g9-secrets)                                                                             |

### Evaluating candidate stack from brief §14

| Item from brief                          | Verdict                | Notes                                                                                |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| TypeScript + Node.js                     | **Keep**               | —                                                                                    |
| NestJS + Fastify                         | **Keep**               | Fastify for schema-first performance, not raw RPS                                    |
| undici / native fetch                    | **Keep** (undici Pool) | Pool needed for per-downstream keep-alive                                            |
| PostgreSQL                               | **Keep**               | —                                                                                    |
| Redis                                    | **Keep**, scoped down  | Completely removed from idempotency path                                             |
| BullMQ                                   | **Defer** → Phase 4    | No async use case yet                                                                |
| S3-compatible / R2                       | **Defer** → Phase 4    | Ships with Speaking                                                                  |
| OTel + Prometheus + Grafana + Tempo/Loki | **Partial Keep**       | Omit Tempo. Keep `traceparent` propagation for future hookup                         |
| OpenAPI 3.1 + JSON Schema                | **Keep**               | Generated from TypeBox, not handwritten                                              |
| Docker + VPS                             | **Keep**               | —                                                                                    |
| Kubernetes                               | **Defer**              | Trigger in [10 §N.5](10-deployment-roadmap.md#n5-triggers-to-exit-this-architecture) |

### Three directions evaluated for the brief's primary architectural question (§18.1, §18.2)

**Direction A — Modular monolith, no separate data plane.** _(Chosen)_ Single Node app handles everything; Caddy only terminates TLS. Trade-off: Node is single-threaded, so multi-core utilization requires multiple instances — at 50 RPS this is non-issue because AI requests are I/O-bound.

**Direction B — Kong/Envoy as data plane + app as control plane.** _(Rejected)_ Kong knows nothing about `entitlement ∩ api_key_scope`, cannot verify assertions with _per-org_ JWKS, cannot map requests. Would require custom Lua plugins for each feature — essentially rewriting the app in an inferior language. Plus Kong requires its own Postgres. For 2–3 devs without DevOps, maintaining two configuration systems is fatal.

**Direction C — Go, single binary.** _(Deferred)_ Excellent deployment story, superior concurrency, lower RAM — but at 50 RPS that advantage is negligible. Loses the rich validation/OpenAPI/DI ecosystem needed for D1. Review trigger in [10 §N.5](10-deployment-roadmap.md#n5-triggers-to-exit-this-architecture).

---

## C. Architecture Diagram

```
                          Internet
                             │ :443 TLS
                        ┌────▼────┐
                        │  Caddy  │  Automatic Let's Encrypt, HTTP/2
                        └────┬────┘
                    ┌────────┴────────┐
               ┌────▼────┐       ┌────▼────┐
               │ aihub-1 │       │ aihub-2 │   Node, 2 replicas
               └────┬────┘       └────┬────┘   (zero-downtime deploy)
                    └────────┬────────┘
          ┌──────────────────┼──────────────────┐
     ┌────▼─────┐      ┌─────▼────┐      ┌──────▼──────┐
     │ Postgres │      │  Redis   │      │ Prometheus  │
     │   SoT    │      │  cache   │      │ Loki        │
     │          │      │ counter  │      │ Grafana     │
     └──────────┘      └──────────┘      └─────────────┘
                    │
       ══════════════╪══════════════  private network, unexposed
                    ▼
             ┌─────────────┐
             │ AI Writing  │  Bearer <internal JWT>, TTL 60s
             └──────┬──────┘
                    ▼
            OpenAI / Anthropic / ...   (called by AI Service; AIHUB has no visibility)
```

Async path in Phase 4:

```
  AIHUB ──► jobs (Postgres, SoT) ──► BullMQ (Redis, execution) ──► worker ──► AI Speaking
     │                                                                          │
     └──────────────── R2 (audio, presigned upload) ◄───────────────────────────┘
```

---

→ Next: [02 — Request Lifecycle](02-request-lifecycle.md)
