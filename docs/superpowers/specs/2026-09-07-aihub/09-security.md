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
| 11 | **AI Service lộ ra Internet** | Must | Private network — **hiện đang vi phạm** | [01 §0.1](01-context-and-stack.md#hai-vấn-đề-an-ninh-trên-service-đang-chạy-production), Phase 2 |
| 12 | IDOR giữa các học viên | Must | Danh tính chỉ đi qua internal JWT đã ký, **không qua body** | [06 §H.3](06-routing-adapter.md#adapter-thật) |
| 13 | Internal JWT dùng chéo service | Should | `aud` riêng từng service, TTL 60s | [05 §G.7](05-auth-identity.md#g7-internal-jwt-aihub--ai-service) |
| 14 | Replay assertion | Should | `jti` bắt buộc trong contract; bật kiểm tra khi cần | [05 §G.6](05-auth-identity.md#g6-replay-protection--không-làm-ở-d2) |
| 15 | Rò khoá ký của AIHUB | Should | Quy trình xoay khoá 5 bước, chu kỳ 3 tháng | [05 §G.8](05-auth-identity.md#g8-jwks-của-aihub--xoay-khoá) |
| 16 | mTLS giữa AIHUB ↔ AI Service | Later | Private network + internal JWT là đủ ở Stage A | — |
| 17 | Vault cho secret | Later | `.env` chmod 600 tới khi có ≥ 3 môi trường | [05 §G.9](05-auth-identity.md#g9-secret) |
| 18 | Webhook SSRF / replay | Later | Khi làm async | Phase 4 |

## M.2 Vì sao bốn mục in đậm nguy hiểm hơn phần còn lại

Mục 3, 4, 6, 7, 11, 12 hỏng theo kiểu **im lặng**. Không có triệu chứng nào — không lỗi, không alert, không log bất thường — cho tới lúc dữ liệu của org này đã chảy sang org khác, hoặc AIHUB đã quét xong mạng nội bộ giúp người khác.

Đó là lý do chúng nằm **rải rác khắp thiết kế** chứ không gom vào một "module security":

- `UNIQUE(issuer)` là một dòng trong DDL
- alg allowlist là một dòng trong verify
- chặn redirect là một tuỳ chọn của HTTP client
- downstream URL ở env là một quyết định về nơi để config
- `actorId` không nằm trong body là một dòng *không* viết trong adapter

Bảo mật đúng ở đây là những thứ nhỏ đặt đúng chỗ, không phải một lớp middleware to.

## M.3 Việc cần làm sớm nhất, và nó không nằm trong code AIHUB

**Mục 11 — AI Writing đang public trên Internet.**

Chừng nào `api-ielts-writing.aihubproduction.com` còn phân giải được từ ngoài:

- khách hàng có thể gọi thẳng Writing, đi vòng qua AIHUB
- mọi rate limit, quota, metering của AIHUB **đều vô nghĩa**
- `/five-minute-grading` không có auth → bất kỳ ai cũng đốt được token của bạn

Không có thiết kế nào ở các file trước cứu được điều này. Nó phải được đóng lại ở **Phase 2**, và đó là điều kiện để câu tuyên bố "AIHUB là public API boundary duy nhất" trở thành sự thật thay vì một mong muốn.

## M.4 Threat chưa xử lý và lý do chấp nhận

| Threat | Vì sao chấp nhận ở Stage A | Xét lại khi |
|---|---|---|
| mTLS AIHUB ↔ AI Service | Private network + JWT đã trả lời cả hai câu "workload nào" và "đại diện cho ai" | Có nhiều tenant hạ tầng chung, hoặc yêu cầu compliance |
| Replay assertion | TLS backend-to-backend; kẻ đọc được traffic đã có luôn API key | Có org yêu cầu, hoặc assertion đi qua đường kém tin cậy hơn |
| SSRF qua `image_url` của Task 1 | Fetch xảy ra ở **Writing**, không ở AIHUB | Chuyển sang `asset_id` ở Phase 4, hoặc yêu cầu Writing chặn private IP |
| Rate limit theo IP cho request hợp lệ | Đã có limit theo org/key, chính xác hơn | Có tấn công phân tán từ nhiều key hợp lệ |
| WAF | Payload là JSON đã validate schema chặt; bề mặt tấn công nhỏ | Có endpoint nhận HTML/SQL-ish input |

---

→ Tiếp: [10 — Deployment & Roadmap](10-deployment-roadmap.md)
