# 07 — Reliability & Unified Error Model

← [Mục lục](README.md) · [06 — Routing & Adapter](06-routing-adapter.md)

# I. Reliability

## I.1 Ngân sách timeout, xếp tầng

```
Caddy                     120s     luôn phải LỚN HƠN app
 └─ AIHUB op.timeoutMs     60s     chấm bài   (sinh đề: 10s / 30s)
     └─ undici headers/bodyTimeout = phần còn lại của ngân sách
         └─ header x-request-deadline -> AI Writing tự biết còn bao lâu
```

Deadline tính **một lần** lúc request vào (`ctx.deadlineMs`), rồi mọi bước sau trừ dần vào đó. Không timeout nào được đặt độc lập — nếu không, retry cộng dồn sẽ vượt qua cả timeout tổng.

Tài liệu cho khách phải ghi rõ: *chấm bài có thể mất tới 60 giây, đặt timeout phía bạn ít nhất 90 giây.* Khách để timeout 30s là chuyện sẽ xảy ra nếu không nói trước.

## I.2 Retry — phân biệt "chưa gửi" và "không biết"

Đây là quyết định cốt lõi của toàn bộ retry policy, và **nó không nằm ở HTTP status**:

```
ECONNREFUSED / DNS fail / lỗi khi đang bắt tay TCP
  -> request CHƯA HỀ tới AI Service -> retry an toàn, kể cả POST tốn tiền

Timeout sau khi đã gửi / connection reset giữa chừng
  -> KHÔNG BIẾT model đã chạy chưa -> mặc định KHÔNG retry
```

| Tình huống | Retry? |
|---|---|
| Chưa kết nối được (`ECONNREFUSED`, DNS) | Có, tối đa 2 lần |
| `503` + có `Retry-After` | Có, 1 lần, nếu còn đủ deadline |
| `502`, `500` | 1 lần nếu operation là `GET`; POST thì không |
| Timeout sau khi gửi | **Không** — xem [§I.5](#i5-timeout--idempotency-key-không-mất-tiền-hai-lần) |
| `4xx` bất kỳ | Không bao giờ — retry lỗi client là vô nghĩa |
| Breaker đang mở | Không, trả 503 ngay |

### Backoff: full jitter

```ts
const delay = Math.random() * Math.min(2_000, 200 * 2 ** attempt);
if (Date.now() + delay + expectedMs > ctx.deadlineMs) throw lastError;  // hết ngân sách thì thôi
```

Full jitter (random **từ 0**) thay vì "exponential + cộng chút nhiễu": khi AI Writing vừa sống lại sau sự cố, mọi client retry cùng lúc sẽ đạp nó chết lần nữa. Random từ 0 rải đều chúng ra.

Tối đa 1–2 retry + circuit breaker ⇒ khuếch đại tải tối đa 2x.

```
ponytail: bỏ retry budget/throttling kiểu gRPC. Thêm khi có > 3 downstream
hoặc khi thấy retry storm trong một sự cố thật.
```

## I.3 Circuit breaker — `opossum`, key theo operation

```ts
new CircuitBreaker(call, {
  errorThresholdPercentage: 50,
  volumeThreshold: 20,        // đừng mở vì 2 request đầu lỗi
  resetTimeout: 30_000,       // sau 30s thả 1 request thăm dò
  timeout: false,             // undici đã lo timeout, đừng đặt hai chỗ
});
```

**Không tự viết.** Breaker đúng cần rolling window + trạng thái half-open chỉ cho **một** request đi qua. Tự viết rất dễ để cả trăm request tràn vào lúc half-open và đạp service chết ngay khi nó vừa hồi.

**Key là `operation`, không phải `downstream`.** Nếu `/grading-feedback-task1` hỏng mà `/generate-question-task1` vẫn tốt, breaker theo service sẽ giết luôn cả hai. Cùng lượng code, chỉ khác cái key.

**Chỉ 5xx / timeout / lỗi kết nối tính là failure.** `4xx` từ downstream **không** được tính — service vẫn khoẻ, chỉ là client gửi sai. Đếm nhầm 400 vào đây thì một khách gửi payload sai sẽ mở breaker và làm sập dịch vụ của **mọi khách khác**.

Breaker mở → `503 AI_SERVICE_UNAVAILABLE`, `retry_after_ms` = thời gian còn lại tới lần thăm dò kế tiếp.

## I.4 Idempotency, vòng đời đầy đủ

```
fingerprint = sha256( canonicalJSON(body đã validate) + actorId )
```

Băm **sau khi validate và chuẩn hoá** (sắp key theo thứ tự), không băm bytes thô — nếu không thì khác mỗi dấu cách cũng thành `409` oan. Có `actorId` vì cùng một key dùng cho hai học viên khác nhau là hai request khác nhau thật.

Trạng thái và xử lý race: xem [03 §E.4](03-database.md#e4-xử-lý-race-của-idempotency--không-cần-distributed-lock).

### Lỗi 4xx thì XOÁ record, không lưu

```ts
if (status >= 400 && status < 500) await idem.delete(key);
```

Khách gửi sai payload, sửa lại, rồi dùng lại key cũ → nếu lưu 4xx thì họ ăn `409` vĩnh viễn và phải đổi key, rất khó hiểu. **Không có tiền nào bị tiêu cho một request 4xx**, nên chẳng có gì để bảo vệ.

Retention 24h theo D1 §26; cron đêm `DELETE WHERE expires_at < now()`.

## I.5 Timeout + Idempotency-Key: không mất tiền hai lần

Hệ quả trực tiếp của [06 §H.7](06-routing-adapter.md#h7-client-ngắt-kết-nối-giữa-chừng--xử-lý-theo-tiền), và nó giải quyết ca khó nhất.

Khi timeout mà request **có** `Idempotency-Key`:

```
1. Trả 504 AI_SERVICE_TIMEOUT cho client ngay
2. NHƯNG không huỷ lời gọi xuống AI Writing — để nó chạy nốt ở nền
3. Khi nó xong -> ghi kết quả vào idempotency record, state = completed
4. Client retry cùng key -> nhận kết quả đã có, KHÔNG gọi model lần hai
```

Tiền đã tiêu rồi ở lần một. Huỷ đi thì vừa mất tiền vừa không có kết quả, rồi lần retry lại tiêu tiếp. **Chạy nốt thì tiêu đúng một lần.**

Chặn an toàn: tác vụ nền bị cắt cứng ở `2 × timeoutMs`, và nó chết theo process khi deploy. Nếu chết thật thì record hết hạn và client retry được — mất tiền một lần, không kẹt.

Không có key thì huỷ ngay để đỡ tốn.

## I.6 Bulkhead & load shedding

Đã có sẵn từ [04](04-redis.md), không cần thêm gì:

- concurrency limit theo org (zset Redis) — chống một khách chiếm hết
- backstop cục bộ `GLOBAL_MAX_INFLIGHT` — chống lúc Redis chết
- pool undici `connections: 64`/downstream — chặn trên tự nhiên cho tải xuống AI Writing

```
ponytail: bỏ load shedding theo event-loop lag. Thêm khi thấy lag p99 > 200ms
trong khi CPU chưa bão hoà — công việc ở đây là I/O-bound nên chưa cần.
```

---

# J. Unified Error Model

## J.1 Vỏ response lỗi

```json
{
  "error": {
    "code": "AI_SERVICE_TIMEOUT",
    "message": "AI service did not respond in time",
    "request_id": "req_01J8...",
    "retryable": true,
    "retry_after_ms": 2000
  }
}
```

**Không bao giờ lộ:** stack trace, URL nội bộ, lỗi DB, tên model/provider, exception thô của downstream.

## J.2 Danh sách mã lỗi v1

| HTTP | Code | Khi nào | Retryable |
|---:|---|---|---|
| 400 | `INVALID_REQUEST` | Sai schema, field lạ | Không |
| 401 | `UNAUTHORIZED` | Thiếu/sai API key | Không |
| 401 | `USER_ASSERTION_REQUIRED` | Operation user-scoped nhưng thiếu assertion | Không |
| 401 | `INVALID_USER_ASSERTION` | Sai chữ ký / hết hạn / sai claim | Không |
| 403 | `FORBIDDEN` | Scope không đủ | Không |
| 403 | `ENVIRONMENT_NOT_ALLOWED` | Key không được dùng ở env này | Không |
| 404 | `NOT_FOUND` | Endpoint/resource không tồn tại | Không |
| 409 | `IDEMPOTENCY_CONFLICT` | Cùng key khác payload, hoặc đang chạy | Không |
| 413 | `PAYLOAD_TOO_LARGE` | Vượt `maxBodyBytes` của operation | Không |
| 429 | `RATE_LIMITED` | Vượt limit theo phút của AIHUB | Có |
| 429 | `CONCURRENCY_LIMIT` | Quá nhiều request đồng thời | Có, sớm |
| 429 | `QUOTA_EXCEEDED` | Hết hạn mức tháng | Đầu tháng sau |
| 502 | `AI_SERVICE_ERROR` | Downstream 5xx | Có thể |
| 502 | `AI_SERVICE_CONTRACT_VIOLATION` | Downstream trả shape không parse được | Không |
| 503 | `AI_SERVICE_UNAVAILABLE` | Không kết nối được / breaker mở | Có |
| 503 | `AI_SERVICE_THROTTLED` | Downstream / model provider bị throttle | Có |
| 503 | `IDENTITY_PROVIDER_UNAVAILABLE` | JWKS của khách không lấy được | Có |
| 504 | `AI_SERVICE_TIMEOUT` | Hết deadline | Chỉ khi có Idempotency-Key |

### Sáu mã mới so với D1

Cần bổ sung vào D1 §25 trước khi freeze: `USER_ASSERTION_REQUIRED`, `ENVIRONMENT_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`, `CONCURRENCY_LIMIT`, `AI_SERVICE_CONTRACT_VIOLATION`, `IDENTITY_PROVIDER_UNAVAILABLE`.

Đáng chú ý nhất là **`AI_SERVICE_CONTRACT_VIOLATION`**: khi Writing đổi response mà quên báo, phải phân biệt được với "Writing bị lỗi". Gộp chung vào `AI_SERVICE_ERROR` thì sẽ đi tìm sự cố hạ tầng trong khi vấn đề thật là ai đó vừa deploy.

**`IDENTITY_PROVIDER_UNAVAILABLE`** cũng quan trọng: đây không phải lỗi credential của client (401 sẽ khiến họ đi tạo lại key vô ích) và cũng không phải lỗi AI Service.

### Giữ nguyên nguyên tắc phân biệt của D1

```
Client vượt AIHUB rate limit    -> 429 RATE_LIMITED
Organization hết quota           -> 429 QUOTA_EXCEEDED
AI Service / model bị throttle   -> 503 AI_SERVICE_THROTTLED   ← KHÔNG dùng 429
```

Khách nhìn 429 sẽ tưởng họ vượt limit của mình và đi giảm tải một cách vô ích.

## J.3 Một chỗ duy nhất

```
ExceptionFilter toàn cục
 ├─ AihubError            -> dùng code/status đã gắn sẵn
 ├─ lỗi validate Fastify  -> INVALID_REQUEST + đường dẫn field
 ├─ lỗi undici/opossum    -> DownstreamErrorMapper (dùng chung mọi service)
 └─ còn lại               -> INTERNAL_ERROR + log full stack nội bộ
```

**Controller không bao giờ tự dựng response lỗi. Adapter không bao giờ ném lỗi HTTP.**

## J.4 Internal downstream error (US08)

Log nội bộ giữ đủ chi tiết cho AIHUB developer, và **chỉ ở đây**:

```json
{
  "request_id": "req_01J8...",
  "ai_service": "ai-writing",
  "downstream_status": 503,
  "downstream_error_code": "MODEL_NOT_READY",
  "downstream_message": "Model worker unavailable",
  "downstream_ms": 30120,
  "private_endpoint": "/grading-feedback-task1"
}
```

---

→ Tiếp: [08 — Metering & Observability](08-metering-and-observability.md)
