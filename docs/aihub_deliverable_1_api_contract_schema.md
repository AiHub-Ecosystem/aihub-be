# AIHUB OPEN API — Deliverable 1: API Contract & Schema Definition

> **Scope:** File này chỉ tập trung vào **Deliverable 1** của team: chuẩn hoá API contract/schema, Provider Mapper Rules Engine và Unified Error Codes.
>
> **Nguồn requirement:** Project Scope Statement / Deliverable 1 của team.
>
> **Quy ước:**
>
> - **[Requirement]**: bám theo tài liệu Deliverable 1 của team.
> - **[Team Design Decision]**: quyết định thiết kế bổ sung đã thống nhất qua trao đổi của team.
> - **[Implementation Proposal]**: đề xuất kỹ thuật để hiện thực requirement; không phải wording gốc của Deliverable 1.
> - **[D2 Implementation]**: phần được định nghĩa ở D1 nhưng việc code/runtime implementation thuộc Deliverable 2 trở đi.
> - **[Khảo sát thực tế]**: nội dung đã được đối chiếu với API thật của AI Writing đang chạy production.

> **Cập nhật 2026-09-07:** file này đã được đồng bộ với khảo sát API thật của AI Writing
> (`api-ielts-writing.aihubproduction.com`) và với architecture design ở
> [`implementation spec index`](superpowers/specs/2026-09-07-aihub/README.md).
>
> **Trạng thái hiện hành:** D1 đã freeze. Runtime source of truth là code trong
> `src/contracts/` và `src/catalog/`; `openapi.json` và Postman collection được sinh
> từ source. Các checklist trong PHẦN E là ảnh chụp lịch sử để traceability, không phải
> danh sách blocker hiện tại.
>
> Các schema ví dụ trước đây (`content` / `language` / `level`) là **placeholder và đã sai so với thực tế** —
> nay được thay bằng schema thật. Xem [§34](#34-nhật-ký-thay-đổi) để biết danh sách thay đổi.

---

# 1. Mục tiêu Deliverable 1

## [Requirement]

D1 tập trung vào ba checkpoint:

1. **Chuẩn hoá cấu trúc endpoint + request/response**.
2. **Provider Mapper Rules Engine**.
3. **Unified Error Codes**.

D1 phải tạo ra contract đủ rõ để D2 build Core API Gateway / Reverse Proxy / Routing & Dispatcher mà không phải đổi public contract lớn.

---

# 2. D1 và D2 khác nhau ở đâu?

Đây là boundary cần rõ để tránh D1 bị scope creep.

| Nội dung                              |    D1 — Define Contract |   D2+ — Implement Runtime |
| ------------------------------------- | ----------------------: | ------------------------: |
| Base URL / versioning / naming        |                       ✓ |                   sử dụng |
| API key header format                 |                       ✓ |    middleware + DB lookup |
| Organization/API key schema           |                       ✓ |       persistence/runtime |
| Request/response schemas              |                       ✓ |  validation/serialization |
| End-user assertion contract           |    ✓ nếu capability cần |   verification middleware |
| Provider/Downstream mapping rules     |                       ✓ |      adapter + dispatcher |
| Unified error catalog                 |                       ✓ |    exception/error mapper |
| Timing/usage metadata contract        |                       ✓ |         timers + metering |
| Internal AI Service response contract |                       ✓ | downstream implementation |
| Rate limit/quota algorithm            | có thể reserve contract |        implementation sau |
| Internal JWT AIHUB → AI Service       |       kiến trúc dài hạn |  implementation phase sau |

> **Team Design Decision:** API key nên được **định nghĩa ngay trong D1** để public contract ổn định, nhưng không có nghĩa D1 phải hoàn thiện toàn bộ auth/billing runtime.

---

# 3. Terminology

Từ **Provider** trong Deliverable 1 dễ gây hiểu nhầm.

Trong tài liệu này:

| Term                      | Ý nghĩa                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| **AI Service**            | AI Writing / AI Speaking / AI Reading phía sau AIHUB                                                 |
| **Model Provider**        | OpenAI / Anthropic / Google / ... mà AI Service có thể gọi                                           |
| **Provider Mapper Rules** | Requirement name của team; về kỹ thuật nên hiểu là **Downstream AI Service Adapter / Mapping Rules** |
| **Canonical Contract**    | Public contract thống nhất của AIHUB                                                                 |

> Không dùng `provider` để vừa chỉ AI Writing vừa chỉ OpenAI trong cùng một schema.

---

# PHẦN A — API CONTRACT & SCHEMA DEFINITION

# 4. US01 — Chuẩn hoá Base URL

## [Requirement]

Client cần Base URL thống nhất, dễ gọi và dễ nhớ.

## [Implementation Proposal]

```text
Production: https://api.aihub.example.com/v1
Staging:    https://staging-api.aihub.example.com/v1
Dev:        https://dev-api.aihub.example.com/v1
```

### Environment source of truth

**Đề xuất chốt:** hostname/deployment là source of truth cho `dev/staging/prod`.

```text
api.aihub...          → production
staging-api.aihub...  → staging
dev-api.aihub...      → development
```

API key có thể được bind vào `allowed_environments`, nhưng environment không do client tự khai báo bằng header.

---

# 5. US02 — Chuẩn hoá API Naming Scheme

## [Requirement]

URL phải phân biệt được chức năng AI mà client cần.

## [Implementation Proposal]

```text
/v{version}/{capability}/{task}/{resource-or-action}
```

Ví dụ — 4 operation của MVP:

```http
POST /v1/ielts/writing/task1/questions     # sinh đề Task 1
POST /v1/ielts/writing/task2/questions     # sinh đề Task 2
POST /v1/ielts/writing/task1/grade         # chấm bài Task 1
POST /v1/ielts/writing/task2/grade         # chấm bài Task 2
```

Phase sau:

```http
POST /v1/speaking/grade
GET  /v1/jobs/{job_id}
POST /v1/reading/analyze
```

Không expose naming của AI Service/Model Provider ra public API.

## [Khảo sát thực tế] Vì sao tách `task1` / `task2`

AI Writing có endpoint riêng cho từng task, và **input khác nhau thật sự**: chấm Task 1 bắt buộc có ảnh biểu đồ (`url` phía downstream), Task 2 thì không có.

Gộp thành một `POST /v1/ielts/writing/grade` với field phân biệt sẽ buộc schema phải dùng `oneOf`, làm thông báo lỗi validate khó hiểu và SDK sinh ra kém sạch. Tách riêng cho phép mỗi endpoint có schema chính xác, và sau này tính giá/scope riêng được.

Đồng thời adapter che luôn được sự thiếu nhất quán của downstream: AI Writing đặt tên `/generate-question-task1` nhưng `/question-generated-task2` — public API vẫn đối xứng.

---

# 6. US03 — Request Standard

## [Requirement]

Request phải có đủ thông tin để định danh:

- Organization;
- Service;
- Environment.

## [Team Design Decision] Organization API Key từ đầu

Không bắt client tự gửi ba header độc lập rồi AIHUB tin trực tiếp.

Thay vào đó:

| Requirement          | AIHUB lấy từ đâu?        |
| -------------------- | ------------------------ |
| Organization         | **Organization API Key** |
| Service / Capability | **Endpoint/path**        |
| Environment          | **Deployment hostname**  |

Flow:

```text
X-API-Key
   ↓
Organization

/v1/ielts/writing/task1/grade
   ↓
Service    = writing
Task       = task1
Operation  = writing.task1.grade

api.aihub... / staging-api.aihub...
   ↓
Environment
```

Như vậy requirement US03 vẫn được đáp ứng nhưng tránh dữ liệu định danh bị client tự khai báo sai/giả mạo.

## 6.1 Request headers đề xuất

```http
POST /v1/ielts/writing/task1/grade
X-API-Key: aihub_sk_xxxxx
X-User-Assertion: <signed-jwt>       # chỉ khi operation user-scoped
X-Correlation-Id: customer-req-123  # optional
Idempotency-Key: <uuid>             # nếu operation quy định
Content-Type: application/json
```

### Không dùng client-supplied `X-Request-Id` làm request ID chính

AIHUB tự generate:

```text
request_id = req_01JXYZ
```

Client muốn correlate với hệ thống của họ thì dùng:

```http
X-Correlation-Id: customer-request-123
```

---

# 7. API Key Contract — D1 define, D2 implement

## [Team Design Decision]

D1 chốt contract tối thiểu:

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

Nguyên tắc:

- Không lưu raw API key.
- Raw key chỉ trả một lần khi tạo.
- API key xác định Organization.
- API key có thể được bind vào environment.
- Sau này thêm scopes/rate-limit/quota mà không đổi public credential contract.

## [D2 Implementation]

- middleware đọc API key;
- hash/lookup DB;
- validate status/expiry/environment;
- attach organization context vào request.

---

# 8. End-user Identity Contract

Deliverable 1 gốc tập trung organization/service/environment, nhưng nếu API thao tác data theo user/học viên thì cần chốt contract ngay để tránh dùng raw `X-User-Id`.

## [Implementation Proposal] Signed User Assertion

Customer Backend gửi:

```http
X-User-Assertion: <SIGNED_JWT>
```

Ví dụ payload:

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

`jti` là **bắt buộc**, không phải optional.

Hiện tại AIHUB chỉ log `jti` chứ chưa kiểm tra replay — với TTL 5 phút và kết nối TLS backend-to-backend, kẻ đọc trộm được traffic thì đã có luôn API key, nên replay assertion là mối lo nhỏ hơn nhiều so với chi phí duy trì một Redis set cho mọi request.

Nhưng contract phải yêu cầu `jti` **ngay từ bây giờ**: khi cần bật replay protection cho một org nhạy cảm, chỉ thêm một lần `SET NX` ở phía AIHUB — không phải đi bảo mọi khách hàng sửa code.

Trust model:

```text
Customer Backend Private Key
        ↓ sign
User Assertion
        ↓
AIHUB
        ↓ verify bằng Organization Public Key/JWKS
Trusted actor = student_456
```

AIHUB phải kiểm tra, theo đúng thứ tự này (rẻ trước, crypto sau cùng):

```text
1. alg ∈ allowed_algorithms của org      # CHẶN 'none', chặn HS* khi key là RSA/EC
2. aud == "aihub"
3. iss == issuer đã đăng ký cho org lấy từ API key
4. exp > now - 60s   ∧   iat < now + 60s     # clock skew ±60s
5. (exp - iat) <= max_assertion_ttl_seconds  # mặc định 300s
6. jti có mặt
7. signature hợp lệ theo JWKS của org
```

Ba ràng buộc dưới đây là **bổ sung so với bản D1 đầu tiên**, mỗi cái chặn một lớp tấn công cụ thể:

**Bước 1 — chặn alg confusion.** Đây là lỗ JWT kinh điển: token khai `alg: HS256`, thư viện lấy public key RSA làm HMAC secret — mà public key thì ai cũng lấy được → giả token thoải mái. Chỉ chấp nhận `alg` nằm trong allowlist _của chính org đó_, và loại khoá phải khớp thuật toán.

**Bước 3 — chặn cross-tenant.** API key nói org A nhưng assertion khai `iss` của org B → `403`. Kèm theo đó, cột `issuer` trong `organization_identity_configs` phải **UNIQUE toàn hệ thống**, nếu không org B có thể đăng ký trùng `iss` của org A ngay từ đầu rồi tự ký assertion mạo danh học viên của A.

**Bước 5 — chặn assertion sống vĩnh viễn.** Không giới hạn TTL thì khách có thể ký một assertion `exp` sau 5 năm rồi nhúng vào app mobile — assertion biến thành một API key vĩnh viễn bị rò. `max_assertion_ttl_seconds` lưu ở DB nên nới được cho từng org khi có lý do.

Operation organization-scoped mà client vẫn gửi assertion: **vẫn phải verify**. Có mặt thì phải hợp lệ — bỏ qua một assertion hỏng là mở đường cho lỗi tích hợp âm thầm.

### Identity config của Organization — contract tối thiểu

```text
organization_identity_configs
- organization_id
- issuer                      UNIQUE toàn hệ thống
- jwks_url                    ưu tiên
- public_keys_jwks            fallback khi org chưa host được JWKS
- allowed_algorithms          mặc định {RS256, ES256}
- max_assertion_ttl_seconds   mặc định 300
- status
```

Ràng buộc: phải có ít nhất một trong `jwks_url` hoặc `public_keys_jwks`.

### AIHUB có cần database toàn bộ user không?

Không bắt buộc. AIHUB có thể trust Organization xác nhận end-user bằng signed assertion.

### Operation catalog phải ghi rõ

```text
organization-scoped → assertion optional
user-scoped         → assertion required
```

---

# 9. Authorization Contract

Cần phân biệt:

```text
Organization Entitlement
          ∩
     API Key Scope
          ↓
    Effective Scope
```

Ví dụ:

```text
Organization plan: writing + speaking
API Key A: writing.grade only

Effective scope của key A:
writing.grade
```

D1 nên định nghĩa operation → required scope; runtime enforcement có thể implement ở D2/later.

---

# 10. Canonical Request Schema

## [Requirement]

AIHUB phải định nghĩa key/value, datatype, constraints và allowed values.

## [Khảo sát thực tế]

Bản D1 đầu tiên dùng `{ content, language, level }` làm ví dụ. Đối chiếu với AI Writing thật thì schema đó **không dùng được**:

- chấm bài cần `question`, `topic`, `essay` — không phải một trường `content` chung;
- Task 1 bắt buộc thêm ảnh biểu đồ;
- **không có `language`** — IELTS luôn là tiếng Anh;
- `level` chỉ dùng cho writing-assistant, không dùng khi chấm.

Dưới đây là schema thật.

## Chấm bài — Task 1

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

| Field        | Type   | Required | Constraints             | Description             |
| ------------ | ------ | -------: | ----------------------- | ----------------------- |
| `question`   | string |      yes | 1..2000 chars           | Đề bài                  |
| `chart_type` | enum   |      yes | 7 giá trị, xem bên dưới | Loại biểu đồ của đề     |
| `essay`      | string |      yes | 1..20000 chars          | Bài làm của học viên    |
| `image_url`  | string |      yes | URI, ≤2000 chars        | Ảnh biểu đồ/bảng của đề |
| `language`   | enum   |       no | `vi` (mặc định)         | Ngôn ngữ của feedback   |

### `chart_type` — 7 giá trị, CASE-SENSITIVE

```text
Bar Chart      Line Graph      Pie Chart      Table
Map            Process Diagram Multiple Graphs
```

Đã dò trực tiếp trên API thật ngày 2026-09-07. `"bar chart"` viết thường bị downstream trả 500; `"Process"`, `"Diagram"`, `"Bar Graph"`, `"Mixed Chart"` không tồn tại.

> **Vì sao không gọi là `topic`:** downstream đặt tên field này là `topic`, nhưng giá trị thật là **loại biểu đồ** chứ không phải chủ đề — gửi `"environment"` bị trả 500. Giữ tên `topic` ở public API là truyền lại chính sự hiểu nhầm đó cho khách hàng. Adapter map ngược `chart_type` → `topic` khi gọi downstream.

## Chấm bài — Task 2

`POST /v1/ielts/writing/task2/grade`

```json
{
  "question": "Some people believe that university education should be free...",
  "topic": "education funding",
  "essay": "In recent decades, the debate over..."
}
```

| Field      | Type   | Required | Constraints     | Description                    |
| ---------- | ------ | -------: | --------------- | ------------------------------ |
| `question` | string |      yes | 1..2000 chars   | Đề bài                         |
| `topic`    | string |      yes | 1..200 chars    | Chủ đề thật, ví dụ `education` |
| `essay`    | string |      yes | 1..20000 chars  | Bài làm của học viên           |
| `language` | enum   |       no | `vi` (mặc định) | Ngôn ngữ của feedback          |

> Task 2 **không nhận** `image_url` và **không nhận** `chart_type`. Gửi kèm sẽ bị `400 INVALID_REQUEST`.
>
> Khác Task 1: ở đây `topic` đúng nghĩa **chủ đề** (`education`, `technology`…), không phải loại biểu đồ.

### Về `language`

Hiện downstream chỉ sinh feedback **tiếng Việt**, nên enum tạm thời chỉ có `vi`. Contract giữ sẵn field để khi AI Writing hỗ trợ `en` thì chỉ cần nới enum — **nới lỏng là non-breaking, siết chặt thì không**, nên thứ tự này an toàn.

Response luôn echo `language` để client biết feedback đang ở ngôn ngữ nào.

## Sinh đề — Task 1 và Task 2

`POST /v1/ielts/writing/task1/questions`

```json
{ "chart_type": "Bar Chart" }
```

| Field        | Type | Required | Constraints                                     |
| ------------ | ---- | -------: | ----------------------------------------------- |
| `chart_type` | enum |       no | 7 giá trị ở trên; **bỏ trống = lấy ngẫu nhiên** |

Bỏ trống là đường dùng phổ biến nhất và luôn thành công. Truyền giá trị ngoài enum sẽ bị AIHUB chặn ở `400` trước khi chạm downstream — nếu không, downstream trả `500` cho một lỗi lẽ ra là `404`.

`POST /v1/ielts/writing/task2/questions`

```json
{ "topic": "technology", "question_type": "opinion" }
```

| Field           | Type   | Required | Constraints                                                                         |
| --------------- | ------ | -------: | ----------------------------------------------------------------------------------- |
| `topic`         | string |      yes | 1..200 chars                                                                        |
| `question_type` | enum   |      yes | `opinion`, `discussion`, `problem_solution`, `advantages_disadvantages`, `two_part` |

> **Cần chốt:** downstream hiện nhận `question_type` là string tự do. Enum trên là 5 dạng chuẩn của IELTS Task 2; phải lấy danh sách giá trị AI Writing thật sự chấp nhận trước khi siết thành enum, nếu không sẽ chặn nhầm request hợp lệ. Tạm thời có thể để string ở phase đầu rồi siết sau — **nới lỏng thì không breaking, siết chặt thì có**.

## Quy tắc chung cho mọi canonical request

- `additionalProperties: false` — field ngoài contract trả `400`, không âm thầm bỏ (xem §18).
- Không có field nào mang danh tính người dùng. `actor_id` đi trong User Assertion, không đi trong body.

---

# 11. Media / File Input Contract

Speaking/audio là chỗ dễ mơ hồ nếu chỉ có JSON example.

## [Implementation Proposal]

D1 phải ghi rõ content type theo operation.

### Text operations

```http
Content-Type: application/json
```

### Small/medium media

Có thể dùng:

```http
Content-Type: multipart/form-data
```

với size/type limit rõ ràng.

### Large media

Ưu tiên upload trước rồi truyền reference:

```json
{
  "audio": {
    "asset_id": "asset_01JXYZ"
  }
}
```

Không khuyến nghị base64 cho file lớn.

### Operation catalog cần có

| Operation                         | Input mode                    |                   Max body | Allowed types      |
| --------------------------------- | ----------------------------- | -------------------------: | ------------------ |
| `writing.task1.question.generate` | JSON                          |                       8 KB | text               |
| `writing.task2.question.generate` | JSON                          |                       8 KB | text               |
| `writing.task1.grade`             | JSON                          |                     256 KB | text + `image_url` |
| `writing.task2.grade`             | JSON                          |                     256 KB | text               |
| `speaking.grade`                  | `asset_id` + presigned upload | 10 MB (multipart fallback) | `audio/*`          |

Giới hạn body đặt **theo từng operation**, không đặt một mức chung — sinh đề chỉ cần vài KB, không có lý do gì cho phép nó nhận 256 KB.

Vượt giới hạn → `413 PAYLOAD_TOO_LARGE`.

### `image_url` của Task 1

Client gửi URL, và **AI Writing** là bên đi fetch ảnh đó. Nghĩa là bề mặt SSRF nằm ở phía Writing, không ở AIHUB. Writing phải chặn private IP / loopback / `169.254.169.254` khi fetch.

Đường dài nên chuyển sang `asset_id` cùng lúc với object storage của Speaking, để không còn URL do client tự khai nào được fetch cả.

### Speaking (Phase 4)

Theo default đã chốt ở `aihub_long_term_architecture.md` §32.6: presigned upload + `asset_id` là đường chính, `multipart/form-data` chỉ dùng cho file nhỏ (gợi ý ≤ 10 MB). Max size và danh sách MIME cụ thể chốt khi làm Phase 4 — chưa cần cho D1 vì envelope async đã cố định (§12).

---

# 12. Sync vs Async Contract

D1 phải ghi mỗi operation là sync hay async.

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

Theo sau bởi:

```http
GET /v1/jobs/{job_id}
```

> Không nhất thiết D1 phải implement async job engine, nhưng phải chốt contract nếu capability có khả năng chạy lâu để tránh breaking change.

---

# 13. US04 — Unified Response Standard

## [Requirement]

Client nhận response có request metadata và thông tin định lượng như token/time.

## 13.1 Metadata AIHUB tự biết

- `request_id`;
- `correlation_id` nếu client gửi;
- `service` / `operation`;
- `total_ms`;
- `downstream_ms`;
- `gateway_overhead_ms`.

## 13.2 Metadata phải do AI Service cung cấp

Nếu AI Service là nơi gọi model thì AIHUB không tự biết chính xác:

- `input_tokens`;
- `output_tokens`;
- `total_tokens`;
- model(s) thực tế;
- `ai_processing_ms`;
- breakdown usage khi operation gọi model nhiều lần.

AIHUB **không tự tokenize lại request để ước lượng**.

---

# 14. Timing Definitions — chốt để không hiểu sai

Không dùng `provider_ms` vì có thể hiểu là AI Service hoặc Model Provider.

Khuyến nghị:

```text
total_ms
= AIHUB ingress → AIHUB egress

downstream_ms
= AIHUB bắt đầu HTTP call tới AI Service
  → AIHUB nhận xong downstream response

ai_processing_ms
= AI Service tự đo thời gian xử lý AI nội bộ
  (optional)

gateway_overhead_ms
≈ total_ms - downstream_ms
```

Không giả định:

```text
total_ms = gateway_overhead_ms + ai_processing_ms
```

vì `downstream_ms` còn bao gồm network/service overhead.

---

# 15. Internal AI Service Response Contract

D1 cần chốt contract private tối thiểu để US04 khả thi.

## 15.1 Phân biệt standardized vs service-specific

```text
data
→ service-specific

usage / models / metrics
→ standardized common metadata
```

Ví dụ:

```json
{
  "data": {
    "band": 7.5,
    "comment": "Good structure"
  },
  "usage": {
    "input_tokens": 820,
    "output_tokens": 310,
    "total_tokens": 1130,
    "calls": [
      {
        "model_provider": "provider-y",
        "model": "model-x",
        "input_tokens": 820,
        "output_tokens": 310,
        "total_tokens": 1130
      }
    ]
  },
  "models": [
    {
      "provider": "provider-y",
      "name": "model-x"
    }
  ],
  "metrics": {
    "ai_processing_ms": 790
  }
}
```

### Usage aggregation rule

Nếu operation gọi model nhiều lần:

```text
usage.input_tokens
usage.output_tokens
usage.total_tokens
```

phải là **aggregate của toàn operation**.

`usage.calls[]` là optional breakdown để debug/metering chi tiết.

### Endpoint không gọi model

`usage` phải **omit**, không giả token bằng `0` và không trả `null`.

Ví dụ cụ thể có thật: `/generate-question-task1` của AI Writing **đọc câu hỏi từ database**, không gọi model lần nào. Trong khi `/question-generated-task2` thì có gọi model. Hai operation nhìn giống nhau ở public API nhưng metering khác nhau hoàn toàn — đây chính là ca mà quy tắc này tồn tại để xử lý.

### `metering_status` — phân biệt "không có usage" với "mất usage"

Omit `usage` là chưa đủ, vì có hai lý do rất khác nhau dẫn tới cùng một kết quả. AIHUB phải ghi lại lý do:

| Giá trị            | Nghĩa                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `complete`         | AI Service trả usage đầy đủ                                                                  |
| `missing_usage`    | Operation **có** gọi model nhưng AI Service quên trả usage → **vi phạm contract**, cần alert |
| `not_applicable`   | Operation không gọi model (vd sinh đề Task 1) → bình thường                                  |
| `quota_unverified` | Không kiểm được quota vào thời điểm đó (vd Redis sập), request vẫn cho qua                   |

Trường này là **internal**, không expose ra public response. Nó là thứ quyết định sau này có được phép tính tiền theo token hay không: chừng nào `missing_usage` còn khác 0 thì mô hình token chưa dùng được.

Xử lý runtime theo default đã chốt ở `aihub_long_term_architecture.md` §32.8: **không fail business response** chỉ vì thiếu telemetry, nhưng phải alert và reconcile.

### [Khảo sát thực tế] Contract này là additive — không phá app hiện tại

AI Writing đang chạy production và có ứng dụng đang dùng. Bọc response vào `{ "data": ... }` là **breaking change** cho app đó.

Nhưng **thêm** field ở cấp cao nhất thì không phá gì — client cũ bỏ qua field lạ. Nên yêu cầu với AI Service chỉ là:

```jsonc
// giữ nguyên mọi field đang có, CHỈ THÊM 3 field:
{
  "...": "...",
  "usage": { "input_tokens": 820, "output_tokens": 310, "total_tokens": 1130 },
  "models": [{ "provider": "openai", "name": "gpt-4o-mini" }],
  "metrics": { "ai_processing_ms": 790 },
}
```

AIHUB chấp nhận **cả hai dạng** — phẳng lẫn có bọc `data` — trong giai đoạn chuyển tiếp:

```ts
function splitEnvelope(body) {
  const { usage, models, metrics, data, ...rest } = body ?? {};
  return { data: data ?? rest, usage, models, metrics };
}
```

Nhờ vậy AI Service và AIHUB làm song song được, không bên nào chặn đường bên nào. Khi mọi AI Service đã trả envelope chuẩn thì bỏ nhánh dự phòng.

Nếu response không parse được theo cả hai dạng → `502 AI_SERVICE_CONTRACT_VIOLATION` (§25), **không phải** `AI_SERVICE_ERROR` — hai thứ này cần phân biệt vì cách xử lý hoàn toàn khác nhau.

---

# 16. Unified Public Response Example

AIHUB map `data` service-specific thành canonical public `data`, rồi bổ sung metadata:

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

> Ví dụ trên dựng từ **response thật** đã gọi ngày 2026-09-07; fixture đầy đủ ở `test/fixtures/ai-writing/`.
> `meta.usage` là phần AI Writing **chưa trả** — hiện `metering_status` sẽ là `missing_usage`.

### Năm quyết định trong shape của `data`

**`criteria` là mảng, không phải 4 field cố định — thực tế đã xác nhận.** Response thật dùng key `1_task_achievement` cho Task 1 và `1_task_response` cho Task 2; ba tiêu chí còn lại giống nhau. Field cố định thì hai task ra hai shape và client phải viết hai nhánh render. Mảng có `id` ổn định + `name` hiển thị cho phép dùng chung một component. **Thứ tự các phần tử là cam kết cố định**, theo tiền tố số của downstream.

**`band` và `overall_band` là bội số của 0.5**, trong khoảng 0..9. Ràng buộc này chấp nhận cả `7` (int) lẫn `6.5` (float) — downstream hiện trả `overall_band` kiểu float nhưng `band` kiểu int, nên **không được ép kiểu float**, sẽ reject nhầm response hợp lệ.

**`improvements` là mảng rỗng khi không có gì để cải thiện.** Downstream trả sentinel `["None specified"]`; adapter lọc bỏ. Client kiểm tra `length === 0` chứ không so chuỗi tiếng Anh.

**`annotations` là bình luận về đoạn trích, KHÔNG phải đề xuất sửa.** Bản D1 đầu tiên có `corrections` với `{original, suggestion}` — giả định sai. Dữ liệu thật là `{quote, explanation}`: nhận xét về một đoạn trong bài, không có bản thay thế. Đặt tên `corrections` sẽ khiến client dựng UI "nhấn để sửa" cho dữ liệu không hỗ trợ điều đó.

**AIHUB không tự tính `overall_band`.** Cách làm tròn band tổng là luật nghiệp vụ IELTS, thuộc về AI Service. Gateway chỉ kiểm tra tính hợp lệ.

### Ba thứ có ở downstream nhưng KHÔNG ra public

| Bỏ                             | Vì sao                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `data.coT`                     | Chain-of-thought nội bộ (`layer1_errors`, `layer2_matching`, `layer3_calibration`). Lộ prompt engineering và gợi ý cho người dò prompt |
| `evaluation.*.feedback_detail` | Chỉ là bản làm phẳng của `data_micro` thành chuỗi. `annotations` giữ bản có cấu trúc                                                   |
| `data_micro.*.*.question_type` | Task 1 trả `bar_chart`, Task 2 trả `education` — hai nghĩa khác nhau cùng một tên                                                      |

### `meta.models[]` đã bị bỏ khỏi public response

Bản D1 đầu tiên có `meta.models[]`. Điều này **mâu thuẫn với `aihub_long_term_architecture.md` §32.7**, vốn chốt rằng public API chỉ expose aggregate usage còn chi tiết model giữ cho internal.

Lý do giữ theo §32.7: mục tiêu của AIHUB là trừu tượng hoá AI Service và Model Provider. Cho khách thấy tên model cụ thể sẽ khiến public contract phụ thuộc vào implementation phía sau — đổi model hay đổi provider về sau thành breaking change, hoặc tệ hơn là khách bắt đầu viết logic dựa trên tên model.

`models[]` vẫn được AI Service trả về ở internal contract và vẫn được ghi vào `usage_records` để phục vụ metering/debug/tính giá theo model. Chỉ là **không ra tới client**.

## Source-of-truth matrix

| Field                             | Source of truth                                                |
| --------------------------------- | -------------------------------------------------------------- |
| `meta.request_id`                 | AIHUB                                                          |
| `meta.correlation_id`             | Client-supplied, AIHUB preserves                               |
| `meta.service` / `operation`      | AIHUB                                                          |
| `meta.timing.total_ms`            | AIHUB                                                          |
| `meta.timing.downstream_ms`       | AIHUB                                                          |
| `meta.timing.gateway_overhead_ms` | AIHUB derived                                                  |
| `meta.timing.ai_processing_ms`    | AI Service                                                     |
| `meta.usage.*`                    | AI Service / underlying Model Provider                         |
| `models[]`                        | AI Service — **internal only**, không có trong public response |
| `metering_status`                 | AIHUB — internal only                                          |

---

# PHẦN B — PROVIDER MAPPER RULES ENGINE

# 17. Tổng quan

## [Requirement]

AIHUB cần mapping giữa contract thống nhất của client và contract riêng của từng AI Provider/AI Service.

## Terminology đã chốt

Trong implementation, gọi lớp này là **Downstream Adapter** để tránh lẫn với Model Provider.

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

# 18. US05 — Param/value không hỗ trợ

## [Requirement]

AIHUB cần loại bỏ param/value không được hỗ trợ.

## [Implementation Proposal]

Phân biệt:

```text
Unknown field ngoài public contract
→ Reject 400

Field hợp lệ trong canonical contract
nhưng AI Service hiện tại không hỗ trợ
→ Adapter transform/drop theo rule đã định nghĩa
```

Không nên silent-drop unknown client fields vì dễ che bug integration.

---

# 19. US06 — Map service → scope → AI Service

## [Requirement]

AIHUB map dịch vụ client cần với scope hệ thống và AI Provider.

## [Implementation Proposal]

| Public Endpoint                          | Operation                         | Required Scope              | AI Service  | Downstream path             |
| ---------------------------------------- | --------------------------------- | --------------------------- | ----------- | --------------------------- |
| `POST /v1/ielts/writing/task1/questions` | `writing.task1.question.generate` | `writing.question.generate` | AI Writing  | `/generate-question-task1`  |
| `POST /v1/ielts/writing/task2/questions` | `writing.task2.question.generate` | `writing.question.generate` | AI Writing  | `/question-generated-task2` |
| `POST /v1/ielts/writing/task1/grade`     | `writing.task1.grade`             | `writing.grade`             | AI Writing  | `/grading-feedback-task1`   |
| `POST /v1/ielts/writing/task2/grade`     | `writing.task2.grade`             | `writing.grade`             | AI Writing  | `/grading-feedback-task2`   |
| `POST /v1/speaking/grade`                | `speaking.grade`                  | `speaking.grade`            | AI Speaking | _(Phase 4)_                 |
| `POST /v1/reading/analyze`               | `reading.analyze`                 | `reading.analyze`           | AI Reading  | _(chưa có)_                 |

Hai task dùng chung scope (`writing.grade`, `writing.question.generate`) vì khách mua "chấm bài Writing" chứ không mua riêng từng task. Nếu sau này cần bán tách thì đổi thành `writing.task1.grade` / `writing.task2.grade` — operation đã tách sẵn nên việc đó không phá cấu trúc.

Cột `Downstream path` là **internal**, đưa vào đây chỉ để đối chiếu khi implement. Public contract không bao giờ để lộ nó.

Authorization:

```text
Required Scope
      ↓
Organization Entitlement ∩ API Key Scope
      ↓
Allowed / Denied
```

---

# 20. US07 — Data Dictionary

## [Requirement]

Mỗi request/response key phải có khái niệm, datatype, constraints và allowed values rõ ràng.

### Request — chấm bài

| Field        | Type   |       Required | Constraints               | Description        |
| ------------ | ------ | -------------: | ------------------------- | ------------------ |
| `question`   | string |            yes | 1..2000 chars             | Đề bài             |
| `chart_type` | enum   | **chỉ Task 1** | 7 giá trị, case-sensitive | Loại biểu đồ       |
| `topic`      | string | **chỉ Task 2** | 1..200 chars              | Chủ đề             |
| `essay`      | string |            yes | 1..20000 chars            | Bài làm            |
| `image_url`  | string | **chỉ Task 1** | URI, ≤2000 chars          | Ảnh biểu đồ của đề |
| `language`   | enum   |             no | `vi`                      | Ngôn ngữ feedback  |

### Request — sinh đề

| Field           | Type   |                 Required | Constraints                                                                         |
| --------------- | ------ | -----------------------: | ----------------------------------------------------------------------------------- |
| `chart_type`    | enum   | **chỉ Task 1**, optional | 7 giá trị; bỏ trống = ngẫu nhiên                                                    |
| `topic`         | string |      **chỉ Task 2**, yes | 1..200 chars                                                                        |
| `question_type` | enum   |      **chỉ Task 2**, yes | `opinion`, `discussion`, `problem_solution`, `advantages_disadvantages`, `two_part` |

### Response — chấm bài

| Field                             | Type    |                   Required | Constraints           | Description                               | Source                            |
| --------------------------------- | ------- | -------------------------: | --------------------- | ----------------------------------------- | --------------------------------- |
| `data.overall_band`               | number  |                        yes | 0..9, bội số 0.5      | Band tổng                                 | AI Service                        |
| `data.language`                   | enum    |                        yes | `vi`                  | Ngôn ngữ của feedback                     | AIHUB                             |
| `data.criteria[]`                 | array   |                        yes | đúng 4 phần tử        | 4 tiêu chí IELTS                          | AI Service → Adapter              |
| `data.criteria[].id`              | enum    |                        yes | xem bên dưới          | Định danh tiêu chí                        | Adapter                           |
| `data.criteria[].name`            | string  |                        yes | —                     | Tên hiển thị                              | Adapter                           |
| `data.criteria[].band`            | number  |                        yes | 0..9, bội số 0.5      | Điểm tiêu chí                             | AI Service                        |
| `data.criteria[].band_reason`     | string  |                        yes | —                     | Trích band descriptor + giải thích        | AI Service                        |
| `data.criteria[].strengths[]`     | array   |                        yes | có thể rỗng           | Điểm mạnh                                 | AI Service                        |
| `data.criteria[].improvements[]`  | array   |                        yes | có thể rỗng           | Điểm cần cải thiện                        | AI Service → Adapter lọc sentinel |
| `data.summary`                    | string  |                        yes | —                     | Nhận xét tổng                             | AI Service                        |
| `data.suggestions[]`              | array   |                        yes | có thể rỗng           | Gợi ý cụ thể                              | AI Service                        |
| `data.next_steps[]`               | array   |                        yes | có thể rỗng           | Việc nên luyện tiếp                       | AI Service                        |
| `data.annotations[]`              | array   |                        yes | có thể rỗng           | Bình luận theo đoạn trích                 | AI Service → Adapter              |
| `data.annotations[].criterion`    | enum    |                        yes | như `criteria[].id`   | Thuộc tiêu chí nào                        | Adapter                           |
| `data.annotations[].issue`        | string  |                        yes | —                     | Loại vấn đề, vd `inaccurate_data_support` | AI Service                        |
| `data.annotations[].quote`        | string  |                        yes | —                     | Đoạn trích nguyên văn từ bài viết         | AI Service                        |
| `data.annotations[].explanation`  | string  |                        yes | —                     | Giải thích                                | AI Service                        |
| `meta.request_id`                 | string  |                        yes | ULID có prefix `req_` | AIHUB trace ID                            | AIHUB                             |
| `meta.correlation_id`             | string  |                         no | —                     | Echo `X-Correlation-Id`                   | Client                            |
| `meta.service` / `operation`      | string  |                        yes | —                     | Routing metadata                          | AIHUB                             |
| `meta.timing.total_ms`            | integer |                        yes | —                     | Ingress → egress                          | AIHUB                             |
| `meta.timing.downstream_ms`       | integer | yes nếu có downstream call | —                     | Thời lượng HTTP xuống AI Service          | AIHUB                             |
| `meta.timing.gateway_overhead_ms` | integer |                        yes | —                     | `total_ms - downstream_ms`                | AIHUB derived                     |
| `meta.timing.ai_processing_ms`    | integer |                         no | —                     | AI Service tự đo                          | AI Service                        |
| `meta.usage.input_tokens`         | integer |                         no | —                     | Aggregate                                 | AI Service                        |
| `meta.usage.output_tokens`        | integer |                         no | —                     | Aggregate                                 | AI Service                        |
| `meta.usage.total_tokens`         | integer |                         no | —                     | Aggregate                                 | AI Service                        |

`criteria[].id` nhận một trong:

```text
task_achievement              # chỉ Task 1
task_response                 # chỉ Task 2
coherence_cohesion
lexical_resource
grammatical_range_accuracy
```

> Đo thực tế 2026-09-07: chấm bài mất **16–18 giây**, response nặng **~12 KB**. Vẫn dưới ngưỡng 30s nên giữ `execution: sync`.

### Response — sinh đề

| Field                | Type   |       Required | Description                    |
| -------------------- | ------ | -------------: | ------------------------------ |
| `data.question`      | string |            yes | Đề bài sinh ra                 |
| `data.question_id`   | string | **chỉ Task 1** | UUID của đề trong ngân hàng đề |
| `data.chart_type`    | enum   | **chỉ Task 1** | Loại biểu đồ                   |
| `data.image_url`     | string | **chỉ Task 1** | Ảnh biểu đồ đi kèm đề          |
| `data.topic`         | string | **chỉ Task 2** | Chủ đề                         |
| `data.question_type` | enum   | **chỉ Task 2** | Dạng câu hỏi                   |

`image_url` trả về ở đây chính là giá trị client gửi lại khi gọi chấm bài Task 1 — luồng khép kín: sinh đề → học viên viết → chấm bài.

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

Adapter có thể xử lý:

- field rename;
- enum/value conversion;
- nested object;
- default value;
- unsupported option;
- multipart/file conversion;
- response normalization;
- error mapping.

MVP nên adapter bằng code thay vì dynamic rule engine quá sớm.

---

# PHẦN C — UNIFIED ERROR CODES

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

# 23. US08 — Detailed downstream error cho AIHUB Developer

## [Requirement]

AIHUB developer cần đủ chi tiết để biết downstream đang gặp vấn đề gì.

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

Raw details chỉ dùng nội bộ.

> **Trạng thái triển khai.** `downstream_error_code` và `downstream_message` ở trên là **ví dụ minh hoạ**, không phải field AI Writing đang trả. Service thật trả `{"detail": "..."}` không kèm mã lỗi nào, nên `HttpOperationDispatcher` hiện ghi `null` cho cả hai. Mọi field còn lại — `request_id`, `ai_service`, `downstream_status`, `downstream_ms`, `private_endpoint` — đều đã có thật trong log. Điều kiện để điền hai field kia nằm ở [US10 § Đề xuất](#25-us10--master-error-mapping-matrix).

---

# 24. US09 — Unified Error Payload cho Client

## [Requirement]

Client không phải xử lý raw error phức tạp của từng downstream.

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

Không leak:

- stack trace;
- internal endpoint;
- DB error;
- secret;
- raw exception không cần thiết.

---

# 25. US10 — Master Error Mapping Matrix

## [Requirement]

Cần ma trận mapping lỗi giữa client/system/AI Provider, kèm nguyên nhân và recommended client/system action.

## [Implementation Proposal]

Danh sách chốt cho v1 gồm **19 mã**. Sáu mã đánh dấu ★ là bổ sung so với bản D1 đầu tiên.

Cột **Downstream Signal** cho biết AIHUB _quan sát được gì_ từ phía sau trước khi dựng mã lỗi. Dấu `—` nghĩa là request chưa bao giờ rời gateway, nên khi debug không cần đi tìm log của AI Service.

| Layer       | Condition                                    | Downstream Signal                                | HTTP | AIHUB Code                        |  Retryable | Client Action                   | System Action           |
| ----------- | -------------------------------------------- | ------------------------------------------------ | ---: | --------------------------------- | ---------: | ------------------------------- | ----------------------- |
| Client      | Missing/invalid field, field lạ              | —                                                |  400 | `INVALID_REQUEST`                 |         No | Fix request                     | None                    |
| Client      | Body vượt `max_body_bytes`                   | —                                                |  413 | ★ `PAYLOAD_TOO_LARGE`             |         No | Giảm kích thước                 | Metric                  |
| Client      | Endpoint/resource không tồn tại              | —                                                |  404 | `NOT_FOUND`                       |         No | Kiểm tra URL                    | None                    |
| Auth        | Missing/invalid API key                      | —                                                |  401 | `UNAUTHORIZED`                    |         No | Check credential                | Audit                   |
| Auth        | Operation user-scoped nhưng thiếu assertion  | —                                                |  401 | ★ `USER_ASSERTION_REQUIRED`       |         No | Gửi kèm `X-User-Assertion`      | Audit                   |
| Auth        | Assertion sai chữ ký/hết hạn/sai claim       | —                                                |  401 | `INVALID_USER_ASSERTION`          |         No | Tạo lại assertion               | Audit                   |
| Auth        | Không lấy được JWKS của Organization         | JWKS endpoint của **org**, không phải AI Service |  503 | ★ `IDENTITY_PROVIDER_UNAVAILABLE` |        Yes | Kiểm tra JWKS endpoint của mình | Alert                   |
| AuthZ       | Scope denied                                 | —                                                |  403 | `FORBIDDEN`                       |         No | Check permission/plan           | Audit                   |
| AuthZ       | Key không được dùng ở environment này        | —                                                |  403 | ★ `ENVIRONMENT_NOT_ALLOWED`       |         No | Dùng đúng key cho môi trường    | Audit                   |
| Idempotency | Same key, different payload — hoặc đang chạy | —                                                |  409 | `IDEMPOTENCY_CONFLICT`            |         No | New key/fix request             | Audit                   |
| Gateway     | Client exceeds AIHUB rate limit              | —                                                |  429 | `RATE_LIMITED`                    |        Yes | Backoff; obey `Retry-After`     | Metric                  |
| Gateway     | Quá nhiều request đồng thời của cùng org     | —                                                |  429 | ★ `CONCURRENCY_LIMIT`             |   Yes, sớm | Giảm song song, retry ~500ms    | Metric                  |
| Quota       | Organization quota exhausted                 | —                                                |  429 | `QUOTA_EXCEEDED`                  | Time-based | Wait/upgrade                    | Metering                |
| Downstream  | AI Service/Model Provider throttled          | `HTTP 429`                                       |  503 | `AI_SERVICE_THROTTLED`            |        Yes | Retry later                     | Backoff/circuit breaker |
| Downstream  | Timeout                                      | abort / `UND_ERR_*_TIMEOUT`                      |  504 | `AI_SERVICE_TIMEOUT`              |      Yes\* | Retry only idempotently         | Timeout/circuit breaker |
| Downstream  | AI Service unavailable / breaker mở          | `ECONNREFUSED` / DNS fail                        |  503 | `AI_SERVICE_UNAVAILABLE`          |        Yes | Retry later                     | Alert/health check      |
| Downstream  | Response không parse được theo contract      | `HTTP 2xx` + body sai shape                      |  502 | ★ `AI_SERVICE_CONTRACT_VIOLATION` |         No | Báo AIHUB                       | **Alert khẩn**          |
| Downstream  | Other 5xx/invalid response                   | `HTTP ≥ 500`                                     |  502 | `AI_SERVICE_ERROR`                |      Maybe | Retry later                     | Alert/metrics           |
| Downstream  | 4xx khác 429 — xem ghi chú bên dưới          | `HTTP 4xx`                                       |  502 | `AI_SERVICE_ERROR`                |         No | Báo AIHUB                       | Metric                  |
| AIHUB       | Unexpected error                             | —                                                |  500 | `INTERNAL_ERROR`                  |      Maybe | Retry later                     | Alert                   |

`*` Timeout chỉ nên retry khi operation idempotent hoặc request có `Idempotency-Key` hợp lệ.

### ⚠️ Downstream đang trả 5xx cho lỗi client

Đo thật 2026-09-07:

```
POST /generate-question-task1  {"topic":"environment"}
  -> HTTP 500  {"detail":"404: Không tìm thấy dữ liệu cho topic này!"}
```

Một trạng thái nghiệp vụ ("không có dữ liệu cho loại biểu đồ này") đang trả về **500**. Hệ quả với AIHUB: theo policy circuit breaker, chỉ 5xx mới tính là failure — nên **một khách gõ sai `chart_type` nhiều lần có thể mở breaker và làm sập operation đó cho mọi khách khác**.

Hai lớp phòng vệ:

1. **AIHUB chặn trước.** `chart_type` là enum nên giá trị lạ bị `400` ngay ở validate, không bao giờ chạm downstream. Đây là lý do enum quan trọng hơn vẻ ngoài của nó.
2. **AI Writing phải sửa** thành `404`/`422`. Đưa vào danh sách bàn giao.

AIHUB **không** tự chữa bằng cách đọc chuỗi `detail` để đoán — heuristic đó vỡ ngay khi downstream đổi thông điệp.

### Vì sao ba mã trong số đó đáng được tách riêng

**`AI_SERVICE_CONTRACT_VIOLATION` vs `AI_SERVICE_ERROR`.** Gộp chung là sai lầm tốn thời gian nhất: khi AI Service đổi shape response mà quên báo, đội trực sẽ đi tìm sự cố hạ tầng trong khi nguyên nhân thật là **ai đó vừa deploy**. Mã riêng cộng alert riêng chỉ thẳng vào đúng chỗ. Nó cũng không retryable — retry một contract sai thì lần nào cũng sai.

**`IDENTITY_PROVIDER_UNAVAILABLE`.** Đây không phải lỗi credential của client — trả `401` sẽ khiến khách đi tạo lại API key một cách vô ích. Cũng không phải lỗi AI Service. Nó là "JWKS endpoint **của chính bạn** đang không truy cập được", và chỉ mã riêng mới nói được điều đó.

**`CONCURRENCY_LIMIT` vs `RATE_LIMITED`.** Hai hành động khắc phục khác nhau: `RATE_LIMITED` thì khách phải **giảm tần suất**, `CONCURRENCY_LIMIT` thì khách phải **giảm số request chạy song song** — có thể vẫn giữ nguyên tổng số request mỗi phút. Cùng dùng `RATE_LIMITED` sẽ dẫn khách đi sai hướng.

> Không dùng public `429 RATE_LIMITED` cho downstream throttling, vì client có thể hiểu nhầm họ đã vượt AIHUB limit.

### 4xx của downstream đang được gộp vào `AI_SERVICE_ERROR`

Hành vi hiện tại trong `HttpOperationDispatcher.mapDownstreamStatus`: chỉ `429` được tách thành `AI_SERVICE_THROTTLED`, mọi status ngoài dải 2xx còn lại đều thành `AI_SERVICE_ERROR`, với `retryable` bật khi status ≥ 500.

Hệ quả: một `422` do AI Service từ chối **input** vẫn trả về client thành `502` — báo sai địa chỉ. Client đọc `502` sẽ hiểu là hệ thống hỏng và thử lại, trong khi việc cần làm là sửa request.

Chưa sửa vì hai lý do, và cả hai đều nằm ở phía AI Service:

1. AI Writing hiện **không** trả 4xx cho lỗi nghiệp vụ — nó trả `500` (xem ghi chú ở trên). Tách mã lúc này không thay đổi hành vi thực tế nào.
2. Chưa có error contract chuẩn hoá để phân biệt "AI Service từ chối input" với "AI Service hỏng". Đề xuất ở mục kế tiếp.

### Đề xuất — chờ AI Service xác nhận

> **Chưa có thật.** Mục này mô tả trạng thái đích, không phải trạng thái hiện tại. AI Writing đang trả `500` kèm `{"detail": "..."}` cho cả lỗi nghiệp vụ, và không có field mã lỗi nào. Không implement `parseError` hay thêm mã mới vào registry theo bảng dưới cho tới khi AI Service xác nhận và AIHUB capture được fixture lỗi thật.

Contract lỗi tối thiểu mà AIHUB đề nghị mọi AI Service tuân theo:

```json
{
  "error": {
    "code": "TOPIC_NOT_FOUND",
    "message": "No data available for this chart type"
  }
}
```

Ba yêu cầu, không hơn:

1. **HTTP status đúng nghĩa** — lỗi nghiệp vụ trả `4xx`, không trả `500`. Đây là yêu cầu quan trọng nhất: circuit breaker chỉ đếm `5xx` là failure, nên lỗi input bị trả `500` có thể mở breaker và làm sập operation cho mọi tổ chức khác.
2. **`code` là enum ổn định** — không đổi theo văn bản hiển thị. AIHUB map theo `code`, không bao giờ parse `message`.
3. **`message` chỉ dành cho người đọc log** — không đi ra client, không tham gia vào bất kỳ nhánh điều kiện nào.

Khi có contract đó, cột Downstream Signal điền được thêm mã lỗi, và một mã AIHUB mới trở nên cần thiết:

| Downstream Signal (đề xuất) | AIHUB Code                      | HTTP | Retryable |
| --------------------------- | ------------------------------- | ---: | --------: |
| `429` + `RATE_LIMITED`      | `AI_SERVICE_THROTTLED`          |  503 |       Yes |
| `503` + `MODEL_NOT_READY`   | `AI_SERVICE_UNAVAILABLE`        |  503 |       Yes |
| `422` + `TOPIC_NOT_FOUND`   | ☆ `AI_SERVICE_REJECTED`         |  400 |        No |
| `422` + `ESSAY_TOO_SHORT`   | ☆ `AI_SERVICE_REJECTED`         |  400 |        No |
| `5xx` khác                  | `AI_SERVICE_ERROR`              |  502 |       Yes |
| `2xx` + body sai shape      | `AI_SERVICE_CONTRACT_VIOLATION` |  502 |        No |

☆ Mã đề xuất, chưa có trong `error-registry.ts`.

**Vì sao `AI_SERVICE_REJECTED` cần là mã riêng.** Nó nằm đúng giữa hai mã đã có. Không phải `INVALID_REQUEST`, vì request đã qua validate của AIHUB — schema hợp lệ. Cũng không phải `AI_SERVICE_ERROR`, vì không có gì hỏng cả. Ý nghĩa của nó là: _đúng shape, nhưng AI Service không xử lý được nội dung này_. Client cần biết để sửa dữ liệu chứ không phải để retry.

**Việc cần làm, theo đúng thứ tự:**

1. AI Service triển khai error contract ở trên
2. AIHUB gọi thật, capture response lỗi, commit vào `test/fixtures/ai-writing/`
3. Implement `parseError` trên adapter — hook đã khai sẵn trong `DownstreamAdapter`, chưa adapter nào dùng
4. Thêm `AI_SERVICE_REJECTED` vào registry, điền `downstream_error_code` vào log US08

Đảo thứ tự là viết parser cho một contract chưa tồn tại.

---

# 26. Idempotency Contract

D1 nên **reserve contract** cho POST có side effect/cost cao dù runtime implementation có thể ở D2/later.

```http
Idempotency-Key: <uuid-or-opaque-string>
```

Semantics đề xuất:

```text
same org + same operation + same key + same request
→ same result / same in-flight operation

same org + same operation + same key + different request
→ 409 IDEMPOTENCY_CONFLICT
```

Operation catalog phải ghi `idempotency_required: true/false`.

---

# PHẦN D — OPERATION CATALOG

# 27. Mỗi operation cần một record đầy đủ

Để không còn mơ hồ, mỗi public operation nên có catalog dạng:

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
observed_latency: 18.3s # đo thật 2026-09-07
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

```yaml
operation: writing.task1.question.generate
method: POST
path: /v1/ielts/writing/task1/questions
scope: writing.question.generate
identity_scope: organization
execution: sync
content_type: application/json
idempotency: none # đọc DB, không tốn tiền, lặp lại vô hại
max_body_bytes: 8192
timeout_ms: 10000
downstream_service: ai-writing
downstream_path: /generate-question-task1
request_schema: Task1QuestionRequest
response_schema: Task1QuestionResponse
observed_latency: 1.4s # đọc DB, không gọi model
```

```yaml
operation: writing.task2.question.generate
method: POST
path: /v1/ielts/writing/task2/questions
scope: writing.question.generate
identity_scope: organization
execution: sync
content_type: application/json
idempotency: optional # CÓ gọi model -> tốn tiền
max_body_bytes: 8192
timeout_ms: 30000
downstream_service: ai-writing
downstream_path: /question-generated-task2
request_schema: Task2QuestionRequest
response_schema: Task2QuestionResponse
```

Speaking (Phase 4, envelope async đã chốt ở §12):

```yaml
operation: speaking.grade
method: POST
path: /v1/speaking/grade
scope: speaking.grade
identity_scope: user
execution: async # đã chốt
content_type: application/json # + asset_id; multipart cho file nhỏ
idempotency: required
max_body_bytes: TBD # chốt ở Phase 4
timeout_ms: TBD
downstream_service: ai-speaking
```

### `idempotency` có ba giá trị, không phải boolean

Bản đầu dùng `idempotency_required: true/false`. Ba trạng thái mới phản ánh đúng thực tế:

| Giá trị    | Nghĩa                           | Dùng cho                                               |
| ---------- | ------------------------------- | ------------------------------------------------------ |
| `required` | Thiếu `Idempotency-Key` → `400` | Operation tốn tiền và tạo record cho học viên          |
| `optional` | Có thì dùng, không có vẫn chạy  | Operation tốn tiền nhưng không tạo side effect lâu dài |
| `none`     | Bỏ qua header nếu client gửi    | Operation chỉ đọc, lặp lại vô hại                      |

`writing.task1.question.generate` là `none` vì nó **đọc câu hỏi từ database**, không gọi model. Bắt buộc idempotency ở đó chỉ tạo phiền phức cho client mà không bảo vệ gì cả.

### `timeout_ms` không phải "thời gian dự kiến"

`aihub_long_term_architecture.md` §32.5 chốt ngưỡng sync/async ở **thời gian xử lý thường gặp ≤ 30 giây**. Chấm bài có `timeout_ms: 60000` nhưng đó là **trần**, không phải kỳ vọng — thực tế thường vài giây tới hơn chục giây, nên vẫn thuộc nhóm sync.

Nếu đo thực tế cho thấy p95 vượt 30 giây thì phải chuyển `writing.*.grade` sang async, và envelope ở §12 đã sẵn sàng cho việc đó.

---

# PHẦN E — D1 ACCEPTANCE CHECKLIST

> **Ảnh chụp lịch sử:** các ô chưa đánh dấu bên dưới phản ánh checklist trước khi D1
> freeze. Xem phần trạng thái ở đầu tài liệu và `CONTEXT.md` để biết công việc hiện hành.

# 28. API Contract & Schema

- [ ] Chốt Base URL.
- [ ] Chốt API versioning.
- [ ] Chốt endpoint naming convention.
- [ ] Chốt API key header convention.
- [ ] Chốt environment source of truth = hostname/deployment.
- [ ] Chốt API key environment binding rule.
- [ ] Chốt Organization derive từ API key.
- [ ] Chốt Service/Operation derive từ path.
- [ ] Chốt canonical request schema cho từng capability.
- [ ] Chốt canonical response envelope.
- [ ] Chốt AIHUB-generated `request_id` + optional `X-Correlation-Id`.
- [ ] Chốt timing definitions: `total_ms`, `downstream_ms`, `ai_processing_ms`, `gateway_overhead_ms`.
- [ ] Chốt source of truth cho từng metadata field.
- [ ] Chốt internal AI Service response contract.
- [ ] Chốt usage aggregation rule khi operation gọi model nhiều lần.
- [ ] Chốt behavior khi endpoint không có usage (`omit` hay `null`).
- [ ] Chốt operation nào user-scoped / organization-scoped.
- [ ] Chốt User Assertion contract nếu capability cần end-user identity.
- [ ] Chốt sync/async cho từng operation.
- [ ] Chốt media/file input mode và limits cho Speaking/media operation.
- [ ] Chốt datatype/constraints/default/required cho từng field.

# 29. API Key Foundation

### D1

- [ ] Chốt schema `organizations` / `api_keys`.
- [ ] Chốt raw key/hash rule.
- [ ] Chốt status/expiry/environment binding semantics.
- [ ] Chốt API key scope model ở mức contract.

### D2 Implementation

- [ ] Implement DB/middleware lookup.
- [ ] Invalid/missing key trả unified error.
- [ ] Attach authenticated org context.

# 30. Provider / Downstream Mapping

- [ ] Chốt terminology: AI Service vs Model Provider.
- [ ] Có operation → required scope mapping.
- [ ] Có operation → AI Service mapping.
- [ ] Có request adapter rule.
- [ ] Có response adapter rule.
- [ ] Có rule cho unsupported field/value.
- [ ] Có internal response metadata contract.
- [ ] Có unit-test examples/spec cho mapping rules.

# 31. Unified Errors

- [ ] Có public error payload.
- [ ] Có internal downstream error structure.
- [ ] Có master error mapping matrix.
- [ ] Phân biệt AIHUB 429 với downstream throttling 503.
- [ ] Có `Retry-After` / `retry_after_ms` semantics khi phù hợp.
- [ ] Không leak raw downstream errors.
- [ ] Error có AIHUB `request_id`.
- [ ] Chốt idempotency conflict error.

---

# PHẦN F — OUTPUT EXPECTED CỦA DELIVERABLE 1

Đến cuối D1 nên có ít nhất:

```text
1. API Naming / Versioning Convention
2. Environment / Base URL Convention
3. Standard Request Header Contract
4. API Key Contract
5. End-user Assertion Contract cho user-scoped operations
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
23. Example Request/Response cho từng capability chính
24. OpenAPI/Swagger draft nếu kịp — ✅ **XONG 2026-09-07**, `openapi.json` (OpenAPI 3.1), sinh từ operation catalog qua `pnpm generate:openapi`, không viết tay (issue #2)
25. Postman examples để handoff sang D2 — ✅ **XONG 2026-09-07**, `aihub.postman_collection.json`, sinh từ `openapi.json` qua `pnpm generate:postman`, chứa đủ 15 case §G; 2 case (13, 14) vẫn chờ #9 metering (issue #6)
```

---

# PHẦN G — HANDOFF SANG DELIVERABLE 2

D1 chốt contract; D2 hiện thực runtime pipeline:

```text
HTTP Request
    ↓
Generate request_id
    ↓
API Key Authentication
    ↓
Canonical Validation
    ↓
User Assertion Verification (nếu operation cần)
    ↓
Authorization
    ↓
Idempotency / Rate Limit / Quota (theo scope phase)
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

## D2 Postman tests tối thiểu

1. Valid API key + valid request → route đúng AI Service.
2. Missing/invalid API key.
3. API key không allowed trong environment hiện tại.
4. Missing required params.
5. Unknown/unsupported field.
6. Scope/service mismatch.
7. User-scoped operation thiếu/invalid User Assertion.
8. Downstream timeout.
9. Downstream throttle → public 503 `AI_SERVICE_THROTTLED`, không phải client 429.
10. Downstream 4xx/5xx → unified error đúng.
11. `request_id` do AIHUB generate; `correlation_id` được preserve nếu có.
12. Timing fields đúng semantics.
13. Usage/model public response khớp metadata downstream cung cấp.
14. Multi-model usage aggregate đúng nếu downstream trả breakdown.
15. Idempotency behavior nếu phase này implement.

---

# 32. Những điểm team phải chốt trước khi freeze D1

**Trạng thái: 17/18 đã chốt.** Bảng dưới là đáp án; câu 14 còn mở nhưng thuộc Phase 4 nên không cản việc freeze D1.

|   # | Câu hỏi                                     | Đáp án                                                                                                                                                                                                        |
| --: | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|   1 | `X-API-Key` hay `Authorization: Bearer`?    | **`X-API-Key`.** `Authorization` để dành cho internal JWT ở boundary AIHUB → AI Service, tránh hai loại credential dùng chung một header                                                                      |
|   2 | Key có cần `live/test` mode?                | **Không.** Environment do hostname quyết định; key chỉ bị _bind_ qua `allowed_environments`. Nhét mode vào key là tạo nguồn sự thật thứ hai                                                                   |
|   3 | `dev/staging/prod` derive từ hostname?      | **Có, đã chốt** (§4)                                                                                                                                                                                          |
|   4 | `/v1` hay header versioning?                | **`/v1` trong path**                                                                                                                                                                                          |
|   5 | Unknown field reject 400?                   | **Có, không ngoại lệ.** `additionalProperties: false` (§18)                                                                                                                                                   |
|   6 | `usage` khi không gọi model                 | **Omit.** Không `null`, không `0`. Kèm `metering_status: not_applicable` (§15)                                                                                                                                |
|   7 | Public expose `models[]`/breakdown tới đâu? | **Chỉ aggregate usage.** `models[]` và `usage.calls[]` là internal — theo LTA §32.7 (§16)                                                                                                                     |
|   8 | JWKS URL hay upload public key?             | **Cả hai.** `jwks_url` là đường chính, `public_keys_jwks` là fallback (§8)                                                                                                                                    |
|   9 | TTL tối đa của assertion                    | **300 giây**, cấu hình được theo org qua `max_assertion_ttl_seconds`. Clock skew ±60s                                                                                                                         |
|  10 | Capability nào bắt buộc user identity?      | Chấm bài (`writing.task1.grade`, `writing.task2.grade`) → `user`. Sinh đề → `organization`. Mặc định fail-closed: chưa chắc thì coi là `user`                                                                 |
|  11 | `writing.grade` sync hay async?             | **Sync**, `timeout_ms: 60000` (trần, không phải kỳ vọng — xem §27)                                                                                                                                            |
|  12 | `speaking.grade` sync hay async?            | **Async.** Envelope chốt ở §12, code ở Phase 4                                                                                                                                                                |
|  13 | Speaking multipart hay `asset_id`?          | **`asset_id` + presigned upload** là đường chính; multipart cho file nhỏ ≤10 MB (LTA §32.6)                                                                                                                   |
|  14 | Max media size / MIME                       | ⏳ **Còn mở** — chốt ở Phase 4. Không cản freeze D1 vì envelope async đã cố định                                                                                                                              |
|  15 | Idempotency bắt buộc với operation nào?     | `required` cho 2 operation chấm bài; `optional` cho sinh đề Task 2; `none` cho sinh đề Task 1 (§27)                                                                                                           |
|  16 | Scope/entitlement áp dụng từ D2?            | **Có, ngay từ D2.** `Entitlement ∩ Key Scope` không cần thêm query nào — dữ liệu đã có sẵn từ bước lookup key (§9)                                                                                            |
|  17 | Missing usage với metering-critical op?     | **Không fail business response.** Đánh dấu `metering_status: missing_usage` + alert + reconcile (LTA §32.8). Nhưng contract/integration test phải coi `usage` là bắt buộc trước khi AI Service lên production |
|  18 | Danh sách public error codes v1             | **18 mã** ở §25                                                                                                                                                                                               |

---

# 33. Điều kiện còn lại để freeze D1

Ba việc, và chỉ một trong số đó là chặn:

| #   | Việc                                             | Chặn gì | Trạng thái                                                                                                               |
| --- | ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | ~~Lấy response thật của `/grading-feedback-task1 | 2`~~    | —                                                                                                                        | ✅ **XONG 2026-09-07**, fixture ở `test/fixtures/ai-writing/` |
| 2   | ~~Danh sách `question_type` / `chart_type`~~     | —       | ✅ **XONG** — 5 dạng Task 2, 7 chart type Task 1                                                                         |
| 3   | ~~Xuất OpenAPI 3.1 + Postman collection~~        | —       | ✅ **XONG 2026-09-07** — `openapi.json` (#2) + `aihub.postman_collection.json` (#6), cả hai sinh tự động, không viết tay |

**D1 đã freeze.** Cả ba việc còn lại đều xong; không còn blocker nào.

Một nghi vấn còn mở nhưng **không cản freeze**: band nửa điểm (xem §34). Đó là vấn đề chất lượng của AI Writing, không phải vấn đề contract — schema đã dùng `multipleOf: 0.5` nên đúng trong cả hai trường hợp.

---

# 34. Nhật ký thay đổi

## 2026-09-07 — đồng bộ với khảo sát AI Writing thật

| #   | Thay đổi                                                                                  | Mục           |
| --- | ----------------------------------------------------------------------------------------- | ------------- |
| 1   | Thay canonical request/response bằng schema thật; bỏ `content`/`language`/`level`         | §10, §20      |
| 2   | Tách Task 1 / Task 2 thành 4 operation riêng                                              | §5, §19, §27  |
| 3   | Thêm 6 mã lỗi; tổng 18 mã cho v1                                                          | §25           |
| 4   | Thêm `max_assertion_ttl_seconds`, allowlist `alg`, `UNIQUE(issuer)`; `jti` thành bắt buộc | §8            |
| 5   | `usage` phải omit khi không gọi model, kèm ví dụ có thật                                  | §15           |
| 6   | Thêm `metering_status` với 4 giá trị                                                      | §15, §16      |
| 7   | Chốt Speaking ở mức envelope async; giới hạn body theo từng operation                     | §11, §12, §27 |
| 8   | Ghi rõ internal contract là **additive** — AI Service chỉ thêm field, không bọc `data`    | §15           |
| 9   | Trả lời 17/18 câu chốt                                                                    | §32           |
| 10  | **Bỏ `meta.models[]` khỏi public response** — mâu thuẫn với LTA §32.7                     | §16           |
| 11  | `idempotency_required` boolean → `idempotency` ba trạng thái                              | §27           |

## 2026-09-07 (lần 2) — sau khi gọi thật API AI Writing

Đã gọi cả 4 endpoint bằng token do team cấp; fixture lưu ở `test/fixtures/ai-writing/`.

| #   | Thay đổi                                                                                                                                          | Mục           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 12  | `topic` → **`chart_type`** enum 7 giá trị cho Task 1. Giá trị thật là loại biểu đồ, không phải chủ đề — gửi `"environment"` bị downstream trả 500 | §10, §20, §27 |
| 13  | Thêm **`language`** vào request/response chấm bài; enum hiện tại `['vi']` vì downstream chỉ sinh feedback tiếng Việt                              | §10, §16, §20 |
| 14  | **Mở rộng `GradeResponse`** theo response thật: `band_reason`, `strengths[]`, `improvements[]`, `suggestions[]`, `next_steps[]`, `annotations[]`  | §16, §20      |
| 15  | Đổi `corrections` → **`annotations`**. Dữ liệu thật là `{quote, explanation}` chứ không phải `{original, suggestion}`                             | §16, §20      |
| 16  | Ghi rõ **3 thứ không ra public**: `coT`, `feedback_detail`, `data_micro.*.question_type`                                                          | §16           |
| 17  | `band` chấp nhận **cả int lẫn float** — downstream trả `overall_band: 7.0` nhưng `band_score: 7`                                                  | §16, §20      |
| 18  | Cảnh báo **downstream trả 5xx cho lỗi client**, và hai lớp phòng vệ                                                                               | §25           |
| 19  | Ghi `observed_latency` đo thật vào operation catalog                                                                                              | §27           |

### Ba vấn đề của AI Writing phát hiện qua việc gọi thật

1. **Không endpoint nào trả `usage`** → metering hiện là 0%.
2. **`data.coT` lộ chain-of-thought** ra response (`layer1_errors`, `layer2_matching`, `layer3_calibration`).
3. **Chấm điểm đáng ngờ:** 3 mẫu đều ra band nguyên và cả 4 tiêu chí luôn bằng nhau (7-7-7-7 rồi 5-5-5-5); bài Task 2 dài 98 từ (yêu cầu 250) vẫn được band 5.0.

Chi tiết lập luận cho từng thay đổi: [`implementation spec index`](superpowers/specs/2026-09-07-aihub/README.md)

---

# 35. Kết luận D1

Deliverable 1 nên tạo ra một **public contract ổn định và không mơ hồ** để D2 chỉ việc hiện thực gateway/proxy/routing theo contract đã freeze.

Các nguyên tắc quan trọng đã làm rõ:

```text
Organization     → derive từ API Key
Service/Operation→ derive từ endpoint
Environment      → derive từ deployment hostname
End User         → Signed User Assertion cho user-scoped operations
Request ID       → AIHUB tự generate
Model usage      → AI Service là source of truth
Timing           → tách total/downstream/AI-processing rõ ràng
Authorization    → Organization Entitlement ∩ API Key Scope
Downstream       → gọi AI Service private, không gọi trực tiếp Model Provider từ public contract
```

D1 định nghĩa contract; D2/later mới chịu trách nhiệm runtime implementation.
