# AIHUB — AI Agent Brainstorm Brief

> ## ✅ Đã được trả lời — 2026-09-07
>
> Brief này là **prompt đầu vào**, giữ nguyên làm hồ sơ. Kết quả brainstorm nằm ở:
>
> **[`docs/superpowers/specs/2026-09-07-aihub/`](docs/superpowers/specs/2026-09-07-aihub/README.md)** — 12 file, theo đúng cấu trúc output A–P yêu cầu ở §16.
>
> | Mục brief                                       | Trả lời ở                                                                                                 |
> | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
> | A, B, C — recommendation, stack matrix, diagram | [01-context-and-stack](docs/superpowers/specs/2026-09-07-aihub/01-context-and-stack.md)                   |
> | D — request lifecycle                           | [02-request-lifecycle](docs/superpowers/specs/2026-09-07-aihub/02-request-lifecycle.md)                   |
> | E — database design                             | [03-database](docs/superpowers/specs/2026-09-07-aihub/03-database.md)                                     |
> | F — redis design                                | [04-redis](docs/superpowers/specs/2026-09-07-aihub/04-redis.md)                                           |
> | G — auth & identity                             | [05-auth-identity](docs/superpowers/specs/2026-09-07-aihub/05-auth-identity.md)                           |
> | H — routing & adapter                           | [06-routing-adapter](docs/superpowers/specs/2026-09-07-aihub/06-routing-adapter.md)                       |
> | I, J — reliability, error model                 | [07-reliability-and-errors](docs/superpowers/specs/2026-09-07-aihub/07-reliability-and-errors.md)         |
> | K, L — metering, observability                  | [08-metering-and-observability](docs/superpowers/specs/2026-09-07-aihub/08-metering-and-observability.md) |
> | M — threat model                                | [09-security](docs/superpowers/specs/2026-09-07-aihub/09-security.md)                                     |
> | N, O — roadmap, ADR                             | [10-deployment-roadmap](docs/superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md)                 |
> | P — open questions                              | [11-open-questions](docs/superpowers/specs/2026-09-07-aihub/11-open-questions.md)                         |
>
> ### Những chỗ agent challenge lại brief
>
> Brief cho phép challenge kèm lý do. Bốn điểm đã challenge và được team chấp nhận:
>
> 1. **13 bảng → 5 bảng** cho D2. Plans/subscriptions là thiết kế cho một mô hình kinh doanh chưa tồn tại.
> 2. **Routing catalog ở code, không ở DB** (§13.8 gợi ý config-driven). Lý do chính là SSRF: chính brief §13.14 liệt kê "SSRF từ configurable downstream URL" là mối đe doạ — cách rẻ nhất để trị là đừng để URL configurable.
> 3. **Redis ra khỏi đường idempotency hoàn toàn** (§13.11 gợi ý "Redis + durable fallback"). `ON CONFLICT` của Postgres đã lo phần đua; thêm Redis chỉ tạo hai nguồn sự thật cho đúng thứ không được phép sai.
> 4. **`mapError` thành optional** trong adapter interface. Lỗi tầng vận chuyển giống nhau ở mọi AI Service nên dùng chung một mapper; bắt buộc mỗi adapter cài `mapError` nghĩa là chép lại cùng một đoạn code.
>
> ### Scale assumption đã chốt
>
> **Stage A** (§15): vài Organization, 10–50 RPS peak. Mọi quyết định đều kèm trigger cụ thể để nâng cấp — xem [10 §N.5](docs/superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md#n5-trigger-rời-khỏi-kiến-trúc-này).

---

> **Mục đích:** File này dùng để gửi cho một AI Agent/Architecture Agent brainstorm **tech stack, database, infrastructure, security, scaling, proxy/gateway implementation và roadmap triển khai** cho AIHUB.
>
> Đây **không phải** tài liệu requirement cuối cùng. Agent được phép challenge các lựa chọn kỹ thuật, nhưng phải giữ các business/architecture constraints đã chốt bên dưới trừ khi nêu rõ lý do cần thay đổi.

---

# 1. Bối cảnh dự án

AIHUB là một **B2B multi-tenant AI API Gateway** đứng giữa Customer Backend và nhiều AI Service nội bộ.

Mục tiêu dài hạn:

```text
Customer Backend
       │
       │ AIHUB Public API
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
                   ▼
        ┌──────────┼───────────┐
        ▼          ▼           ▼
   AI Writing  AI Speaking  AI Reading
    PRIVATE      PRIVATE      PRIVATE
        │          │           │
        ▼          ▼           ▼
   Writing DB  Speaking DB Reading DB
        │          │           │
        └── may call Model Providers ──► OpenAI / Anthropic / Google / ...
```

## End-state quan trọng

- **AIHUB là public API boundary duy nhất.**
- Client không gọi trực tiếp AI Writing / Speaking / Reading.
- AI Services chỉ expose private API.
- AIHUB không sở hữu business data của từng domain.
- AIHUB sở hữu control-plane data: organization, API key, entitlement, quota, routing, metering, identity config...
- Public client chỉ phụ thuộc canonical contract của AIHUB.
- Contract riêng của từng AI Service được che bởi Downstream Adapter.

---

# 2. Các quyết định kiến trúc đã chốt hoặc gần như đã chốt

Agent **không nên âm thầm thay đổi** các điểm dưới đây. Nếu thấy có vấn đề, hãy ghi rõ `Challenge` + lý do + alternative.

## 2.1 Multi-tenancy

Tenant chính là **Organization**.

```text
Organization
├── API Keys
├── Entitlements
├── Plan / Subscription
├── Quota
├── Identity Configuration
└── Usage
```

Không có layer `Team` ở thời điểm hiện tại.

---

## 2.2 Organization authentication

Customer Backend gọi AIHUB bằng Organization API Key.

Recommended convention hiện tại:

```http
X-API-Key: aihub_sk_xxxxx
```

API key dùng để xác định:

```text
API Key
   ↓
Organization
   ↓
API Key Scope
   ↓
Status / Expiry
```

Raw API key không được lưu trực tiếp; DB chỉ giữ hash/prefix/metadata.

---

## 2.3 End-user identity

API key chỉ xác định được Organization, **không xác định được user cụ thể bên trong Organization**.

Với operation user-scoped, Customer Backend phải gửi một **Signed End-user Assertion**.

Ví dụ JWT:

```json
{
  "iss": "org_abc",
  "sub": "student_123",
  "aud": "aihub",
  "iat": 1788350000,
  "exp": 1788350300
}
```

Recommended:

```http
X-User-Assertion: <signed-jwt>
```

Trust model:

```text
Customer Backend
    │ sign JWT
    ▼
AIHUB
    │ verify signature bằng Organization JWKS/public key
    │ verify API-key.org == assertion issuer
    ▼
Trusted identity = (organization_id, external_user_id)
```

Identity đúng của một end-user là composite:

```text
(organization_id, external_user_id)
```

AIHUB không nhất thiết phải quản lý account/login của từng học viên.

---

## 2.4 AIHUB → AI Service identity propagation

Sau khi AIHUB xác thực Organization + End User, AIHUB tạo **short-lived internal JWT** cho downstream.

Ví dụ:

```json
{
  "iss": "aihub",
  "aud": "ai-writing",
  "org_id": "org_abc",
  "sub": "student_123",
  "scope": ["writing.grade"],
  "exp": 1788350060
}
```

AI Services chỉ trust token do AIHUB phát hành.

Long-term có thể kết hợp mTLS, nhưng không nhất thiết bắt buộc trong MVP nếu private network + internal JWT đã đủ.

---

# 3. Public API abstraction

AIHUB phải expose canonical API dễ dùng, ví dụ:

```http
POST /v1/ielts/writing/grade
GET  /v1/ielts/writing/history
POST /v1/speaking/grade
GET  /v1/speaking/history
```

Mỗi AI Service có thể có contract riêng phía sau.

AIHUB sử dụng **Downstream Adapter / Provider Mapper Rules** để transform:

```text
Canonical Request
       ↓
Downstream Adapter
       ↓
AI-Service-specific Request
       ↓
AI Service
       ↓
AI-Service-specific Response
       ↓
Downstream Adapter
       ↓
Canonical Response
```

> Trong project hiện tại cụm từ `Provider Mapper` có thể xuất hiện, nhưng cần phân biệt:
>
> - **AI Service** = AI Writing / Speaking / Reading
> - **Model Provider** = OpenAI / Anthropic / Google / ...

---

# 4. Usage / token metadata

AIHUB chỉ là gateway nên **không tự biết chính xác model token usage**.

Source of truth:

| Metadata                       | Source of truth                      |
| ------------------------------ | ------------------------------------ |
| `request_id`                   | AIHUB                                |
| `service/operation`            | AIHUB                                |
| `total_ms`                     | AIHUB                                |
| `downstream_ms`                | AIHUB                                |
| `gateway_overhead_ms`          | AIHUB-derived                        |
| `input_tokens`                 | AI Service                           |
| `output_tokens`                | AI Service                           |
| `total_tokens`                 | AI Service                           |
| `ai_processing_ms`             | AI Service, optional                 |
| model/model-provider breakdown | AI Service, preferably internal-only |

AI Service cần trả standardized internal metadata, ví dụ:

```json
{
  "data": {},
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 300,
    "total_tokens": 1500
  },
  "model": {
    "name": "...",
    "provider": "..."
  },
  "metrics": {
    "ai_processing_ms": 2800
  }
}
```

Một operation có thể gọi nhiều model nhiều lần. Public API mặc định chỉ expose aggregate usage; breakdown có thể giữ cho internal metering/debug.

---

# 5. Data ownership

AIHUB dự kiến giữ **control-plane data**:

```text
organizations
api_keys
plans
subscriptions
organization_entitlements
api_key_scopes
routing_rules
downstream_configs
quota_configs
usage_records
identity_configs
idempotency_records
```

Business data nằm ở domain service:

```text
Writing attempts/results → Writing DB
Speaking results/audio   → Speaking DB / Object Storage
Reading results          → Reading DB
```

Agent cần đánh giá database phù hợp cho **AIHUB control plane**, không thiết kế lại toàn bộ database của từng AI domain trừ khi cần nêu integration boundary.

---

# 6. Environment và routing

Recommended current direction:

- Deployment hostname là source of truth cho `dev/staging/prod`.
- Service/operation derive từ endpoint/path.
- Organization derive từ API Key.
- End User derive từ Signed User Assertion khi operation cần.

Ví dụ:

```text
api.aihub.example.com          → production
staging-api.aihub.example.com  → staging
```

Routing logic dạng:

```text
operation = writing.grade
       ↓
routing rule
       ↓
AI Writing
       ↓
Downstream Adapter
```

Agent cần đề xuất cách lưu/cache/configure routing rules và downstream endpoints.

---

# 7. Authorization model

Effective permission dự kiến:

```text
Organization Entitlement
           ∩
      API Key Scope
           ↓
    Effective Scope
```

Ví dụ:

```text
Organization plan:
- writing
- speaking

API Key A:
- writing.grade

=> Key A không được gọi speaking dù Organization có entitlement.
```

Operation Catalog nên mô tả rõ:

```yaml
operation: writing.grade
method: POST
path: /v1/ielts/writing/grade
scope: writing.grade
identity_scope: user
execution: sync
content_type: application/json
idempotency_required: true
downstream_service: ai-writing
```

---

# 8. Reliability constraints đã nghĩ tới

Agent phải brainstorm kỹ các phần này:

- Timeout policy.
- Retry policy.
- Exponential backoff + jitter.
- Idempotency cho generative/mutating POST.
- Circuit breaker.
- Bulkhead / concurrency limit.
- Load shedding / backpressure.
- Abort/cancellation propagation từ client → AIHUB → AI Service nếu có thể.
- Handling downstream 429/5xx/timeouts.
- Streaming response/SSE nếu tương lai AI APIs cần streaming.

Recommended hiện tại:

- `Idempotency-Key` cho operation cần chống duplicate.
- Default idempotency retention khoảng 24h.
- Không retry mù quáng POST nếu không có idempotency guarantee.
- AIHUB rate limit `429` cần phân biệt với downstream/model-provider throttling.

---

# 9. File/audio workloads

Long-term recommendation hiện tại:

```text
Client
  ↓ request upload URL
AIHUB
  ↓ presigned URL
Object Storage
  ↓ asset_id
Client
  ↓ AI operation + asset_id
AIHUB
```

`multipart/form-data` vẫn có thể hỗ trợ với file nhỏ/MVP.

Agent cần đánh giá:

- S3-compatible storage / Cloudflare R2 / MinIO / cloud-native alternative.
- Metadata table cho assets.
- Upload authorization.
- Expiry.
- Malware/content validation nếu cần.
- Async processing cho audio/file lớn.

---

# 10. Sync vs Async

Current recommended default:

- Operation predictable và thường ≤ 30s → sync.
- Long-running/media/batch → async.

Async contract có thể dạng:

```http
POST /v1/speaking/grade
→ 202 Accepted
```

```json
{
  "job_id": "job_123",
  "status": "queued"
}
```

sau đó:

```http
GET /v1/jobs/job_123
```

hoặc webhook về customer.

Agent cần brainstorm queue/job architecture nếu async được đưa vào phase sau.

---

# 11. Scope của Deliverable 1 hiện tại

Deliverable 1 chủ yếu là **API Contract & Schema Definition**, gồm:

- Base URL / RESTful endpoint naming.
- Request Standard.
- Response Standard.
- Provider/Downstream Mapper Rules.
- Data type / constraints cho request-response fields.
- Unified Error Codes.
- Master Error Mapping Matrix.

Core reverse proxy/routing implementation nằm ở deliverable sau.

**Organization API Key nên được định nghĩa trong contract từ đầu**, dù phần DB/middleware implementation có thể triển khai ở phase kế tiếp.

---

# 12. Brainstorm Mission cho AI Agent

Hãy đóng vai **Principal Backend / Platform Architect** và thiết kế implementation strategy cho AIHUB.

Không chỉ liệt kê công nghệ. Với mỗi decision quan trọng, hãy:

1. Đưa ra **2–4 options thực tế**.
2. Phân tích trade-off ngắn gọn.
3. Chọn **Recommended Default**.
4. Giải thích vì sao phù hợp với AIHUB.
5. Nếu chưa đủ dữ kiện, ghi rõ assumption thay vì tự bịa requirement.
6. Ưu tiên kiến trúc **đủ tốt để production nhưng không over-engineer MVP**.

---

# 13. Các nhóm câu hỏi bắt buộc phải brainstorm

## 13.1 Backend / Gateway Tech Stack

So sánh ít nhất:

- NestJS + Fastify.
- Go (`net/http`, Fiber, Gin hoặc framework phù hợp).
- Một phương án dùng dedicated proxy/gateway như Envoy/Kong/NGINX đứng trước application layer.

Cần trả lời:

- Có nên custom proxy logic trong AIHUB app hay dùng Envoy/Kong cho data plane?
- Nếu dùng NestJS, có đủ cho proxy AI workload/streaming/high concurrency không?
- Fastify vs Express.
- HTTP client nào phù hợp (`undici`, native fetch, Axios, etc.).
- Connection pooling / keep-alive.
- Streaming/SSE support.
- Request cancellation.
- Large body/file handling.
- Backpressure.

> **Candidate stack hiện tại, CHƯA LOCK:** NestJS/TypeScript vì team backend quen hệ sinh thái này. Agent được quyền recommend giữ hoặc thay đổi.

---

## 13.2 Database cho AIHUB Control Plane

Đánh giá:

- PostgreSQL.
- MySQL nếu có lý do.
- Một distributed SQL option chỉ nếu thật sự cần.

Thiết kế schema/index/constraints cho ít nhất:

```text
organizations
api_keys
plans
subscriptions
organization_entitlements
api_key_scopes
identity_configs
routing_rules
downstream_configs
quota_configs
usage_records
idempotency_records
assets (nếu AIHUB quản lý asset metadata)
webhook_endpoints (nếu async callback)
```

Cần trả lời:

- PK nên UUID/UUIDv7/ULID/bigint?
- API key lookup/index strategy.
- Hash API key bằng gì và lookup hiệu quả thế nào?
- Unique constraints nào bắt buộc?
- Soft delete hay hard delete?
- Audit fields nào cần?
- Multi-tenant indexes như thế nào?
- Có cần partition `usage_records` theo time không?
- Retention strategy.

---

## 13.3 Redis / Cache / Ephemeral State

Đánh giá Redis có nên dùng cho:

- Rate limit.
- Quota counters.
- API key cache.
- JWKS cache.
- Routing config cache.
- Idempotency response/cache.
- Distributed locks.
- Async job state.

Cần phân biệt cái gì là **cache** và cái gì là **source of truth**.

Đề xuất TTL/invalidation strategy và failure behavior khi Redis down.

---

## 13.4 Queue / Async Jobs

So sánh nếu cần:

- BullMQ + Redis.
- RabbitMQ.
- Kafka.
- Cloud-native queue.

Không chọn Kafka chỉ vì “scale”. Cần căn cứ vào AIHUB workload.

Use cases:

- Long-running AI jobs.
- Usage reconciliation.
- Billing/metering aggregation.
- Webhook delivery + retry.
- Audit/event pipeline.

Đưa ra recommendation cho MVP và path nâng cấp.

---

## 13.5 API Key Design

Brainstorm chi tiết:

- Key format/prefix, ví dụ `aihub_sk_live_...`.
- Generation entropy.
- Hashing strategy.
- Prefix lookup.
- Rotation.
- Multiple active keys / Organization.
- Expiration.
- Revocation.
- Scope binding.
- Environment binding.
- Last-used tracking.
- Secret display one-time.
- Audit logs.

Đề xuất DB representation và request authentication flow.

---

## 13.6 Signed End-user Assertion

Đánh giá/đề xuất:

- JWT asymmetric algorithms (`RS256`, `ES256`, `EdDSA`).
- JWKS discovery/cache.
- Key rotation.
- `iss/sub/aud/iat/exp/jti` validation.
- Replay protection có cần cho mọi request không?
- Clock skew.
- Tenant ↔ issuer mapping.
- Nếu Customer chưa có JWKS thì fallback public-key registration như thế nào?

Current recommended TTL: tối đa khoảng 5 phút.

---

## 13.7 Internal JWT AIHUB → AI Service

Đề xuất:

- Signing algorithm.
- Key rotation.
- JWKS endpoint của AIHUB.
- Token TTL.
- Claims bắt buộc.
- `aud` per AI Service.
- `scope` per operation.
- Service verification middleware/library.
- Có cần mTLS ngay hay phase sau.

---

## 13.8 Routing / Downstream Resolver / Adapter

Đề xuất architecture code-level:

```text
Controller
→ Request Validation
→ Auth
→ Authorization
→ Rate Limit / Quota
→ Operation Resolver
→ Downstream Resolver
→ Adapter
→ HTTP Client
→ Response Adapter
→ Metering
→ Unified Response
```

Cần brainstorm:

- Routing config hard-coded vs DB/config-driven.
- Versioning.
- Feature flags.
- Canary routing.
- Failover giữa multiple instances/providers.
- Adapter interface.
- Error mapper interface.
- Operation Catalog representation.
- Hot reload config có cần không.

---

## 13.9 Unified Error Model

Đề xuất taxonomy rõ ràng cho:

- Authentication.
- Authorization.
- Invalid request/schema.
- Rate limit.
- Quota exceeded.
- Downstream timeout.
- Downstream unavailable.
- Downstream throttled.
- Unsupported operation.
- Internal contract violation.
- Metering incomplete.
- Idempotency conflict.

Cần phân biệt:

```text
AIHUB rate-limit         → 429
AIHUB quota              → 429 hoặc business-specific rule
Downstream throttling    → không để client hiểu nhầm chính họ bị AIHUB throttle
```

Đề xuất `retryable`, `retry_after_ms`, `request_id` semantics.

---

## 13.10 Rate Limit / Quota / Billing

Brainstorm:

- Token Bucket / Sliding Window / GCRA.
- Scope theo org/key/operation.
- Redis Lua vs library vs gateway plugin.
- Hard quota vs soft quota.
- Reservation model cho token-based quota có cần không.
- Usage aggregation từ AI Services.
- Billing accuracy khi downstream trả usage trễ/thiếu.
- Reconciliation.
- Periodic rollup.
- Source of truth cho billable usage.

---

## 13.11 Idempotency

Thiết kế chi tiết:

- `Idempotency-Key` contract.
- Key scope:

```text
(organization_id, operation, idempotency_key)
```

- Request fingerprint/hash để detect same key + different payload.
- Pending/completed/failed states.
- Response replay.
- Concurrent duplicate handling.
- Retention 24h default có hợp lý không.
- Storage: PostgreSQL vs Redis + durable fallback.

---

## 13.12 Observability

Đề xuất stack và signal:

- OpenTelemetry.
- Prometheus.
- Grafana.
- Loki / alternative.
- Tempo / Jaeger.

Trace flow:

```text
Customer Backend
→ AIHUB
→ AI Service
→ Model Provider / DB / Worker
```

Cần metric:

- RPS.
- p50/p95/p99 latency.
- `total_ms`.
- `downstream_ms`.
- Gateway overhead.
- Error rate by operation/downstream.
- Rate-limit rejects.
- Quota rejects.
- Token usage.
- Circuit-breaker state.
- Queue depth nếu async.

Phân biệt `request_id`, `trace_id`, client `correlation_id`.

---

## 13.13 Deployment / Infrastructure

Đề xuất theo ít nhất 2 phase:

### MVP / initial production

Có thể cân nhắc:

- Docker Compose / VPS.
- Managed PostgreSQL.
- Redis.
- Reverse proxy/load balancer.
- TLS.
- Private network giữa AIHUB và AI services.

### Scale-out

Có thể cân nhắc:

- Kubernetes.
- HPA.
- Managed DB/Redis.
- Service discovery.
- Ingress/Gateway API.
- mTLS/service mesh chỉ nếu có lợi ích thực tế.

Agent cần tránh đề xuất K8s/service mesh chỉ vì “best practice”. Hãy đưa trigger rõ ràng khi nào cần nâng cấp.

---

## 13.14 Security Threat Model

Phân tích ít nhất:

- API key leak.
- Brute-force key guessing.
- Header spoofing.
- Forged `X-User-Assertion`.
- JWT replay.
- Cross-tenant data access.
- IDOR.
- SSRF từ configurable downstream URL.
- Secret leakage trong logs.
- Payload size abuse.
- Expensive AI request DoS.
- File upload abuse.
- Webhook SSRF/replay nếu có.
- Internal API bị expose nhầm ra Internet.

Đề xuất controls theo mức **Must / Should / Later**.

---

## 13.15 Testing Strategy

Đề xuất:

- Unit tests cho mapper/auth/error mapper.
- Contract tests AIHUB ↔ AI Service.
- Schema tests.
- Integration tests.
- E2E tests.
- Load tests.
- Failure injection.
- Security tests.
- Idempotency race tests.
- JWT/JWKS rotation tests.
- Golden fixtures cho Provider Mapper.

Cần trả lời có nên dùng Pact/consumer-driven contract testing hay JSON Schema/OpenAPI validation là đủ cho phase đầu.

---

## 13.16 OpenAPI / SDK / Developer Experience

Brainstorm:

- OpenAPI 3.1.
- Generate SDK hay manual SDK.
- Postman collection.
- API versioning.
- Deprecation policy.
- Error documentation.
- Examples.
- Idempotency docs.
- Usage metadata docs.
- Auth quick-start.

---

## 13.17 Streaming

AI endpoints tương lai có thể cần streaming.

Agent cần đánh giá:

- SSE vs WebSocket.
- Proxy streaming qua NestJS/Fastify/Envoy.
- Buffering phải tắt ở đâu.
- Timeout khác với normal HTTP như thế nào.
- Usage metadata thường chỉ biết ở cuối stream thì response contract xử lý ra sao.
- Client disconnect propagation.
- Billing/metering khi stream bị cancel giữa chừng.

Không nhất thiết implement streaming ngay, nhưng architecture không nên khóa đường nâng cấp.

---

# 14. Candidate Tech Stack để agent đánh giá

> **Đây là candidate, không phải quyết định bắt buộc.**

```text
Language / Runtime       TypeScript + Node.js
Backend Framework        NestJS + Fastify
HTTP Client              undici / native fetch
Primary DB               PostgreSQL
Cache / Rate Limit       Redis
Async Jobs (MVP)         BullMQ nếu use case phù hợp
Object Storage           S3-compatible / Cloudflare R2
Observability            OpenTelemetry + Prometheus + Grafana + Tempo/Loki
API Schema               OpenAPI 3.1 + JSON Schema
Deployment MVP           Docker + VPS/managed services
Future orchestration     Kubernetes nếu scale/ops justify
```

Hãy đánh giá từng item theo:

```text
Keep
Replace
Defer
```

và giải thích ngắn gọn.

---

# 15. Scale assumptions — nếu thiếu dữ kiện hãy dùng range

Hiện chưa có scale target chính thức trong brief này.

Không được tự giả định AIHUB có hàng triệu RPS.

Hãy đánh giá ít nhất 3 mức:

```text
Stage A — MVP
10–50 RPS
vài Organization

Stage B — Growth
100–1,000 RPS
hàng chục/hàng trăm Organization

Stage C — Larger scale
1,000+ RPS
nhiều downstream AI services
```

Với mỗi decision quan trọng, nói rõ nó có cần thay đổi khi chuyển stage hay không.

Lưu ý: AI request thường có latency cao hơn CRUD API và có thể giữ connection lâu, nên concurrency có thể quan trọng hơn RPS thuần túy.

---

# 16. Output bắt buộc của AI Agent

Hãy trả kết quả theo đúng cấu trúc sau.

## A. Executive Recommendation

Một kiến trúc recommended tổng thể, tối đa khoảng 1–2 trang.

## B. Recommended Tech Stack Matrix

| Layer          | Recommended | Alternatives | Why |
| -------------- | ----------- | ------------ | --- |
| Runtime        |             |              |     |
| Framework      |             |              |     |
| DB             |             |              |     |
| Redis          |             |              |     |
| Queue          |             |              |     |
| Object Storage |             |              |     |
| Proxy/LB       |             |              |     |
| Observability  |             |              |     |
| Deployment     |             |              |     |

## C. Architecture Diagram

Mermaid hoặc ASCII, gồm cả:

```text
Client
→ AIHUB
→ Redis/PostgreSQL
→ AI Service
→ Model Provider
```

và async path nếu đề xuất.

## D. Request Lifecycle

Sequence cho ít nhất:

1. `POST /v1/ielts/writing/grade` sync.
2. Một async media operation.
3. Một failed downstream request.

## E. Database Design

Đề xuất tables + important columns + indexes + unique constraints.

Không cần viết full SQL migration nếu không cần, nhưng schema phải đủ cụ thể để implement.

## F. Redis Design

Key patterns, TTL, source-of-truth rule và behavior khi Redis unavailable.

## G. Auth & Identity Design

- API Key.
- User Assertion.
- Internal JWT.
- JWKS/key rotation.
- Authorization.

## H. Routing & Adapter Design

Interfaces/modules + example pseudocode hoặc TypeScript signatures.

## I. Reliability Design

- timeout;
- retry;
- circuit breaker;
- idempotency;
- concurrency limit;
- backpressure.

## J. Unified Error Model

Error taxonomy + mapping examples.

## K. Usage / Metering / Billing

Source of truth + aggregation + reconciliation.

## L. Observability

Logs + metrics + traces.

## M. Security Threat Model

Top threats + controls.

## N. Deployment Roadmap

Ít nhất:

```text
Phase 1 — D1 contract
Phase 2 — Core Proxy MVP
Phase 3 — Auth + identity + metering
Phase 4 — Reliability + async
Phase 5 — Scale-out
```

Nếu thấy phase nên khác, hãy đề xuất lại.

## O. ADR List

Liệt kê các Architecture Decision Records nên tạo, ví dụ:

```text
ADR-001 Choose NestJS/Fastify
ADR-002 Choose PostgreSQL for control plane
ADR-003 Organization API Key format
ADR-004 End-user assertion protocol
ADR-005 Internal JWT trust model
ADR-006 Redis responsibilities
ADR-007 Idempotency storage
ADR-008 Async queue
ADR-009 Object storage
ADR-010 Proxy vs dedicated data plane
```

## P. Open Questions

Chỉ hỏi những câu thực sự có thể làm thay đổi architecture.

Mỗi câu cần kèm:

```text
Why it matters
Recommended default if team has no opinion
```

---

# 17. Design principles

Agent cần tuân theo các nguyên tắc:

1. **Do not over-engineer.**
2. **Public contract ổn định hơn implementation phía sau.**
3. **Fail closed cho auth/authorization.**
4. **Không tin identity field do untrusted frontend tự khai báo.**
5. **Tenant isolation phải explicit ở mọi user-scoped data access.**
6. **Không retry generative POST mù quáng.**
7. **Không tự đoán token usage ở gateway.**
8. **Redis không mặc định là source of truth cho durable business/control-plane state.**
9. **Không chọn Kafka/Kubernetes/service mesh nếu workload chưa justify.**
10. **Mỗi recommended technology phải có lý do gắn với AIHUB workload.**
11. **Ưu tiên migration path đơn giản từ MVP → production → scale.**
12. **Nếu một requirement chưa rõ, state assumption + recommended default.**

---

# 18. Những câu hỏi trọng tâm nhất cần được trả lời

Nếu thời gian brainstorm hạn chế, ưu tiên trả lời thật sâu các câu sau:

1. **AIHUB nên build bằng NestJS + Fastify hay công nghệ khác?**
2. **Có cần Envoy/Kong/NGINX làm data plane hay app AIHUB tự proxy là đủ?**
3. **PostgreSQL schema cho Organization/API Key/Scope/Routing/Usage nên thiết kế thế nào?**
4. **Redis nên giữ những gì và không nên giữ những gì?**
5. **Cách làm API key lookup vừa nhanh vừa an toàn?**
6. **Signed End-user Assertion + JWKS triển khai production thế nào?**
7. **Internal JWT/key rotation giữa AIHUB và AI Services nên làm thế nào?**
8. **Provider/Downstream Adapter nên tổ chức code và contract ra sao để dễ thêm AI Service mới?**
9. **Rate limit/quota/idempotency/retry/circuit breaker nên đặt ở layer nào?**
10. **Usage/metering làm sao đủ chính xác cho billing khi AIHUB chỉ proxy?**
11. **Async/media workload nên dùng BullMQ/RabbitMQ/khác?**
12. **Streaming về sau có làm thay đổi lựa chọn framework/proxy hiện tại không?**
13. **MVP deployment đơn giản nhất nhưng vẫn có đường scale hợp lý là gì?**
14. **Top security risks của multi-tenant AI Gateway này là gì?**

---

# 19. Final instruction cho AI Agent

Hãy đưa ra một **recommended architecture có thể implement được**, không chỉ brainstorm chung chung.

Nếu team không có ý kiến cho một open decision, hãy ghi rõ:

```text
Recommended Default: <option>
Reason: <1–3 câu>
```

Ưu tiên giải pháp phù hợp với một team backend nhỏ/trung bình đang xây MVP nhưng muốn tránh technical debt lớn ở authentication, tenant isolation, API contract và metering.
