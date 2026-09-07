# 05 — Auth & Identity Design

← [Mục lục](README.md) · [04 — Redis](04-redis.md)

> Đây là file duy nhất trong bộ tài liệu **không** áp dụng nguyên tắc "làm ít nhất có thể". Auth sai thì không có đường sửa rẻ.

## G.1 Format và sinh API key

```
aihub_sk_ + base62(32 bytes CSPRNG)
        -> aihub_sk_7Kq2mXvR9wLpN4tYbZ3sHgD8fJc1AeQ6
```

- **32 byte = 256 bit entropy.** Brute-force bất khả thi — đây là cơ sở cho quyết định hash nhanh ở [03 §E.3](03-database.md#1-api-key-hash-bằng-sha-256-không-dùng-bcryptargon2).
- **Prefix cố định `aihub_sk_`** để secret scanner của GitHub/GitLab bắt được khi khách lỡ commit key lên repo.
- **Không** nhét `live`/`test` vào key. Environment đã do hostname quyết định (kiến trúc đích §7); nhét vào key là tạo ra nguồn sự thật thứ hai.

### CLI onboarding

Admin API hoãn sang sau (quyết định của team), nên onboard bằng CLI:

```bash
pnpm cli org:create --name "Acme Edu" --entitlements writing

pnpm cli key:create --org org_01J8... --name "Prod backend" \
                    --scopes writing.grade,writing.question.generate \
                    --envs production
# -> in raw key ĐÚNG MỘT LẦN ra stdout; không ghi log, không ghi file

pnpm cli key:revoke   --key ak_01J8...

pnpm cli identity:set --org org_01J8... --issuer https://acme.edu \
                      --jwks-url https://acme.edu/.well-known/jwks.json
```

CLI này là **code sản xuất**, không phải script vứt đi — API admin sau này gọi lại đúng service bên dưới.

## G.2 Lookup flow

```ts
const hash = sha256(rawKey);                 // 32 byte, ~1µs

// 1. Redis: aihub:v1:key:<hex>  TTL 60s — cache cả HIT lẫn MISS
// 2. miss -> SELECT ... WHERE key_hash = $1        (1 index seek)
// 3. validate: status='active' ∧ (expires_at IS NULL ∨ > now())
//              ∧ env ∈ allowed_environments ∧ org.status='active'
```

**Negative cache là bắt buộc.** Không có nó, kẻ tấn công spam key bịa sẽ biến mỗi request thành một query Postgres. Có nó, họ chỉ chạm Redis.

**TTL 60s là giá của việc hoãn admin API** — revoke một key có độ trễ tới 60 giây. Chấp nhận được, nhưng CLI `key:revoke` phải xoá luôn cache để revoke có hiệu lực tức thì:

```ts
await redis.del(`aihub:v1:key:${hex(hash)}`);   // ~2 dòng, xoá hẳn 60s cửa sổ rủi ro
```

## G.3 Chống brute-force

```
Redis: aihub:v1:authfail:<ip>   INCR, TTL 300s
>= 20 lần THẤT BẠI / 5 phút  -> 429
```

**Chỉ đếm thất bại.** Request hợp lệ không bao giờ chạm counter này, nên khách hàng thật không bị ảnh hưởng dù bắn 50 RPS từ một IP.

## G.4 User Assertion — verify cái gì

```
Thứ tự có chủ đích: rẻ trước, crypto sau cùng.

1. decode header  -> alg ∈ config.allowed_algorithms   # CHẶN 'none', chặn HS*
2. payload.aud === 'aihub'
3. payload.iss === identityConfig.issuer               # khớp org lấy từ API key
4. exp > now - skew(60s)  ∧  iat < now + skew(60s)
5. (exp - iat) <= max_assertion_ttl_seconds
6. jti có mặt                                          # hiện chỉ log, xem G.6
7. verify chữ ký bằng JWKS của org                     # crypto ở cuối
```

**Bước 1 chặn alg confusion.** Đây là lỗ JWT kinh điển: token khai `alg: HS256`, thư viện lấy public key RSA làm HMAC secret — mà public key thì ai cũng có → giả token thoải mái. Chỉ nhận `alg` nằm trong allowlist *của org đó*, và loại key phải khớp thuật toán.

**Bước 3 là chốt chặn cross-tenant.** API key nói org A, assertion khai `iss` của org B → `403`. Cộng với `UNIQUE(issuer)` ở [03 §E.2](03-database.md#e2-ddl), org B không thể đăng ký trùng issuer của A ngay từ đầu.

**Bước 5 là bổ sung so với D1.** Nếu không giới hạn TTL, khách có thể ký một assertion `exp` sau 5 năm rồi nhúng vào app mobile — assertion biến thành một API key vĩnh viễn bị rò. `max_assertion_ttl_seconds` mặc định 300, nằm ở DB nên nới được cho từng org.

**Operation org-scoped mà client vẫn gửi assertion: vẫn verify.** Có mặt thì phải hợp lệ. Bỏ qua một assertion hỏng là mở đường cho lỗi tích hợp âm thầm.

## G.5 JWKS fetch — chặn SSRF

`jwks_url` do khách hàng cung cấp và AIHUB sẽ tự đi gọi nó. Không kiểm soát là AIHUB thành công cụ quét mạng nội bộ.

```
Bắt buộc, trước mọi lần fetch:
- scheme === 'https'
- resolve DNS trước, chặn nếu IP ∈ {private, loopback, link-local, CGNAT}
  đặc biệt 169.254.169.254 (metadata endpoint của cloud)
- CHẶN REDIRECT (maxRedirections: 0)
- timeout 3s, response tối đa 64KB
- không gửi kèm bất kỳ credential nào
```

**Chặn redirect là chỗ hay quên:** kiểm IP xong rồi cho redirect thì server của khách chỉ cần trả `302 -> 169.254.169.254` là xuyên qua hết.

### Cache

```
aihub:v1:jwks:<org_id>  TTL 15 phút
kid lạ  -> refetch 1 lần, tối đa 1 lần / 5 phút / org   (chống DoS bằng kid bịa)
fetch fail nhưng còn cache cũ -> DÙNG cache cũ tới 24h
fetch fail và không có cache   -> 503 IDENTITY_PROVIDER_UNAVAILABLE
```

Dùng cache quá hạn khi không refresh được là **an toàn** — public key không tự nhiên thành độc hại — và nó giữ AIHUB sống khi JWKS của khách sập.

> `IDENTITY_PROVIDER_UNAVAILABLE` chưa có trong error matrix của D1. Cần bổ sung: đây không phải lỗi credential của client (401 sẽ khiến họ đi tạo lại key vô ích), cũng không phải lỗi AI Service.

## G.6 Replay protection — KHÔNG làm ở D2

**Lý lẽ:** assertion sống 5 phút và đi cùng API key trên một kết nối TLS backend-to-backend. Muốn replay được thì phải đã đọc trộm được traffic — mà lúc đó kẻ tấn công có luôn API key, và replay assertion là mối lo nhỏ nhất.

**Chi phí nếu làm:** một Redis set `jti` cho mọi request, cộng một round-trip vào đường nóng, cộng câu hỏi "Redis sập thì fail open hay closed".

**Nhưng contract phải yêu cầu `jti` bắt buộc ngay từ D1**, và AIHUB log nó. Như vậy khi cần bật replay protection cho một org nhạy cảm, chỉ thêm một `SET NX` — **không phải đi bảo mọi khách hàng sửa code**.

## G.7 Internal JWT: AIHUB → AI Service

```json
{ "alg": "EdDSA", "kid": "aihub-2026-01" }
{
  "iss": "aihub", "aud": "ai-writing",
  "org_id": "org_01J8...", "sub": "student_456",
  "scope": ["writing.grade"],
  "iat": 1788350000, "exp": 1788350060,
  "jti": "req_01J8..."
}
```

- **EdDSA (Ed25519)** thay vì RS256: ký ~50µs so với ~1ms, token ngắn hơn nhiều. Node/Python/Go đều verify được sẵn; team sở hữu cả hai đầu nên không có rào tương thích. Có `kid` + `alg` trong header nên rơi về RS256 được nếu một service nào đó không hỗ trợ.
- **`jti` = `request_id`** — miễn phí, và nó nối trace giữa AIHUB với AI Service.
- **`aud` riêng từng service:** token mint cho `ai-writing` không dùng được ở `ai-speaking`. Nếu `ai-writing` bị chiếm quyền, nó không tự đi gọi `ai-speaking` được.
- **TTL 60s**, mint just-in-time, không lưu DB, không refresh.

## G.8 JWKS của AIHUB + xoay khoá

```
GET https://api.aihub.example.com/.well-known/jwks.json     # public, chỉ chứa public key
AI Service cache 1 giờ; gặp kid lạ -> refetch (rate-limit như G.5)
```

Quy trình xoay khoá — không downtime và không cần deploy đồng bộ:

```
1. Sinh keypair mới -> đưa PUBLIC key mới vào JWKS, vẫn KÝ bằng key cũ
2. Chờ > 1 giờ (đủ để mọi AI Service cache lại)
3. Chuyển sang KÝ bằng key mới
4. Chờ > 2 phút (token cũ TTL 60s đã chết hết)
5. Gỡ public key cũ khỏi JWKS
```

Chu kỳ 3 tháng, hoặc lập tức khi nghi ngờ rò rỉ. Kịch bản này **phải có test** — xem [10 §N.7](10-deployment-roadmap.md#n7-testing-strategy).

## G.9 Secret

Stage A, không có DevOps → **không dựng Vault**. Private key và DB password nằm trong file `.env` mount vào container, `chmod 600`, không bao giờ vào git, backup riêng bằng tay và lưu ngoài server.

Trigger dựng Vault/SOPS: có từ **3 môi trường** trở lên, hoặc **có người rời team** cần thu hồi quyền, hoặc **yêu cầu compliance**. Chưa tới thì Vault chỉ là thêm một thứ để sập lúc 3 giờ sáng.

## G.10 Authorization

```ts
effectiveScopes = apiKey.scopes.filter(s =>
  org.entitlements.includes(s.split('.')[0])   // 'writing.grade' -> 'writing'
);
if (!effectiveScopes.includes(operation.requiredScope)) throw new ForbiddenError();
```

Toàn bộ dữ liệu đã có sẵn từ bước lookup key → **không thêm query nào**. Đúng theo `Entitlement ∩ Key Scope` của kiến trúc đích §10.

**Fail-closed:** entitlements rỗng → không gọi được gì. Scope rỗng → không gọi được gì. Không có nhánh nào mặc định cho phép.

---

→ Tiếp: [06 — Routing & Adapter](06-routing-adapter.md)
