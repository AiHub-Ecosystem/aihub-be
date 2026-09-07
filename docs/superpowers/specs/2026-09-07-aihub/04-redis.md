# 04 — Redis Design

← [Mục lục](README.md) · [03 — Database](03-database.md)

> Nguyên tắc chi phối cả file này (brief §17.8):
>
> **Redis không bao giờ là nguồn sự thật. Redis chết thì AIHUB chậm đi và mất một phần lớp bảo vệ — nhưng không bao giờ trả sai kết quả và không bao giờ cho qua một request đáng lẽ bị chặn vì lý do authorization.**

## F.1 Bảng key

Tiền tố `aihub:v1:` — đổi cấu trúc cache sau này chỉ cần bump `v1`, không phải đi dọn key cũ.

| Key | Kiểu | TTL | Nguồn sự thật | Redis chết thì |
|---|---|---|---|---|
| `v1:key:<sha256hex>` | JSON | 60s | Postgres | Rơi thẳng xuống Postgres |
| `v1:key:miss:<sha256hex>` | `1` | 30s | Postgres | Như trên |
| `v1:jwks:<org_id>` | JSON | 15m | JWKS của khách | Fetch trực tiếp (có SSRF guard) |
| `v1:authfail:<ip>` | counter | 300s | — | **Fail open** + alert |
| `v1:rl:<key_id>:<phút>` | counter | 120s | — | **Fail open** + backstop cục bộ |
| `v1:inflight:<org_id>` | zset | tự dọn | — | **Fail open** + backstop cục bộ |
| `v1:quota:<org_id>:<YYYY-MM>` | counter | 40 ngày | `usage_records` | **Fail open** + đánh dấu |

**Không có key nào cho idempotency.** Brief gợi ý "Redis + durable fallback"; thiết kế này bỏ Redis khỏi đường đó hoàn toàn. `ON CONFLICT` của Postgres đã lo phần đua ([03 §E.4](03-database.md#e4-xử-lý-race-của-idempotency--không-cần-distributed-lock)), thêm Redis chỉ tạo hai nguồn sự thật cho đúng thứ tuyệt đối không được sai.

## F.2 Rate limit: fixed window, không Lua

```ts
const bucket = `v1:rl:${keyId}:${Math.floor(Date.now() / 60000)}`;
const n = await redis.incr(bucket);
if (n === 1) await redis.expire(bucket, 120);
if (n > org.rate_limit_rpm) throw new RateLimitedError({ retryAfterMs: msToNextMinute() });
```

```
ponytail: fixed window -> burst tối đa 2x rate_limit_rpm ở ranh giới phút.
Nâng lên GCRA/sliding window bằng Lua khi có khách phàn nàn về công bằng,
hoặc khi rate limit trở thành cam kết hợp đồng.
```

Chấp nhận sai số 2x vì mục đích của rate limit ở đây là **chặn client chạy loạn làm sập AI Service**, không phải phân phối công bằng chính xác. 2x trong một giây không làm sập gì cả. Sliding window đòi Lua script — thêm một thứ phải test và debug, chưa đáng.

## F.3 Concurrency limit — quan trọng hơn rate limit

Brief §15 tự nhận xét: *"AI request thường có latency cao và giữ connection lâu, nên concurrency có thể quan trọng hơn RPS thuần tuý."* Hệ quả: **giới hạn RPM gần như không bảo vệ được downstream**.

Ví dụ: khách gửi 60 request/phút (đúng limit), mỗi request chạy 30 giây → lúc nào cũng có ~30 request treo trên AI Writing. Ba khách như vậy là AI Writing gục — **trong khi không ai vượt rate limit cả**.

```ts
const k = `v1:inflight:${orgId}`;
await redis.zremrangebyscore(k, 0, Date.now() - 120_000);   // dọn request chết
if (await redis.zcard(k) >= org.max_concurrent) throw new ConcurrencyLimitError();
await redis.zadd(k, Date.now(), requestId);
try   { /* gọi downstream */ }
finally { await redis.zrem(k, requestId); }
```

Dùng zset thay vì `INCR`/`DECR` vì zset **tự lành**: process chết giữa chừng thì `finally` không chạy, `DECR` bị mất vĩnh viễn và counter kẹt cao dần cho tới khi org đó bị khoá hoàn toàn. `zremrangebyscore` dọn sạch sau 120 giây.

Mặc định `max_concurrent = 20`/org → `429 CONCURRENCY_LIMIT` với `retry_after_ms` ngắn (~500ms).

## F.4 Quota

```
Đường nóng:  INCR v1:quota:<org>:<YYYY-MM>  -> so với monthly_request_quota
Mỗi đêm:     SELECT count(*) FROM usage_records
             WHERE organization_id=$1 AND created_at >= <đầu tháng>
             -> SET đè lên counter Redis
```

Counter Redis là **ước lượng để chặn nhanh**; `usage_records` là con số đem đi xuất hoá đơn. Job đêm kéo hai số về khớp nhau, nên counter có trôi trong ngày cũng không ảnh hưởng tiền bạc.

Hết quota → `429 QUOTA_EXCEEDED`, `retry_after_ms` = thời gian tới đầu tháng sau.

## F.5 Redis chết thì sao — quyết định từng mục

| Mất gì | Chọn | Lý do |
|---|---|---|
| Cache API key | Rơi xuống Postgres | Vẫn đúng, chỉ chậm. Postgres thừa sức 50 RPS |
| Chống brute-force | **Cho qua** + alert | Key 256 bit không đoán được trong một lần Redis sập |
| Rate limit | **Cho qua** + backstop | Fail-closed nghĩa là Redis sập = AIHUB sập. Không đáng |
| Concurrency limit | **Cho qua** + backstop | Như trên |
| Quota | **Cho qua** + `quota_unverified` | Xem lập luận bên dưới |
| JWKS cache | Fetch trực tiếp | Chậm hơn, vẫn an toàn |
| **Xác thực / phân quyền** | **Không phụ thuộc Redis** | Không có nhánh nào "Redis sập nên cho qua" |

Dòng cuối là ranh giới không được vượt: cho qua rate limit là mất *tiền*; cho qua authorization là mất *dữ liệu khách hàng*.

### Vì sao quota fail open

**Cho qua thì sửa được sau, chặn thì không.**

Mọi request đi qua đều đã ghi `usage_records` ở Postgres. Redis sập không làm mất dữ liệu đó. Nên sáng hôm sau biết chính xác org nào vượt bao nhiêu, rồi quyết định tính tiền phần vượt hay bỏ qua — **quyết định lúc có đủ dữ liệu, không phải lúc 3 giờ sáng và đang mù**.

Chặn thì ngược lại: học viên bấm nộp bài nhận lỗi, giáo viên gọi lên trung tâm, trung tâm gọi cho mình. Không thao tác nào hoàn tác được điều đó — đốt uy tín để tiết kiệm tiền token.

Định lượng thiệt hại thật:

```
Redis sập -> concurrency backstop cục bộ vẫn còn
1 org chạy loạn ≈ 20 đồng thời × ~2s ≈ 600 req/phút
Redis sập 10 phút ≈ 6.000 request thừa, xấu nhất, cho 1 org cố tình
```

Vài chục đô tiền model, đổi lấy 10 phút không từ chối bất kỳ khách nào. Không phải một cuộc đánh đổi cân sức.

### Núm vặn cho ngoại lệ

```sql
ALTER TABLE organizations
  ADD COLUMN hard_stop_on_quota boolean NOT NULL DEFAULT false;
```

```ts
// Redis chết + không đọc được quota:
if (org.hard_stop_on_quota) throw new QuotaExceededError();   // fail closed cho riêng org này
metering.flag('quota_unverified');                            // còn lại: cho qua, đánh dấu
```

Mặc định `false` cho tất cả; bật cho riêng org có hợp đồng ghi trần chi tiêu cứng. Một cột boolean, ba dòng code, và không bị khoá vào một chính sách duy nhất cho mọi khách hàng.

### Điều kiện đi kèm — cho qua phải ồn ào

Nếu không, nó thành rò rỉ âm thầm:

- Redis mất kết nối → alert đẩy ngay, không chờ ngưỡng
- `usage_records.metering_status = 'quota_unverified'` cho mọi request trong cửa sổ đó
- Job đêm ở [§F.4](#f4-quota) khi dựng lại counter sẽ tự lộ ra org nào vượt

### Backstop cục bộ

Làm cho các lựa chọn "cho qua" bớt đáng sợ. Mỗi process Node giữ một bộ đếm in-memory rất thô:

```ts
// ponytail: chỉ là phao cứu sinh khi Redis chết, không phải rate limiter thật.
// Không chia sẻ giữa các instance, không công bằng giữa các org.
const GLOBAL_MAX_INFLIGHT = 200;   // mỗi process
```

Redis sập, một khách chạy loạn cũng chỉ kéo được tối đa 200 connection/process thay vì vô hạn. Khoảng 10 dòng code, mua được sự yên tâm để chọn "fail open" ở trên.

## F.6 Hai chi tiết vận hành hay bị bỏ sót

### `commandTimeout` bắt buộc phải đặt

```ts
new Redis({ commandTimeout: 100, maxRetriesPerRequest: 1, enableOfflineQueue: false });
```

Redis **treo** nguy hiểm hơn Redis **chết**. Chết thì connection refuse ngay lập tức và code fallback chạy. Treo mà không có timeout thì mọi request đứng chờ vô hạn — và đó chính là cách một sự cố Redis biến thành sự cố toàn hệ thống. `enableOfflineQueue: false` để lệnh fail ngay thay vì xếp hàng chờ trong RAM.

### `maxmemory-policy noeviction`, không phải `allkeys-lru`

Tất cả key đều có TTL nên bộ nhớ tự bị chặn trên và rất nhỏ (vài chục MB). Nếu để `allkeys-lru`, Redis có thể âm thầm xoá counter quota của một org đang gần chạm hạn mức — **quota tự nhiên reset về 0**. Với `noeviction`, khi đầy thì lệnh ghi lỗi và các nhánh fail-open ở [§F.5](#f5-redis-chết-thì-sao--quyết-định-từng-mục) xử lý gọn. Alert ở 75% maxmemory.

### Persistence: không cần

Mọi thứ trong Redis đều dựng lại được từ Postgres. Bật RDB snapshot mỗi 15 phút chỉ để restart ấm; bỏ AOF — không có gì đáng để `fsync`.

---

→ Tiếp: [05 — Auth & Identity](05-auth-identity.md)
