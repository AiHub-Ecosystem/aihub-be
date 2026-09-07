# 09 — Security Threat Model

← [Mục lục](README.md) · [08 — Metering & Observability](08-metering-and-observability.md)

## M.1 Bảng threat model

| # | Mối đe doạ | Mức | Biện pháp | Thiết kế ở |
|---|---|---|---|---|
| 1 | Rò rỉ API key | Must | Prefix `aihub_sk_` cho secret scanner; revoke tức thì (xoá cache); `last_used_at` để phát hiện | [05 §G.1–G.2](05-auth-identity.md#g1-format-và-sinh-api-key) |
| 2 | Brute-force key | Must | 256-bit entropy + đếm auth-fail theo IP | [05 §G.3](05-auth-identity.md#g3-chống-brute-force) |
| 3 | **Giả mạo assertion / cross-tenant** | Must | `iss` phải khớp org lấy từ API key + `UNIQUE(issuer)` | [03 §E.2](03-database.md#e2-ddl), [05 §G.4](05-auth-identity.md#g4-user-assertion--verify-cái-gì) |
| 4 | **Alg confusion JWT** | Must | Allowlist `alg` theo từng org; chặn `none` và `HS*` | [05 §G.4](05-auth-identity.md#g4-user-assertion--verify-cái-gì) |
| 5 | Assertion sống quá lâu | Must | `max_assertion_ttl_seconds` (mặc định 300) | [05 §G.4](05-auth-identity.md#g4-user-assertion--verify-cái-gì) |
| 6 | **SSRF qua `jwks_url`** | Must | https + chặn private IP + **chặn redirect** + timeout + size cap | [05 §G.5](05-auth-identity.md#g5-jwks-fetch--chặn-ssrf) |
| 7 | **SSRF qua downstream URL** | Must | URL ở env var không ở DB; adapter chỉ biết `path` | [03 §E.5](03-database.md#vì-sao-routing-catalog-nằm-ở-code-chứ-không-ở-db), [06 §H.3](06-routing-adapter.md#h3-adapter-hàm-thuần-không-io) |
| 8 | Rò secret / PII trong log | Must | Danh sách redact + test tự động | [08 §L.1](08-metering-and-observability.md#không-bao-giờ-log) |
| 9 | Payload lớn phá bộ nhớ | Must | `maxBodyBytes` theo từng operation | [06 §H.1](06-routing-adapter.md#h1-operation-catalog--code-có-kiểu) |
| 10 | DoS bằng request AI đắt tiền | Must | Rate limit + concurrency limit + quota | [04 §F.2–F.4](04-redis.md#f2-rate-limit-fixed-window-không-lua) |
| 11 | **AI Service reachable từ Internet** | Should | Ranh giới bằng **credential** thay vì network — xem §M.3 | [§M.3](#m3-ai-writing-còn-public--rủi-ro-được-chấp-nhận-có-điều-kiện) |
| 11b | **Endpoint không có auth trên service public** | **Must** | Bịt `/five-minute-grading` | [01 §0.1](01-context-and-stack.md#hai-vấn-đề-an-ninh-trên-service-đang-chạy-production) |
| 12 | IDOR giữa các học viên | Must | Danh tính chỉ đi qua internal JWT đã ký, **không qua body** | [06 §H.3](06-routing-adapter.md#adapter-thật) |
| 13 | Internal JWT dùng chéo service | Should | `aud` riêng từng service, TTL 60s | [05 §G.7](05-auth-identity.md#g7-internal-jwt-aihub--ai-service) |
| 14 | Replay assertion | Should | `jti` bắt buộc trong contract; bật kiểm tra khi cần | [05 §G.6](05-auth-identity.md#g6-replay-protection--không-làm-ở-d2) |
| 15 | Rò khoá ký của AIHUB | Should | Quy trình xoay khoá 5 bước, chu kỳ 3 tháng | [05 §G.8](05-auth-identity.md#g8-jwks-của-aihub--xoay-khoá) |
| 16 | mTLS giữa AIHUB ↔ AI Service | Later | Private network + internal JWT là đủ ở Stage A | — |
| 17 | Vault cho secret | Later | `.env` chmod 600 tới khi có ≥ 3 môi trường | [05 §G.9](05-auth-identity.md#g9-secret) |
| 18 | Webhook SSRF / replay | Later | Khi làm async | Phase 4 |

## M.2 Vì sao bốn mục in đậm nguy hiểm hơn phần còn lại

Mục 3, 4, 6, 7, 11b, 12 hỏng theo kiểu **im lặng**. Không có triệu chứng nào — không lỗi, không alert, không log bất thường — cho tới lúc dữ liệu của org này đã chảy sang org khác, hoặc AIHUB đã quét xong mạng nội bộ giúp người khác.

Đó là lý do chúng nằm **rải rác khắp thiết kế** chứ không gom vào một "module security":

- `UNIQUE(issuer)` là một dòng trong DDL
- alg allowlist là một dòng trong verify
- chặn redirect là một tuỳ chọn của HTTP client
- downstream URL ở env là một quyết định về nơi để config
- `actorId` không nằm trong body là một dòng *không* viết trong adapter

Bảo mật đúng ở đây là những thứ nhỏ đặt đúng chỗ, không phải một lớp middleware to.

## M.3 AI Writing còn public — rủi ro được chấp nhận, có điều kiện

`api-ielts-writing.aihubproduction.com` vẫn phân giải được từ Internet, và **sẽ còn như vậy một thời gian**: Writing đang phục vụ ứng dụng Wispace chưa đi qua AIHUB. Đóng lại phụ thuộc lịch của bên đó, không phải lịch của AIHUB.

### Ranh giới ở giai đoạn này là credential, không phải network

Đây là chỗ dễ kết luận sai. Câu "service public nên ai cũng đi vòng được" **không đúng** — Writing vẫn yêu cầu `HTTPBearer`. Muốn đi vòng phải **có token của Writing**.

```
Khách hàng AIHUB  --(API key AIHUB)-->  AIHUB  --(token Writing)-->  Writing
Wispace           --(token Writing)------------------------------->  Writing
```

Khách hàng AIHUB chỉ cầm API key của AIHUB. Họ **không có** token Writing, nên không đi vòng được — dù Writing có public hay không. Bên đang gọi thẳng là ứng dụng nội bộ, không phải khách hàng.

Nên rate limit, quota, metering của AIHUB **vẫn có hiệu lực** với mọi khách hàng AIHUB.

### Ba điều kiện để giữ mức rủi ro này

| # | Điều kiện | Loại |
|---|---|---|
| 1 | Token Writing **không bao giờ** cấp cho khách hàng AIHUB | Quy trình |
| 2 | AIHUB dùng **token riêng**, tách khỏi token Wispace | Kỹ thuật, cần bên Writing cấp |
| 3 | **Mọi** endpoint của Writing đều có auth | Kỹ thuật, hiện đang thiếu |

Điều kiện 1 là thứ dễ vỡ nhất và nó không phải vấn đề kỹ thuật — chỉ cần một lần "cho khách gọi thẳng cho nhanh" là mất hết. Nên ghi vào quy trình onboarding.

Điều kiện 2 mua thêm hai thứ: usage của AIHUB tách bạch khỏi Wispace, và thu hồi được độc lập khi một bên rò token.

### Điều kiện 3 mới là việc gấp — `/five-minute-grading`

Trong OpenAPI, mọi endpoint khai `HTTPBearer` **trừ** `/five-minute-grading`, endpoint này không khai security nào.

Service private thì đó là lỗ nhỏ. Service **public** thì đó là một endpoint gọi model, mở cho cả Internet, và bạn trả tiền. Đây là mục an ninh cần sửa gấp nhất trong toàn bộ danh sách — và nó không nằm trong code AIHUB.

### Khi nào chuyển sang private

Khi Wispace cũng gọi qua AIHUB. Lúc đó việc đóng mạng là thao tác hạ tầng thuần tuý, và tất cả những gì thiết kế ở đây vẫn giữ nguyên — chỉ thêm một lớp phòng vệ nữa lên trên lớp credential đã có.

## M.4 Threat chưa xử lý và lý do chấp nhận

| Threat | Vì sao chấp nhận ở Stage A | Xét lại khi |
|---|---|---|
| Ai đó cầm token Writing đi vòng qua AIHUB | Chỉ ứng dụng nội bộ có token; khách hàng AIHUB không có | Có bên thứ ba được cấp token Writing, hoặc Wispace chuyển qua AIHUB |
| mTLS AIHUB ↔ AI Service | Private network + JWT đã trả lời cả hai câu "workload nào" và "đại diện cho ai" | Có nhiều tenant hạ tầng chung, hoặc yêu cầu compliance |
| Replay assertion | TLS backend-to-backend; kẻ đọc được traffic đã có luôn API key | Có org yêu cầu, hoặc assertion đi qua đường kém tin cậy hơn |
| SSRF qua `image_url` của Task 1 | Fetch xảy ra ở **Writing**, không ở AIHUB | Chuyển sang `asset_id` ở Phase 4, hoặc yêu cầu Writing chặn private IP |
| Rate limit theo IP cho request hợp lệ | Đã có limit theo org/key, chính xác hơn | Có tấn công phân tán từ nhiều key hợp lệ |
| WAF | Payload là JSON đã validate schema chặt; bề mặt tấn công nhỏ | Có endpoint nhận HTML/SQL-ish input |

---

→ Tiếp: [10 — Deployment & Roadmap](10-deployment-roadmap.md)
