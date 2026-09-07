# 11 — Open Questions & Việc phải đưa ngược vào D1

← [Mục lục](README.md) · [10 — Deployment & Roadmap](10-deployment-roadmap.md)

# P. Open Questions

Mỗi câu có **Recommended default** để team không bị chặn nếu chưa quyết được.

> **Cập nhật 2026-09-07:** đã gọi thật cả 4 endpoint của AI Writing bằng token do team cấp.
> **P.1 và P.2 đã gỡ** — không còn blocker nào cho Phase 1. Fixture ở `test/fixtures/ai-writing/`.

## P.1 Response thật của `/grading-feedback-task1|2` — ✅ **ĐÃ GỠ 2026-09-07**

Đã gọi thật cả 4 endpoint; fixture lưu ở `test/fixtures/ai-writing/`. `parseResponse` viết xong ở [06 §H.3](06-routing-adapter.md#adapter-thật--viết-từ-fixture-không-phải-suy-đoán).

Điều kiện của scaffold plan — *"no Writing response parser is implemented until the unknown grading response fixture is resolved"* — **đã thoả**.

Ba điều chỉnh contract phát sinh từ dữ liệu thật:

| Phát hiện | Xử lý |
|---|---|
| Response giàu hơn thiết kế: `strengths[]`, `areas_for_improvement[]`, `band_reason`, `data_micro` với quote+explanation | Mở rộng `GradeResponse`; expose gần hết trừ `coT` |
| Feedback trả về **tiếng Việt** | Thêm `language` vào request/response, enum hiện tại `['vi']` |
| `corrections` giả định `{original, suggestion}`; thực tế là `{quote, explanation}` | Đổi tên thành `annotations` — bình luận về đoạn trích, không phải đề xuất thay thế |

## P.2 `question_type` và `chart_type` — ✅ **ĐÃ CHỐT 2026-09-07**

`question_type` cho Task 2: `opinion` xác nhận chạy được; giữ enum 5 dạng chuẩn IELTS.

`chart_type` cho Task 1 — **7 giá trị, CASE-SENSITIVE**:

```
Bar Chart   Line Graph   Pie Chart   Table   Map   Process Diagram   Multiple Graphs
```

`"bar chart"` viết thường → downstream trả 500. `"Process"`, `"Diagram"`, `"Bar Graph"`, `"Mixed Chart"` đều không tồn tại.

**Quan trọng:** downstream đặt tên field này là `topic`, nhưng giá trị là loại biểu đồ chứ không phải chủ đề — gửi `"environment"` bị 500. Canonical đổi tên thành `chart_type`; adapter map ngược lại thành `topic` khi gọi downstream. Task 2 thì `topic` đúng nghĩa chủ đề nên giữ nguyên.

## P.2b Band nửa điểm — 🟡 **CÒN NGHI VẤN**

**Why it matters:** nếu downstream không bao giờ phát ra `.5` cho từng tiêu chí thì đó là lỗi chấm điểm thật, ảnh hưởng trực tiếp tới giá trị sản phẩm.

Ba mẫu đã chấm đều ra band nguyên, và **cả 4 tiêu chí luôn bằng nhau** (7-7-7-7 rồi 5-5-5-5). `overall_band` là `float`, `band_score` là `int`.

**Recommended default:** schema dùng `multipleOf: 0.5` — thoả cả `7` lẫn `6.5`, nên không reject nhầm dù kết quả ra sao. Việc xác minh thuộc team Writing: chạy một bộ bài mẫu có band đã biết và đối chiếu.

## P.3 Mô hình bán hàng

**Why it matters:** quyết định `metering_status='missing_usage'` là cảnh báo hay là lỗi chặn request, và quyết định query nào ở [08 §K.2](08-metering-and-observability.md#k2-billing-chưa-chốt-thì-đo-cả-hai) là query xuất hoá đơn.

**Recommended default:** bán **theo request** cho khách đầu tiên. AIHUB đếm được chính xác 100% mà không phụ thuộc AI Service, nên đi được ngay. Token vẫn ghi song song; khi `unmetered` về 0 ổn định thì mới có lựa chọn chuyển sang mô hình token.

## P.4 `rate_limit_rpm` và `max_concurrent` mặc định

**Why it matters:** đặt quá cao thì không bảo vệ được AI Writing; quá thấp thì chặn nhầm khách thật.

**Recommended default:** tạm **600 rpm / 20 concurrent**. Chốt bằng load test ở Phase 3: đo sức chịu thật của AI Writing, đặt tổng concurrency toàn hệ thống dưới ngưỡng đó, rồi chia cho số org dự kiến.

## P.5 `aud` của user assertion có nên gắn environment không?

**Why it matters:** với `aud: "aihub"`, một assertion ký cho staging về lý thuyết dùng lại được ở production.

**Recommended default:** giữ `aud: "aihub"` như D1 đã chốt. API key đã bị bind environment nên kẻ tấn công vẫn cần key production; rủi ro còn lại rất nhỏ so với chi phí bắt mọi khách sửa code. Xét lại nếu có khách yêu cầu tách môi trường nghiêm ngặt.

---

# Q. Những thay đổi cần đưa ngược vào D1

Danh sách hành động cụ thể cho `AIHUB_Deliverable_1_API_Contract_Schema.md` trước khi freeze.

| # | Thay đổi | Mục D1 bị ảnh hưởng |
|---|---|---|
| 1 | **Thay canonical request/response của Writing** bằng schema thật. `content`/`language`/`level` hiện tại không khớp thực tế | §10, §20 |
| 2 | **Tách Task 1 / Task 2** thành 4 operation riêng; cập nhật Operation Catalog và bảng mapping | §19, §27 |
| 3 | **Thêm 6 mã lỗi** vào Master Error Mapping Matrix | §25 |
| 4 | **Thêm `max_assertion_ttl_seconds`** vào End-user Identity Contract; ghi rõ `jti` là **bắt buộc** | §8 |
| 5 | **Ghi rõ `usage` omit khi không gọi model**, lấy `/generate-question-task1` làm ví dụ cụ thể | §15 |
| 6 | **Bổ sung `metering_status`** vào contract nội bộ: `complete` / `missing_usage` / `not_applicable` | §15, §16 |
| 7 | **Chốt ô TBD của Speaking** ở mức envelope async; chưa cần chốt content-type/size | §11, §12, §27 |
| 8 | **Ghi rõ internal contract là additive** — Writing chỉ thêm `usage`/`models`/`metrics`, không bọc `data` | §15 |
| 9 | Trả lời 18 câu ở §32 — phần lớn đã có đáp án trong bộ tài liệu này | §32 |
| 10 | **Bỏ `meta.models[]` khỏi public response** — mâu thuẫn với LTA §32.7 | §16 |
| 11 | `idempotency_required` boolean → `idempotency` ba trạng thái | §27 |
| 12 | **`topic` → `chart_type` enum 7 giá trị** cho Task 1 (giá trị thật là loại biểu đồ, không phải chủ đề) | §10, §20, §27 |
| 13 | **Thêm `language`** vào request/response chấm bài, enum hiện tại `['vi']` | §10, §16, §20 |
| 14 | **Mở rộng `GradeResponse`** theo response thật: `criteria[].strengths/improvements/band_reason`, `suggestions`, `next_steps`, `annotations` | §16, §20 |
| 15 | **Ghi lỗi 500-thay-vì-404** của downstream vào error mapping + việc cho team Writing | §23, §25 |

Mục 1–11 đã áp dụng vào D1 ngày 2026-09-07; mục 12–15 phát sinh sau khi gọi API thật.

## Đáp án cho D1 §32 (18 câu chốt trước khi freeze)

| # | Câu hỏi | Đáp án theo thiết kế này |
|---|---|---|
| 1 | `X-API-Key` hay `Authorization: Bearer`? | **`X-API-Key`** — tách bạch với internal JWT dùng `Authorization` |
| 2 | Key có cần `live/test` mode? | **Không.** Environment do hostname; key chỉ bị *bind* qua `allowed_environments` |
| 3 | `dev/staging/prod` derive từ hostname? | **Đã chốt: có** |
| 4 | `/v1` hay header versioning? | **`/v1` trong path** |
| 5 | Unknown field reject 400? | **Có** — `additionalProperties: false`, không ngoại lệ |
| 6 | `usage` khi không có model call | **Omit**, không `null`, không `0` |
| 7 | Public expose `models[]`/breakdown tới đâu? | **Chỉ aggregate usage.** `models[]` và `usage.calls[]` đều internal — theo LTA §32.7 |
| 8 | JWKS URL hay upload public key? | **Cả hai** — `jwks_url` ưu tiên, `public_keys_jwks` làm fallback |
| 9 | TTL tối đa của assertion | **300s**, cấu hình được theo org |
| 10 | Capability nào bắt buộc user identity? | `writing.task1.grade`, `writing.task2.grade`. Sinh đề là org-scoped |
| 11 | `writing.grade` sync hay async? | **Sync**, timeout 60s |
| 12 | `speaking.grade` sync hay async? | **Async** — contract chốt ở [02 §D.5](02-request-lifecycle.md#d5-lifecycle-3--async-media-phase-4-contract-chốt-ngay), code Phase 4 |
| 13 | Speaking multipart hay `asset_id`? | **`asset_id`** + presigned upload. Phase 4 |
| 14 | Max media size / MIME | ⏳ Còn mở — Phase 4. Không cản freeze D1 |
| 15 | Idempotency bắt buộc với operation nào? | `required` cho 2 grade; `optional` cho task2 question; `none` cho task1 question |
| 16 | Scope/entitlement áp dụng từ D2? | **Có** — [05 §G.10](05-auth-identity.md#g10-authorization), không thêm query nào |
| 17 | Missing usage với metering-critical op? | **Cho qua** + `metering_status='missing_usage'` + alert. Xem [§P.3](#p3-mô-hình-bán-hàng) |
| 18 | Danh sách public error codes v1 | 18 mã ở [07 §J.2](07-reliability-and-errors.md#j2-danh-sách-mã-lỗi-v1) |

---

# R. Đối chiếu nguyên tắc thiết kế (brief §17)

| Nguyên tắc brief | Áp dụng ở đây |
|---|---|
| Không over-engineer | 5 bảng thay 13; không queue/object storage/K8s/Vault/Tempo ở MVP |
| Public contract ổn định hơn implementation | Catalog + TypeBox là nguồn duy nhất; adapter hấp thụ mọi lộn xộn của downstream |
| Fail closed cho auth/authorization | [05 §G.10](05-auth-identity.md#g10-authorization); không nhánh nào "Redis sập nên cho qua" cho authz |
| Không tin identity do client tự khai | Org từ API key, env từ hostname, actor từ assertion đã ký |
| Tenant isolation explicit | `UNIQUE(issuer)`; `iss` phải khớp org; actor chỉ đi qua internal JWT |
| Không retry generative POST mù quáng | [07 §I.2](07-reliability-and-errors.md#i2-retry--phân-biệt-chưa-gửi-và-không-biết) — phân biệt "chưa gửi" với "không biết" |
| Không tự đoán token ở gateway | `missing_usage`, không bao giờ ước lượng |
| Redis không phải source of truth | [04](04-redis.md) toàn bộ |
| Không Kafka/K8s/mesh khi chưa justify | [10 §N.5](10-deployment-roadmap.md#n5-trigger-rời-khỏi-kiến-trúc-này) — trigger cụ thể thay vì "best practice" |
| Mỗi công nghệ phải có lý do gắn với workload | [01 §B](01-context-and-stack.md#b-recommended-tech-stack-matrix) — cột "Vì sao" |
| Ưu tiên migration path đơn giản | Phase 0→5; expand-only migration; `splitEnvelope` cho giai đoạn chuyển tiếp |
| Chưa rõ thì state assumption | [§P](#p-open-questions) — mỗi câu có "Recommended default" |
