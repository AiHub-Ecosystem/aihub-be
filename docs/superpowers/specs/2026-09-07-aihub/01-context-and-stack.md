# 01 — Bối cảnh, hiện trạng, và Tech Stack

← [Mục lục](README.md)

## 0. Ràng buộc đã chốt

Mọi quyết định trong bộ tài liệu này suy ra từ 8 ràng buộc sau. Nếu một ràng buộc thay đổi, phải xem lại các quyết định gắn với nó.

| # | Ràng buộc | Ảnh hưởng chính |
|---|---|---|
| 1 | Sản phẩm **thương mại thật**, có khách B2B trả tiền | Metering/billing là ràng buộc kiến trúc, không phải tính năng phụ |
| 2 | Chỉ **AI Writing** đang tồn tại; Speaking/Reading là kế hoạch | MVP proxy 1 service, nhưng phải chứng minh mở rộng được |
| 3 | Team **2–3 backend, không có DevOps riêng** | Loại K8s, service mesh, Kafka, Vault ở giai đoạn này |
| 4 | Hạ tầng **VPS tự host** | Tự lo Postgres/Redis + backup nghiêm túc |
| 5 | **Stage A**: vài org, 10–50 RPS peak | Không partition, không autoscale, không distributed tracing |
| 6 | D2 trong **1–2 tháng**, chỉ Writing sync; Speaking ngay sau | Async chốt contract nhưng chưa implement |
| 7 | Khách hàng **có team dev tốt** | JWKS/JWT asymmetric khả thi ngay từ đầu |
| 8 | **Mô hình bán hàng chưa chốt** | Ghi cả request count lẫn token từ ngày đầu |
| 9 | **Admin API hoãn** — onboard org/key bằng CLI/SQL tay | CLI là code sản xuất, không phải script vứt đi |

## 0.1 Hiện trạng AI Writing (khảo sát thật)

Service: `Wispace AI Writing Assistant` — `https://api-ielts-writing.aihubproduction.com`

13 endpoint, path phẳng, không version, auth `HTTPBearer`:

```
task 1                        task 2                      chung
/generate-question-task1      /question-generated-task2   /five-minute-grading
/writing-assistant-task1      /writing-assistant-task2    /create-micro-exercise
/vocab-suggestion-task1       /vocab-suggestion-task2     /grading-micro-exercise
/grading-feedback-task1       /grading-feedback-task2
/essay-improvement-task1      /essay-improvement-task2
```

Input của 4 endpoint được team ưu tiên (tạo đề + chấm bài, task 1 và task 2):

| Endpoint | Required fields | Gọi model? |
|---|---|---|
| `/generate-question-task1` | `topic` (optional, default `""`) | **Không** — đọc từ DB |
| `/question-generated-task2` | `topic`, `question_type` | Có |
| `/grading-feedback-task1` | `question`, `url`, `topic`, `essay` | Có |
| `/grading-feedback-task2` | `question`, `topic`, `essay` | Có |

### Bốn phát hiện làm thay đổi thiết kế

1. **Canonical schema trong D1 §10 không khớp thực tế.** D1 giả định `content` / `language` / `level`; chấm bài thật cần `question` / `topic` / `essay`, và Task 1 cần thêm `url` (ảnh biểu đồ). Không có `language` — IELTS thì luôn là tiếng Anh. Phải viết lại trước khi freeze D1.
2. **Task 1 và Task 2 khác shape thật sự** (`url` chỉ có ở Task 1) → tách endpoint riêng, xem [06 §H.1](06-routing-adapter.md#h1-operation-catalog--code-có-kiểu).
3. **`/generate-question-task1` không gọi model** → `usage` phải `omit`, không phải `0`. Đúng ca mà D1 §15 đã lường trước, và giờ có ví dụ cụ thể.
4. **Response schema trong OpenAPI là `{}`** — không có mô tả nào. Đây là blocker duy nhất còn lại cho Phase 1, xem [11 §P.1](11-open-questions.md#p1-response-thật-của-grading-feedback-task12--chặn-phase-1).

### Hai vấn đề an ninh trên service đang chạy production

- **`/five-minute-grading` không khai báo security** trong khi mọi endpoint khác dùng `HTTPBearer`. Service đang mở ra Internet → bất kỳ ai cũng gọi được và team trả tiền token.
- **Cả service đang public trên Internet.** Kiến trúc đích yêu cầu AI Service chỉ reachable trong private network. Chừng nào còn public, khách hàng có thể đi vòng qua AIHUB và **mọi rate limit / quota / metering đều vô nghĩa**. Việc đóng nó lại thuộc Phase 2, không phải "sau này".

Ngoài ra: `url` trong Task 1 là URL do client cung cấp mà Writing sẽ tự đi fetch → SSRF nằm ở phía Writing. Cần chặn private IP ở đó, hoặc chuyển sang `asset_id` khi làm object storage ở Phase 4.

---

## B. Recommended Tech Stack Matrix

| Layer | Recommended | Alternatives đã cân nhắc | Vì sao |
|---|---|---|---|
| Runtime | **Node.js 22 LTS + TypeScript** | Go, Bun | Ở 50 RPS, request AI là I/O-bound — đúng chỗ Node mạnh. Go không trả công cho chi phí học ở Stage A |
| Framework | **NestJS + Fastify adapter** | Fastify trần, Express, Go/chi | Module NestJS khớp 1-1 với §27 kiến trúc đích; sản phẩm sống lâu, nhiều người sửa → DI + boundary đáng giá |
| Validation | **TypeBox** | Zod, class-validator, AJV thuần | Fastify chạy thẳng JSON Schema (compile được). Một định nghĩa ra ba thứ: type TS + validator + OpenAPI 3.1 |
| HTTP client | **undici (Pool)** | axios, native fetch, got | Keep-alive pool, `AbortSignal`, timeout tách headers/body, sẵn sàng cho streaming |
| Primary DB | **PostgreSQL 16** | MySQL, distributed SQL | `text[]`, partial index, `ON CONFLICT`, JSONB, BRIN — dùng hết trong thiết kế này |
| DB access | **Drizzle** | Prisma, TypeORM, Kysely | Giữ SQL gần nguyên bản; Prisma vướng đúng ở array column, `ON CONFLICT`, partial index |
| Cache / counters | **Redis 7** | Memcached, in-memory | Cần INCR nguyên tử + zset + TTL. Không bao giờ là nguồn sự thật |
| Queue | **Không có ở MVP** → BullMQ ở Phase 4 | RabbitMQ, Kafka, SQS | Chưa có async use case. BullMQ dùng lại Redis sẵn có |
| Object storage | **Không có ở MVP** → Cloudflare R2 ở Phase 4 | S3, MinIO, B2 | R2 không tính egress — hợp file audio Speaking |
| Circuit breaker | **opossum** | tự viết | Half-open đúng cách khó viết; tự viết dễ thả cả trăm request vào lúc service vừa hồi |
| Proxy / TLS | **Caddy** | nginx, Traefik | TLS tự động, config ~5 dòng, không ai phải nhớ gia hạn cert |
| Observability | **Prometheus + Loki + Grafana** | + Tempo/Jaeger, Datadog | 3 container. Bỏ Tempo ở Stage A: với 2 service, `request_id` trong log đã đủ |
| Deployment | **Docker Compose trên 1 VPS** | K8s, ECS, Cloud Run | 2–3 dev không DevOps. Trigger rời đi ở [10 §N.5](10-deployment-roadmap.md#n5-trigger-rời-khỏi-kiến-trúc-này) |
| Secrets | **`.env` chmod 600** | Vault, SOPS, Doppler | Chưa tới ngưỡng. Trigger ở [05 §G.9](05-auth-identity.md#g9-secret) |

### Đánh giá candidate stack trong brief §14

| Item trong brief | Phán quyết | Ghi chú |
|---|---|---|
| TypeScript + Node.js | **Keep** | — |
| NestJS + Fastify | **Keep** | Fastify vì schema-first, không phải vì RPS |
| undici / native fetch | **Keep** (undici Pool) | Cần Pool để keep-alive per-downstream |
| PostgreSQL | **Keep** | — |
| Redis | **Keep**, thu hẹp vai trò | Bỏ khỏi đường idempotency hoàn toàn |
| BullMQ | **Defer** → Phase 4 | Chưa có async use case |
| S3-compatible / R2 | **Defer** → Phase 4 | Vào cùng Speaking |
| OTel + Prometheus + Grafana + Tempo/Loki | **Keep một phần** | Bỏ Tempo. Giữ propagate `traceparent` để cắm sau |
| OpenAPI 3.1 + JSON Schema | **Keep** | Sinh từ TypeBox, không viết tay |
| Docker + VPS | **Keep** | — |
| Kubernetes | **Defer** | Trigger ở [10 §N.5](10-deployment-roadmap.md#n5-trigger-rời-khỏi-kiến-trúc-này) |

### Ba hướng đã cân nhắc cho câu hỏi lớn nhất của brief (§18.1, §18.2)

**Hướng A — Modular monolith, không data plane riêng.** *(chọn)* Một app Node làm hết; Caddy chỉ lo TLS. Giá phải trả: Node single-threaded nên muốn dùng hết CPU phải chạy nhiều instance — ở 50 RPS không thành vấn đề vì request AI là chờ I/O.

**Hướng B — Kong/Envoy làm data plane + app làm control plane.** *(loại)* Kong không biết gì về `entitlement ∩ api_key_scope`, không verify được assertion với JWKS *per-org*, không map được request. Phải viết plugin Lua cho từng thứ đó — tức là viết lại chính app của mình bằng ngôn ngữ tệ hơn. Cộng thêm Kong tự nó cần một Postgres nữa. Với 2–3 dev không DevOps, nuôi 2 hệ thống config là tự sát.

**Hướng C — Go, single binary.** *(hoãn)* Deploy sướng, concurrency tốt hơn, RAM thấp hơn — nhưng ở 50 RPS lợi thế đó bằng 0. Đổi lại mất hệ sinh thái validation/OpenAPI/DI mà D1 đang cần. Trigger xét lại ở [10 §N.5](10-deployment-roadmap.md#n5-trigger-rời-khỏi-kiến-trúc-này).

---

## C. Architecture Diagram

```
                          Internet
                             │ :443 TLS
                        ┌────▼────┐
                        │  Caddy  │  Let's Encrypt tự động, HTTP/2
                        └────┬────┘
                    ┌────────┴────────┐
               ┌────▼────┐       ┌────▼────┐
               │ aihub-1 │       │ aihub-2 │   Node, 2 replica
               └────┬────┘       └────┬────┘   (deploy không đứt)
                    └────────┬────────┘
          ┌──────────────────┼──────────────────┐
     ┌────▼─────┐      ┌─────▼────┐      ┌──────▼──────┐
     │ Postgres │      │  Redis   │      │ Prometheus  │
     │   SoT    │      │  cache   │      │ Loki        │
     │          │      │ counter  │      │ Grafana     │
     └──────────┘      └──────────┘      └─────────────┘
                    │
      ══════════════╪══════════════  private network, không expose
                    ▼
             ┌─────────────┐
             │ AI Writing  │  Bearer <internal JWT>, TTL 60s
             └──────┬──────┘
                    ▼
            OpenAI / Anthropic / ...   (AI Service tự gọi, AIHUB không biết)
```

Đường async ở Phase 4:

```
  AIHUB ──► jobs (Postgres, SoT) ──► BullMQ (Redis, thi hành) ──► worker ──► AI Speaking
     │                                                                          │
     └──────────────── R2 (audio, presigned upload) ◄───────────────────────────┘
```

---

→ Tiếp: [02 — Request Lifecycle](02-request-lifecycle.md)
