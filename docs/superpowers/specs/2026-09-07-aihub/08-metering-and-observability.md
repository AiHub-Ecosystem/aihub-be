# 08 — Metering, Billing & Observability

← [Mục lục](README.md) · [07 — Reliability & Errors](07-reliability-and-errors.md)

# K. Usage / Metering / Billing

## K.1 Ghi ở đâu, lúc nào

`usage_records` ở Postgres là **nguồn sự thật duy nhất**. Ghi **trước khi trả response**, và `await` nó:

```ts
await usageRepo.insert(record); // ~1ms
return envelope;
```

Nghe ngược với phản xạ "đừng chặn response", nhưng: request chấm bài mất 800–3000ms, thêm 1ms là nhiễu không đo được. Đổi lại **không cần queue, không cần buffer trong RAM, không lo mất dữ liệu khi process chết**. Đây là chỗ mà giải pháp lười nhất cũng là giải pháp đúng nhất.

Nếu INSERT lỗi thì **vẫn trả response cho khách** — không thể để một lần ghi metering hỏng làm hỏng một request AI đã chạy thành công. Nhưng phải để lại dấu vết cứu được:

```ts
catch (e) {
  logger.error({ event: 'metering_write_failed', record }, 'BILLING DATA AT RISK');
}
```

Record đầy đủ nằm trong log dưới dạng JSON → dựng lại được bằng tay từ Loki. Hai dòng, và nó là khác biệt giữa "mất một ít dữ liệu billing" với "biết chính xác đã mất cái gì".

## K.2 Billing chưa chốt thì đo cả hai

```sql
-- Bán theo request
SELECT organization_id, operation, count(*)
FROM usage_records
WHERE created_at >= :month_start AND outcome = 'success'
GROUP BY 1, 2;

-- Bán theo token
SELECT organization_id,
       sum(total_tokens),
       count(*) FILTER (WHERE metering_status = 'missing_usage') AS unmetered
FROM usage_records
WHERE created_at >= :month_start AND outcome = 'success'
GROUP BY 1;
```

Cột `unmetered` quyết định bạn **có được phép** bán theo token hay không. Nếu còn khác 0 thì mô hình token chưa dùng được — và bạn biết điều đó **trước khi ký hợp đồng**, không phải sau.

**Chỉ tính tiền `outcome = 'success'`.** Downstream lỗi thì mình chịu, không đẩy sang khách.

`models` (jsonb) được ghi lại để sau này tính giá theo từng model nếu cần.

## K.3 Khi usage thiếu

Theo kiến trúc đích §24 — không tự bịa số:

```
usage thiếu -> metering_status = 'missing_usage'
            -> KHÔNG ước lượng token, KHÔNG ghi 0
            -> metric aihub_metering_incomplete_total + alert nếu > 1%
            -> business rule quyết định fail hay cho qua (hiện tại: cho qua)
```

AIHUB **không bao giờ tự tokenize lại request để ước lượng** (brief §17.7).

## K.4 Reconciliation — job đêm

```
1. Dựng lại counter quota Redis từ usage_records          (04 §F.4)
2. Đếm missing_usage theo operation -> alert nếu > 1%
3. Xoá usage_records > 13 tháng, idempotency_records hết hạn
```

Cron trong container app, không cần scheduler riêng.

---

# L. Observability

## L.1 Log: một dòng JSON cho mỗi request

```jsonc
{
  "level": "info",
  "event": "request_completed",
  "request_id": "req_01J8...",
  "correlation_id": "cust-123",
  "trace_id": "...",
  "org_id": "org_01J8...",
  "api_key_id": "ak_01J8...",
  "actor_id": "student_456",
  "operation": "writing.task1.grade",
  "environment": "production",
  "http_status": 200,
  "outcome": "success",
  "total_ms": 840,
  "downstream_ms": 810,
  "ai_processing_ms": 790,
  "total_tokens": 1130,
  "metering_status": "complete",
}
```

Cùng bộ field cho mọi request, kể cả lỗi. Truy sự cố bằng `request_id`, truy khách bằng `org_id`.

Log lỗi downstream có thêm khối nội bộ ([07 §J.4](07-reliability-and-errors.md#j4-internal-downstream-error-us08)) — chỉ ở đây, không ra tới client.

### Ba ID, ba vai trò khác nhau

Theo D1 §6.1 và kiến trúc đích §18:

| ID               | Ai sinh                           | Dùng để                                       |
| ---------------- | --------------------------------- | --------------------------------------------- |
| `request_id`     | **AIHUB**                         | Tracing chính. Không bao giờ tin ID từ client |
| `correlation_id` | Client gửi qua `X-Correlation-Id` | AIHUB chỉ giữ lại và echo                     |
| `trace_id`       | OTel / `traceparent`              | Nối span nếu sau này cắm collector            |

`request_id` là tracing metadata, **không phải identity**.

### Không bao giờ log

- raw API key
- `X-User-Assertion`
- **nội dung bài viết của học viên**

Cái cuối là dữ liệu cá nhân của khách hàng của khách hàng bạn — dính vào là chuyện pháp lý, không phải chuyện kỹ thuật. Có một **danh sách redact** ở logger và **một test kiểm tra nó** ([10 §N.7](10-deployment-roadmap.md#n7-testing-strategy)).

## L.2 Metric — 8 cái, không hơn

```
aihub_requests_total{operation,status,outcome}
aihub_request_duration_seconds{operation}          histogram
aihub_downstream_duration_seconds{operation}       histogram
aihub_tokens_total{operation,org_id}               counter
aihub_rejected_total{reason}                       rate_limit|quota|concurrency|auth
aihub_breaker_state{operation}                     0 đóng / 1 mở / 2 half-open
aihub_metering_incomplete_total{operation}
aihub_redis_unavailable_total
```

Đủ trả lời mọi câu hỏi trong brief §13.12. `gateway_overhead` **không cần metric riêng** — nó là hiệu của hai histogram đầu.

## L.3 Stack: 3 container, không có Tempo

```
Prometheus  -> scrape /metrics
Loki        -> nhận log JSON qua docker log driver
Grafana     -> dashboard + ALERT (không cần Alertmanager riêng)
```

**Bỏ Tempo/Jaeger ở giai đoạn này.** Với đúng hai service (AIHUB → Writing), `request_id` trong log đã trả lời được mọi câu hỏi mà distributed tracing trả lời — và đó là hai container ít hơn cho một team không có DevOps.

**Nhưng giữ đường nâng cấp cho rẻ:** propagate header `traceparent` (W3C) xuống downstream và ghi `trace_id` vào log **ngay từ bây giờ**. Ngày nào thêm Tempo thì chỉ cần cắm collector, không phải đi sửa code.

Trigger thêm Tempo: có ≥ 3 service trong một luồng request, hoặc có worker async (Phase 4).

## L.4 Alert tối thiểu

```
breaker mở > 2 phút
error rate 5xx > 5% trong 5 phút
p95 latency > 2x bình thường
Redis không kết nối được
missing_usage > 1% trong 1 giờ
disk Postgres > 80%
```

Grafana alert đẩy thẳng vào một kênh chat. Không dựng Alertmanager riêng — nó là một container nữa để cấu hình sai.

### L.4.1 Synthetic canary — AI Writing contract

Ngoài metric phản ứng, còn có một synthetic canary chủ động kiểm tra
response shape của AI Writing mỗi 6 giờ. Nếu AI Writing deploy một breaking
change, canary bắt được trong vòng run interval, trước khi request thật của
khách hàng chạm vào nó.

→ Xem runbook: [Canary: AI Writing Contract](../../../operations/canary-ai-writing.md)

---

→ Tiếp: [09 — Security Threat Model](09-security.md)
