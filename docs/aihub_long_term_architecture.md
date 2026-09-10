# AIHUB — Long-Term Architecture

> **Mục đích:** Mô tả kiến trúc đích dài hạn khi **AIHUB là public API gateway duy nhất**, còn các AI services phía sau chỉ expose **private API**.
>
> **Cách đọc tài liệu này.** Phần lớn kiến trúc mô tả ở đây đã được triển khai. Những mục đó nay chỉ còn **một dòng trỏ tới nguồn hiện hành** — spec, code, hoặc contract — vì hai tài liệu cùng mô tả một cơ chế thì cái cũ sẽ âm thầm sai. Tài liệu này giữ lại đúng ba thứ: **trạng thái đích chưa xây**, **ranh giới trách nhiệm giữa AIHUB và AI Service**, và **§32 — hồ sơ quyết định** mà `aihub_deliverable_1_api_contract_schema.md` trích dẫn.
>
> **Khi mâu thuẫn: implementation spec và code thắng.** Số mục giữ nguyên để các tham chiếu `§32.x` trong D1 không gãy.

---

# 1. Executive Summary

AIHUB được thiết kế như một **multi-tenant AI API Gateway + Identity Broker + Downstream Adapter Layer**.

```text
Customer Backend
       │
       │ AIHUB Public API
       │ Organization API Key
       │ Signed End-user Assertion (nếu operation cần user context)
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

- Client **không gọi trực tiếp** AI Writing / Speaking / Reading.
- AIHUB là public API boundary duy nhất.
- AI services chỉ reachable trong private network.
- Client chỉ phụ thuộc vào contract của AIHUB.
- AIHUB che giấu URL, contract và implementation details của downstream services.
- Business data vẫn do từng AI service/domain sở hữu.

---

# 2. Terminology

Từ **Provider** dễ bị hiểu theo hai nghĩa khác nhau, nên bảng này cố định cách dùng.

| Term                         | Ý nghĩa trong tài liệu                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- |
| **Organization / Tenant**    | Khách hàng/doanh nghiệp sử dụng AIHUB                                             |
| **End User / Actor**         | User/học viên cụ thể bên trong Organization                                       |
| **AI Service**               | Downstream service của hệ thống, ví dụ AI Writing, AI Speaking, AI Reading        |
| **Model Provider**           | Nền tảng/model bên dưới mà AI Service có thể gọi, ví dụ OpenAI, Anthropic, Google |
| **Downstream Adapter**       | Lớp trong AIHUB map canonical contract sang contract của AI Service               |
| **Canonical Contract**       | Public request/response contract thống nhất của AIHUB                             |
| **Internal Contract**        | Contract private giữa AIHUB và AI Service                                         |
| **Organization Entitlement** | Những capability/service mà Organization được phép dùng theo plan/subscription    |
| **API Key Scope**            | Những capability cụ thể mà một API key được phép gọi                              |

Glossary ngắn cho công việc hằng ngày: [`CONTEXT.md`](../CONTEXT.md).

---

# 3. Responsibility Boundary

Phần này vẫn là nguồn chính khi **thêm một AI Service mới** — nó nói rõ AIHUB không nhận việc gì.

## 3.1 AIHUB chịu trách nhiệm

- Public API contract.
- Organization authentication bằng API key.
- End-user identity verification khi operation cần user context.
- Authorization.
- Rate limiting / quota.
- Routing tới AI Service.
- Request/response transformation.
- Unified error mapping.
- Gateway-level timing.
- Usage aggregation/metering dựa trên metadata do AI Service trả về.
- Audit logging / tracing.
- Issuing short-lived internal JWT.

## 3.2 AI Service chịu trách nhiệm

- Domain/business logic.
- Domain database.
- Gọi model/RAG/tool/worker nội bộ.
- Trả usage/model/processing metadata mà chỉ service đó biết.
- Enforce downstream identity context (`org_id`, `actor_id`) khi truy cập user-scoped data.

## 3.3 Model Provider chịu trách nhiệm

- Inference/model execution.
- Model-specific token usage hoặc metering nếu API hỗ trợ.
- Model-specific errors/limits.

---

# 4. Public Boundary và Private AI Services

Trạng thái đích: AI Service chỉ reachable từ private network / AIHUB.

**Hiện chưa đạt, và đó là quyết định có chủ đích.** `api-ielts-writing.aihubproduction.com` vẫn public vì đang phục vụ một ứng dụng khác chưa đi qua AIHUB. Không đóng được cho tới khi ứng dụng đó cũng chuyển sang gọi AIHUB.

**Ranh giới thật ở giai đoạn này là credential, không phải network.** Chừng nào khách hàng của AIHUB không bao giờ được cấp token của Writing, thì với họ AIHUB vẫn là đường vào duy nhất.

Ba điều kiện giữ cho rủi ro ở mức chấp nhận được:

1. Token Writing **không bao giờ** cấp cho khách hàng AIHUB — đây là quy trình, không phải kỹ thuật.
2. AIHUB dùng **token riêng**, tách khỏi token của ứng dụng kia, để usage tách bạch và thu hồi độc lập được.
3. Mọi endpoint của Writing đều có auth.

→ Phân tích đầy đủ: [`09-security.md`](superpowers/specs/2026-09-07-aihub/09-security.md).

Vì toàn bộ service sẽ private nên không bắt buộc phải có prefix `/internal`.

---

# 5. Multi-tenant Model

Identity của end-user là **composite**, không phải `external_user_id` đơn lẻ:

```text
(organization_id, external_user_id)
```

Org A → `user_123` và Org B → `user_123` là hai actor khác nhau. Không cần layer `Team` nếu requirement chỉ có một cấp Organization.

→ Đã triển khai. Schema: `database/migrations/0001_control_plane.sql`.

---

# 6. Organization API Key

→ **Đã triển khai.** Format, sinh key, hash SHA-256 và lý do không dùng bcrypt/argon2, lookup flow, negative cache: [`05-auth-identity.md` §G.1–G.3](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/`.

Một nguyên tắc vận hành không nằm trong code, nên nhắc lại ở đây: **không để frontend/mobile giữ Organization API Key.** Key phải nằm ở Customer Backend. Đây là quy trình onboarding, AIHUB không tự kiểm chứng được.

→ Hướng dẫn cho khách: [`integration-guide.md`](integration-guide.md) §1.

---

# 7. Environment

**Deployment hostname là source of truth cho environment.** API key được bind vào `allowed_environments` nhưng không tự quyết định environment của request.

→ Đã triển khai, kèm cảnh báo `Host` header là do client tự khai và cần reverse proxy validate: [`05-auth-identity.md` §G.11](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/presentation/request-environment.ts`.

---

# 8. End-user Identity

Trust model: **Signed End-user Assertion**. Customer Backend ký, AIHUB verify bằng JWKS của Organization. AIHUB không quản lý user của khách.

→ **Đã triển khai.** Thứ tự verify, chống alg confusion, `UNIQUE(issuer)` chặn cross-tenant, trần TTL, chống SSRF khi fetch JWKS, chiến lược cache: [`05-auth-identity.md` §G.4–G.6](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/identity/application/user-assertion-verifier.ts`.

→ Hướng dẫn ký cho khách, kèm ví dụ Node/Python/Java: [`integration-guide.md`](integration-guide.md) §3.

---

# 9. Request Identity Context

Sau khi authenticate/verify, AIHUB normalize thành một context nội bộ và **không để controller/business logic đọc raw headers để tự suy identity**.

→ Đã triển khai: `src/common/request-context/`.

---

# 10. Authorization

Hai lớp khác nhau, giao nhau:

```text
Organization Entitlement  ∩  API Key Scope  →  Effective Scope
```

→ Đã triển khai, fail-closed: `src/modules/identity/application/authorization.ts`. Lý do và ví dụ: [`05-auth-identity.md` §G.10](superpowers/specs/2026-09-07-aihub/05-auth-identity.md).

---

# 11. AIHUB → AI Service: Short-lived Internal JWT

AIHUB không forward customer credential xuống AI Service. Nó mint JWT nội bộ just-in-time, TTL ngắn, `aud` riêng cho từng service, không lưu DB, không refresh.

→ **Đã triển khai.** Claims, lý do chọn EdDSA, quy trình xoay khoá 5 bước: [`05-auth-identity.md` §G.7–G.8](superpowers/specs/2026-09-07-aihub/05-auth-identity.md). Code: `src/modules/gateway/infrastructure/configured-token-issuer.ts`.

---

# 12. Service-to-service Security

Hai lớp trả lời hai câu hỏi khác nhau, không thay thế nhau:

```text
Network policy / mTLS  →  service/workload nào đang kết nối?
Internal JWT           →  request đang đại diện cho org/actor/scope nào?
```

Quyết định phase đầu ở [§32.10](#3210-phase-đầu-có-cần-mtls-không).

---

# 13. Canonical Public API Contract

Client chỉ phụ thuộc contract của AIHUB. AIHUB che tên field, tên endpoint và cách đặt tên của AI Service.

→ **Contract hiện hành là code, không phải tài liệu.** Schema: `src/contracts/writing/`. Bản sinh tự động: `openapi.json`, phục vụ tại `GET /docs`. Đặc tả và Data Dictionary: [`aihub_deliverable_1_api_contract_schema.md`](aihub_deliverable_1_api_contract_schema.md) §10 và §20.

---

# 14. Downstream Adapter Layer

Lớp map canonical contract ↔ contract riêng của từng AI Service. Adapter là **hàm thuần**: không network, không config, không thời gian — nhờ vậy test được bằng fixture thật thay vì mock.

Adapter xử lý: field rename, enum/value conversion, default values, nested transformation, unsupported options, media transformation, service-specific response và error mapping.

MVP dùng adapter bằng code thay vì dynamic rule engine.

→ **Đã triển khai.** Interface: `src/downstream/downstream-adapter.ts`. Adapter Writing: `src/downstream/writing/`. Nguyên tắc bắt buộc — không bao giờ đoán shape downstream, phải capture fixture thật trước: [`AGENTS.md`](../AGENTS.md) và [`06-routing-adapter.md`](superpowers/specs/2026-09-07-aihub/06-routing-adapter.md).

---

# 15. Internal AI Service Response Contract

> **Chưa đạt.** AI Writing hiện không trả `usage`, `models`, hay `metrics`. Đây là contract AIHUB đề nghị mọi AI Service tuân theo, và là điều kiện tiên quyết cho metering/billing ở §24.

Phân biệt rõ hai loại dữ liệu trong response:

```text
Domain data          → khác nhau giữa Writing / Speaking / Reading
Operational metadata → nên chuẩn hoá giữa mọi AI Service
```

```ts
interface InternalAIServiceResponse<TData> {
  data: TData;

  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    // Optional: chi tiết khi operation gọi model nhiều lần.
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

Quy tắc:

- `data` là service-specific domain payload.
- `usage`, `models`, `metrics` là common internal metadata.
- Response Adapter map `data` thành canonical public data.
- **AIHUB không tự đoán token usage.**

---

# 16. Token Usage khi một request gọi model nhiều lần

> **Chưa đạt**, phụ thuộc §15.

Một operation có thể chạy: LLM call #1 + RAG + LLM call #2 + evaluator model. Nếu chỉ trả usage của một call thì billing sai.

**`usage.inputTokens` / `outputTokens` / `totalTokens` là aggregate của toàn operation**, `calls[]` là breakdown optional cho internal metering.

Public API chỉ expose aggregate — xem [§32.7](#327-public-response-expose-model-breakdown-hay-chỉ-aggregate-usage).

---

# 17. Timing và Source of Truth

## 17.1 Định nghĩa

Không dùng `provider_ms` vì từ này lẫn giữa AI Service và Model Provider.

```text
total_ms
= AIHUB ingress → AIHUB egress

downstream_ms
= từ lúc AIHUB bắt đầu HTTP call tới AI Service
  cho tới khi AIHUB nhận xong response
  (bao gồm network + AI Service execution)

ai_processing_ms
= thời gian AI Service tự đo phần xử lý AI nội bộ
  (optional, không bao gồm network AIHUB ↔ AI Service)

gateway_overhead_ms
≈ total_ms - downstream_ms
```

Không giả định `total_ms = gateway_ms + ai_processing_ms` — còn network/downstream overhead ở giữa.

→ Ba trường đầu đã có trong `meta.timing` của mọi response. `ai_processing_ms` chờ §15. Shape thật: `src/common/http/success-envelope.interceptor.ts`.

## 17.2 Source-of-truth matrix

| Field                   | Source of truth                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `request_id`            | AIHUB                                                                                       |
| `service` / `operation` | AIHUB routing metadata                                                                      |
| `total_ms`              | AIHUB                                                                                       |
| `downstream_ms`         | AIHUB                                                                                       |
| `gateway_overhead_ms`   | AIHUB derived metric                                                                        |
| `ai_processing_ms`      | AI Service                                                                                  |
| `input_tokens`          | AI Service / underlying Model Provider                                                      |
| `output_tokens`         | AI Service / underlying Model Provider                                                      |
| `total_tokens`          | AI Service aggregate                                                                        |
| model(s) thực tế        | AI Service — **internal only**, không có trong public response                              |
| `metering_status`       | AIHUB — internal only. `complete` / `missing_usage` / `not_applicable` / `quota_unverified` |
| public cost             | AIHUB từ normalized usage + pricing config, hoặc business rule riêng                        |

> Endpoint không gọi model nên **omit `usage`** hoặc trả `null`; không nên giả token bằng `0`.

**`meta.models[]` không có trong public response.** Cho khách thấy tên model cụ thể khiến public contract phụ thuộc implementation phía sau: đổi model trở thành breaking change, hoặc tệ hơn là khách viết logic dựa trên tên model. Chi tiết model vẫn giữ ở internal contract cho metering và debug.

---

# 18. Request ID và Correlation ID

Canonical `request_id` do **AIHUB generate**; không tin id từ client làm primary tracing id. Client có thể gửi `X-Correlation-Id` để nối log hai bên.

→ Đã triển khai: `src/common/request-context/request-id.ts`, echo trong `meta.correlation_id`.

---

# 19. Retry và Idempotency

→ **Đã triển khai.** Fingerprint, xử lý race không cần distributed lock, quy tắc xoá record khi 4xx, ca timeout + `Idempotency-Key` để không mất tiền hai lần: [`07-reliability-and-errors.md` §I.2–I.5](superpowers/specs/2026-09-07-aihub/07-reliability-and-errors.md). Code: `src/modules/idempotency/`.

TTL mặc định chốt ở [§32.9](#329-idempotency-retentionttl-là-bao-lâu).

---

# 20. Unified Error Model

Nguyên tắc giữ nguyên: một envelope duy nhất, không tầng nào tự chọn HTTP status, và raw downstream error chỉ log nội bộ — không leak stack trace, private URL, DB error, hay secret của provider.

→ **Đã triển khai.** Ma trận đầy đủ kèm cột Downstream Signal: [`aihub_deliverable_1_api_contract_schema.md`](aihub_deliverable_1_api_contract_schema.md) §25 (US10). Registry: `src/common/errors/error-registry.ts`. Bản rút gọn cho khách: [`integration-guide.md`](integration-guide.md) §8.

Ba mã đáng tách riêng và lý do — `AI_SERVICE_CONTRACT_VIOLATION`, `IDENTITY_PROVIDER_UNAVAILABLE`, `CONCURRENCY_LIMIT` — ghi ở US10, không lặp lại ở đây.

---

# 21. Sync vs Async Operations

> **Chưa xây phần async.** Cả 4 operation hiện tại đều sync.

## 21.1 Sync

```http
POST /v1/ielts/writing/task1/grade
→ 200 OK
```

## 21.2 Async

Phù hợp audio/video/pipeline dài:

```http
POST /v1/speaking/grade
→ 202 Accepted
```

```json
{ "data": { "job_id": "job_01JXYZ", "status": "queued" } }
```

Sau đó `GET /v1/jobs/{job_id}`, hoặc webhook/callback nếu platform hỗ trợ.

> Contract catalog phải ghi rõ **mỗi operation là sync hay async**; không để implementation tự quyết định sau khi client đã tích hợp.

Ngưỡng chốt ở [§32.5](#325-operation-nào-sync-operation-nào-async).

---

# 22. File / Audio / Media Input Policy

> **Chưa xây.** Cả 4 operation hiện tại chỉ nhận `application/json`. Object storage và presigned upload vào cùng lúc với Speaking.

Không để mỗi capability tự chọn base64/multipart/url tuỳ ý.

| Loại input        | Cách nhận                                                    |
| ----------------- | ------------------------------------------------------------ |
| Text / small JSON | `application/json`                                           |
| Media nhỏ/vừa     | `multipart/form-data` với size limit rõ ràng                 |
| Media lớn         | Presigned upload lên object storage → `asset_id` → gọi AIHUB |

```json
{ "audio": { "asset_id": "asset_01JXYZ" } }
```

Không khuyến nghị base64 cho file lớn: tăng payload, memory và bandwidth.

Ngưỡng chốt ở [§32.6](#326-fileaudio-dùng-multipart-hay-asset_id--presigned-upload).

---

# 23. Routing Catalog

→ Bảng operation hiện hành nằm ở code: `src/catalog/operation-catalog.ts`.

Hai quyết định về **chỗ đặt** catalog cần giữ lại, vì code không tự nói ra:

**Routing catalog nằm ở code, không ở database.** Adapter vốn đã là code nên thêm AI Service mới vẫn phải deploy — config trong DB không giúp tránh deploy, chỉ tách sự thật ra làm hai chỗ.

**URL downstream trong DB là một lỗ SSRF.** Ai ghi được vào bảng đó thì trỏ được AIHUB vào `169.254.169.254`, trong khi AIHUB đang cầm internal JWT. Để ở biến môi trường thì không có bề mặt tấn công đó.

Sinh đề là `organization`-scoped vì kết quả không thuộc về học viên nào; chấm bài là `user`-scoped vì kết quả gắn với một học viên cụ thể — theo nguyên tắc fail-closed ở [§32.4](#324-operation-nào-organization-scoped-operation-nào-user-scoped).

---

# 24. Rate Limit, Quota và Billing

Rate limit và concurrency limit **đã triển khai** (`src/modules/gateway/`, đếm trên Redis theo tổ chức). Quota, subscription, metering và billing **chưa**.

Nguyên tắc cho phần chưa làm:

- Usage/billing dựa trên **normalized usage do AI Service trả về**, không dựa trên token estimate tại gateway.
- Nếu usage thiếu: **không tự bịa số**; đánh dấu metering incomplete; log/metric để phát hiện contract violation; business rule quyết định fail hay cho qua tuỳ operation/plan.

Xử lý runtime khi thiếu usage chốt ở [§32.8](#328-nếu-ai-service-không-trả-usage-metadata-thì-xử-lý-thế-nào). Phụ thuộc §15.

---

# 25. Observability

`request_id` do AIHUB sinh, truyền xuống downstream, và là **tracing metadata — không phải identity**.

Cần đo, khi có chỗ để đo:

- request count;
- latency p50/p95/p99;
- `downstream_ms`;
- `ai_processing_ms` nếu downstream cung cấp;
- error rate theo AI Service;
- Model Provider error/throttle rate nếu AI Service expose;
- rate-limit/quota rejects;
- token usage từ downstream;
- circuit breaker state.

→ Trạng thái hiện tại và quyết định hoãn distributed tracing: [`08-metering-and-observability.md`](superpowers/specs/2026-09-07-aihub/08-metering-and-observability.md).

---

# 26. Data Ownership

AIHUB giữ **control-plane data**; mỗi AI Service giữ **business data** của mình.

| AIHUB (control plane)                                                                                                       | AI Service (business data)                                                          |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `organizations`, `api_keys`, `organization_identity_configs`, `idempotency_records` — **đã có**                             | Writing attempts/results → Writing DB                                               |
| `plans`, `subscriptions`, `organization_entitlements`, `quota_configs`, `usage_records` — **chưa có**, vào cùng lúc với §24 | Speaking results/audio → Speaking DB + Object Storage; Reading results → Reading DB |

Ranh giới này là bất biến của hệ thống: AIHUB không bao giờ lưu bài viết của học viên, và AI Service không bao giờ lưu API key.

---

# 30. Kiến trúc chốt

> **AIHUB is a multi-tenant AI API Gateway that authenticates organizations using API keys, verifies end-user assertions for user-scoped operations, computes effective authorization from organization entitlements and API-key scopes, normalizes public API contracts, maps requests to private AI services, and propagates trusted identity downstream using short-lived internal JWTs.**

Identity chain:

```text
Organization API Key      → Organization Identity
Signed End-user Assertion → Actor Identity
AIHUB Internal JWT        → Trusted Downstream Identity (org_id + actor_id + scope)
```

Luồng request đầy đủ theo từng chặng, kèm file và mã lỗi: [`02-request-lifecycle.md`](superpowers/specs/2026-09-07-aihub/02-request-lifecycle.md).

> Mục 27–29 của bản trước — module design, full request flow, sequence diagram — đã bị gỡ vì code và spec mô tả chính xác hơn. Cấu trúc thư mục thật: [`README.md`](../README.md) mục Source layout.

---

# 31. Roadmap

| Phase                                      | Nội dung                                                                                                                         | Trạng thái                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **1 — Contract Foundation**                | Canonical contract, API key contract, identity contract, adapter contract, error codes, usage/timing metadata, operation catalog | Xong, trừ usage metadata      |
| **2 — Core Gateway + Private AI Services** | API key middleware, routing/dispatcher, internal JWT, user assertion verification, adapters, network policy                      | Xong, trừ network policy      |
| **3 — Platform Capabilities**              | Rate limiting, quota, subscription/plan, usage metering, billing, audit logs, idempotency                                        | Rate limit + idempotency xong |
| **4 — Reliability & Scale**                | Circuit breaker, retry + backoff/jitter, load shedding, downstream failover, distributed tracing, SLO/SLI                        | Chưa                          |

Trigger cụ thể để rời khỏi kiến trúc hiện tại: [`10-deployment-roadmap.md` §N.5](superpowers/specs/2026-09-07-aihub/10-deployment-roadmap.md).

---

# 32. Open Decisions — đã chốt

> **Trạng thái 2026-09-07: cả 10 quyết định đã chốt theo Recommended default.**
> Toàn bộ đã được phản ánh vào `aihub_deliverable_1_api_contract_schema.md` và vào architecture design ở
> [`docs/superpowers/specs/2026-09-07-aihub/`](superpowers/specs/2026-09-07-aihub/README.md).
> **Giữ nguyên phần options bên dưới làm hồ sơ lý do** — sau này muốn đổi thì đọc lại trade-off đã cân nhắc. Đây là lý do mục 32 không bị rút gọn như các mục khác.

Nguyên tắc: các default dưới đây ưu tiên **contract rõ ràng, security đủ tốt, dễ triển khai ở phase đầu và vẫn có đường nâng cấp về sau**.

---

## 32.1 API key dùng `X-API-Key` hay `Authorization`?

### Options

**Option A — `X-API-Key`**

```http
X-API-Key: aihub_sk_live_xxx
```

**Option B — `Authorization: Bearer`**

```http
Authorization: Bearer aihub_sk_live_xxx
```

### Recommended default

**Chọn `X-API-Key`.**

### Lý do

AIHUB đang có nhiều loại credential/context khác nhau như Organization API Key, User Assertion và internal JWT. Dùng `X-API-Key` giúp vai trò của Organization API Key rõ ràng hơn và tránh nhầm với bearer JWT ở các boundary khác.

Quy ước đề xuất:

```text
Client → AIHUB:
X-API-Key          = Organization credential
X-User-Assertion   = End-user identity assertion (khi operation user-scoped)

AIHUB → AI Service:
Authorization      = Bearer <AIHUB_INTERNAL_JWT>
```

---

## 32.2 User Assertion dùng JWKS URL hay upload public key?

### Options

**Option A — JWKS URL**

Organization đăng ký một URL như:

```text
https://customer.example.com/.well-known/jwks.json
```

AIHUB fetch/cached public keys theo `kid` để verify assertion.

**Option B — Upload/Register public key trực tiếp trên AIHUB**

Organization upload PEM/public key trong portal hoặc qua admin API.

### Recommended default

**Ưu tiên JWKS URL.**
**Public-key upload có thể giữ làm fallback cho Organization chưa có JWKS.**

### Lý do

JWKS hỗ trợ key rotation tốt hơn, không cần cập nhật thủ công public key ở AIHUB mỗi lần rotate và phù hợp với B2B federation lâu dài. Upload public key dễ làm hơn cho MVP nhưng operational burden cao hơn khi số Organization tăng.

---

## 32.3 TTL tối đa của User Assertion?

### Options

- 1–2 phút: security chặt nhưng dễ gặp clock skew/network delay.
- 5 phút: cân bằng security và khả năng vận hành.
- 15 phút trở lên: dễ sử dụng hơn nhưng replay window lớn hơn.

### Recommended default

**TTL tối đa: 5 phút.**

Ngoài ra nên yêu cầu:

```text
exp - iat <= 5 phút
clock skew cho phép khoảng ±60 giây
jti nên có nếu cần chống replay ở operation nhạy cảm
```

### Lý do

User Assertion nên là credential ngắn hạn, được Customer Backend tạo gần thời điểm gọi AIHUB. 5 phút đủ chịu network delay/clock skew nhưng vẫn giới hạn replay window.

---

## 32.4 Operation nào organization-scoped, operation nào user-scoped?

### Options

**Organization-scoped**: chỉ cần xác định Organization.

Ví dụ:

```text
- service/catalog metadata
- organization usage summary
- organization configuration
- health/capability discovery
```

**User-scoped**: operation đọc, tạo hoặc thay đổi dữ liệu gắn với một end user cụ thể.

Ví dụ:

```text
- writing.grade
- writing.history
- speaking.grade
- speaking.history
- user-specific feedback/result
```

### Recommended default

**Mặc định mọi operation có đọc/ghi dữ liệu cá nhân hoặc kết quả AI của một end user là `user-scoped`.**
Chỉ các operation thực sự ở cấp Organization mới là `organization-scoped`.

Operation Catalog phải khai báo explicit `identity_scope: user` hoặc `identity_scope: organization`.

### Lý do

Fail-closed an toàn hơn fail-open. Nếu chưa chắc một operation có cần user identity hay không thì coi là user-scoped trước, sau đó relax khi requirement rõ ràng.

---

## 32.5 Operation nào sync, operation nào async?

### Options

**Sync**

```text
Request → AIHUB → AI Service → Response ngay
```

Phù hợp operation ngắn và predictable.

**Async**

```text
POST request
→ 202 Accepted + job_id
→ xử lý background
→ client GET /jobs/{job_id} hoặc webhook
```

Phù hợp operation lâu, xử lý file/audio lớn hoặc pipeline nhiều bước.

### Recommended default

- **Sync** nếu expected processing time thường **≤ 30 giây**.
- **Async** nếu có khả năng thường xuyên **> 30 giây**, xử lý media lớn, hoặc pipeline nhiều bước.

Ví dụ mặc định ban đầu:

```text
Writing grade ngắn          → sync
Simple text generation      → sync
Speaking/audio dài          → async
Long-running analysis       → async
Batch processing            → async
```

### Lý do

Giữ API đơn giản cho request nhanh nhưng tránh giữ HTTP connection lâu và timeout/retry khó kiểm soát cho workload nặng.

---

## 32.6 File/audio dùng multipart hay `asset_id` + presigned upload?

### Options

**Option A — `multipart/form-data`**

Client upload trực tiếp file qua request API.

**Option B — Presigned upload + `asset_id`**

```text
1. Client xin upload URL
2. Upload trực tiếp object storage
3. Nhận/giữ asset_id
4. Gọi AI operation bằng asset_id
```

### Recommended default

**Long-term: ưu tiên presigned upload + `asset_id` cho audio/file.**
Cho phép `multipart/form-data` với file nhỏ, đơn giản (gợi ý ≤ 10 MB) hoặc cho MVP.

### Lý do

Không đẩy file lớn xuyên qua toàn bộ API Gateway giúp giảm memory/bandwidth pressure lên AIHUB, dễ retry upload và scale tốt hơn. Multipart vẫn tiện cho integration nhỏ nên không cần cấm hoàn toàn.

---

## 32.7 Public response expose model breakdown hay chỉ aggregate usage?

### Options

**Option A — Aggregate usage only**

```json
{
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 300,
    "total_tokens": 1500
  }
}
```

**Option B — Expose breakdown từng model call**

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

### Recommended default

**Public API chỉ expose aggregate usage.**
Model/call breakdown giữ cho internal metering, observability hoặc admin/debug API nếu sau này cần.

### Lý do

AIHUB có mục tiêu abstraction các AI Service/Model Provider. Expose chi tiết model quá sớm sẽ làm public contract phụ thuộc implementation phía sau và khó đổi provider/model về sau.

---

## 32.8 Nếu AI Service không trả usage metadata thì xử lý thế nào?

### Options

**Option A — Fail request ngay**

AIHUB coi missing usage là protocol violation và trả lỗi cho client.

**Option B — Trả business response nhưng đánh dấu metering incomplete**

```text
- trả kết quả thành công cho client
- log/metric metering_status = INCOMPLETE
- alert nội bộ
- enqueue reconciliation nếu có thể
- provider/service vi phạm lặp lại có thể bị disable/circuit-break
```

### Recommended default

**Chọn Option B ở runtime. Không làm fail một business response đã xử lý thành công chỉ vì thiếu usage metadata.**

Tuy nhiên đối với operation `metering-critical`, contract/integration test phải coi `usage` là **required** trước khi AI Service được đưa lên production.

### Lý do

Không nên làm mất kết quả của user chỉ vì lỗi telemetry/metering. Nhưng cũng không được âm thầm bỏ qua vì sẽ gây sai billing; cần alert và reconciliation rõ ràng.

---

## 32.9 Idempotency retention/TTL là bao lâu?

### Options

- 1 giờ: nhẹ storage nhưng retry muộn không được deduplicate.
- 24 giờ: đủ cho phần lớn retry/replay thực tế.
- 72 giờ+: an toàn hơn cho workflow dài nhưng giữ record lâu hơn.

### Recommended default

**TTL mặc định: 24 giờ cho mutating/generative POST có `Idempotency-Key`.**

Key nên được scope theo:

```text
(organization_id, operation, idempotency_key)
```

Operation async/job dài có thể override TTL lên 48–72 giờ nếu cần.

### Lý do

24 giờ là điểm cân bằng tốt giữa khả năng retry an toàn và chi phí lưu idempotency record; vẫn cho phép override theo từng operation trong Operation Catalog.

---

## 32.10 Phase đầu có cần mTLS không?

### Options

**Option A — Private network + Internal JWT**

```text
Network Policy / Security Group
+
AIHUB-signed short-lived JWT
```

**Option B — Private network + Internal JWT + mTLS**

Thêm workload/service identity ở transport layer.

### Recommended default

**Phase đầu: Private network + strict network policy + short-lived Internal JWT là đủ.**
Thiết kế certificate/mTLS như một hardening step cho phase sau.

Nâng lên mTLS khi có một trong các nhu cầu:

```text
- cross-VPC / cross-cluster / multi-region
- Zero Trust requirement
- compliance/security requirement cao
- cần strong workload identity ở transport layer
```

### Lý do

mTLS tăng security nhưng kéo theo certificate issuance, rotation, trust store và operational complexity. Phase đầu nên giữ boundary đơn giản nếu các AI Service đã hoàn toàn private và chỉ nhận trusted internal JWT.

---

## 32.11 Bảng default để team chốt nhanh

| Decision                              | Recommended default                                             |
| ------------------------------------- | --------------------------------------------------------------- |
| Organization API Key header           | `X-API-Key`                                                     |
| End-user identity                     | Signed User Assertion JWT                                       |
| Assertion key discovery               | JWKS URL; public-key upload là fallback                         |
| User Assertion TTL                    | ≤ 5 phút                                                        |
| Identity scope                        | Dữ liệu end-user → `user`; còn lại phải khai báo explicit       |
| Sync vs Async                         | ≤ 30s → sync; workload dài/media → async                        |
| File/audio                            | Presigned upload + `asset_id`; multipart cho file nhỏ/MVP       |
| Public usage                          | Aggregate only                                                  |
| Missing usage at runtime              | Không fail business response; mark incomplete + alert/reconcile |
| Idempotency TTL                       | 24 giờ mặc định                                                 |
| Service-to-service security phase đầu | Private network + network policy + short-lived Internal JWT     |
| mTLS                                  | Phase hardening sau hoặc khi có requirement cụ thể              |

> Khi một operation cần khác default, phải khai báo override rõ trong **Operation Catalog** thay vì để implementation tự suy đoán.
