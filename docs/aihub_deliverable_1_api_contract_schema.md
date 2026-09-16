# AIHUB OPEN API — Deliverable 1: API Contract & Schema Definition

> **Scope:** This document focuses exclusively on the team's **Deliverable 1**: standardizing the API contract/schema, Provider Mapper Rules Engine, and Unified Error Codes.
>
> **Requirement Source:** Project Scope Statement / Team Deliverable 1.
>
> **Conventions:**
>
> - **[Requirement]**: Follows the team's original Deliverable 1 requirement document.
> - **[Team Design Decision]**: Supplementary architectural decisions agreed upon by the engineering team.
> - **[Implementation Proposal]**: Technical proposals to realize requirements; not original Deliverable 1 phrasing.
> - **[D2 Implementation]**: Specifications defined in D1 whose code/runtime implementation belongs to Deliverable 2 onwards.
> - **[Empirical Survey]**: Content cross-referenced against the actual live production AI Writing API.

> **Updated 2026-09-07:** Synchronized with the empirical survey of the live AI Writing API
> (`api-ielts-writing.aihubproduction.com`) and architecture designs in
> [`implementation spec index`](superpowers/specs/2026-09-07-aihub/README.md).
>
> **Current Status:** D1 is frozen. The runtime source of truth is code in
> `src/contracts/` and `src/catalog/`; `openapi.json` and Postman collections are generated
> from source. Checklists in PART E are preserved as historical snapshots for traceability, not
> active blocker lists.
>
> **Runtime scope update 2026-09-12:** AIHUB now exposes Writing grading only. The
> question-generation routes and their AIHUB adapters were removed; the upstream AI Writing
> service may still retain its private generation endpoints. The historical generation sections
> below are retained only to explain the original D1 decision and are not public AIHUB routes.
>
> Legacy placeholder schemas (`content` / `language` / `level`) were **invalid against production** —
> replaced with empirical schemas. See [§34](#34-changelog) for the changelog.

---

# 1. Deliverable 1 Objectives

## [Requirement]

D1 focuses on three core checkpoints:

1. **Standardizing endpoint structure + request/response**.
2. **Provider Mapper Rules Engine**.
3. **Unified Error Codes**.

D1 must establish a clear contract allowing D2 to construct the Core API Gateway / Reverse Proxy / Routing & Dispatcher without requiring breaking changes to the public contract.

---

# 2. D1 vs D2 Boundaries

Defines clear boundaries to prevent scope creep in D1.

| Topic                                 |          D1 — Define Contract |     D2+ — Implement Runtime |
| ------------------------------------- | ----------------------------: | --------------------------: |
| Base URL / versioning / naming        |                             ✓ |                     Consume |
| API key header format                 |                             ✓ |      Middleware + DB lookup |
| Organization / API key schema         |                             ✓ |       Persistence / runtime |
| Request / response schemas            |                             ✓ |  Validation / serialization |
| End-user assertion contract           | ✓ (if required by capability) |     Verification middleware |
| Provider / downstream mapping rules   |                             ✓ |        Adapter + dispatcher |
| Unified error catalog                 |                             ✓ |    Exception / error mapper |
| Timing / usage metadata contract      |                             ✓ |           Timers + metering |
| Internal AI Service response contract |                             ✓ |   Downstream implementation |
| Rate limit / quota algorithms         |              Reserve contract |       Future implementation |
| Internal JWT AIHUB → AI Service       |           Target architecture | Future implementation phase |

> **Team Design Decision:** API keys must be **defined upfront in D1** to stabilize the public contract, without requiring D1 to implement full authentication/billing runtimes.

---

# 3. Terminology

The term **Provider** in Deliverable 1 often causes confusion.

Throughout this document:

| Term                      | Meaning                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| **AI Service**            | Downstream domain service behind AIHUB (AI Writing, AI Speaking, AI Reading)                     |
| **Model Provider**        | Upstream foundational provider (OpenAI, Anthropic, Google, etc.) invoked by an AI Service        |
| **Provider Mapper Rules** | Team requirement name; technically represents **Downstream AI Service Adapters / Mapping Rules** |
| **Canonical Contract**    | Unified public contract exposed by AIHUB                                                         |

> Never overload `provider` to mean both AI Writing and OpenAI in the same schema.

---

# PART A — API CONTRACT & SCHEMA DEFINITION

# 4. US01 — Base URL Standardization

## [Requirement]

Clients require a unified, intuitive, and easy-to-remember Base URL structure.

## [Implementation Proposal]

```text
Production: https://api.aihub.example.com/v1
Staging:    https://staging-api.aihub.example.com/v1
Dev:        https://dev-api.aihub.example.com/v1
Sandbox:    https://sandbox-api.aihub.example.com/v1
```

### Environment Source of Truth

**Settled proposal:** Hostname / deployment URL is the sole source of truth for `dev/staging/prod/sandbox`.

```text
api.aihub...          → production
staging-api.aihub...  → staging
dev-api.aihub...      → development
sandbox-api.aihub...  → sandbox
```

API keys bind to `allowed_environments`, but environment is never self-asserted by clients via request headers.

---

# 5. US02 — API Naming Scheme Standardization

## [Requirement]

URLs must cleanly distinguish the AI capability requested by the client.

## [Implementation Proposal]

```text
/v{version}/{capability}/{task}/{resource-or-action}
```

Current AIHUB Writing operations:

```http
POST /v1/ielts/writing/task1/grade         # Grade Task 1 essay
POST /v1/ielts/writing/task2/grade         # Grade Task 2 essay
```

Future phases:

```http
POST /v1/speaking/grade
GET  /v1/jobs/{job_id}
POST /v1/reading/analyze
```

Never expose internal AI Service / Model Provider naming to the public API.

## [Empirical Survey] Rationale for Splitting `task1` / `task2`

AI Writing hosts dedicated endpoints for each task with **divergent input requirements**: Task 1 grading mandates a chart image (`url` downstream), whereas Task 2 forbids it.

Combining both into a single `POST /v1/ielts/writing/grade` endpoint with discriminator fields forces `oneOf` unions into schemas, producing confusing validation errors and degraded SDK generation. Splitting them gives each endpoint an exact schema and allows independent pricing and permission scoping.

Furthermore, adapters encapsulate downstream inconsistencies: AI Writing named its endpoints `/generate-question-task1` versus `/question-generated-task2` — the public API maintains perfect symmetry.

---

# 6. US03 — Request Standards

## [Requirement]

Requests must supply sufficient context to identify:

- Organization;
- Service;
- Environment.

## [Team Design Decision] Organization API Keys from Day One

Clients are never asked to send three unverified headers that AIHUB blindly trusts.

Instead:

| Context Requirement  | Resolution Source in AIHUB |
| -------------------- | -------------------------- |
| Organization         | **Organization API Key**   |
| Service / Capability | **Endpoint URL Path**      |
| Environment          | **Deployment Hostname**    |

Resolution Flow:

```text
X-API-Key
   ↓
Organization

/v1/ielts/writing/task1/grade
   ↓
Service    = writing
Task       = task1
Operation  = writing.task1.grade

api.aihub... / staging-api.aihub... / sandbox-api.aihub...
   ↓
Environment
```

This fulfills US03 while preventing spoofing of identity metadata.

## 6.1 Proposed Request Headers

```http
POST /v1/ielts/writing/task1/grade
X-API-Key: aihub_sk_xxxxx
X-User-Assertion: <signed-jwt>       # Only on user-scoped operations
X-Correlation-Id: customer-req-123  # Optional
Idempotency-Key: <uuid>             # If required by operation
Content-Type: application/json
```

### Never Use Client-Supplied `X-Request-Id` as Primary Tracing ID

AIHUB autonomously generates:

```text
request_id = req_01JXYZ
```

Clients correlating with their internal systems should supply:

```http
X-Correlation-Id: customer-request-123
```

---

# 7. API Key Contract — D1 Define, D2 Implement

## [Team Design Decision]

D1 settles the minimal control-plane contract:

```text
organizations
- id
- name
- status

api_keys
- id
- organization_id
- key_prefix
- key_hash
- status
- allowed_environments
- created_at
- expires_at
- last_used_at
```

Governing rules:

- Raw API keys are never persisted in the database.
- Raw keys are displayed exactly once upon generation.
- The API key establishes organization identity.
- API keys bind to allowed deployment environments.
- Future scopes, rate limits, and quotas can be added without altering the public credential contract.

## [D2 Implementation]

- Middleware extracts the API key header;
- Computes SHA-256 hash and performs index seek in DB;
- Validates key status, expiry, and environment permissions;
- Attaches authenticated organization context to the request pipeline.

---

# 8. End-user Identity Contract

The initial Deliverable 1 draft focused on organization, service, and environment. When APIs manipulate user-specific data, identity contracts must be locked in early to prevent reliance on raw `X-User-Id` headers.

## [Implementation Proposal] Signed User Assertion

The customer backend sends:

```http
X-User-Assertion: <SIGNED_JWT>
```

Example payload:

```json
{
  "iss": "org_123",
  "sub": "student_456",
  "aud": "aihub",
  "iat": 1788350000,
  "exp": 1788350300,
  "jti": "ua_01JXYZ"
}
```

`jti` is **required**, not optional.

Currently, AIHUB only logs `jti` and does not yet check for replay — with a 5-minute TTL and backend-to-backend TLS connections, an adversary capable of intercepting traffic would already possess the API key, so assertion replay is a much smaller concern than the cost of maintaining a Redis set for every request.

However, the contract must require `jti` **from day one**: when replay protection needs to be enabled for a sensitive organization, it only requires an additional `SET NX` check on the AIHUB side — without requiring every customer to update their code.

Trust model:

```text
Customer Backend Private Key
        ↓ sign
User Assertion
        ↓
AIHUB
        ↓ verify using Organization Public Key/JWKS
Trusted actor = student_456
```

AIHUB must verify in this exact order (cheapest checks first, cryptography last):

```text
1. alg ∈ allowed_algorithms of the org    # BLOCK 'none', block HS* when key is RSA/EC
2. aud == "aihub"
3. iss == registered issuer for the org derived from the API key
4. exp > now - 60s   ∧   iat < now + 60s   # clock skew ±60s
5. (exp - iat) <= max_assertion_ttl_seconds # default 300s
6. jti is present
7. signature is valid according to org JWKS
```

The three constraints below are **additions compared to the initial D1 draft**, each mitigating a specific attack vector:

**Step 1 — Prevent algorithm confusion.** This is a classic JWT vulnerability: the token declares `alg: HS256`, and the library uses the RSA public key as the HMAC secret — since anyone can obtain the public key, tokens can be freely forged. Only accept `alg` within the allowlist _of that specific org_, and ensure the key type strictly matches the algorithm.

**Step 3 — Prevent cross-tenant impersonation.** If the API key indicates org A but the assertion declares `iss` belonging to org B → `403`. In addition, the `issuer` column in `organization_identity_configs` must be **globally UNIQUE**, otherwise org B could register org A's `iss` from the outset and sign assertions impersonating A's students.

**Step 5 — Prevent indefinitely lived assertions.** Without a TTL limit, a customer could sign an assertion with `exp` 5 years into the future and embed it into a mobile app — turning the assertion into a leaked permanent API key. `max_assertion_ttl_seconds` is stored in the database and can be relaxed for specific orgs when justified.

If a client sends an assertion for an organization-scoped operation: **it must still be verified**. If present, it must be valid — ignoring a broken assertion paves the way for silent integration bugs.

### Organization Identity Config — Minimum Contract

```text
organization_identity_configs
- organization_id
- issuer                      globally UNIQUE
- jwks_url                    primary
- public_keys_jwks            fallback when org cannot host a JWKS endpoint
- allowed_algorithms          default {RS256, ES256}
- max_assertion_ttl_seconds   default 300
- status
```

Constraint: must have at least one of `jwks_url` or `public_keys_jwks`.

### Does AIHUB need a complete user database?

Not mandatory. AIHUB can trust the Organization to verify end-users via signed assertions.

### The Operation Catalog must explicitly specify

```text
organization-scoped → assertion optional
user-scoped         → assertion required
```

---

# 9. Authorization Contract

Distinguish between:

```text
Organization Entitlement
          ∩
     API Key Scope
          ↓
    Effective Scope
```

Example:

```text
Organization plan: writing + speaking
API Key A: writing.grade only

Effective scope of key A:
writing.grade
```

D1 defines operation → required scope; runtime enforcement can be implemented in D2/later.

---

# 10. Canonical Request Schema

## [Requirement]

AIHUB must define key/value, datatype, constraints, and allowed values.

## [Empirical Findings]

The initial D1 draft used `{ content, language, level }` as an example. Cross-checking against real AI Writing shows that this schema **cannot be used**:

- grading requires `question`, `topic`, `essay` — not a generic `content` field;
- Task 1 strictly requires a chart image;
- **no `language` for the essay itself** — IELTS is always in English;
- `level` is only used for writing-assistant, not for grading.

Below is the actual schema.

## Grading — Task 1

`POST /v1/ielts/writing/task1/grade`

```json
{
  "question": "The chart below shows the total number of minutes of telephone calls in the UK...",
  "chart_type": "Bar Chart",
  "essay": "The bar chart illustrates...",
  "image_url": "https://s3.wispace.app/ielts-task1/ca95bd4ab522946d",
  "language": "vi"
}
```

| Field        | Type   | Required | Constraints         | Description              |
| ------------ | ------ | -------: | ------------------- | ------------------------ |
| `question`   | string |      yes | 1..2000 chars       | Prompt / question text   |
| `chart_type` | enum   |      yes | 7 values, see below | Chart type of prompt     |
| `essay`      | string |      yes | 1..20000 chars      | Student essay submission |
| `image_url`  | string |      yes | URI, ≤2000 chars    | Prompt chart/table image |
| `language`   | enum   |       no | `vi` (default)      | Feedback language        |

### `chart_type` — 7 values, CASE-SENSITIVE

```text
Bar Chart      Line Graph      Pie Chart      Table
Map            Process Diagram Multiple Graphs
```

Empirically probed directly against the live API on 2026-09-07. Lowercase `"bar chart"` causes downstream to return 500; `"Process"`, `"Diagram"`, `"Bar Graph"`, `"Mixed Chart"` do not exist.

> **Why it is not named `topic`:** downstream names this field `topic`, but its real value is **chart type**, not subject matter — sending `"environment"` yields a 500. Retaining `topic` in the public API would propagate this exact confusion to customers. The adapter maps `chart_type` back to downstream `topic`.

## Grading — Task 2

`POST /v1/ielts/writing/task2/grade`

```json
{
  "question": "Some people believe that university education should be free...",
  "topic": "education funding",
  "essay": "In recent decades, the debate over..."
}
```

| Field      | Type   | Required | Constraints    | Description                    |
| ---------- | ------ | -------: | -------------- | ------------------------------ |
| `question` | string |      yes | 1..2000 chars  | Prompt / question text         |
| `topic`    | string |      yes | 1..200 chars   | Actual topic, e.g. `education` |
| `essay`    | string |      yes | 1..20000 chars | Student essay submission       |
| `language` | enum   |       no | `vi` (default) | Feedback language              |

> Task 2 **does not accept** `image_url` and **does not accept** `chart_type`. Passing them results in `400 INVALID_REQUEST`.
>
> Unlike Task 1: here `topic` truly means **topic / theme** (`education`, `technology`...), not a chart type.

### Regarding `language`

Currently downstream only generates feedback in **Vietnamese**, so the enum temporarily only contains `vi`. The contract reserves this field so that when AI Writing supports `en`, only an enum relaxation is needed — **relaxing constraints is non-breaking, tightening is breaking**, so this order is safe.

The response always echoes `language` so clients know the feedback language.

## Historical Question Generation — Task 1 and Task 2 (not exposed by AIHUB)

`POST /v1/ielts/writing/task1/questions`

```json
{ "chart_type": "Bar Chart" }
```

| Field        | Type | Required | Constraints                                    |
| ------------ | ---- | -------: | ---------------------------------------------- |
| `chart_type` | enum |       no | 7 values above; **omitted = random selection** |

Omitting it is the most common path and always succeeds. Passing a value outside the enum is rejected by AIHUB with `400` before reaching downstream — otherwise, downstream returns `500` for an error that should have been `404`.

`POST /v1/ielts/writing/task2/questions`

```json
{ "topic": "technology", "question_type": "opinion" }
```

| Field           | Type   | Required | Constraints                                                                         |
| --------------- | ------ | -------: | ----------------------------------------------------------------------------------- |
| `topic`         | string |      yes | 1..200 chars                                                                        |
| `question_type` | enum   |      yes | `opinion`, `discussion`, `problem_solution`, `advantages_disadvantages`, `two_part` |

> **To be finalized:** downstream currently accepts `question_type` as a free string. The enum above lists 5 standard IELTS Task 2 types; the exact list of values genuinely accepted by AI Writing must be confirmed before tightening into an enum, otherwise valid requests may be blocked. Temporarily, this can remain a string in the initial phase and be tightened later — **relaxing is non-breaking, tightening is breaking**.

## General Rules for All Canonical Requests

- `additionalProperties: false` — fields outside the contract return `400`, never silently stripped (see §18).
- No field conveys user identity. `actor_id` travels in the User Assertion, not in the body.

---

# 11. Media / File Input Contract

Speaking/audio input is prone to ambiguity if specified only through JSON examples.

## [Implementation Proposal]

D1 must explicitly specify the content type by operation.

### Text operations

```http
Content-Type: application/json
```

### Small/medium media

May use:

```http
Content-Type: multipart/form-data
```

with explicit size/type limits.

### Large media

Prefer pre-uploading and passing a reference:

```json
{
  "audio": {
    "asset_id": "asset_01JXYZ"
  }
}
```

Base64 is strongly discouraged for large files.

### Operation Catalog Requirements

| Operation             | Input mode          | Max body | Allowed types      |
| --------------------- | ------------------- | -------: | ------------------ |
| `writing.task1.grade` | JSON                |   256 KB | text + `image_url` |
| `writing.task2.grade` | JSON                |   256 KB | text               |
| `speaking.grading`    | multipart/form-data |    25 MB | `audio/*`          |

Body limits are configured **per operation**, not as a single global threshold.

Exceeding the limit → `413 PAYLOAD_TOO_LARGE`.

### Task 1 `image_url`

The client provides a URL, and **AI Writing** is the service fetching the image. This means the SSRF attack surface resides on the Writing service side, not in AIHUB. AI Writing must block private IPs / loopback / `169.254.169.254` during image fetching.

In the long run, this should transition to `asset_id` alongside Speaking's object storage, eliminating arbitrary client-supplied fetch URLs entirely.

### Speaking (Phase 4)

Per the default decided in `aihub_long_term_architecture.md` §32.6: presigned upload + `asset_id` is the primary path, with `multipart/form-data` reserved for small files (suggested ≤ 10 MB). The exact max size and allowed MIME list will be locked during Phase 4 — not required for D1 because the async envelope is already fixed (§12).

---

# 12. Sync vs Async Contract

D1 must declare whether each operation is sync or async.

## Sync

```http
POST /v1/ielts/writing/task1/grade
→ 200 OK
```

## Async

```http
POST /v1/speaking/grade
→ 202 Accepted
```

```json
{
  "data": {
    "job_id": "job_01JXYZ",
    "status": "queued"
  }
}
```

Followed by:

```http
GET /v1/jobs/{job_id}
```

> D1 does not necessarily have to implement the async job engine immediately, but it must freeze the contract for long-running capabilities to avoid future breaking changes.

---

# 13. US04 — Unified Response Standard

## [Requirement]

Clients receive responses containing request metadata and quantitative metrics such as tokens and timing.

## 13.1 Metadata AIHUB Knows Natively

- `request_id`;
- `correlation_id` if provided by client;
- `service` / `operation`;
- `total_ms`;
- `downstream_ms`;
- `gateway_overhead_ms`.

## 13.2 Metadata Required from the AI Service

When the AI Service makes model calls directly, AIHUB cannot know natively:

- `input_tokens`;
- `output_tokens`;
- `total_tokens`;
- `ai_processing_ms`;
- aggregate usage across all model calls made by one operation.

AIHUB **does not re-tokenize requests to estimate tokens**.

---

# 14. Timing Definitions — Locked to Avoid Misinterpretation

Avoid using `provider_ms` because it could be interpreted as either AI Service or Model Provider duration.

Recommended definitions:

```text
total_ms
= AIHUB ingress → AIHUB egress

downstream_ms
= AIHUB initiates HTTP call to AI Service
  → AIHUB finishes receiving downstream response

ai_processing_ms
= AI Service internal processing time
  (optional)

gateway_overhead_ms
≈ total_ms - downstream_ms
```

Do not assume:

```text
total_ms = gateway_overhead_ms + ai_processing_ms
```

because `downstream_ms` also includes network and service overhead.

---

# 15. Internal AI Service Response Contract

D1 must freeze the minimum private contract required to make US04 feasible.

## 15.1 Distinguishing Standardized vs Service-Specific Fields

```text
data
→ service-specific

usage / metrics
→ standardized common metadata
```

Example:

```json
{
  "data": {
    "band": 7.5,
    "comment": "Good structure"
  },
  "usage": {
    "input_tokens": 820,
    "output_tokens": 310,
    "total_tokens": 1130
  },
  "metrics": {
    "ai_processing_ms": 790
  }
}
```

### Usage aggregation rule

When an operation invokes models multiple times:

```text
usage.input_tokens
usage.output_tokens
usage.total_tokens
```

must represent the **aggregate across the entire operation**.

Model identity and per-call breakdown are not part of the current AI Service contract.

### Endpoints Not Calling Models

`usage` must be **omitted**, never faked with `0` tokens or returned as `null`.

A concrete real-world example: AI Writing's `/generate-question-task1` **reads questions from a database** without calling a model at all. Conversely, `/question-generated-task2` invokes a model. Two operations that look similar in the public API have fundamentally different metering characteristics — this is precisely the case this rule exists to address.

### `metering_status` — Distinguishing "No Usage" from "Lost Usage"

Omitting `usage` is not enough, because two very different reasons can produce the same result. AIHUB must record the reason:

| Value              | Meaning                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `complete`         | AI Service returned complete usage telemetry                                                                   |
| `missing_usage`    | Operation **does** call models, but AI Service failed to return usage → **contract violation**, alert required |
| `not_applicable`   | Operation does not call models (e.g. Task 1 question generation) → expected normal behavior                    |
| `quota_unverified` | Quota could not be verified at that moment (e.g. Redis unavailable), request was allowed through               |

This field is **internal** and never exposed in the public response. It dictates whether token-based billing can be safely activated in the future: as long as `missing_usage` remains greater than zero, token billing cannot be used reliably.

Runtime handling follows the default decided in `aihub_long_term_architecture.md` §32.8: **do not fail business responses** merely due to missing telemetry, but trigger alerts and reconcile.

### [Empirical Findings] This Contract is Additive — Breaking No Existing Apps

AI Writing is currently running in production with live applications consuming it. Wrapping responses in `{ "data": ... }` would be a **breaking change** for those legacy clients.

However, **adding** top-level fields does not break existing clients — they simply ignore unrecognized keys. Therefore, the requirement on the AI Service is strictly additive:

```jsonc
// keep all existing fields intact, ONLY ADD 2 fields:
{
  "...": "...",
  "usage": { "input_tokens": 820, "output_tokens": 310, "total_tokens": 1130 },
  "metrics": { "ai_processing_ms": 790 },
}
```

AIHUB accepts **both representations** — flat or wrapped in `data` — during the transition phase:

```ts
function splitEnvelope(body) {
  const { usage, metrics, data, ...rest } = body ?? {};
  return { data: data ?? rest, usage, metrics };
}
```

This allows AI Service and AIHUB teams to work in parallel without blocking each other. Once all AI Services adopt the standard envelope, the fallback branch can be retired.

If a response cannot be parsed in either shape → `502 AI_SERVICE_CONTRACT_VIOLATION` (§25), **not** `AI_SERVICE_ERROR` — these two cases must be distinguished because their remediation paths are entirely different.

---

# 16. Unified Public Response Example

AIHUB maps the service-specific `data` into canonical public `data`, then enriches it with metadata:

```json
{
  "data": {
    "overall_band": 7.0,
    "language": "vi",
    "criteria": [
      {
        "id": "task_achievement",
        "name": "Task Achievement",
        "band": 7,
        "band_reason": "'Covers requirements' — Bài viết đáp ứng yêu cầu đề, có overview rõ...",
        "strengths": ["Overview rõ ràng, nêu đúng 2 xu hướng chính..."],
        "improvements": [
          "Đề cập sai dữ liệu ở chi tiết 'a more than twentyfold increase'"
        ]
      },
      {
        "id": "coherence_cohesion",
        "name": "Coherence and Cohesion",
        "band": 7,
        "...": "..."
      },
      {
        "id": "lexical_resource",
        "name": "Lexical Resource",
        "band": 7,
        "...": "..."
      },
      {
        "id": "grammatical_range_accuracy",
        "name": "Grammatical Range and Accuracy",
        "band": 7,
        "...": "..."
      }
    ],
    "summary": "Bài viết đạt mức tốt và rất ổn định ở cả bốn tiêu chí...",
    "suggestions": [
      "Tiếp tục giữ cách viết overview ngắn gọn nhưng bao quát 2 xu hướng chính..."
    ],
    "next_steps": [
      "Luyện thêm 5–10 bài biểu đồ cột/đường có 3 nhóm dữ liệu..."
    ],
    "annotations": [
      {
        "criterion": "task_achievement",
        "issue": "inaccurate_data_support",
        "quote": "a more than twentyfold increase",
        "explanation": "Cách diễn đạt này hơi phóng đại so với số liệu trên biểu đồ..."
      }
    ]
  },
  "meta": {
    "request_id": "req_01JXYZ",
    "correlation_id": "customer-req-123",
    "service": "writing",
    "operation": "writing.task1.grade",
    "usage": {
      "input_tokens": 820,
      "output_tokens": 310,
      "total_tokens": 1130
    },
    "timing": {
      "downstream_ms": 18267,
      "ai_processing_ms": null,
      "gateway_overhead_ms": 30,
      "total_ms": 18297
    }
  }
}
```

> The above example is constructed from a **real response** captured on 2026-09-07; full fixtures reside in `test/fixtures/ai-writing/`.
> `meta.usage` represents telemetry that AI Writing **does not yet return** — currently `metering_status` will be `missing_usage`.

### Five Key Decisions in the Shape of `data`

**`criteria` is an array, not 4 fixed fields — empirically confirmed.** The real response uses the key `1_task_achievement` for Task 1 and `1_task_response` for Task 2; the other three criteria are identical. Using fixed fields would force two different response shapes between tasks and require clients to write two separate rendering branches. An array with stable `id` + display `name` enables reuse of a single component. **The order of array elements is a guaranteed contract**, following downstream's numerical prefix.

**`band` and `overall_band` are multiples of 0.5**, within the range 0..9. This constraint accepts both `7` (int) and `6.5` (float) — downstream currently returns `overall_band` as a float but criterion `band` as an int, so **do not strictly enforce a float type**, which would mistakenly reject valid responses.

**`improvements` is an empty array when there is nothing to improve.** Downstream returns the sentinel `["None specified"]`; the adapter strips it. Clients check `length === 0` rather than string-matching English text.

**`annotations` are commentary on excerpts, NOT replacement suggestions.** The initial D1 draft had `corrections` with `{original, suggestion}` — an incorrect assumption. The actual data is `{quote, explanation}`: observations regarding an excerpt in the essay, with no replacement text provided. Naming this `corrections` would mislead clients into building "click-to-replace" UIs for data that does not support it.

**AIHUB does not compute `overall_band`.** Overall band rounding rules are IELTS business logic belonging to the AI Service. The gateway only validates domain boundaries.

### Three Items Present in Downstream but EXCLUDED from Public Responses

| Excluded                       | Rationale                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `data.coT`                     | Internal chain-of-thought (`layer1_errors`, `layer2_matching`, `layer3_calibration`). Exposes prompt engineering and invites prompt extraction attacks |
| `evaluation.*.feedback_detail` | Merely a stringified flattening of `data_micro`. `annotations` preserves the structured representation                                                 |
| `data_micro.*.*.question_type` | Task 1 returns `bar_chart`, Task 2 returns `education` — two contradictory semantics under the exact same property name                                |

### Model Identity Is Not Part of the Provider Contract

The initial D1 draft included `meta.models[]`. This **conflicted with `aihub_long_term_architecture.md` §32.7**, which established that public APIs only expose aggregate usage while model details remain internal.

Rationale for upholding §32.7: AIHUB's objective is to abstract away AI Services and Model Providers. Exposing specific model names ties the public contract to behind-the-scenes implementation details — changing models or providers down the road would become a breaking change, or worse, clients might write brittle logic branching on specific model names.

AI Services do not return model identity under the current internal contract. AIHUB therefore does not require or expose `models[]`; aggregate token usage and `metrics.ai_processing_ms` are the only provider telemetry fields required for metering.

## Source-of-truth matrix

| Field                             | Source of truth                             |
| --------------------------------- | ------------------------------------------- |
| `meta.request_id`                 | AIHUB                                       |
| `meta.correlation_id`             | Client-supplied, AIHUB preserves            |
| `meta.service` / `operation`      | AIHUB                                       |
| `meta.timing.total_ms`            | AIHUB                                       |
| `meta.timing.downstream_ms`       | AIHUB                                       |
| `meta.timing.gateway_overhead_ms` | AIHUB derived                               |
| `meta.timing.ai_processing_ms`    | AI Service                                  |
| `meta.usage.*`                    | AI Service / underlying Model Provider      |
| model identity                    | Not part of the current AI Service contract |
| `metering_status`                 | AIHUB — **internal only**                   |

---

<a id="phần-b--provider-mapper-rules-engine"></a><a id="part-b--provider-mapper-rules-engine"></a>

# PART B — PROVIDER MAPPER RULES ENGINE

<a id="17-tổng-quan"></a><a id="17-overview"></a>

# 17. Overview

## [Requirement]

AIHUB requires mapping between the unified client contract and the proprietary contract of each AI Provider/AI Service.

## Finalized Terminology

In implementation, this layer is named **Downstream Adapter** to prevent confusion with Model Providers.

```text
AIHUB Canonical Contract
          ↕
Downstream AI Service Contract
```

Pipeline:

```text
Client Request
      ↓
Canonical DTO Validation
      ↓
Downstream Resolver
      ↓
Request Adapter
      ↓
AI Service
      ↓
Internal AI Service Response
      ↓
Response Adapter
      ↓
Canonical AIHUB Response
```

---

<a id="18-us05--paramvalue-không-hỗ-trợ"></a><a id="18-us05--unsupported-parameters-and-values"></a>

# 18. US05 — Unsupported Parameters and Values

## [Requirement]

AIHUB must reject or sanitize unsupported parameters and values.

## [Implementation Proposal]

Distinguish between:

```text
Unknown field outside public contract
→ Reject 400

Valid field in canonical contract
unsupported by current downstream AI Service
→ Adapter transforms or drops according to explicit rules
```

Never silently drop unknown client fields, as this conceals integration bugs.

---

<a id="19-us06--map-service--scope--ai-service"></a><a id="19-us06--mapping-service--scope--ai-service"></a>

# 19. US06 — Mapping Service → Scope → AI Service

## [Requirement]

AIHUB maps the requested service to system authorization scopes and downstream AI Services.

## [Implementation Proposal]

| Public Endpoint                        | Operation               | Required Scope    | AI Service  | Downstream path                 |
| -------------------------------------- | ----------------------- | ----------------- | ----------- | ------------------------------- |
| `POST /v1/ielts/writing/task1/grade`   | `writing.task1.grade`   | `writing.grade`   | AI Writing  | `/grading-feedback-task1`       |
| `POST /v1/ielts/writing/task2/grade`   | `writing.task2.grade`   | `writing.grade`   | AI Writing  | `/grading-feedback-task2`       |
| `POST /v1/ielts/speaking/grading`      | `speaking.grading`      | `speaking.grade`  | AI Speaking | `/api/v1/speaking/grading`      |
| `POST /v1/ielts/speaking/grading-json` | `speaking.grading-json` | `speaking.grade`  | AI Speaking | `/api/v1/speaking/grading-json` |
| `POST /v1/reading/analyze`             | `reading.analyze`       | `reading.analyze` | AI Reading  | _(future)_                      |

Both Writing grading tasks share the `writing.grade` scope because customers purchase Writing grading, not individual tasks. Question generation is no longer an AIHUB capability.

The `Downstream path` column is **internal**, provided here solely for implementation reference. The public contract never leaks it.

Authorization:

```text
Required Scope
      ↓
Organization Entitlement ∩ API Key Scope
      ↓
Allowed / Denied
```

---

<a id="20-us07--data-dictionary"></a>

# 20. US07 — Data Dictionary

## [Requirement]

Every request and response key must define clear semantics, datatypes, constraints, and allowed values.

### Request — Grading

| Field        | Type   |        Required | Constraints              | Description              |
| ------------ | ------ | --------------: | ------------------------ | ------------------------ |
| `question`   | string |             yes | 1..2000 chars            | Prompt / question text   |
| `chart_type` | enum   | **Task 1 only** | 7 values, case-sensitive | Chart type               |
| `topic`      | string | **Task 2 only** | 1..200 chars             | Topic / theme            |
| `essay`      | string |             yes | 1..20000 chars           | Student essay submission |
| `image_url`  | string | **Task 1 only** | URI, ≤2000 chars         | Prompt chart image       |
| `language`   | enum   |              no | `vi`                     | Feedback language        |

### Historical Request — Question Generation (not exposed by AIHUB)

| Field           | Type   |                  Required | Constraints                                                                         |
| --------------- | ------ | ------------------------: | ----------------------------------------------------------------------------------- |
| `chart_type`    | enum   | **Task 1 only**, optional | 7 values; omitted = random selection                                                |
| `topic`         | string |      **Task 2 only**, yes | 1..200 chars                                                                        |
| `question_type` | enum   |      **Task 2 only**, yes | `opinion`, `discussion`, `problem_solution`, `advantages_disadvantages`, `two_part` |

### Response — Grading

| Field                             | Type    |                 Required | Constraints             | Description                                | Source                            |
| --------------------------------- | ------- | -----------------------: | ----------------------- | ------------------------------------------ | --------------------------------- |
| `data.overall_band`               | number  |                      yes | 0..9, multiple of 0.5   | Overall band score                         | AI Service                        |
| `data.language`                   | enum    |                      yes | `vi`                    | Feedback language                          | AIHUB                             |
| `data.criteria[]`                 | array   |                      yes | exactly 4 elements      | 4 IELTS criteria                           | AI Service → Adapter              |
| `data.criteria[].id`              | enum    |                      yes | see below               | Criterion identifier                       | Adapter                           |
| `data.criteria[].name`            | string  |                      yes | —                       | Display name                               | Adapter                           |
| `data.criteria[].band`            | number  |                      yes | 0..9, multiple of 0.5   | Criterion score                            | AI Service                        |
| `data.criteria[].band_reason`     | string  |                      yes | —                       | Band descriptor quotation + explanation    | AI Service                        |
| `data.criteria[].strengths[]`     | array   |                      yes | may be empty            | Strengths                                  | AI Service                        |
| `data.criteria[].improvements[]`  | array   |                      yes | may be empty            | Areas for improvement                      | AI Service → Adapter sentinel cut |
| `data.summary`                    | string  |                      yes | —                       | Overall evaluation summary                 | AI Service                        |
| `data.suggestions[]`              | array   |                      yes | may be empty            | Actionable suggestions                     | AI Service                        |
| `data.next_steps[]`               | array   |                      yes | may be empty            | Recommended follow-up practice             | AI Service                        |
| `data.annotations[]`              | array   |                      yes | may be empty            | Commentary on specific excerpts            | AI Service → Adapter              |
| `data.annotations[].criterion`    | enum    |                      yes | same as `criteria[].id` | Criterion classification                   | Adapter                           |
| `data.annotations[].issue`        | string  |                      yes | —                       | Issue type, e.g. `inaccurate_data_support` | AI Service                        |
| `data.annotations[].quote`        | string  |                      yes | —                       | Exact quotation from the essay             | AI Service                        |
| `data.annotations[].explanation`  | string  |                      yes | —                       | Explanation                                | AI Service                        |
| `meta.request_id`                 | string  |                      yes | ULID with `req_` prefix | AIHUB trace ID                             | AIHUB                             |
| `meta.correlation_id`             | string  |                       no | —                       | Echoes `X-Correlation-Id`                  | Client                            |
| `meta.service` / `operation`      | string  |                      yes | —                       | Routing metadata                           | AIHUB                             |
| `meta.timing.total_ms`            | integer |                      yes | —                       | Ingress → egress                           | AIHUB                             |
| `meta.timing.downstream_ms`       | integer | yes if downstream called | —                       | HTTP duration to AI Service                | AIHUB                             |
| `meta.timing.gateway_overhead_ms` | integer |                      yes | —                       | `total_ms - downstream_ms`                 | AIHUB derived                     |
| `meta.timing.ai_processing_ms`    | integer |                       no | —                       | AI Service self-measured                   | AI Service                        |
| `meta.usage.input_tokens`         | integer |                       no | —                       | Aggregate                                  | AI Service                        |
| `meta.usage.output_tokens`        | integer |                       no | —                       | Aggregate                                  | AI Service                        |
| `meta.usage.total_tokens`         | integer |                       no | —                       | Aggregate                                  | AI Service                        |

`criteria[].id` accepts one of:

```text
task_achievement              # Task 1 only
task_response                 # Task 2 only
coherence_cohesion
lexical_resource
grammatical_range_accuracy
```

> Empirical benchmark on 2026-09-07: grading takes **16–18 seconds**, response size is **~12 KB**. Since it remains comfortably below the 30-second boundary, it is kept as `execution: sync`.

### Historical Response — Question Generation (not exposed by AIHUB)

| Field                | Type   |        Required | Description                        |
| -------------------- | ------ | --------------: | ---------------------------------- |
| `data.question`      | string |             yes | Generated question prompt          |
| `data.question_id`   | string | **Task 1 only** | Question UUID in the question bank |
| `data.chart_type`    | enum   | **Task 1 only** | Chart type                         |
| `data.image_url`     | string | **Task 1 only** | Accompanying chart image           |
| `data.topic`         | string | **Task 2 only** | Topic                              |
| `data.question_type` | enum   | **Task 2 only** | Question type                      |

The `image_url` returned here is the exact value clients submit when requesting Task 1 grading — completing the closed-loop flow: generate prompt → student writes → grade submission.

---

# 21. Downstream Adapter Interface

## [Implementation Proposal]

```ts
interface DownstreamAdapter<TReq, TRes> {
  mapRequest(input: TReq, context: RequestContext): unknown;
  mapResponse(input: InternalAIServiceResponse<unknown>): TRes;
  mapError(error: unknown): InternalDownstreamError;
}
```

The adapter can handle:

- field rename;
- enum/value conversion;
- nested objects;
- default values;
- unsupported options;
- multipart/file conversion;
- response normalization;
- error mapping.

For the MVP, implement adapters via explicit code rather than introducing an over-engineered dynamic rule engine too early.

---

<a id="phần-c--unified-error-codes"></a><a id="part-c--unified-error-codes"></a>

# PART C — UNIFIED ERROR CODES

# 22. Error Architecture

```text
AI Service / Model Provider Raw Error
             ↓
Internal Downstream Error
             ↓
AIHUB Public Error
             ↓
Client
```

---

<a id="23-us08--detailed-downstream-error-cho-aihub-developer"></a><a id="23-us08--detailed-downstream-error-for-aihub-developers"></a>

# 23. US08 — Detailed Downstream Error for AIHUB Developers

## [Requirement]

AIHUB developers need sufficient detail to diagnose what downstream services are experiencing.

## [Implementation Proposal]

Internal log:

```json
{
  "request_id": "req_01JXYZ",
  "ai_service": "ai-writing",
  "model_provider": "provider-y",
  "downstream_status": 503,
  "downstream_error_code": "MODEL_NOT_READY",
  "downstream_message": "Model worker unavailable",
  "downstream_ms": 30120,
  "private_endpoint": "/v2/essay/score"
}
```

Raw details are strictly for internal diagnostics.

> **Implementation Status.** `downstream_error_code` and `downstream_message` above are **illustrative examples**, not fields currently returned by AI Writing. The live service returns `{"detail": "..."}` without any machine error codes, so `HttpOperationDispatcher` currently records `null` for both. All remaining fields — `request_id`, `ai_service`, `downstream_status`, `downstream_ms`, `private_endpoint` — are actively captured in logs. The prerequisites for populating those two fields are detailed in [US10 § Implementation Proposal](#25-us10--master-error-mapping-matrix).

---

<a id="24-us09--unified-error-payload-cho-client"></a><a id="24-us09--unified-error-payload-for-clients"></a>

# 24. US09 — Unified Error Payload for Clients

## [Requirement]

Clients do not have to parse complex raw error structures from disparate downstream services.

## [Implementation Proposal]

```json
{
  "error": {
    "code": "AI_SERVICE_UNAVAILABLE",
    "message": "AI service is temporarily unavailable",
    "request_id": "req_01JXYZ",
    "retryable": true,
    "retry_after_ms": 2000
  }
}
```

Never leak:

- stack traces;
- internal endpoints;
- DB errors;
- secrets;
- unneeded raw exceptions.

---

<a id="25-us10--master-error-mapping-matrix"></a>

# 25. US10 — Master Error Mapping Matrix

## [Requirement]

Requires an error mapping matrix spanning client, system, and AI Provider errors, including root causes and recommended client/system actions.

## [Implementation Proposal]

The finalized list for v1 contains **19 codes**. The six codes marked with ★ are additions relative to the initial D1 draft.

The **Downstream Signal** column indicates what AIHUB _observes_ from the downstream tier before constructing the error code. A dash `—` signifies that the request never left the gateway, so engineers debugging this error do not need to inspect AI Service logs.

| Layer       | Condition                                     | Downstream Signal                 | HTTP | AIHUB Code                        |  Retryable | Client Action                    | System Action           |
| ----------- | --------------------------------------------- | --------------------------------- | ---: | --------------------------------- | ---------: | -------------------------------- | ----------------------- |
| Client      | Missing/invalid field, unknown field          | —                                 |  400 | `INVALID_REQUEST`                 |         No | Fix request                      | None                    |
| Client      | Body exceeds `max_body_bytes`                 | —                                 |  413 | ★ `PAYLOAD_TOO_LARGE`             |         No | Reduce payload size              | Metric                  |
| Client      | Endpoint/resource does not exist              | —                                 |  404 | `NOT_FOUND`                       |         No | Check URL                        | None                    |
| Auth        | Missing/invalid API key                       | —                                 |  401 | `UNAUTHORIZED`                    |         No | Check credentials                | Audit                   |
| Auth        | User-scoped operation lacks assertion         | —                                 |  401 | ★ `USER_ASSERTION_REQUIRED`       |         No | Provide `X-User-Assertion`       | Audit                   |
| Auth        | Assertion signature invalid/expired/bad claim | —                                 |  401 | `INVALID_USER_ASSERTION`          |         No | Re-issue assertion               | Audit                   |
| Auth        | Unable to fetch Organization JWKS             | Org JWKS endpoint, not AI Service |  503 | ★ `IDENTITY_PROVIDER_UNAVAILABLE` |        Yes | Check customer JWKS endpoint     | Alert                   |
| AuthZ       | Scope denied                                  | —                                 |  403 | `FORBIDDEN`                       |         No | Check permissions/plan           | Audit                   |
| AuthZ       | Key not permitted in this environment         | —                                 |  403 | ★ `ENVIRONMENT_NOT_ALLOWED`       |         No | Use key matching environment     | Audit                   |
| Idempotency | Same key, different payload — or in flight    | —                                 |  409 | `IDEMPOTENCY_CONFLICT`            |         No | New key / fix request            | Audit                   |
| Gateway     | Client exceeds AIHUB rate limit               | —                                 |  429 | `RATE_LIMITED`                    |        Yes | Back off; obey `Retry-After`     | Metric                  |
| Gateway     | Too many concurrent requests for the same org | —                                 |  429 | ★ `CONCURRENCY_LIMIT`             |  Yes, soon | Reduce parallelism, retry ~500ms | Metric                  |
| Quota       | Organization quota exhausted                  | —                                 |  429 | `QUOTA_EXCEEDED`                  | Time-based | Wait / upgrade plan              | Metering                |
| Downstream  | AI Service / Model Provider throttled         | `HTTP 429`                        |  503 | `AI_SERVICE_THROTTLED`            |        Yes | Retry later                      | Backoff/circuit breaker |
| Downstream  | Timeout                                       | abort / `UND_ERR_*_TIMEOUT`       |  504 | `AI_SERVICE_TIMEOUT`              |      Yes\* | Retry only idempotently          | Timeout/circuit breaker |
| Downstream  | AI Service unavailable / breaker open         | `ECONNREFUSED` / DNS fail         |  503 | `AI_SERVICE_UNAVAILABLE`          |        Yes | Retry later                      | Alert/health check      |
| Downstream  | Response cannot be parsed to contract         | `HTTP 2xx` + malformed body       |  502 | ★ `AI_SERVICE_CONTRACT_VIOLATION` |         No | Contact AIHUB support            | **Urgent alert**        |
| Downstream  | Other 5xx / invalid response                  | `HTTP ≥ 500`                      |  502 | `AI_SERVICE_ERROR`                |      Maybe | Retry later                      | Alert/metrics           |
| Downstream  | 4xx other than 429 — see note below           | `HTTP 4xx`                        |  502 | `AI_SERVICE_ERROR`                |         No | Contact AIHUB support            | Metric                  |
| AIHUB       | Unexpected error                              | —                                 |  500 | `INTERNAL_ERROR`                  |      Maybe | Retry later                      | Alert                   |

`*` Timeout should only be retried when the operation is idempotent or the request carries a valid `Idempotency-Key`.

### ⚠️ Downstream Currently Returning 5xx for Client Errors

Empirical observation on 2026-09-07:

```
POST /generate-question-task1  {"topic":"environment"}
  -> HTTP 500  {"detail":"404: Không tìm thấy dữ liệu cho topic này!"}
```

A business domain status ("no data found for this topic/chart type") is returned as an **HTTP 500**. Consequence for AIHUB: according to the circuit breaker policy, only 5xx responses count as failures — meaning **a single client sending invalid `chart_type` values repeatedly could trip the breaker and take down the operation for all other tenants**.

Two lines of defense:

1. **AIHUB gatekeeper.** `chart_type` is an enum so unknown values are rejected with `400` at validation time before ever touching downstream. This is why strict enums are crucial.
2. **AI Writing remediation.** Downstream must correct this to `404` or `422`. Included in the service handoff checklist.

AIHUB **does not** attempt heuristic recovery by parsing the `detail` string — that heuristic breaks the moment downstream modifies its wording.

### Why Three Codes Specifically Warrant Separation

**`AI_SERVICE_CONTRACT_VIOLATION` vs `AI_SERVICE_ERROR`.** Lumping them together is the costliest operational trap: when an AI Service alters its response shape without notice, on-call engineers chase infrastructure ghosts when the actual culprit is **a recent deployment**. A dedicated code with a high-priority alert pinpoints the regression instantly. It is also non-retryable — retrying a broken contract will fail every time.

**`IDENTITY_PROVIDER_UNAVAILABLE`.** This is not a client credential error — returning `401` would prompt customers to rotate API keys in vain. Nor is it an AI Service failure. It communicates that "your organization's **own JWKS endpoint** is unreachable", which only a distinct code can convey.

**`CONCURRENCY_LIMIT` vs `RATE_LIMITED`.** These demand two entirely different corrective actions: for `RATE_LIMITED`, clients must **reduce request frequency**; for `CONCURRENCY_LIMIT`, clients must **reduce concurrent parallel calls** while potentially maintaining total throughput per minute. Using `RATE_LIMITED` for both misdirects customer remediation.

> Do not use public `429 RATE_LIMITED` for downstream throttling, as clients would misinterpret it as exceeding their AIHUB quota.

### Downstream 4xx Currently Grouped into `AI_SERVICE_ERROR`

Current behavior in `HttpOperationDispatcher.mapDownstreamStatus`: only `429` is mapped to `AI_SERVICE_THROTTLED`; all other non-2xx statuses collapse into `AI_SERVICE_ERROR`, with `retryable` enabled whenever status ≥ 500.

Consequence: a `422` rejected by an AI Service due to invalid input is returned to the client as a `502` — attributing the fault to the wrong party. Clients seeing `502` assume an infrastructure breakdown and retry, when they actually need to fix their request.

Not yet addressed for two reasons, both residing on the AI Service side:

1. AI Writing currently does **not** return 4xx for domain errors — it returns `500` (see note above). Splitting codes now would not alter any observable runtime behavior.
2. No standardized downstream error contract exists to differentiate "AI Service rejected input" from "AI Service failure". Proposed in the next section.

### Proposal — Pending AI Service Confirmation

> **Not yet active.** This section describes the target architecture, not current reality. AI Writing currently returns `500` with `{"detail": "..."}` even for business errors, without any machine error code field. Do not implement `parseError` or register new codes from the table below until the AI Service confirms the contract and AIHUB captures genuine error fixtures.

Minimum error contract AIHUB proposes across all AI Services:

```json
{
  "error": {
    "code": "TOPIC_NOT_FOUND",
    "message": "No data available for this chart type"
  }
}
```

Three strict requirements, nothing more:

1. **Accurate HTTP status codes** — business/validation errors must return `4xx`, never `500`. This is the most crucial requirement: circuit breakers count only `5xx` as failures, so invalid inputs returning `500` can trip the breaker and take down the operation for all other tenants.
2. **Stable enum `code`** — independent of display strings. AIHUB maps via `code` and never parses `message`.
3. **`message` is exclusively for log readers** — never leaked to clients, never used in control-flow branching.

Once that contract is established, Downstream Signal can include specific machine codes, and a new AIHUB code becomes necessary:

| Downstream Signal (proposed) | AIHUB Code                      | HTTP | Retryable |
| ---------------------------- | ------------------------------- | ---: | --------: |
| `429` + `RATE_LIMITED`       | `AI_SERVICE_THROTTLED`          |  503 |       Yes |
| `503` + `MODEL_NOT_READY`    | `AI_SERVICE_UNAVAILABLE`        |  503 |       Yes |
| `422` + `TOPIC_NOT_FOUND`    | ☆ `AI_SERVICE_REJECTED`         |  400 |        No |
| `422` + `ESSAY_TOO_SHORT`    | ☆ `AI_SERVICE_REJECTED`         |  400 |        No |
| other `5xx`                  | `AI_SERVICE_ERROR`              |  502 |       Yes |
| `2xx` + malformed body       | `AI_SERVICE_CONTRACT_VIOLATION` |  502 |        No |

☆ Proposed code, not yet present in `error-registry.ts`.

**Why `AI_SERVICE_REJECTED` warrants a dedicated code.** It sits precisely between two existing concepts. It is not `INVALID_REQUEST`, because the request passed AIHUB gateway validation — the schema was valid. Nor is it `AI_SERVICE_ERROR`, because nothing crashed or degraded. Its precise semantic is: _the shape is correct, but downstream AI logic rejected the content_. Clients must know this to fix their payload rather than retrying blindly.

**Prerequisites in strict sequential order:**

1. AI Service implements the error contract above
2. AIHUB invokes real endpoints, captures error fixtures, commits to `test/fixtures/ai-writing/`
3. Implement `parseError` on the adapter — hook is declared on `DownstreamAdapter`, but not yet implemented by adapters
4. Register `AI_SERVICE_REJECTED` in the registry, populate `downstream_error_code` in US08 logs

Reversing the order means writing a parser for a non-existent contract.

---

# 26. Idempotency Contract

D1 **reserves the contract** for high-cost / side-effecting POST operations, even though runtime enforcement can be implemented in D2/later.

```http
Idempotency-Key: <uuid-or-opaque-string>
```

Proposed semantics:

```text
same org + same operation + same key + same request
→ same result / same in-flight operation

same org + same operation + same key + different request
→ 409 IDEMPOTENCY_CONFLICT
```

The Operation Catalog must declare `idempotency` requirements.

---

<a id="phần-d--operation-catalog"></a><a id="part-d--operation-catalog"></a>

# PART D — OPERATION CATALOG

<a id="27-mỗi-operation-cần-một-record-đầy-đủ"></a><a id="27-complete-record-for-every-operation"></a>

# 27. Complete Record for Every Operation

To eliminate ambiguity, every public operation must have a catalog entry of the form:

```yaml
operation: writing.task1.grade
method: POST
path: /v1/ielts/writing/task1/grade
scope: writing.grade
identity_scope: user
execution: sync
content_type: application/json
idempotency: required
max_body_bytes: 262144 # 256 KB
timeout_ms: 60000
downstream_service: ai-writing
downstream_path: /grading-feedback-task1
request_schema: GradeTask1Request
response_schema: GradeResponse
observed_latency: 18.3s # empirically measured 2026-09-07
```

```yaml
operation: writing.task2.grade
method: POST
path: /v1/ielts/writing/task2/grade
scope: writing.grade
identity_scope: user
execution: sync
content_type: application/json
idempotency: required
max_body_bytes: 262144
timeout_ms: 60000
downstream_service: ai-writing
downstream_path: /grading-feedback-task2
request_schema: GradeTask2Request
response_schema: GradeResponse
```

Speaking grading:

```yaml
operation: speaking.grading
method: POST
path: /v1/ielts/speaking/grading
scope: speaking.grade
identity_scope: user
execution: sync
content_type: multipart/form-data
idempotency: none
max_body_bytes: 26214400
timeout_ms: 30000
downstream_service: ai-speaking
downstream_path: /api/v1/speaking/grading
```

Speaking JSON-by-URL fallback:

```yaml
operation: speaking.grading-json
method: POST
path: /v1/ielts/speaking/grading-json
scope: speaking.grade
identity_scope: user
execution: sync
content_type: application/json
idempotency: none
max_body_bytes: 262144
timeout_ms: 30000
downstream_service: ai-speaking
downstream_path: /api/v1/speaking/grading-json
```

### `idempotency` Takes Three Values, Not a Boolean

The initial draft used boolean `idempotency_required: true/false`. Three distinct states accurately reflect reality:

| Value      | Meaning                              | Used for                                              |
| ---------- | ------------------------------------ | ----------------------------------------------------- |
| `required` | Missing `Idempotency-Key` → `400`    | Costly operations and those creating student records  |
| `optional` | Honored if provided, allowed without | Costly operations that do not produce permanent state |
| `none`     | Header ignored if provided           | Read-only operations, safely repeatable               |

The current runtime uses `required` for Writing grading and `none` for Speaking grading,
including the JSON-by-URL fallback. The
`optional` mode remains a reserved catalog value for a future operation; it is not used by any
public AIHUB route today.

### `timeout_ms` Is a Ceiling, Not Expected Duration

`aihub_long_term_architecture.md` §32.5 sets the sync/async boundary at **typical execution time ≤ 30 seconds**. Grading specifies `timeout_ms: 60000`, but that is a **timeout ceiling**, not an expected duration — empirical latency is 16–18 seconds, well within the sync boundary.

If real-world monitoring indicates p95 latency exceeds 30 seconds, `writing.*.grade` must transition to async, for which the envelope in §12 is already prepared.

---

<a id="phần-e--d1-acceptance-checklist"></a><a id="part-e--d1-acceptance-checklist"></a>

# PART E — D1 ACCEPTANCE CHECKLIST

> **Historical Snapshot:** unchecked boxes below reflect the checklist status prior to the D1
> freeze. Refer to the status section at the top of this document and `CONTEXT.md` for current sprint tasks.

# 28. API Contract & Schema

- [ ] Freeze Base URL.
- [ ] Freeze API versioning.
- [ ] Freeze endpoint naming conventions.
- [ ] Freeze API key header convention.
- [ ] Freeze environment source of truth = hostname/deployment.
- [ ] Freeze API key environment binding rules.
- [ ] Freeze Organization derived from API key.
- [ ] Freeze Service/Operation derived from path.
- [ ] Freeze canonical request schemas per capability.
- [ ] Freeze canonical response envelope.
- [ ] Freeze AIHUB-generated `request_id` + optional `X-Correlation-Id`.
- [ ] Freeze timing definitions: `total_ms`, `downstream_ms`, `ai_processing_ms`, `gateway_overhead_ms`.
- [ ] Freeze source of truth for each metadata field.
- [ ] Freeze internal AI Service response contract.
- [ ] Freeze usage aggregation rule when operation invokes models multiple times.
- [ ] Freeze behavior when an endpoint produces no usage (`omit` vs `null`).
- [ ] Freeze which operations are user-scoped vs organization-scoped.
- [ ] Freeze User Assertion contract when capabilities require end-user identity.
- [ ] Freeze sync/async classification per operation.
- [ ] Freeze media/file input mode and limits for Speaking/media operations.
- [ ] Freeze datatype/constraints/default/required specifications for every field.

# 29. API Key Foundation

### D1

- [ ] Freeze schema for `organizations` / `api_keys`.
- [ ] Freeze raw key vs hash rules.
- [ ] Freeze status/expiry/environment binding semantics.
- [ ] Freeze API key scope model at contract level.

### D2 Implementation

- [ ] Implement DB/middleware lookup.
- [ ] Invalid/missing keys return unified error.
- [ ] Attach authenticated org context.

# 30. Provider / Downstream Mapping

- [ ] Freeze terminology: AI Service vs Model Provider.
- [ ] Establish operation → required scope mapping.
- [ ] Establish operation → AI Service mapping.
- [ ] Establish request adapter rules.
- [ ] Establish response adapter rules.
- [ ] Establish rules for unsupported fields/values.
- [ ] Establish internal response metadata contract.
- [ ] Provide unit-test examples/spec for mapping rules.

# 31. Unified Errors

- [ ] Provide public error payload.
- [ ] Provide internal downstream error structure.
- [ ] Provide master error mapping matrix.
- [ ] Distinguish AIHUB 429 from downstream throttling 503.
- [ ] Provide `Retry-After` / `retry_after_ms` semantics where applicable.
- [ ] Never leak raw downstream errors.
- [ ] Errors carry AIHUB `request_id`.
- [ ] Freeze idempotency conflict errors.

---

<a id="phần-f--output-expected-của-deliverable-1"></a><a id="part-f--expected-output-of-deliverable-1"></a>

# PART F — EXPECTED OUTPUT OF DELIVERABLE 1

By the conclusion of D1, the following artifacts must exist:

```text
1. API Naming / Versioning Convention
2. Environment / Base URL Convention
3. Standard Request Header Contract
4. API Key Contract
5. End-user Assertion Contract for user-scoped operations
6. Canonical Request Schemas
7. Canonical Response Schemas
8. Field Data Dictionary
9. Operation Catalog
10. Organization Entitlement / API Key Scope Model
11. Operation → AI Service Mapping Table
12. Downstream Mapping Rules
13. Downstream Adapter Interface
14. Internal AI Service Response Contract
15. Metadata Source-of-Truth Matrix
16. Timing Definitions
17. Usage Aggregation Rule
18. Unified Error Payload
19. Master Error Mapping Matrix
20. Idempotency Header/Semantics
21. Media/File Input Policy
22. Sync/Async Decision per Operation
23. Example Request/Response for each primary capability
24. OpenAPI/Swagger draft — ✅ COMPLETED 2026-09-07, openapi.json (OpenAPI 3.1), generated from operation catalog via pnpm generate:openapi, not hand-crafted (issue #2)
25. Postman examples for handoff to D2 — ✅ COMPLETED 2026-09-07, aihub.postman_collection.json, generated from openapi.json via pnpm generate:postman, containing the 16 active handover scenarios in §G; 2 cases (13, 14) awaiting #9 metering (issue #6)
```

---

<a id="phần-g--handoff-sang-deliverable-2"></a><a id="part-g--handoff-to-deliverable-2"></a>

# PART G — HANDOFF TO DELIVERABLE 2

D1 freezes contracts; D2 implements runtime execution:

```text
HTTP Request
    ↓
Generate request_id
    ↓
API Key Authentication
    ↓
Canonical Validation
    ↓
User Assertion Verification (if operation requires)
    ↓
Authorization
    ↓
Idempotency / Rate Limit / Quota (per phase scope)
    ↓
Downstream Resolver
    ↓
Request Adapter
    ↓
Routing / Dispatcher
    ↓
HTTP Client → AI Service
    ↓
Response / Error Adapter
    ↓
Canonical Response
```

## D2 Minimum Postman Test Suite

1. Valid API key + valid request → correctly routes to downstream AI Service.
2. Missing/invalid API key.
3. API key not allowed in the current environment.
4. Missing required parameters.
5. Unknown/unsupported field rejected.
6. Scope/service mismatch rejected.
7. User-scoped operation missing or invalid User Assertion.
8. Downstream timeout.
9. Downstream throttled → public 503 `AI_SERVICE_THROTTLED`, not client 429.
10. Downstream 4xx/5xx → correctly mapped unified error.
11. `request_id` generated by AIHUB; client `correlation_id` preserved when present.
12. Timing fields adhere to defined semantics.
13. Provider usage and processing telemetry is metered internally and absent from the public response.
14. Aggregate usage across multiple model calls is persisted correctly.
15. Idempotency behavior when implemented in scope.

---

<a id="32-những-điểm-team-phải-chốt-trước-khi-freeze-d1"></a>

# 32. Decisions Required Before Freezing D1

**Status: superseded for the current runtime.** The table preserves the original D1 freeze for traceability; the 2026-09-12 scope update removes public question-generation operations.

|   # | Question                                          | Decision                                                                                                                                                                                                     |
| --: | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | `X-API-Key` or `Authorization: Bearer`?           | **`X-API-Key`.** `Authorization` is reserved for internal JWTs across the AIHUB → AI Service boundary, preventing two credential classes from colliding on one header                                        |
|   2 | Does key require `live/test` mode?                | **No.** Environment is determined by hostname; keys are strictly _bound_ via `allowed_environments`. Embedding mode into the key creates a dual source of truth                                              |
|   3 | `dev/staging/prod/sandbox` derived from hostname? | **Yes, finalized** (§4)                                                                                                                                                                                      |
|   4 | `/v1` or header versioning?                       | **`/v1` in path**                                                                                                                                                                                            |
|   5 | Unknown fields reject 400?                        | **Yes, zero exceptions.** `additionalProperties: false` (§18)                                                                                                                                                |
|   6 | `usage` when not calling models                   | **Omit.** Neither `null` nor `0`. Accompanied by `metering_status: not_applicable` (§15)                                                                                                                     |
|   7 | How much to expose `models[]`/breakdown?          | **Aggregate token counts only.** AI Services do not return model identity or per-call breakdown; only aggregate usage is exchanged (§16)                                                                     |
|   8 | JWKS URL or upload public key?                    | **Both.** `jwks_url` is primary, `public_keys_jwks` is fallback (§8)                                                                                                                                         |
|   9 | Maximum assertion TTL                             | **300 seconds**, configurable per org via `max_assertion_ttl_seconds`. Clock skew ±60s                                                                                                                       |
|  10 | Which capabilities mandate user identity?         | All active grading operations (`writing.task1.grade`, `writing.task2.grade`, `speaking.grading`) → `user`. Default fail-closed: if unsure, classify as `user`                                                |
|  11 | `writing.grade` sync or async?                    | **Sync**, `timeout_ms: 60000` (ceiling, not expectation — see §27)                                                                                                                                           |
|  12 | `speaking.grading` sync or async?                 | **Sync** for the current multipart proxy; the future asset/job API remains deferred                                                                                                                          |
|  13 | Speaking multipart or `asset_id`?                 | **`asset_id` + presigned upload** is primary; multipart for small files ≤10 MB (LTA §32.6)                                                                                                                   |
|  14 | Max media size / MIME                             | ⏳ **Open** — finalized in Phase 4. Does not block D1 freeze because async envelope is locked                                                                                                                |
|  15 | Idempotency mandatory for which operations?       | `required` for Writing grading; `none` for current Speaking grading; `optional` reserved for future operations (§27)                                                                                         |
|  16 | Scope/entitlement enforcement starting D2?        | **Yes, starting in D2.** `Entitlement ∩ Key Scope` requires no extra query — data is retrieved during key lookup (§9)                                                                                        |
|  17 | Missing usage for metering-critical op?           | **Do not fail business responses.** Record `metering_status: missing_usage` + alert + reconcile (LTA §32.8). However, contract/integration tests must treat `usage` as required before deploying AI Services |
|  18 | Finalized public error codes list v1              | **19 codes** in §25                                                                                                                                                                                          |

---

<a id="33-điều-kiện-còn-lại-để-freeze-d1"></a>

# 33. Remaining Prerequisites to Freeze D1

Three tasks, only one of which was a blocker:

| #   | Task                                                          | Blocks | Status                                                                                                            |
| --- | ------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Capture real responses for `/grading-feedback-task1 \| 2`~~ | —      | ✅ **DONE 2026-09-07**, fixtures in `test/fixtures/ai-writing/`                                                   |
| 2   | ~~List of `question_type` / `chart_type`~~                    | —      | ✅ **DONE** — 5 Task 2 types, 7 Task 1 chart types                                                                |
| 3   | ~~Export OpenAPI 3.1 + Postman collection~~                   | —      | ✅ **DONE 2026-09-07** — `openapi.json` (#2) + `aihub.postman_collection.json` (#6), both generated automatically |

**D1 is frozen.** All three tasks are complete; zero blockers remain.

One open question remains but **does not block freeze**: half-band score granularity (see §34). That is an AI Writing model quality issue, not a contract defect — the schema specifies `multipleOf: 0.5`, making it correct in both scenarios.

---

<a id="34-nhật-ký-thay-đổi"></a>

# 34. Changelog

## 2026-09-12 — AIHUB scope reduced to grading

AIHUB no longer exposes or dispatches the Task 1/Task 2 question-generation
routes. Writing clients submit their own prompts to the two grading endpoints;
upstream AI Writing generation endpoints, if retained, remain private to that
service. `writing.question.generate` is no longer issued for new API keys, and
existing stored scopes/records remain historical data only.

## 2026-09-07 — Synchronized with Empirical AI Writing Exploration

| #   | Change                                                                                        | Section       |
| --- | --------------------------------------------------------------------------------------------- | ------------- |
| 1   | Replaced canonical request/response with actual schema; removed `content`/`language`/`level`  | §10, §20      |
| 2   | Split Task 1 / Task 2 into 4 distinct operations                                              | §5, §19, §27  |
| 3   | Added 6 error codes; total 19 codes for v1                                                    | §25           |
| 4   | Added `max_assertion_ttl_seconds`, allowlisted `alg`, `UNIQUE(issuer)`; made `jti` mandatory  | §8            |
| 5   | `usage` must be omitted when no models are called, with real-world example                    | §15           |
| 6   | Added `metering_status` with 4 states                                                         | §15, §16      |
| 7   | Locked Speaking to async envelope; scoped body limits per operation                           | §11, §12, §27 |
| 8   | Clarified internal contract is **additive** — AI Services add top-level fields without `data` | §15           |
| 9   | Resolved 17/18 freeze questions                                                               | §32           |
| 10  | **Removed `meta.models[]` from public response** — aligned with LTA §32.7                     | §16           |
| 11  | Converted `idempotency_required` boolean → three-state `idempotency`                          | §27           |

## 2026-09-07 (Round 2) — Post Live AI Writing API Invocations

Invoked all 4 endpoints using credentials supplied by the team; fixtures stored in `test/fixtures/ai-writing/`.

| #   | Change                                                                                                                                           | Section       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| 12  | `topic` → **`chart_type`** 7-value enum for Task 1. Real value is chart type, not subject topic — sending `"environment"` yields downstream 500  | §10, §20, §27 |
| 13  | Added **`language`** to grading request/response; enum temporarily `['vi']` as downstream only generates Vietnamese feedback                     | §10, §16, §20 |
| 14  | **Expanded `GradeResponse`** per live response: `band_reason`, `strengths[]`, `improvements[]`, `suggestions[]`, `next_steps[]`, `annotations[]` | §16, §20      |
| 15  | Renamed `corrections` → **`annotations`**. Real payload is `{quote, explanation}` rather than `{original, suggestion}`                           | §16, §20      |
| 16  | Explicitly documented **3 excluded downstream fields**: `coT`, `feedback_detail`, `data_micro.*.question_type`                                   | §16           |
| 17  | `band` accepts **both int and float** — downstream returns `overall_band: 7.0` but criterion `band: 7`                                           | §16, §20      |
| 18  | Documented warning: **downstream returns 5xx for client input errors**, established two-tier defense                                             | §25           |
| 19  | Recorded real `observed_latency` in operation catalog                                                                                            | §27           |

### Three AI Writing Issues Discovered During Live Testing

1. **No endpoint returns `usage` telemetry** → current metering coverage is 0%.
2. **`data.coT` leaks chain-of-thought** in responses (`layer1_errors`, `layer2_matching`, `layer3_calibration`).
3. **Suspicious grading anomalies:** all 3 test samples produced identical integer bands across all 4 criteria (7-7-7-7 then 5-5-5-5); a Task 2 submission of 98 words (250 required) was still awarded band 5.0.

Detailed rationale for each architectural change: [`implementation spec index`](superpowers/specs/2026-09-07-aihub/README.md)

---

<a id="35-kết-luận-d1"></a>

# 35. Conclusion D1

Deliverable 1 establishes a **stable and unambiguous public contract** so that Deliverable 2 can implement gateway, proxy, and routing mechanics against frozen interfaces.

Key principles established:

```text
Organization     → derived from API Key
Service/Operation→ derived from endpoint path
Environment      → derived from deployment hostname
End User         → Signed User Assertion for user-scoped operations
Request ID       → generated by AIHUB
Model usage      → AI Service is source of truth
Timing           → clearly separates total, downstream, and AI processing
Authorization    → Organization Entitlement ∩ API Key Scope
Downstream       → invokes private AI Services; never exposes Model Providers directly
```

D1 defines contracts; D2 and later sprints assume responsibility for runtime implementation.
