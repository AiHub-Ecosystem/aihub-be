# 02 — Request Lifecycle

← [Mục lục](README.md) · [01 — Bối cảnh & Stack](01-context-and-stack.md)

## D.1 Pipeline — thứ tự có chủ đích

Nguyên tắc: **rẻ trước, đắt sau; fail closed**.

```
 1. request_id (ULID) + start timer          middleware, không I/O
 2. environment <- Host header               middleware, không I/O
 3. IP-level guard (đếm auth-fail)           Redis
 4. API Key auth                             Redis cache -> Postgres
 5. environment binding check                in-memory, từ bước 4
 ─────────── tới đây mới biết là org nào ───────────
 6. parse + validate body (JSON Schema)      Fastify, bodyLimit theo operation
 7. User Assertion verify                    JWKS cache -> verify chữ ký
 8. effective scope = entitlement ∩ key scope
 9. authorize(operation.required_scope)
10. rate limit + quota + concurrency         Redis
11. idempotency check                        Postgres
════════════════ BIÊN TỐN TIỀN ════════════════
12. resolve downstream + buildRequest
13. mint internal JWT (TTL 60s)
14. HTTP call qua undici (timeout + breaker)
15. parseResponse / mapError
16. ghi usage_records
17. đóng gói { data, meta }
```

### Ba lý do cho thứ tự này

**Auth (4) trước validate body (6).** Request rác không có key hợp lệ bị chặn khi mới đọc header — không tốn công parse 20KB JSON. Đây cũng là lý do `bodyLimit` đặt theo operation chứ không đặt global.

**Bước 3 tồn tại vì bước 4 là chỗ bị brute-force.** Rate limit theo org không cứu được kẻ đang *đoán* key — lúc đó chưa xác định được org nào cả. Cần một guard theo IP đứng trước, và nó chỉ đếm **lần thất bại**, nên khách hàng thật không bao giờ chạm tới dù bắn 50 RPS từ một IP.

**Vạch sau bước 11 là "biên tốn tiền".** Mọi thứ trên vạch phải fail nhanh và rẻ; mọi thứ dưới vạch có thể gọi model và tốn tiền thật. Idempotency **phải** nằm ngay trên vạch, không phải dưới.

## D.2 Map vào NestJS

Trùng gần như 1-1 với execution order sẵn có của Nest, nên không phải bịa framework riêng.

| Bước | Nest construct |
|---|---|
| 1, 2 | Middleware |
| 3, 4, 5 | `ApiKeyGuard` |
| 7, 8, 9 | `UserAssertionGuard` → `ScopeGuard` |
| 10 | `RateLimitGuard` |
| 6 | Pipe (chạy sau Guard — đúng ý ta) |
| 11, 16, 17 | Interceptor (bọc handler) |
| 12–15 | Service: Registry → Adapter → Dispatcher → HttpClient |
| lỗi | Một `ExceptionFilter` duy nhất |

Controller chỉ khai báo operation và gọi dispatcher. **Không controller nào đọc header thô** — identity đã được chuẩn hoá thành `RequestContext` từ guard.

## D.3 Lifecycle 1 — sync thành công

`POST /v1/writing/task1/grade`

```
Customer BE ──X-API-Key, X-User-Assertion, Idempotency-Key──► AIHUB
                                          t0 ─┐
   req_01J... ; env=production                │  bước 1-11: ~3-8ms
   org_abc ; actor=student_123                │
   scope OK ; quota OK ; idem: chưa thấy      │
                                          t1 ─┤
   ──Bearer <internal JWT, exp=t1+60s>──► ai-writing        │
       POST /grading-feedback-task1                         │ downstream_ms
   ◄── { ...fields, usage{}, models[], metrics{} } ──       │
                                          t2 ─┤
   splitEnvelope -> parseResponse -> ghi usage_records
                                          t3 ─┘
◄── 200 { data, meta{ request_id, usage, timing } }

total_ms = t3-t0    downstream_ms = t2-t1    gateway_overhead_ms = total - downstream
```

Định nghĩa timing giữ nguyên theo D1 §14 và kiến trúc đích §17.1. Không giả định `total_ms = gateway_overhead_ms + ai_processing_ms`, vì `downstream_ms` còn bao gồm network và overhead của chính AI Service.

## D.4 Lifecycle 2 — downstream lỗi

```
   ──► ai-writing ─╳─ ECONNREFUSED / 503 / timeout
                    │
       circuit breaker ghi nhận failure (CHỈ 5xx/timeout/lỗi kết nối)
                    │
       retry CHỈ khi request chưa hề được gửi đi  (xem 07 §I.2)
                    │
       503 AI_SERVICE_UNAVAILABLE  /  504 AI_SERVICE_TIMEOUT
       idempotency: 5xx -> failed (cho retry) ; 4xx -> XOÁ record
       usage_records: outcome=downstream_error, usage=null
                    ▼
◄── { error: { code, message, request_id, retryable, retry_after_ms } }

Log nội bộ giữ: private_endpoint, downstream_status, downstream_error_code, downstream_ms
Client không thấy bất kỳ field nào trong số đó.
```

## D.5 Lifecycle 3 — async media (Phase 4, contract chốt ngay)

```
POST /v1/speaking/grade
  -> ghi jobs(status=queued) vào Postgres   ← nguồn sự thật
  -> đẩy job id vào BullMQ                  ← chỉ là hàng đợi thi hành
  -> 202 { data: { job_id, status: "queued" } }

worker: jobs.status=running -> AI Speaking -> jobs.status=succeeded + result

GET /v1/jobs/{job_id}
  -> 200 { data: { job_id, status, result?, error? } }
```

**Quy tắc phải chốt ngay bây giờ, dù code ở Phase 4:**

> Bảng `jobs` ở Postgres là **nguồn sự thật** của job. Redis/BullMQ chỉ là hàng đợi thi hành.

Redis mất là mất hàng đợi, không mất job — một reconciler quét `jobs` ở trạng thái `queued` quá lâu rồi đẩy lại vào queue. Nếu để trạng thái job sống trong Redis thì một lần Redis sập là mất bài nộp của học viên, tức là mất dữ liệu khách hàng.

Chốt contract async ngay từ D1 để sau này thêm Speaking không phải phá vỡ public API — kể cả khi implementation còn xa.

---

→ Tiếp: [03 — Database](03-database.md)
