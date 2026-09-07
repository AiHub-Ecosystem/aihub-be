# 03 — Database Design (Control Plane)

← [Mục lục](README.md) · [02 — Request Lifecycle](02-request-lifecycle.md)

> Brief §13.2 liệt kê 13 bảng. Thiết kế này dùng **5 bảng** cho D2. Lý do từng bảng bị cắt ở [§E.5](#e5-tám-bảng-bị-cắt-khỏi-d2).

## E.1 Quy ước

- **PK = ULID có prefix, kiểu `text`**: `org_01J8…`, `ak_01J8…`, `req_01J8…`. Tự mô tả trong log và response, sort được theo thời gian (index locality tốt), không lộ số lượng như bigint. Sinh ở app, không ở DB.
- **Soft delete = cột `status`**, không có `deleted_at`. API key bị revoke không bao giờ xoá thật — cần cho audit.
- **Audit fields**: `created_at` mọi bảng; `updated_at` cho bảng có sửa.
- **Driver: Drizzle** — schema này dùng `text[]`, partial index, `ON CONFLICT`, BRIN; Drizzle giữ SQL gần nguyên bản, Prisma vướng đúng mấy chỗ đó.

## E.2 DDL

```sql
CREATE TABLE organizations (
  id                    text PRIMARY KEY,                    -- org_01J...
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','suspended')),
  entitlements          text[] NOT NULL DEFAULT '{}',        -- {writing,speaking}
  rate_limit_rpm        integer NOT NULL DEFAULT 600,
  max_concurrent        integer NOT NULL DEFAULT 20,
  monthly_request_quota integer,                             -- NULL = không giới hạn
  hard_stop_on_quota    boolean NOT NULL DEFAULT false,      -- xem 04 §F.5
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id                   text PRIMARY KEY,                     -- ak_01J...
  organization_id      text NOT NULL REFERENCES organizations(id),
  key_hash             bytea NOT NULL,                       -- sha256(raw), 32 byte
  key_prefix           text NOT NULL,                        -- 'aihub_sk_a1b2c3', chỉ để hiển thị
  name                 text NOT NULL,
  scopes               text[] NOT NULL DEFAULT '{}',
  allowed_environments text[] NOT NULL DEFAULT '{production}',
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','revoked')),
  expires_at           timestamptz,
  last_used_at         timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX api_keys_hash_uq ON api_keys (key_hash);   -- đường lookup DUY NHẤT
CREATE INDEX api_keys_org_idx        ON api_keys (organization_id);

CREATE TABLE organization_identity_configs (
  organization_id           text PRIMARY KEY REFERENCES organizations(id),
  issuer                    text NOT NULL,
  jwks_url                  text,
  public_keys_jwks          jsonb,          -- fallback khi org không host JWKS
  allowed_algorithms        text[] NOT NULL DEFAULT '{RS256,ES256}',
  max_assertion_ttl_seconds integer NOT NULL DEFAULT 300,
  status                    text NOT NULL DEFAULT 'active',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (jwks_url IS NOT NULL OR public_keys_jwks IS NOT NULL)
);
CREATE UNIQUE INDEX oic_issuer_uq ON organization_identity_configs (issuer);

CREATE TABLE idempotency_records (
  organization_id     text NOT NULL,
  operation           text NOT NULL,
  idempotency_key     text NOT NULL,
  request_fingerprint bytea NOT NULL,      -- sha256(canonicalJSON(body) + actorId)
  state               text NOT NULL CHECK (state IN ('pending','completed','failed')),
  request_id          text NOT NULL,
  response_status     integer,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  expires_at          timestamptz NOT NULL,
  PRIMARY KEY (organization_id, operation, idempotency_key)
);
CREATE INDEX idem_expires_idx ON idempotency_records (expires_at);

CREATE TABLE usage_records (
  request_id        text PRIMARY KEY,                        -- req_01J..., ULID
  organization_id   text NOT NULL,
  api_key_id        text NOT NULL,
  actor_id          text,                                    -- external_user_id
  service           text NOT NULL,
  operation         text NOT NULL,
  environment       text NOT NULL,
  outcome           text NOT NULL CHECK (outcome IN
                      ('success','client_error','downstream_error','internal_error')),
  http_status       integer NOT NULL,
  error_code        text,
  billable_requests integer NOT NULL DEFAULT 1,
  input_tokens      integer,
  output_tokens     integer,
  total_tokens      integer,
  models            jsonb,
  metering_status   text NOT NULL CHECK (metering_status IN
                      ('complete','missing_usage','not_applicable','quota_unverified')),
  total_ms          integer NOT NULL,
  downstream_ms     integer,
  ai_processing_ms  integer,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_org_time_idx ON usage_records (organization_id, created_at DESC);
CREATE INDEX usage_created_brin ON usage_records USING BRIN (created_at);
```

## E.3 Bốn quyết định quan trọng nhất

### 1. API key hash bằng SHA-256, KHÔNG dùng bcrypt/argon2

Đây là chỗ hay bị làm sai nhất.

Raw key là 256 bit ngẫu nhiên từ CSPRNG — **không có từ điển nào để tấn công**, nên slow hash không thêm một chút an toàn nào. Đổi lại bcrypt tốn ~100ms CPU **mỗi request**; ở 50 RPS đó là tự DoS chính mình. Stripe và GitHub đều dùng hash nhanh vì lý do này.

Hệ quả rất đẹp: `key_hash` unique → lookup là **một index seek duy nhất**, không cần "tìm theo prefix rồi so hash từng cái". `key_prefix` chỉ để hiển thị trong dashboard. Cũng không cần so sánh constant-time, vì ta lookup *bằng* hash chứ không so sánh nó.

### 2. `issuer` UNIQUE toàn hệ thống

Không có ràng buộc này, Org B đăng ký `iss` trùng của Org A rồi tự ký assertion mạo danh học viên của A. **Một dòng `UNIQUE INDEX` chặn cả một lớp tấn công cross-tenant.**

### 3. `metering_status` là cách xử lý việc billing chưa chốt

Ghi **cả hai**: `billable_requests` luôn có, `*_tokens` có khi AI Service trả.

| Giá trị | Khi nào |
|---|---|
| `complete` | AI Service trả usage đầy đủ |
| `missing_usage` | Operation có gọi model nhưng AI Service quên trả usage |
| `not_applicable` | Operation không gọi model (vd `/generate-question-task1`) |
| `quota_unverified` | Redis chết nên không kiểm được quota, request vẫn cho qua |

Không bao giờ giả `0` cho usage thiếu. Rẻ bây giờ, **không thể làm ngược lại sau** — dữ liệu tháng trước không tự mọc ra.

### 4. `last_used_at` không ghi mỗi request

50 RPS ghi cùng một row là row contention thật. Chỉ update khi cũ hơn 1 phút, chạy ngoài luồng response, lỗi thì bỏ qua:

```sql
UPDATE api_keys SET last_used_at = now()
WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute');
```

## E.4 Xử lý race của idempotency — không cần distributed lock

```sql
INSERT INTO idempotency_records (...) VALUES (..., 'pending', ...)
ON CONFLICT (organization_id, operation, idempotency_key) DO NOTHING
RETURNING request_id;
```

| Kết quả | Xử lý |
|---|---|
| Có `RETURNING` | Mình là người đầu tiên → chạy tiếp |
| Không có row, `fingerprint` khác | `409 IDEMPOTENCY_CONFLICT` |
| Không có row, `state=completed` | Replay `response_body` + header `Idempotent-Replay: true` |
| Không có row, `state=pending` | `409` (đang xử lý). **Không chờ** — chờ là giữ connection và gây sập dây chuyền |
| Không có row, `state=failed` | Cho chạy lại |

Primary key của Postgres lo phần đua. **Không Redis lock, không Redlock.**

## E.5 Tám bảng bị cắt khỏi D2

| Bảng | Vì sao bỏ | Thêm lại khi |
|---|---|---|
| `plans`, `subscriptions` | Business chưa chốt mô hình bán. Dựng bảng bây giờ = thiết kế cho một mô hình kinh doanh chưa tồn tại | Chốt pricing |
| `organization_entitlements` | Là một danh sách giá trị, không có vòng đời riêng → `entitlements text[]` | Entitlement cần thời hạn/nguồn gốc riêng |
| `api_key_scopes` | Luôn đọc kèm key, không bao giờ query ngang | Gần như không bao giờ |
| `routing_rules`, `downstream_configs` | Xem ghi chú SSRF bên dưới | Cần canary/failover thật |
| `quota_configs` | 3 cột trên `organizations` là đủ ở Stage A | Quota cần theo từng operation |
| `assets` | Chỉ Speaking cần | Phase 4 |
| `webhook_endpoints` | Chỉ async cần | Phase 4 |

### Vì sao routing catalog nằm ở code chứ không ở DB

Đây là challenge lớn nhất với brief. Operation Catalog và downstream URL nên nằm ở **code + biến môi trường**:

- Adapter vốn đã là code. Thêm AI Service mới = viết adapter mới = deploy. Config trong DB **không giúp khỏi deploy**, chỉ tách sự thật ra làm hai chỗ.
- Catalog trong TypeScript được **type-check**; sai scope hay sai schema là lỗi compile chứ không phải sự cố production.
- Quan trọng nhất: **URL downstream nằm trong DB là một lỗ SSRF**. Ai ghi được vào bảng đó thì trỏ được AIHUB vào `169.254.169.254` — và AIHUB đang cầm internal JWT. URL trong env var thì không có bề mặt tấn công đó.

Brief §13.14 tự liệt kê "SSRF từ configurable downstream URL" là mối đe doạ. Cách rẻ nhất để trị nó là **đừng để URL configurable**.

## E.6 Partition và retention

**Không partition `usage_records` ngay.** Ở 50 RPS peak, thực tế cỡ 1–5 triệu row/năm — Postgres xử lý thoải mái với BRIN trên `created_at`.

Trigger để partition: **> ~50 triệu row**, hoặc job xoá theo retention chạy quá vài phút. Migration khi đó là tạo bảng partitioned + copy + đổi tên, trong một cửa sổ bảo trì. Chấp nhận cái giá đó thay vì gánh phức tạp partitioning suốt năm đầu.

Retention:

| Bảng | Giữ | Vì sao |
|---|---|---|
| `usage_records` | 13 tháng | Đủ so sánh cùng kỳ năm trước cho billing |
| `idempotency_records` | 24h | Theo D1 §26 |

Một cron `DELETE` mỗi đêm, không cần scheduler riêng.

---

→ Tiếp: [04 — Redis](04-redis.md)
