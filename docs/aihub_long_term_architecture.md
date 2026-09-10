# AIHUB — Long-Term Architecture

> **Purpose:** Describes the long-term target architecture where **AIHUB is the sole public API gateway**, and downstream AI services expose only **private APIs**.
>
> **How to read this document:** Most of the architecture described here has been implemented. Those sections now consist of **a single line pointing to the canonical active source** — spec, code, or contract — because when two documents describe the same mechanism, the older one will silently drift. This document retains exactly three things: **unbuilt target states**, **responsibility boundaries between AIHUB and AI Services**, and **§32 — Decision Records** cited by `aihub_deliverable_1_api_contract_schema.md`.
>
> **In case of conflict: implementation specs and code win.** Section numbers are preserved to avoid breaking `§32.x` references throughout D1.

---

# 1. Executive Summary

AIHUB is designed as a **multi-tenant AI API Gateway + Identity Broker + Downstream Adapter Layer**.

```text
Customer Backend
       │
       │ AIHUB Public API
       │ Organization API Key
       │ Signed End-user Assertion (when operation requires user context)
       ▼
┌────────────────────────────────────┐
│               AIHUB                │
│                                    │
│ Public API Contract                │
│ Organization Authentication        │
│ End-user Identity Verification     │
│ Authorization                      │
│ Rate Limit / Quota                 │
│ Routing / Dispatching              │
│ Downstream Adapter                 │
│ Usage / Metering                   │
│ Unified Response / Error           │
│ Audit / Tracing                    │
└──────────────────┬─────────────────┘
                   │
                   │ Private network
                   │ Short-lived Internal JWT
                   │ (+ optional mTLS)
                   ▼
        ┌──────────┼───────────┐
        ▼          ▼           ▼
   AI Writing  AI Speaking  AI Reading
    PRIVATE      PRIVATE      PRIVATE
        │          │           │
        ▼          ▼           ▼
   Writing DB  Speaking DB Reading DB
        │          │           │
        └──── may call one or more ────┐
                                       ▼
                                Model Providers
                          OpenAI / Anthropic / ...
```

### End-state

- Clients **never directly invoke** AI Writing / Speaking / Reading.
- AIHUB is the single public API boundary.
- AI services are reachable only within a private network.
- Clients depend strictly on AIHUB contracts.
- AIHUB encapsulates internal URLs, contracts, and implementation details of downstream services.
- Business data remains owned by each respective AI service/domain.

---

# 2. Terminology

The term **Provider** is often ambiguous, so this table establishes fixed usage across the codebase:

| Term                         | Meaning in Documentation                                                          |
| ---------------------------- | --------------------------------------------------------------------------------- |
| **Organization / Tenant**    | The B2B customer/enterprise subscribing to AIHUB                                  |
| **End User / Actor**         | The specific student/user within an Organization                                  |
| **AI Service**               | Internal downstream domain service (e.g. AI Writing, AI Speaking, AI Reading)     |
| **Model Provider**           | Underlying LLM provider invoked by an AI Service (e.g. OpenAI, Anthropic, Google) |
| **Downstream Adapter**       | AIHUB layer translating canonical contracts to AI Service contracts               |
| **Canonical Contract**       | Unified public request/response contract defined by AIHUB                         |
| **Internal Contract**        | Private boundary contract between AIHUB and downstream AI Services                |
| **Organization Entitlement** | Capabilities/services an Organization is licensed to access per plan/tier         |
| **API Key Scope**            | Specific operational permissions granted to an individual API key                 |

Short glossary for everyday engineering: [`CONTEXT.md`](../CONTEXT.md).

---

# 3. Responsibility Boundary

This section remains the primary reference when **onboarding new AI Services** — explicitly defining what AIHUB does and does not do.

## 3.1 AIHUB Responsibilities

- Public API contract definition and enforcement.
- Organization authentication via API key.
- End-user identity verification when operations require user context.
- Tier-based authorization.
- Rate limiting and monthly quotas.
- Routing to appropriate AI Services.
- Request/response payload transformation.
- Unified error normalization.
- Gateway-level latency telemetry.
- Usage aggregation and metering derived from metadata returned by AI Services.
- Audit logging and distributed tracing.
- Minting short-lived internal JWTs for downstream authentication.

## 3.2 AI Service Responsibilities

- Domain-specific educational/business logic.
- Domain persistence and database management.
- Model invocations, RAG pipelines, tool execution, and worker orchestration.
- Reporting accurate token usage, model identifiers, and processing durations.
- Enforcing downstream identity context (`org_id`, `actor_id`) when accessing user-scoped data.

## 3.3 Model Provider Responsibilities

- Raw model execution and LLM inference.
- Reporting model-specific token consumption metrics via their respective APIs.
- Emitting provider-specific errors and rate limit signals.

---

# 4. Public Boundary and Private AI Services

Target state: AI Services are reachable exclusively via the private network / AIHUB.

**This is not yet achieved, and that is a deliberate transitional choice.** `api-ielts-writing.aihubproduction.com` remains public because it currently serves an existing client app (Wispace) that does not yet route through AIHUB. It cannot be isolated until that client completes its migration.

**The actual security boundary at this stage is credentials, not network isolation.** As long as AIHUB customers are never issued Writing tokens, AIHUB remains their sole entry point.

Three conditions to keep residual risk acceptable:

1. Writing tokens are **never** issued to AIHUB customers — an operational governance rule.
2. AIHUB uses a **dedicated token**, separated from Wispace, ensuring isolated metering and revocation.
3. Every endpoint on Writing requires authentication — **currently unfulfilled**: upstream `/five-minute-grading` lacks authentication, as documented in the [security spec](superpowers/specs/2026-09-07-aihub/09-security.md).

→ Full analysis: [`09-security.md`](superpowers/specs/2026-09-07-aihub/09-security.md).

Because services will eventually reside on a private network, internal `/internal` path prefixes are not mandated.

---

# 5. Multi-tenant Model

End-user identity is **composite**, not an isolated string:

```text
(organization_id, external_user_id)
```

Org A → `user_123` and Org B → `user_123` represent two completely distinct actors. A `Team` hierarchy is unnecessary as requirements dictate a single Organization tier.

→ Implemented. Database schema: `database/migrations/0001_control_plane.sql`.

---

# 6. Organization API Key

→ **Implemented.** Key format, generation, SHA-256 hashing (and why bcrypt/argon2 were rejected), lookup pipeline, and negative caching: [`05-auth-identity.md` §G.1–G.3](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/`.

Key operational rule: **Never store Organization API Keys in frontend or mobile apps.** Keys must reside exclusively on customer backends. This is an integration requirement verified during onboarding.

→ Customer integration guide: [`integration-guide.md`](integration-guide.md) §1.

---

# 7. Environment

**Deployment hostname is the source of truth for the environment.** API keys bind to `allowed_environments` but cannot dictate the environment of an incoming request.

→ Implemented, with caveats that the `Host` header is client-provided and requires reverse-proxy validation: [`05-auth-identity.md` §G.11](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/presentation/request-environment.ts`.

---

# 8. End-user Identity

Trust model: **Signed End-user Assertion**. Signed by customer backends, verified by AIHUB via the organization's JWKS. AIHUB does not store customer user databases.

→ **Implemented.** Verification sequence, algorithm confusion defense, cross-tenant isolation via `UNIQUE(issuer)`, TTL ceilings, SSRF protection on JWKS fetches, and caching strategies: [`05-auth-identity.md` §G.4–G.6](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/application/user-assertion-verifier.ts`.

→ Customer signing instructions with Node/Python/Java samples: [`integration-guide.md`](integration-guide.md) §3.

---

# 9. Request Identity Context

Following authentication and verification, AIHUB normalizes identity into an immutable internal context: **controllers and business logic never inspect raw headers to infer identity**.

→ Implemented: `src/common/request-context/`.

---

# 10. Authorization

Evaluated at the intersection of two distinct layers:

```text
Organization Entitlement  ∩  API Key Scope  →  Effective Scope
```

→ Implemented, fail-closed: `src/modules/identity/application/authorization.ts`. Rationale and examples: [`05-auth-identity.md` §G.10](superpowers/specs/2026-09-07-aihub/05-auth-identity.md).

---

# 11. AIHUB → AI Service: Short-lived Internal JWT

AIHUB never forwards customer credentials downstream. It mints short-lived internal JWTs just-in-time, scoped per downstream service, never persisted in DB, with zero refresh tokens.

→ **Implemented.** Claims structure, EdDSA selection rationale, 5-step key rotation runbook: [`05-auth-identity.md` §G.7–G.8](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/gateway/infrastructure/configured-token-issuer.ts`.

---

# 12. Service-to-service Security

Two layers resolving two distinct concerns:

```text
Network policy / mTLS  →  Which workload/service is initiating the TCP connection?
Internal JWT           →  On behalf of which organization, actor, and scope?
```

Initial phase decision documented in [§32.10](#3210-does-the-initial-phase-need-mtls).

---

# 13. Canonical Public API Contract

Clients depend strictly on AIHUB contracts. AIHUB abstracts field names, endpoint structures, and naming quirks of downstream AI Services.

→ **The canonical contract is code, not documentation.** Schemas: `src/contracts/writing/`. Automatically generated documentation: `openapi.json` served at `GET /docs`. Detailed specification and Data Dictionary: [`aihub_deliverable_1_api_contract_schema.md`](aihub_deliverable_1_api_contract_schema.md) §10 and §20.

---

# 14. Downstream Adapter Layer

The mapping layer between canonical contracts and AI Service proprietary contracts. Adapters are **pure functions**: zero networking, zero configuration lookups, zero clock reads — allowing testing via real fixtures without mocks.

Adapters handle: field renaming, enum/value normalization, default fallback injection, nested transformations, stripping unsupported parameters, media adaptations, and proprietary response/error mapping.

The MVP uses typed code adapters rather than a dynamic rule engine.

→ **Implemented.** Interface: `src/downstream/downstream-adapter.ts`. Writing adapter: `src/downstream/writing/`. Non-negotiable rule: never guess downstream response shapes; capture production fixtures first: [`AGENTS.md`](../AGENTS.md) and [`06-routing-adapter.md`](superpowers/specs/2026-09-07-aihub/06-routing-adapter.md).

---

# 15. Internal AI Service Response Contract

> **Unachieved.** AI Writing does not currently return `usage`, `models`, or `metrics`. This is the standardized contract AIHUB expects all AI Services to adopt, serving as a prerequisite for metering and billing in §24.

Clear separation of data categories:

```text
Domain data          → Unique across Writing / Speaking / Reading
Operational metadata → Standardized across all downstream AI Services
```

```ts
interface InternalAIServiceResponse<TData> {
  data: TData;

  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    // Optional: breakdown when an operation invokes models multiple times.
    calls?: Array<{
      modelProvider?: string;
      model?: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }>;
  };

  models?: Array<{ provider?: string; name?: string }>;

  metrics?: { aiProcessingMs?: number };
}
```

Rules:

- `data` represents service-specific domain output.
- `usage`, `models`, and `metrics` represent standardized internal telemetry.
- Response adapters map `data` into canonical public responses.
- **AIHUB never guesses token usage.**

---

# 16. Token Usage Across Multiple Model Invocations

> **Unachieved**, dependent on §15.

A single operation may trigger: LLM prompt #1 + RAG retrieval + LLM synthesis #2 + evaluator scoring model. Reporting tokens for only one invocation causes inaccurate billing.

**`usage.inputTokens` / `outputTokens` / `totalTokens` represents the aggregate sum across the entire operation**, while `calls[]` provides an optional internal breakdown.

The public API exposes aggregate counts only — see [§32.7](#327-should-public-responses-expose-model-breakdowns-or-aggregate-usage-only).

---

# 17. Timing and Source of Truth

## 17.1 Definitions

Avoid the term `provider_ms` due to ambiguity between AI Services and Model Providers.

```text
total_ms
= AIHUB ingress → AIHUB egress

downstream_ms
= Duration from AIHUB initiating HTTP request to AI Service
  until response reception completes
  (includes network latency + AI Service execution)

ai_processing_ms
= Time spent exclusively on internal model inference as measured by AI Service
  (optional, excludes AIHUB ↔ AI Service network transit)

gateway_overhead_ms
≈ total_ms - downstream_ms
```

We do not assume `total_ms = gateway_ms + ai_processing_ms` — network latency and downstream service overhead sit in between.

→ The first three metrics are emitted in `meta.timing` on all responses. `ai_processing_ms` awaits §15. Implementation: `src/common/http/success-envelope.interceptor.ts`.

## 17.2 Source-of-Truth Matrix

| Field                   | Source of Truth                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `request_id`            | AIHUB                                                                                    |
| `service` / `operation` | AIHUB routing catalog                                                                    |
| `total_ms`              | AIHUB                                                                                    |
| `downstream_ms`         | AIHUB                                                                                    |
| `gateway_overhead_ms`   | AIHUB derived metric                                                                     |
| `ai_processing_ms`      | AI Service                                                                               |
| `input_tokens`          | AI Service / underlying Model Provider                                                   |
| `output_tokens`         | AI Service / underlying Model Provider                                                   |
| `total_tokens`          | AI Service aggregate sum                                                                 |
| Actual model(s)         | AI Service — **internal only**, omitted from public response                             |
| `metering_status`       | AIHUB — internal only: `complete`, `missing_usage`, `not_applicable`, `quota_unverified` |
| Public cost / billing   | AIHUB normalized usage + pricing configuration, or business rules                        |

> Endpoints that do not invoke LLMs must **omit `usage`** or return `null`; never report synthetic `0` values.

**`meta.models[]` is omitted from public responses.** Exposing underlying model names couples the public API to ephemeral implementation details: upgrading models becomes a breaking contract change, or prompts client developers to branch UI logic on model names. Model telemetry remains strictly internal.

---

# 18. Request ID and Correlation ID

Canonical `request_id` is **generated exclusively by AIHUB**; client-provided identifiers are never trusted as primary tracing keys. Clients may supply `X-Correlation-Id`, which AIHUB logs and echoes back.

→ Implemented: `src/common/request-context/request-id.ts`, echoed in `meta.correlation_id`.

---

# 19. Retries and Idempotency

→ **Implemented.** Request fingerprinting, race resolution without distributed locks, record purging on 4xx errors, background execution on timeouts with `Idempotency-Key` to prevent double charges: [`07-reliability-and-errors.md` §I.2–I.5](superpowers/specs/2026-09-07-aihub/07-reliability-and-errors.md). Code: `src/modules/idempotency/`.

Default TTL confirmed in [§32.9](#329-what-is-the-retention-ttl-for-idempotency-records).

---

# 20. Unified Error Model

Core principles: single error envelope, centralized HTTP status assignment, and internal-only logging of raw downstream errors — preventing leakage of stack traces, internal URLs, database errors, or provider secrets.

→ **Implemented.** Master matrix with Downstream Signal mappings: [`aihub_deliverable_1_api_contract_schema.md`](aihub_deliverable_1_api_contract_schema.md) §25 (US10). Error registry: `src/common/errors/error-registry.ts`. Client integration guide: [`integration-guide.md`](integration-guide.md) §8.

---

# 21. Sync vs Async Operations

> **Async pipeline unbuilt.** All 4 current operations execute synchronously.

## 21.1 Synchronous

```http
POST /v1/ielts/writing/task1/grade
→ 200 OK
```

## 21.2 Asynchronous

Suitable for audio/video processing and multi-stage evaluation pipelines:

```http
POST /v1/speaking/grade
→ 202 Accepted
```

```json
{ "data": { "job_id": "job_01JXYZ", "status": "queued" } }
```

Followed by `GET /v1/jobs/{job_id}`, or webhook notifications when supported.

> The operation catalog must declare whether **each operation is sync or async** upfront; never leave this to runtime inference after client integration.

Thresholds documented in [§32.5](#325-which-operations-are-synchronous-vs-asynchronous).

---

# 22. File / Audio / Media Input Policy

> **Unbuilt.** All 4 current operations accept `application/json` only. Object storage and presigned uploads arrive alongside Speaking.

Input standards are centralized rather than ad-hoc per service:

| Input Type           | Ingestion Mechanism                                           |
| -------------------- | ------------------------------------------------------------- |
| Text / small JSON    | `application/json`                                            |
| Small / medium media | `multipart/form-data` with explicit size ceilings             |
| Large media / audio  | Presigned upload to object storage → pass `asset_id` to AIHUB |

```json
{ "audio": { "asset_id": "asset_01JXYZ" } }
```

Base64 encoding is strongly discouraged for large media: it inflates payloads, memory consumption, and bandwidth transfer.

Thresholds documented in [§32.6](#326-should-filesaudio-use-multipart-or-asset_id--presigned-upload).

---

# 23. Routing Catalog

→ Active operations catalog resides in code: `src/catalog/operation-catalog.ts`.

Two key design decisions regarding catalog placement:

**The routing catalog belongs in code, not in the database.** Adapters are compiled code, so onboarding an AI Service requires a deployment regardless — database configuration does not avoid deployments, it merely splits source of truth.

**Downstream URLs stored in a database introduce an SSRF vector.** Anyone with database write access could point AIHUB to `169.254.169.254`, and AIHUB carries signed internal JWTs. Environment variables eliminate that attack surface.

Question generation is `organization`-scoped because prompts do not belong to specific students; grading is `user`-scoped because scores attach to specific learner profiles — following fail-closed rules in [§32.4](#324-which-operations-are-organization-scoped-vs-user-scoped).

---

# 24. Rate Limiting, Quotas, and Billing

Rate limiting and concurrency controls are **implemented** (`src/modules/gateway/`, tracked in Redis per organization). Quotas, subscriptions, metering reconciliation, and automated billing are **in progress**.

Governing principles:

- Usage and billing rely on **normalized usage reported by downstream AI Services**, never token estimation heuristics at the gateway.
- Missing usage data: **never fabricate synthetic numbers**; flag metering as incomplete; emit metrics to track contract violations; apply business rules to either allow or reject requests per tier.

Runtime handling of missing usage documented in [§32.8](#328-how-should-aihub-handle-ai-services-failing-to-return-usage-metadata). Dependent on §15.

---

# 25. Observability

`request_id` is minted by AIHUB, passed downstream, and serves as **tracing metadata — never an identity anchor**.

Required metrics:

- Request counts.
- Latency distributions (p50, p95, p99).
- `downstream_ms`.
- `ai_processing_ms` when downstream provides it.
- Error rates segmented by AI Service.
- Model provider error/throttle rates when exposed.
- Rate limit and quota rejection counts.
- Token consumption reported downstream.
- Circuit breaker state per operation.

→ Telemetry architecture and deferred distributed tracing: [`08-metering-and-observability.md`](superpowers/specs/2026-09-07-aihub/08-metering-and-observability.md).

---

# 26. Data Ownership

AIHUB retains **control-plane data**; each AI Service retains its **domain business data**.

| AIHUB (Control Plane)                                                                                     | AI Service (Business Domain)                                                            |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `organizations`, `api_keys`, `organization_identity_configs`, `idempotency_records` — **active**          | Writing evaluation attempts & results → Writing DB                                      |
| `plans`, `subscriptions`, `organization_entitlements`, `quota_configs`, `usage_records` — **in progress** | Speaking audio & scoring → Speaking DB + Object Storage; Reading analytics → Reading DB |

This boundary is an invariant: AIHUB never persists student essay bodies, and AI Services never store organization API keys.

---

# 30. Settled Architecture

> **AIHUB is a multi-tenant AI API Gateway that authenticates organizations using API keys, verifies end-user assertions for user-scoped operations, computes effective authorization from organization entitlements and API-key scopes, normalizes public API contracts, maps requests to private AI services, and propagates trusted identity downstream using short-lived internal JWTs.**

Identity chain:

```text
Organization API Key      → Organization Identity
Signed End-user Assertion → Actor Identity
AIHUB Internal JWT        → Trusted Downstream Identity (org_id + actor_id + scope)
```

Full lifecycle request flow across each stage with mapped error codes: [`02-request-lifecycle.md`](superpowers/specs/2026-09-07-aihub/02-request-lifecycle.md).

---

# 31. Roadmap

| Phase                                      | Scope                                                                                                                                     | Status                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **1 — Contract Foundation**                | Canonical contract, API key contract, identity contract, adapter interface, unified error codes, usage/timing metadata, operation catalog | Complete (except usage metadata)     |
| **2 — Core Gateway + Private AI Services** | API key middleware, routing/dispatcher, internal JWT, user assertion verifier, adapters, network policies                                 | Complete (except network isolation)  |
| **3 — Platform Capabilities**              | Rate limiting, quotas, subscriptions/plans, usage metering, billing, audit logging, idempotency                                           | Rate limiting + idempotency complete |
| **4 — Reliability & Scale**                | Circuit breakers, retries + jitter, load shedding, failovers, distributed tracing, SLO/SLI                                                | Pending                              |

Explicit triggers to evolve beyond this architecture: [`10-deployment-roadmap.md` §N.5](superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md).

---

<a id="32-hồ-sơ-quyết-định"></a>
<a id="32-open-decisions--settled"></a>

# 32. Open Decisions — Settled Records

> **Status 2026-09-07: All 10 architectural decisions settled based on Recommended Defaults.**
> Synchronized into `aihub_deliverable_1_api_contract_schema.md` and the architecture specifications under
> [`docs/superpowers/specs/2026-09-07-aihub/`](superpowers/specs/2026-09-07-aihub/README.md).
> **The option analyses below are preserved as historical decision records** — providing complete context on evaluated trade-offs if requirements shift.

Core principle: defaults prioritize **unambiguous contracts, rigorous security, minimal operational overhead at MVP, and clean forward-upgrade paths**.

---

<a id="321-api-key-dùng-x-api-key-hay-authorization"></a>
<a id="321-api-key-header-format"></a>

## 32.1 API Key: `X-API-Key` or `Authorization` Header?

### Options

**Option A — `X-API-Key`**

```http
X-API-Key: aihub_sk_live_xxx
```

**Option B — `Authorization: Bearer`**

```http
Authorization: Bearer aihub_sk_live_xxx
```

### Recommended Default

**Adopt `X-API-Key`.**

### Rationale

AIHUB handles multiple concurrent credentials: Organization API Keys, User Assertions, and internal JWTs. Using `X-API-Key` cleanly delineates the Organization credential, avoiding ambiguity with Bearer tokens across different transport boundaries.

Established standard:

```text
Client → AIHUB:
X-API-Key          = Organization credential
X-User-Assertion   = End-user identity assertion (user-scoped operations)

AIHUB → AI Service:
Authorization      = Bearer <AIHUB_INTERNAL_JWT>
```

---

<a id="322-user-assertion-dùng-jwks-url-hay-upload-public-key"></a>
<a id="322-user-assertion-jwks-url-or-uploaded-public-key"></a>

## 32.2 User Assertion: JWKS URL or Direct Public Key Upload?

### Options

**Option A — JWKS URL**

Organization registers an endpoint:

```text
https://customer.example.com/.well-known/jwks.json
```

AIHUB fetches and caches public keys by `kid` to verify incoming assertions.

**Option B — Upload / Register Public Keys Directly in AIHUB**

Organization uploads PEM public keys via management CLI or portal.

### Recommended Default

**Prioritize JWKS URL.**
**Support direct public key upload as a fallback for organizations unable to host JWKS.**

### Rationale

JWKS facilitates seamless key rotation without requiring manual key uploads in AIHUB on each cycle, aligning with B2B enterprise identity federation. Uploading keys is simpler for MVP but incurs higher operational overhead as tenant counts grow.

---

<a id="323-ttl-tối-đa-của-user-assertion"></a>
<a id="323-maximum-user-assertion-ttl"></a>

## 32.3 Maximum TTL for User Assertions?

### Options

- 1–2 minutes: High security, but vulnerable to clock skew and network jitter.
- 5 minutes: Optimal balance between security and operational stability.
- 15+ minutes: Simpler for clients, but widens replay attack exposure.

### Recommended Default

**Maximum TTL: 5 minutes.**

Enforced validation constraints:

```text
exp - iat <= 5 minutes
Permitted clock skew: ±60 seconds
jti should be supplied if replay prevention is needed on sensitive endpoints
```

### Rationale

User Assertions are ephemeral tokens minted by customer backends immediately prior to dispatching requests to AIHUB. A 5-minute lifespan accommodates network latency while tightly bounding replay risk.

---

<a id="324-operation-nào-organization-scoped-operation-nào-user-scoped"></a>
<a id="324-organization-scoped-vs-user-scoped-operations"></a>

## 32.4 Organization-Scoped vs User-Scoped Operations?

### Options

**Organization-scoped**: Requires organization identity only.

Examples:

```text
- service / catalog metadata discovery
- organization usage summaries
- organization configuration
- system health endpoints
```

**User-scoped**: Operations reading, mutating, or producing data tied to an individual end user.

Examples:

```text
- writing.grade
- writing.history
- speaking.grade
- speaking.history
- personalized feedback and evaluation results
```

### Recommended Default

**By default, all operations reading or generating end-user personal data or AI outputs are `user-scoped`.**
Only purely organizational endpoints may be marked `organization-scoped`.

The Operation Catalog must declare an explicit `identity_scope: user` or `identity_scope: organization`.

### Rationale

Fail-closed security is safer than fail-open. When uncertain whether an operation requires user identity, treat it as user-scoped; relax only when requirements explicitly justify it.

---

<a id="325-operation-nào-sync-operation-nào-async"></a>
<a id="325-sync-vs-async-operations"></a>

## 32.5 Synchronous vs Asynchronous Operations?

### Options

**Synchronous**

```text
Request → AIHUB → AI Service → Immediate Response
```

Ideal for short, predictable inference operations.

**Asynchronous**

```text
POST request
→ 202 Accepted + job_id
→ Background execution
→ Client polls GET /jobs/{job_id} or receives webhook
```

Ideal for long-running pipelines, heavy media files, or multi-step analysis.

### Recommended Default

- **Synchronous** if execution time is typically **≤ 30 seconds**.
- **Asynchronous** if latency frequently **exceeds 30 seconds**, involves large audio/video payloads, or executes multi-stage evaluation pipelines.

Initial baseline:

```text
Short essay grading (Writing)     → Synchronous
Simple text generation            → Synchronous
Long audio evaluation (Speaking)  → Asynchronous
Deep multidimensional analysis    → Asynchronous
Batch submissions                 → Asynchronous
```

### Rationale

Keeps API integration simple for fast queries while preventing hung HTTP connections, client drops, and uncontrolled retries on resource-intensive workloads.

---

<a id="326-fileaudio-dùng-multipart-hay-asset_id--presigned-upload"></a>
<a id="326-file-and-audio-multipart-vs-asset_id"></a>

## 32.6 File / Audio Input: Multipart vs `asset_id` via Presigned Upload?

### Options

**Option A — `multipart/form-data`**

Clients upload binary files directly in the API request body.

**Option B — Presigned Upload + `asset_id`**

```text
1. Client requests upload URL
2. Direct upload to cloud object storage
3. Receives asset_id
4. Invokes AIHUB operation referencing asset_id
```

### Recommended Default

**Long-term: Presigned upload + `asset_id` for audio and media assets.**
Permit `multipart/form-data` for small files (≤ 10 MB) or early prototypes.

### Rationale

Streaming large media through API Gateway instances creates severe memory and bandwidth bottlenecks. Presigned uploads isolate binary transit, improve upload retry reliability, and scale horizontally.

---

<a id="327-public-response-expose-model-breakdown-hay-chỉ-aggregate-usage"></a>
<a id="327-public-response-model-breakdown-vs-aggregate-usage"></a>

## 32.7 Public Response: Model Breakdown vs Aggregate Usage Only?

### Options

**Option A — Aggregate Usage Only**

```json
{
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 300,
    "total_tokens": 1500
  }
}
```

**Option B — Detailed Breakdown per Model Invocation**

```json
{
  "usage": {
    "total_tokens": 1500,
    "calls": [
      { "model": "...", "input_tokens": 800, "output_tokens": 200 },
      { "model": "...", "input_tokens": 400, "output_tokens": 100 }
    ]
  }
}
```

### Recommended Default

**The public API exposes aggregate usage only.**
Model breakdowns are reserved strictly for internal metering, observability, or administrative auditing APIs.

### Rationale

AIHUB abstracts downstream AI Services and Model Providers. Exposing granular model identifiers couples public contracts to internal routing, making model upgrades a breaking change and encouraging client code to branch on model names.

---

<a id="328-nếu-ai-service-không-trả-usage-metadata-thì-xử-lý-thế-nào"></a>
<a id="328-handling-missing-usage-metadata-from-ai-service"></a>

## 32.8 How to Handle AI Services Omitting Usage Metadata?

### Options

**Option A — Fail the Request Immediately**

Treat missing usage as an internal protocol violation and return an error to the client.

**Option B — Return Domain Result but Mark Metering Incomplete**

```text
- Return successful business response to client
- Record log/metric metering_status = INCOMPLETE
- Trigger internal telemetry alerts
- Enqueue background reconciliation if available
- Repeatedly delinquent services trigger automated circuit breakers
```

### Recommended Default

**Adopt Option B at runtime. Never fail a successful business evaluation solely because telemetry metadata was omitted.**

However, for `metering-critical` endpoints, integration tests must enforce `usage` presence as a mandatory gate before promoting downstream services to production.

### Rationale

Do not compromise customer educational workflows for telemetry gaps. But never drop telemetry silently — flag anomalies for alerting and billing reconciliation.

---

<a id="329-idempotency-retentionttl-là-bao-lâu"></a>
<a id="329-idempotency-retention-and-ttl"></a>

## 32.9 Idempotency Retention & TTL Window?

### Options

- 1 hour: Minimal storage overhead, but late retries cannot be deduplicated.
- 24 hours: Accommodates virtually all real-world client retries.
- 72+ hours: Safer for long-lived workflows, but increases storage retention.

### Recommended Default

**Default TTL: 24 hours for mutating/generative POST requests carrying an `Idempotency-Key`.**

Keys are scoped by:

```text
(organization_id, operation, idempotency_key)
```

Long-running async operations may override TTL up to 48–72 hours as needed.

### Rationale

24 hours provides an optimal balance between reliable replay protection and reasonable storage footprints, while allowing per-operation overrides in the catalog.

---

<a id="3210-phase-đầu-có-cần-mtls-không"></a>
<a id="3210-is-mtls-required-in-phase-1"></a>

## 32.10 Is mTLS Required in Phase 1?

### Options

**Option A — Private Network + Internal JWT**

```text
Network Security Group / VPC isolation
+
AIHUB-signed short-lived JWT
```

**Option B — Private Network + Internal JWT + mTLS**

Adds cryptographic workload identity at the transport layer.

### Recommended Default

**Phase 1: Private network isolation + strict security groups + short-lived Internal JWTs are sufficient.**
Design mTLS as a future hardening enhancement.

Upgrade to mTLS when:

```text
- Moving across VPCs, multi-cluster topologies, or multi-region networks
- Mandated by Zero Trust enterprise architecture
- Strict compliance audits require cryptographic transport identity
```

### Rationale

mTLS improves security but adds certificate distribution, rotation lifecycles, and operational overhead. Phase 1 maintains simple boundaries provided AI Services reside strictly within private networks and validate trusted internal JWTs.

---

<a id="3211-bảng-default-để-team-chốt-nhanh"></a>
<a id="3211-default-decisions-reference-table"></a>

## 32.11 Default Decisions Reference Table

| Decision Area                  | Adopted Default Standard                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| Organization API Key header    | `X-API-Key`                                                                 |
| End-user identity verification | Cryptographically signed User Assertion JWT                                 |
| Customer JWKS discovery        | JWKS URL; direct public key upload supported as fallback                    |
| User Assertion TTL ceiling     | ≤ 5 minutes                                                                 |
| Identity scoping rules         | End-user data operations → `user`; otherwise explicitly `organization`      |
| Sync vs Async boundary         | ≤ 30s expected latency → sync; long-running / audio → async                 |
| Media / Audio inputs           | Presigned object storage upload + `asset_id`; multipart for small files/MVP |
| Public usage reporting         | Aggregate total tokens only                                                 |
| Missing downstream usage       | Do not fail business response; flag incomplete + trigger alerting           |
| Idempotency record TTL         | 24 hours default                                                            |
| Downstream service auth        | Private VPC isolation + network policies + short-lived Internal JWT         |
| mTLS adoption                  | Deferred to hardening phase or specific compliance requirements             |

> When an operation requires an exception to these defaults, it must declare an explicit override in the **Operation Catalog** rather than relying on custom implementation heuristics.
