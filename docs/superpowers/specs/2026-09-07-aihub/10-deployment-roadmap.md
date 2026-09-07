# 10 — Deployment, Roadmap, Testing, ADR

← [Mục lục](README.md) · [09 — Security](09-security.md)

# N. Deployment

## N.1 Compose stack

```
caddy       :80 :443, TLS tự động, load balance app-1/app-2
app-1       aihub, replica 1
app-2       aihub, replica 2
postgres    16, volume riêng, KHÔNG map port ra ngoài
redis       noeviction, RDB 15 phút, KHÔNG map port ra ngoài
prometheus  scrape app-1, app-2
loki        nhận log qua docker log driver
grafana     dashboard + alert
```

8 container, một VPS **4 vCPU / 8GB** (Hetzner CPX31 ~€15/tháng).

Hai replica app **không phải vì tải**, mà vì deploy không đứt và vì một process chết thì còn cái kia.

## N.2 Graceful shutdown — quan trọng hơn bình thường

```yaml
stop_grace_period: 90s
```

```ts
process.on('SIGTERM', async () => {
  await fastify.close();          // ngừng nhận request mới, xong nốt request đang chạy
  await Promise.all([pg.end(), redis.quit()]);
});
```

Request chấm bài chạy tới 60 giây. Mặc định của Docker là `SIGKILL` sau **10 giây** — nghĩa là mỗi lần deploy bạn cắt ngang bài chấm của học viên **sau khi đã trả tiền token cho nó**. Hai dòng cấu hình này là khác biệt giữa deploy êm với deploy làm khách khó chịu.

## N.3 Deploy: rolling bằng bash

```bash
docker compose pull app-1 app-2
for c in app-1 app-2; do
  docker compose up -d --no-deps "$c"
  until curl -sf "http://$c:3000/health"; do sleep 2; done   # chờ khoẻ mới sang cái kế
done
```

Caddy tự bỏ upstream không healthy ra khỏi vòng quay. **Không cần K8s để có rolling deploy.**

CI: GitHub Actions build image → đẩy lên GHCR → ssh chạy script trên.

Migration chạy **trước** khi deploy app, và chỉ được phép **expand**:

```
ĐƯỢC:    thêm bảng, thêm cột nullable, CREATE INDEX CONCURRENTLY
KHÔNG:   xoá cột, đổi tên cột, thêm NOT NULL không default
```

Xoá cột là một deploy riêng, sau đó vài ngày.

## N.4 Backup — phần dễ bị coi nhẹ nhất

Tự host Postgres cho một sản phẩm thương mại → **đây là rủi ro lớn nhất của cả kiến trúc**.

```bash
# mỗi giờ
pg_dump -Fc aihub | age -r "$BACKUP_PUBKEY" > /tmp/aihub-$(date +%FT%H).dump.age
rclone copy /tmp/aihub-*.age r2:aihub-backups/
# giữ: 48 bản theo giờ, 30 bản theo ngày, 12 bản theo tháng
```

**Mỗi giờ chứ không phải mỗi ngày**, vì mất một ngày `usage_records` là mất một ngày dữ liệu doanh thu. Control plane rất nhỏ (vài trăm MB) nên dump mỗi giờ gần như miễn phí.

```
ponytail: bỏ WAL archiving / PITR. Thêm khi mất 1 giờ dữ liệu là không chấp nhận được,
hoặc khi DB lớn tới mức dump mỗi giờ trở nên nặng.
```

**Diễn tập phục hồi mỗi quý, ghi ngày vào file.** Một bản backup chưa từng restore thì chưa phải backup — nó là một niềm tin. Đây là dòng duy nhất trong toàn bộ thiết kế đề nghị đưa vào **lịch**, không phải vào code.

## N.5 Trigger rời khỏi kiến trúc này

Ghi rõ để sau này không ai nâng cấp vì cảm tính.

| Đổi sang | Trigger |
|---|---|
| Tách VPS riêng cho Postgres | CPU DB > 60% kéo dài, hoặc app và DB tranh I/O |
| Managed Postgres | Không còn ai muốn lo backup/patch, hoặc cần HA |
| Nhiều app node + LB thật | > 300 RPS hoặc > 1000 connection đồng thời |
| Kubernetes | ≥ 3 service cần deploy độc lập **và** có người chịu trách nhiệm vận hành nó |
| Xét lại Go / data plane riêng | p99 gateway overhead > 50ms trong khi CPU chưa bão hoà; hoặc streaming SSE thành must-have; hoặc > 1000 RPS |
| Kafka | Không. Cho tới khi có consumer thứ ba cần đọc lại lịch sử event |
| Partition `usage_records` | > ~50 triệu row, hoặc job retention chạy quá vài phút |
| Vault / SOPS | ≥ 3 môi trường, hoặc có người rời team, hoặc yêu cầu compliance |
| Thêm Tempo/Jaeger | ≥ 3 service trong một luồng request, hoặc có worker async |
| Sliding window / GCRA rate limit | Khách phàn nàn về công bằng, hoặc rate limit thành cam kết hợp đồng |

## N.6 Phases

### Phase 0 — Freeze D1 · *1 tuần, chạy song song*

Chốt canonical schema thật ([06 §H.2](06-routing-adapter.md#h2-canonical-schemas)), 18 mã lỗi ([07 §J.2](07-reliability-and-errors.md#j2-danh-sách-mã-lỗi-v1)), operation catalog ([06 §H.1](06-routing-adapter.md#h1-operation-catalog--code-có-kiểu)), internal contract gửi team Writing ([06 §H.5](06-routing-adapter.md#h5-internal-contract--sửa-writing-mà-không-phá-app-hiện-tại)).

Đây là đầu vào của mọi phase sau. Danh sách thay đổi cụ thể: [11 §Q](11-open-questions.md#q-những-thay-đổi-cần-đưa-ngược-vào-d1).

### Phase 1 — Core proxy · *2–3 tuần*

4 operation Writing; API key auth + CLI; catalog + adapter + dispatcher; error model đầy đủ; `usage_records`; Compose + Caddy + backup.

> **Cột mốc:** khách gọi được `/v1/writing/task1/grade` bằng API key thật.

### Phase 2 — Identity + đóng cửa · *2 tuần*

User assertion + JWKS + SSRF guard; internal JWT + JWKS endpoint + xoay khoá; **Writing rời khỏi Internet vào private network**; Writing trả `usage`.

> **Cột mốc:** AIHUB là đường vào duy nhất, và metering có số thật.

### Phase 3 — Bảo vệ + quan sát · *1–2 tuần*

Rate limit, concurrency limit, quota, idempotency, circuit breaker, retry; Prometheus/Loki/Grafana + alert; load test để chốt `rate_limit_rpm` và `max_concurrent`.

> **Cột mốc:** một khách chạy loạn không làm sập khách khác.

**Phase 1–3 ≈ 6–7 tuần**, khớp mốc 1–2 tháng cho D2.

### Phase 4 — Async + Speaking

Bảng `jobs` (Postgres = SoT), BullMQ trên Redis sẵn có, `assets` + Cloudflare R2 + presigned upload, `GET /v1/jobs/{id}`, webhook delivery + retry.

### Phase 5 — Scale-out

Chỉ khi chạm trigger ở [§N.5](#n5-trigger-rời-khỏi-kiến-trúc-này).

## N.7 Testing strategy

| Loại | Phạm vi | Phase |
|---|---|---|
| Golden fixture cho adapter | `buildRequest` / `parseResponse` — JSON vào, JSON ra, **không mock** | 1 |
| Unit: error mapper, scope resolver, `splitEnvelope` | Hàm thuần | 1 |
| Schema test | Mọi request/response schema có ví dụ hợp lệ và không hợp lệ | 1 |
| **Redact test** | Log không bao giờ chứa key / assertion / nội dung bài viết | 1 |
| Integration: auth pipeline | Key sai/hết hạn/sai env; assertion sai `iss`/`alg`/`exp` | 2 |
| **Xoay khoá JWKS** | Chạy đủ 5 bước [05 §G.8](05-auth-identity.md#g8-jwks-của-aihub--xoay-khoá), không request nào lỗi | 2 |
| Idempotency race | 2 request song song cùng key → đúng **1 lần** gọi downstream | 3 |
| Failure injection | Downstream 500/timeout/connection refused; Redis down | 3 |
| Load test | Chốt `rate_limit_rpm`, `max_concurrent` theo sức chịu thật của Writing | 3 |

### Có cần Pact / consumer-driven contract testing không?

**Chưa.** Với hai service do cùng team sở hữu, JSON Schema validation ở biên (`InternalResponseSchema`) + golden fixture đã bắt được đúng những lỗi mà Pact bắt, với chi phí vận hành gần bằng 0.

Xét lại khi AI Service do **team khác** sở hữu — lúc đó Pact mua được thứ mà schema validation không mua được: phá build của *họ* khi họ đổi contract.

### Postman collection cho D2

Theo D1 §G, tối thiểu 15 ca. Sinh từ OpenAPI (vốn sinh từ TypeBox) thay vì viết tay.

---

# O. ADR List

| ADR | Nội dung | Điểm cốt lõi phải ghi lại |
|---|---|---|
| 001 | NestJS + Fastify; không dùng Envoy/Kong làm data plane | Logic của AIHUB là application logic đội lốt proxy |
| 002 | PostgreSQL cho control plane; 5 bảng thay vì 13 | Bảng nào bị cắt và điều kiện thêm lại |
| 003 | Format API key + SHA-256 | **Vì sao không** bcrypt/argon2 |
| 004 | Signed User Assertion + JWKS | `UNIQUE(issuer)`; giới hạn TTL; alg allowlist |
| 005 | Internal JWT EdDSA + xoay khoá | `aud` riêng từng service; quy trình 5 bước |
| 006 | Trách nhiệm của Redis | **Fail open khi Redis chết** — lập luận "cho qua thì hoàn tác được" |
| 007 | Idempotency lưu ở Postgres | `ON CONFLICT` thay lock; timeout không mất tiền hai lần |
| 008 | Operation catalog ở code, không ở DB | Lý do SSRF + type-check |
| 009 | Adapter là hàm thuần, không I/O | Golden fixture không cần mock |
| 010 | Ghi cả request lẫn token | Billing chưa chốt; dữ liệu quá khứ không tạo lại được |
| 011 | Docker Compose trên VPS | Trigger rời đi ở [§N.5](#n5-trigger-rời-khỏi-kiến-trúc-này) |
| 012 | Bỏ distributed tracing ở Stage A | Giữ `traceparent` để cắm sau |

ADR 003, 006, 007 là ba cái quan trọng nhất phải viết trước — chúng đều là quyết định **ngược trực giác** mà nếu không ghi lý do thì sáu tháng nữa sẽ có người "sửa" lại thành sai.

---

→ Tiếp: [11 — Open Questions](11-open-questions.md)
