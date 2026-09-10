# AIHUB — Architecture Design (nền tảng cho Deliverable 2)

> **Trạng thái:** đã duyệt qua brainstorm ngày 2026-09-07.
> **Trả lời cho:** brief brainstorm ban đầu, đã gỡ khỏi repo — cấu trúc output A–P bắt nguồn từ §16 của brief đó, xem lịch sử git nếu cần đối chiếu.
> **Không thay thế:** `../../../aihub_long_term_architecture.md` (kiến trúc đích) và `../../../aihub_deliverable_1_api_contract_schema.md` (contract). Đây là **implementation strategy** để đi từ D1 sang D2.

Scaffold status: [Clean Architecture and agent workflow design](12-agent-workflow-and-clean-architecture-design.md) is implemented in the initial NestJS/Fastify source scaffold.

## Mục lục

| File                                                                 | Nội dung                                                                                                       | Mục brief |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------- |
| [01-context-and-stack.md](01-context-and-stack.md)                   | Ràng buộc đã chốt, khảo sát AI Writing thật, executive recommendation, tech stack matrix, architecture diagram | A, B, C   |
| [02-request-lifecycle.md](02-request-lifecycle.md)                   | Pipeline 17 bước, map vào NestJS, 3 lifecycle mẫu                                                              | D         |
| [03-database.md](03-database.md)                                     | DDL 5 bảng, index, idempotency race, 8 bảng bị cắt                                                             | E         |
| [04-redis.md](04-redis.md)                                           | Key inventory, rate limit, concurrency limit, quota, hành vi khi Redis chết                                    | F         |
| [05-auth-identity.md](05-auth-identity.md)                           | API key, user assertion, JWKS/SSRF, internal JWT, xoay khoá, authorization                                     | G         |
| [06-routing-adapter.md](06-routing-adapter.md)                       | Operation catalog, canonical schema, adapter interface, dispatcher, internal contract                          | H         |
| [07-reliability-and-errors.md](07-reliability-and-errors.md)         | Timeout, retry, circuit breaker, idempotency, 18 mã lỗi                                                        | I, J      |
| [08-metering-and-observability.md](08-metering-and-observability.md) | Metering, billing, reconciliation, log/metric/alert                                                            | K, L      |
| [09-security.md](09-security.md)                                     | Threat model 18 mục theo Must/Should/Later                                                                     | M         |
| [10-deployment-roadmap.md](10-deployment-roadmap.md)                 | Compose stack, deploy, backup, trigger scale, 6 phase, testing, ADR                                            | N, O      |
| [11-open-questions.md](11-open-questions.md)                         | 5 câu hỏi còn mở, thay đổi cần đưa ngược vào D1, đối chiếu nguyên tắc                                          | P         |

## Executive Recommendation

**AIHUB là một modular monolith viết bằng NestJS + Fastify, tự làm toàn bộ data plane, không có Envoy/Kong đứng trước.**

Lý do cốt lõi: mọi thứ AIHUB làm đều là **application logic đội lốt proxy**. Verify JWT bằng JWKS riêng của từng organization, tính `entitlement ∩ api_key_scope`, map canonical request sang contract riêng của từng AI Service, mint internal JWT theo scope — không có việc nào là "proxy thuần". Đặt Kong/Envoy vào trước chỉ tạo ra một hệ thống config thứ hai phải nuôi, và cuối cùng vẫn phải viết lại chính logic đó bằng Lua/WASM.

Postgres là nguồn sự thật duy nhất cho control plane. Redis chỉ là cache và bộ đếm — **Redis chết thì AIHUB chậm đi và mất một phần lớp bảo vệ, nhưng không bao giờ trả sai kết quả và không bao giờ cho qua một request đáng lẽ bị chặn vì lý do authorization**. Không có queue, không có object storage ở MVP; cả hai vào cùng lúc với Speaking.

Bốn thứ được đầu tư kỹ hơn mức "MVP" vì chúng không sửa rẻ được về sau: **tenant isolation**, **API contract**, **metering**, **auth**. Mọi thứ khác cắt tới mức tối thiểu chạy được, kèm trigger rõ ràng để nâng cấp.

Toàn bộ chạy trên **một VPS với Docker Compose**, 8 container, khoảng €15/tháng. Không phải vì tiết kiệm mà vì một team 2–3 người không có DevOps thì mỗi thành phần hạ tầng thêm vào là một thứ sẽ hỏng lúc 3 giờ sáng.

## Đọc theo vai trò

- **Muốn bắt đầu code ngay:** [01](01-context-and-stack.md) → [03](03-database.md) → [06](06-routing-adapter.md) → [10](10-deployment-roadmap.md#n6-phases)
- **Review bảo mật:** [05](05-auth-identity.md) → [09](09-security.md)
- **Chốt D1 trước khi freeze:** [11](11-open-questions.md#q-những-thay-đổi-cần-đưa-ngược-vào-d1)
- **Bàn giao cho team AI Writing:** [06 §H.5](06-routing-adapter.md#h5-internal-contract--sửa-writing-mà-không-phá-app-hiện-tại) + [01 §0.1](01-context-and-stack.md#01-hiện-trạng-ai-writing-khảo-sát-thật)
