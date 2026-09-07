# 06 — Routing & Adapter Design

← [Mục lục](README.md) · [05 — Auth & Identity](05-auth-identity.md)

> Mục tiêu của file này là trả lời câu §18.8 của brief: *thêm một AI Service mới tốn bao nhiêu công?* Phép thử ở [§H.9](#h9-phép-thử-thêm-ai-reading-tốn-bao-nhiêu).

## H.1 Operation Catalog — code có kiểu

MVP gồm **4 operation**: tạo đề + chấm bài, cho Task 1 và Task 2.

| Public | Operation | Scope | Identity | Idem | Downstream |
|---|---|---|---|---|---|
| `POST /v1/writing/task1/questions` | `writing.task1.question.generate` | `writing.question.generate` | org | none | `/generate-question-task1` |
| `POST /v1/writing/task2/questions` | `writing.task2.question.generate` | `writing.question.generate` | org | optional | `/question-generated-task2` |
| `POST /v1/writing/task1/grade` | `writing.task1.grade` | `writing.grade` | **user** | required | `/grading-feedback-task1` |
| `POST /v1/writing/task2/grade` | `writing.task2.grade` | `writing.grade` | **user** | required | `/grading-feedback-task2` |

```ts
export const OPERATIONS = {
  'writing.task1.question.generate': {
    method: 'POST', path: '/v1/writing/task1/questions',
    requiredScope: 'writing.question.generate',
    identityScope: 'organization',
    execution: 'sync', contentType: 'application/json',
    idempotency: 'none',              // đọc DB, không tốn tiền, lặp lại vô hại
    maxBodyBytes: 8 * 1024, timeoutMs: 10_000,
    downstream: 'ai-writing', downstreamPath: '/generate-question-task1',
    requestSchema: Task1QuestionRequest, responseSchema: Task1QuestionResponse,
  },
  'writing.task2.question.generate': {
    method: 'POST', path: '/v1/writing/task2/questions',
    requiredScope: 'writing.question.generate',
    identityScope: 'organization',
    execution: 'sync', contentType: 'application/json',
    idempotency: 'optional',          // CÓ gọi model -> tốn tiền
    maxBodyBytes: 8 * 1024, timeoutMs: 30_000,
    downstream: 'ai-writing', downstreamPath: '/question-generated-task2',
    requestSchema: Task2QuestionRequest, responseSchema: Task2QuestionResponse,
  },
  'writing.task1.grade': {
    method: 'POST', path: '/v1/writing/task1/grade',
    requiredScope: 'writing.grade',
    identityScope: 'user',            // kết quả thuộc về một học viên
    execution: 'sync', contentType: 'application/json',
    idempotency: 'required',
    maxBodyBytes: 256 * 1024, timeoutMs: 60_000,
    downstream: 'ai-writing', downstreamPath: '/grading-feedback-task1',
    requestSchema: GradeTask1Request, responseSchema: GradeResponse,
  },
  'writing.task2.grade': { /* như trên, downstreamPath: '/grading-feedback-task2' */ },
} as const satisfies Record<OperationId, OperationDef>;
```

Một chỗ duy nhất sinh ra: route Fastify, cấu hình guard, `bodyLimit`, timeout, spec OpenAPI 3.1, và bảng trong tài liệu. **Đó là toàn bộ lý do nó là code chứ không phải DB** ([03 §E.5](03-database.md#vì-sao-routing-catalog-nằm-ở-code-chứ-không-ở-db)).

Downstream URL ở env: `DOWNSTREAM_AI_WRITING_URL=http://ai-writing:8080`

### Vì sao Task 1 và Task 2 tách endpoint riêng

Schema chính xác cho từng loại (task 1 **bắt buộc** `image_url`, task 2 **cấm**), thông báo lỗi validate rõ ràng, SDK sinh ra sạch, và tính giá/scope riêng được. Gộp một endpoint với discriminator buộc phải dùng `oneOf` và cho ra lỗi validate khó hiểu.

### Luồng khép kín

```
sinh đề  -> trả về question + image_url
             ↓
học viên viết bài
             ↓
chấm bài -> gửi lại đúng question + image_url + essay
```

Chính là cái `url` mà `/grading-feedback-task1` đang đòi.

### Adapter chứng minh giá trị ngay ở đây

Downstream đặt tên `/generate-question-task1` nhưng `/question-generated-task2` — **cùng một khái niệm, hai kiểu đặt tên ngược nhau**. Public API vẫn đối xứng: `/v1/writing/task1/questions` và `/v1/writing/task2/questions`. Khách không bao giờ nhìn thấy sự lộn xộn đó, và cũng không phải đi sửa Writing để làm cho nó đẹp.

## H.2 Canonical schemas

```ts
export const GradeTask1Request = Type.Object({
  question:  Type.String({ minLength: 1, maxLength: 2_000 }),
  topic:     Type.String({ minLength: 1, maxLength: 200 }),
  essay:     Type.String({ minLength: 1, maxLength: 20_000 }),
  image_url: Type.String({ format: 'uri', maxLength: 2_000 }),   // -> downstream 'url'
}, { additionalProperties: false });

export const GradeTask2Request = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2_000 }),
  topic:    Type.String({ minLength: 1, maxLength: 200 }),
  essay:    Type.String({ minLength: 1, maxLength: 20_000 }),
}, { additionalProperties: false });

// Task 1 và Task 2 khác nhau đúng một tiêu chí đầu tiên.
const CRITERION_IDS = ['task_achievement',   // chỉ task 1
                       'task_response',      // chỉ task 2
                       'coherence_cohesion',
                       'lexical_resource',
                       'grammatical_range_accuracy'] as const;

export const GradeResponse = Type.Object({
  overall_band: Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 }),
  criteria: Type.Array(Type.Object({
    id:       Type.Union(CRITERION_IDS.map(Type.Literal)),
    name:     Type.String(),                    // 'Task Achievement' / 'Task Response'
    band:     Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 }),
    feedback: Type.String(),
  }), { minItems: 4, maxItems: 4 }),
  summary:     Type.String(),
  word_count:  Type.Optional(Type.Integer({ minimum: 0 })),
  corrections: Type.Optional(Type.Array(Type.Object({
    original:    Type.String(),
    suggestion:  Type.String(),
    type:        Type.Union([Type.Literal('grammar'), Type.Literal('vocabulary'),
                             Type.Literal('coherence'), Type.Literal('spelling')]),
    explanation: Type.Optional(Type.String()),
  }))),
}, { additionalProperties: false });

const QUESTION_TYPES = ['opinion', 'discussion', 'problem_solution',
                        'advantages_disadvantages', 'two_part'] as const;

export const Task1QuestionResponse = Type.Object({
  question: Type.String(), topic: Type.String(),
  image_url: Type.String({ format: 'uri' }),     // ảnh biểu đồ, bắt buộc với task 1
}, { additionalProperties: false });

export const Task2QuestionResponse = Type.Object({
  question: Type.String(), topic: Type.String(),
  question_type: Type.Union(QUESTION_TYPES.map(Type.Literal)),
}, { additionalProperties: false });
```

### Ba quyết định trong `GradeResponse`

**`criteria` là mảng, không phải 4 field cố định.** Task 1 gọi tiêu chí đầu là *Task Achievement*, Task 2 gọi là *Task Response*. Nếu làm field cố định thì hai task ra hai shape khác nhau và client phải viết hai nhánh render; mảng có `id` ổn định + `name` để hiển thị thì UI chỉ cần lặp qua 4 phần tử, dùng chung một component cho cả hai task. Thứ tự cam kết cố định.

**`multipleOf: 0.5` được validate.** IELTS chỉ có band nguyên và nửa. Model trả 6.4 là vi phạm contract — bắt ngay ở AIHUB, đừng để nó chảy ra tới khách.

**AIHUB không tự tính `overall_band`.** Cách làm tròn band tổng là luật nghiệp vụ của IELTS, thuộc về Writing. Gateway chỉ kiểm tra tính hợp lệ, không tính toán nghiệp vụ.

### `additionalProperties: false` xử lý đúng US05

Field ngoài contract thì **báo lỗi 400**, không âm thầm bỏ. Bỏ âm thầm là cách tốt nhất để giấu một bug tích hợp suốt ba tháng. Phân biệt theo D1 §18:

```
Unknown field ngoài public contract          -> Reject 400
Field hợp lệ mà AI Service chưa hỗ trợ       -> Adapter transform/drop theo rule
```

### Vì sao TypeBox thay vì Zod

Fastify **chạy thẳng JSON Schema** — validate và serialize đều được compile. Zod thì phải convert qua lại. Một định nghĩa cho ra: type TypeScript, validator runtime, và schema cho OpenAPI. Data Dictionary ở D1 §20 sinh từ đây, không gõ tay lần nữa.

## H.3 Adapter: hàm thuần, không I/O

Sửa so với interface trong D1 §21:

```ts
interface DownstreamAdapter<TReq, TRes> {
  readonly operation:  OperationId;
  readonly downstream: DownstreamId;

  buildRequest(req: TReq, ctx: RequestContext): DownstreamRequest;
  parseResponse(raw: InternalAIServiceResponse<unknown>): TRes;
  parseError?(status: number, body: unknown): DownstreamErrorHint | undefined;
}

type DownstreamRequest = {
  method: 'GET' | 'POST';
  path: string;                  // '/grading-feedback-task1' — KHÔNG có host
  body?: unknown;
  contentType?: string;
};
```

### Ba thay đổi và lý do

**1. Adapter không tự gọi HTTP.** Nó trả về *mô tả* request; dispatcher mới thực hiện. Nhờ vậy adapter là hàm thuần — không mạng, không DB, không đọc đồng hồ. Golden fixture test mà brief §13.15 yêu cầu trở thành "đọc JSON vào, so JSON ra" — **không mock gì cả**.

**2. Adapter không dựng URL.** Nó chỉ biết `path`; host lấy từ env theo `downstream`. Adapter không bao giờ chạm được vào host → khép lại đường SSRF ở [03 §E.5](03-database.md#vì-sao-routing-catalog-nằm-ở-code-chứ-không-ở-db).

**3. `parseError` là tuỳ chọn.** Phần lớn lỗi là lỗi tầng vận chuyển (timeout, connection refused, 5xx) và giống hệt nhau ở mọi AI Service, nên một `DownstreamErrorMapper` dùng chung xử lý hết. Adapter chỉ cài `parseError` khi service có body lỗi riêng cần đọc (vd `{"error_code":"MODEL_NOT_READY"}`). Trong D1, `mapError` là bắt buộc → mỗi adapter mới phải chép lại cùng một đoạn code.

### Adapter thật

```ts
export const gradeTask1Adapter: DownstreamAdapter<GradeTask1Req, GradeRes> = {
  operation: 'writing.task1.grade',
  downstream: 'ai-writing',

  buildRequest: (req, ctx) => ({
    method: 'POST',
    path: '/grading-feedback-task1',
    body: {
      question: req.question,
      topic:    req.topic,
      essay:    req.essay,
      url:      req.image_url,        // đổi tên field
      // ctx.actorId KHÔNG nhét vào body — danh tính đi trong internal JWT đã ký
    },
  }),

  parseResponse: (raw) => { /* map sang GradeResponse — chờ 11 §P.1 */ },
};
```

`actorId` **cố tình không có trong body**. Danh tính đi trong internal JWT đã ký; nhét thêm vào body tạo ra một đường thứ hai để giả mạo, và AI Service có thể lỡ tin nhầm đường đó.

## H.4 Dispatcher — nơi duy nhất có I/O

```ts
async dispatch(op, canonicalReq, ctx) {
  const adapter = this.registry.get(op);
  const dsReq   = adapter.buildRequest(canonicalReq, ctx);
  const token   = await this.tokenIssuer.mint(ctx, op);        // TTL 60s

  const t1 = performance.now();
  const res = await this.http.request(adapter.downstream, dsReq, {
    signal:    ctx.signal,                                     // huỷ được
    timeoutMs: OPERATIONS[op].timeoutMs,
    headers: {
      authorization:        `Bearer ${token}`,
      'x-request-id':       ctx.requestId,
      'x-request-deadline': String(ctx.deadlineMs - Date.now()),
      traceparent:          ctx.traceparent,
    },
  });
  const downstreamMs = Math.round(performance.now() - t1);

  const env = splitEnvelope(res.body);
  return { data: adapter.parseResponse(env), envelope: env, downstreamMs };
}
```

`x-request-deadline` là ~3 dòng và đáng giá: AI Writing biết còn 4 giây thì đừng bắt đầu một lượt gọi model 20 giây nữa. Không có nó, downstream vẫn đốt token cho một response không ai còn đọc.

## H.5 Internal contract — sửa Writing mà KHÔNG phá app hiện tại

Writing đang chạy production và có app Wispace đang dùng. Bọc response vào `{ data: ... }` là **breaking change**; **thêm** field ở cấp cao nhất thì không phá gì (client cũ bỏ qua field lạ).

Yêu cầu với team Writing chỉ có bấy nhiêu:

```jsonc
// /grading-feedback-task1 — giữ nguyên mọi field đang có, CHỈ THÊM 3 field:
{
  "...": "...",                       // nguyên xi như bây giờ

  "usage":   { "input_tokens": 820, "output_tokens": 310, "total_tokens": 1130 },
  "models":  [{ "provider": "openai", "name": "gpt-4o-mini" }],
  "metrics": { "ai_processing_ms": 790 }
}
```

- `/generate-question-task1` đọc từ DB → **omit `usage`**, không trả `0`.
- Operation gọi model nhiều lần → `usage` là **tổng của cả operation**; chi tiết đưa vào `usage.calls[]` (optional). Theo đúng D1 §15 và kiến trúc đích §16.

AIHUB nuốt được cả hai kiểu — phẳng lẫn có bọc — bằng ba dòng, không cần cấu hình:

```ts
function splitEnvelope(body: any) {
  const { usage, models, metrics, data, ...rest } = body ?? {};
  return { data: data ?? rest, usage, models, metrics };
}
// ponytail: bỏ nhánh `?? rest` khi mọi AI Service đã trả envelope chuẩn.
```

Nhờ vậy **Writing không chặn đường AIHUB và AIHUB không chặn đường Writing** — hai bên làm song song được.

`InternalResponseSchema.parse` ép AI Service đúng contract. Thiếu `usage` → **không ném lỗi**, chỉ `metering_status='missing_usage'` + metric. Request của khách vẫn thành công; vấn đề là của mình, không phải của họ.

### Việc cho team Writing — đúng 4 gạch đầu dòng

1. Thêm `usage` / `models` / `metrics` vào response 4 endpoint ưu tiên. FastAPI + OpenAI thì `usage` có sẵn trong response của model, chỉ cần cộng dồn.
2. Trả đúng shape mà `parseResponse` cần: 4 tiêu chí + band tổng. Nếu hiện đang trả prose tự do thì đây là việc lớn nhất — xem [11 §P.1](11-open-questions.md#p1-response-thật-của-grading-feedback-task12--chặn-phase-1).
3. Bịt `/five-minute-grading` (đang không có auth).
4. Chuyển service vào private network, chỉ AIHUB gọi được.

## H.6 HTTP client

```ts
new Pool(baseUrl, {
  connections:      64,          // mỗi downstream
  pipelining:       1,           // request AI dài -> pipelining vô dụng, dễ head-of-line blocking
  keepAliveTimeout: 60_000,
  headersTimeout:   op.timeoutMs,
  bodyTimeout:      op.timeoutMs,
});
```

Keep-alive quan trọng hơn bình thường ở đây: bắt tay TLS/TCP tốn ~30–50ms trong khi request AI chạy vài giây — không tái dùng connection là cộng overhead vào mọi request mà chẳng đổi lại gì.

## H.7 Client ngắt kết nối giữa chừng — xử lý theo tiền

```
Có Idempotency-Key    -> KHÔNG huỷ. Tiền đã tiêu rồi; chạy nốt và lưu kết quả,
                         để lần retry cùng key trả về ngay, không tiêu tiền lần hai.
Không Idempotency-Key -> huỷ ngay, tiết kiệm phần token còn lại.
```

Trực giác thông thường là "khách đi rồi thì huỷ cho đỡ tốn". Nhưng nếu operation có idempotency key, chạy nốt **rẻ hơn**: client gần như chắc chắn sẽ retry, và lúc đó trả lại kết quả đã có thay vì chạy model lần thứ hai. Xem tiếp [07 §I.5](07-reliability-and-errors.md#i5-timeout--idempotency-key-không-mất-tiền-hai-lần).

## H.8 Cấu trúc thư mục

```
src/
├─ catalog/          operations.ts              <- nguồn sự thật duy nhất
├─ contracts/        writing.ts  speaking.ts    TypeBox schema
├─ gateway/          controller.ts  envelope.interceptor.ts
├─ auth/             api-key/  user-assertion/  authorization/
├─ downstream/
│  ├─ adapter.types.ts   registry.ts   dispatcher.ts
│  ├─ http-client.ts     error-mapper.ts        <- dùng chung mọi service
│  └─ writing/  grade-task1.adapter.ts  grade-task2.adapter.ts  question-*.adapter.ts
├─ internal-token/   issuer.ts  jwks.controller.ts
├─ idempotency/  metering/  rate-limit/  errors/  observability/
└─ cli/              org.ts  key.ts  identity.ts
```

Sát với §27 kiến trúc đích, trừ hai chỗ: thêm `catalog/` và `contracts/`, bỏ `routing/` (đã tan vào catalog + registry, không còn gì để routing service làm).

## H.9 Phép thử: thêm AI Reading tốn bao nhiêu?

```
1. contracts/reading.ts                    TypeBox schema request + response
2. catalog/operations.ts                   thêm 1 entry 'reading.analyze'
3. downstream/reading/analyze.adapter.ts   ~20 dòng
4. .env                                    DOWNSTREAM_AI_READING_URL=...
5. test/fixtures/reading/*.json            golden fixture
```

**Không migration DB. Không sửa controller. Không đụng auth, rate limit, metering, error mapping, observability.** Route tự sinh từ catalog, envelope tự dựng ở interceptor.

Nếu ngày nào đó thêm service mà phải sửa ngoài 5 chỗ này, đó là dấu hiệu logic bị rò ra khỏi adapter — **dùng nó làm chỉ báo sức khoẻ kiến trúc**.

---

→ Tiếp: [07 — Reliability & Errors](07-reliability-and-errors.md)
