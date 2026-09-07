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

> Toàn bộ phần này dựa trên **response thật đã gọi và lưu ở `test/fixtures/ai-writing/`**, không phải suy đoán.

```ts
// 7 giá trị đã dò được, CASE-SENSITIVE ('bar chart' -> downstream 500)
const CHART_TYPES = ['Bar Chart', 'Line Graph', 'Pie Chart', 'Table',
                     'Map', 'Process Diagram', 'Multiple Graphs'] as const;

const QUESTION_TYPES = ['opinion', 'discussion', 'problem_solution',
                        'advantages_disadvantages', 'two_part'] as const;

// Hiện downstream chỉ sinh feedback tiếng Việt. Nới enum khi Writing hỗ trợ 'en'
// — nới lỏng là non-breaking, nên thứ tự này an toàn.
const LANGUAGES = ['vi'] as const;

export const GradeTask1Request = Type.Object({
  question:   Type.String({ minLength: 1, maxLength: 2_000 }),
  chart_type: Type.Union(CHART_TYPES.map(Type.Literal)),         // -> downstream 'topic'
  essay:      Type.String({ minLength: 1, maxLength: 20_000 }),
  image_url:  Type.String({ format: 'uri', maxLength: 2_000 }),  // -> downstream 'url'
  language:   Type.Optional(Type.Union(LANGUAGES.map(Type.Literal))),
}, { additionalProperties: false });

export const GradeTask2Request = Type.Object({
  question: Type.String({ minLength: 1, maxLength: 2_000 }),
  topic:    Type.String({ minLength: 1, maxLength: 200 }),        // chủ đề thật, vd 'education'
  essay:    Type.String({ minLength: 1, maxLength: 20_000 }),
  language: Type.Optional(Type.Union(LANGUAGES.map(Type.Literal))),
}, { additionalProperties: false });

// Task 1 và Task 2 khác nhau đúng một tiêu chí đầu tiên.
const CRITERION_IDS = ['task_achievement',   // chỉ task 1
                       'task_response',      // chỉ task 2
                       'coherence_cohesion',
                       'lexical_resource',
                       'grammatical_range_accuracy'] as const;

const Band = Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 });

export const GradeResponse = Type.Object({
  overall_band: Band,
  language:     Type.Union(LANGUAGES.map(Type.Literal)),
  criteria: Type.Array(Type.Object({
    id:           Type.Union(CRITERION_IDS.map(Type.Literal)),
    name:         Type.String(),               // 'Task Achievement' / 'Task Response'
    band:         Band,
    band_reason:  Type.String(),
    strengths:    Type.Array(Type.String()),
    improvements: Type.Array(Type.String()),   // rỗng thay vì sentinel 'None specified'
  }), { minItems: 4, maxItems: 4 }),
  summary:     Type.String(),
  suggestions: Type.Array(Type.String()),
  next_steps:  Type.Array(Type.String()),
  annotations: Type.Array(Type.Object({        // trích dẫn trong bài + nhận xét
    criterion:   Type.Union(CRITERION_IDS.map(Type.Literal)),
    issue:       Type.String(),                // 'inaccurate_data_support', ...
    quote:       Type.String(),
    explanation: Type.String(),
  })),
}, { additionalProperties: false });

export const Task1QuestionRequest = Type.Object({
  chart_type: Type.Optional(Type.Union(CHART_TYPES.map(Type.Literal))),  // bỏ trống = ngẫu nhiên
}, { additionalProperties: false });

export const Task1QuestionResponse = Type.Object({
  question_id: Type.String(),
  question:    Type.String(),
  chart_type:  Type.Union(CHART_TYPES.map(Type.Literal)),
  image_url:   Type.String({ format: 'uri' }),
}, { additionalProperties: false });

export const Task2QuestionResponse = Type.Object({
  question:      Type.String(),
  topic:         Type.String(),
  question_type: Type.Union(QUESTION_TYPES.map(Type.Literal)),
}, { additionalProperties: false });
```

### Năm quyết định, tất cả rút ra từ dữ liệu thật

**`criteria` là mảng — đã được thực tế xác nhận.** Response thật dùng key `1_task_achievement` cho Task 1 và `1_task_response` cho Task 2, ba tiêu chí còn lại giống nhau. Nếu làm 4 field cố định thì hai task ra hai shape và client phải viết hai nhánh render. Mảng có `id` ổn định + `name` hiển thị cho phép dùng chung một component; thứ tự cam kết cố định theo tiền tố số của downstream.

**`chart_type` thay cho `topic` ở Task 1.** Downstream đặt tên field là `topic` nhưng giá trị thật là loại biểu đồ (`Bar Chart`), không phải chủ đề — gửi `"environment"` bị trả 500. Giữ tên `topic` ở public API là truyền lại chính sự hiểu nhầm đó cho khách. Task 2 thì `topic` đúng nghĩa chủ đề, nên giữ nguyên.

**`multipleOf: 0.5` chấp nhận cả `int` lẫn `float`.** Downstream trả `overall_band: 7.0` (float) nhưng `band_score: 7` (int). `multipleOf: 0.5` thoả cả hai nên không cần ép kiểu — ép float sẽ reject nhầm response hợp lệ.

**`improvements` chuẩn hoá sentinel.** Downstream trả `["None specified"]` khi không có gì để cải thiện. Adapter đổi thành mảng rỗng — client kiểm tra `length === 0` chứ không phải so chuỗi tiếng Anh.

**`annotations` thay cho `corrections`.** Thiết kế ban đầu giả định downstream trả cặp sửa lỗi `{original, suggestion}`. Thực tế nó trả `{quote, explanation}` — **bình luận về một đoạn trích, không phải đề xuất thay thế**. Đặt tên `corrections` sẽ khiến client dựng UI "nhấn để sửa" cho dữ liệu không hỗ trợ việc đó.

**AIHUB không tự tính `overall_band`.** Cách làm tròn band tổng là luật nghiệp vụ IELTS, thuộc về Writing. Gateway chỉ kiểm tra tính hợp lệ.

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

### Adapter thật — viết từ fixture, không phải suy đoán

```ts
const CRITERION_NAMES: Record<CriterionId, string> = {
  task_achievement:           'Task Achievement',
  task_response:              'Task Response',
  coherence_cohesion:         'Coherence and Cohesion',
  lexical_resource:           'Lexical Resource',
  grammatical_range_accuracy: 'Grammatical Range and Accuracy',
};

/** Downstream trả ["None specified"] thay vì mảng rỗng. */
const clean = (xs: string[] = []) =>
  xs.filter(s => s && s.trim().toLowerCase() !== 'none specified');

/** data_micro: { criterion: { issue: { comments: [{quote, explanation}] } } } */
function toAnnotations(micro: Record<string, any> = {}) {
  return Object.entries(micro).flatMap(([criterion, issues]) =>
    Object.entries(issues ?? {}).flatMap(([issue, body]: [string, any]) =>
      (body?.comments ?? []).map((c: any) => ({
        criterion, issue, quote: c.quote, explanation: c.explanation,
      }))));
}

/** Dùng chung cho cả hai task — khác nhau chỉ ở tên tiêu chí đầu tiên. */
function parseGrading(raw: any): GradeRes {
  const d = raw?.data;
  if (!d?.evaluation || d.overall_band == null) {
    throw new ContractViolationError('missing data.evaluation or data.overall_band');
  }

  const criteria = Object.entries(d.evaluation)
    .sort(([a], [b]) => a.localeCompare(b))          // '1_...' < '2_...' — thứ tự downstream
    .map(([key, v]: [string, any]) => {
      const id = key.replace(/^\d+_/, '') as CriterionId;
      if (!(id in CRITERION_NAMES)) {
        throw new ContractViolationError(`unknown criterion: ${key}`);
      }
      return {
        id,
        name:         CRITERION_NAMES[id],
        band:         v.band_score,
        band_reason:  v.band_reason ?? '',
        strengths:    clean(v.strengths),
        improvements: clean(v.areas_for_improvement),
      };
    });

  const oa = d['Overall Assessment'] ?? {};
  return {
    overall_band: d.overall_band,
    language:     'vi',
    criteria,
    summary:      oa.Summary ?? '',
    suggestions:  clean(oa['Specific Suggestions']),
    next_steps:   clean(oa['Next Steps']),
    annotations:  toAnnotations(raw?.data_micro),
  };
}

export const gradeTask1Adapter: DownstreamAdapter<GradeTask1Req, GradeRes> = {
  operation: 'writing.task1.grade',
  downstream: 'ai-writing',

  buildRequest: (req) => ({
    method: 'POST',
    path: '/grading-feedback-task1',
    body: {
      question: req.question,
      topic:    req.chart_type,       // canonical 'chart_type' -> downstream 'topic'
      essay:    req.essay,
      url:      req.image_url,        // canonical 'image_url'  -> downstream 'url'
      // ctx.actorId KHÔNG nhét vào body — danh tính đi trong internal JWT đã ký
    },
  }),

  parseResponse: parseGrading,
};

export const gradeTask2Adapter: DownstreamAdapter<GradeTask2Req, GradeRes> = {
  operation: 'writing.task2.grade',
  downstream: 'ai-writing',
  buildRequest: (req) => ({
    method: 'POST', path: '/grading-feedback-task2',
    body: { question: req.question, topic: req.topic, essay: req.essay },
  }),
  parseResponse: parseGrading,
};

export const task1QuestionAdapter: DownstreamAdapter<Task1QuestionReq, Task1QuestionRes> = {
  operation: 'writing.task1.question.generate',
  downstream: 'ai-writing',
  buildRequest: (req) => ({
    method: 'POST', path: '/generate-question-task1',
    body: req.chart_type ? { topic: req.chart_type } : {},
  }),
  // envelope lồng HAI lớp: { data: { data: {...} } }
  parseResponse: (raw: any) => {
    const d = raw?.data?.data ?? raw?.data;
    if (!d?.question || !d?.image_url) {
      throw new ContractViolationError('missing question or image_url');
    }
    return { question_id: d.question_id, question: d.question,
             chart_type: d.topic, image_url: d.image_url };
  },
};

export const task2QuestionAdapter: DownstreamAdapter<Task2QuestionReq, Task2QuestionRes> = {
  operation: 'writing.task2.question.generate',
  downstream: 'ai-writing',
  buildRequest: (req) => ({
    method: 'POST', path: '/question-generated-task2',
    body: { topic: req.topic, question_type: req.question_type },
  }),
  // envelope PHẲNG, tên field khác hẳn task 1
  parseResponse: (raw: any) => {
    const d = raw?.data;
    if (!d?.description) throw new ContractViolationError('missing data.description');
    return { question: d.description,          // 'description' -> 'question'
             topic: d.topic ?? '',
             question_type: d.instruction };   // 'instruction'  -> 'question_type'
  },
};
```

### Bốn thứ adapter cố tình vứt bỏ

| Bỏ | Vì sao |
|---|---|
| `data.coT` | Chain-of-thought nội bộ (`layer1_errors`, `layer2_matching`, `layer3_calibration`). Lộ prompt engineering và gợi ý cho người dò prompt. **Không được ra tới client** |
| `evaluation.*.feedback_detail` | Chỉ là bản làm phẳng của `data_micro` dạng chuỗi `'quote' -> explanation`. `annotations` giữ bản có cấu trúc, dùng được |
| `data_micro.*.*.question_type` | Task 1 trả `'bar_chart'`, Task 2 trả `'education'` — hai nghĩa khác nhau cùng một tên. Không dùng được |
| `success`, `original_type`, `converted`, `message`, `timestamp`, `data.task` | Nhiễu của envelope. Trạng thái đã nằm ở HTTP status |

`actorId` **cố tình không có trong body**. Danh tính đi trong internal JWT đã ký; nhét thêm vào body tạo ra một đường thứ hai để giả mạo, và AI Service có thể lỡ tin nhầm đường đó.

### Adapter thuần nên test là so JSON

```ts
it('map response chấm Task 1 thật', () => {
  const raw = require('../../test/fixtures/ai-writing/grade-task1.response.json');
  const out = gradeTask1Adapter.parseResponse(raw);
  expect(out.overall_band).toBe(7.0);
  expect(out.criteria.map(c => c.id)).toEqual([
    'task_achievement', 'coherence_cohesion', 'lexical_resource', 'grammatical_range_accuracy',
  ]);
  expect(out.criteria[1].improvements).toEqual([]);   // sentinel đã bị lọc
  expect(out.annotations[0].quote).toBe('a more than twentyfold increase');
  expect(JSON.stringify(out)).not.toContain('layer1_errors');   // coT không rò ra
});
```

Không mock, không network — đúng lợi ích của việc bắt adapter là hàm thuần ([§H.3](#h3-adapter-hàm-thuần-không-io)).

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

### Việc cho team Writing — 7 mục, xếp theo mức ưu tiên

Danh sách này rút ra từ việc **gọi thật cả 4 endpoint** ngày 2026-09-07; fixture ở `test/fixtures/ai-writing/`.

| # | Việc | Mức | Vì sao |
|---|---|---|---|
| 1 | **Thêm `usage`/`models`/`metrics`** vào response (additive) | 🔴 Chặn | Metering hiện tại là 0%. Chấm bài chạy 16–18s, chắc chắn gọi model nhiều lần, nhưng không trả token nào |
| 2 | **Bỏ `data.coT` khỏi response** | 🔴 Chặn | Đang lộ `layer1_errors` / `layer2_matching` / `layer3_calibration` ra ngoài. AIHUB sẽ cắt, nhưng đừng gửi ngay từ đầu |
| 3 | **Sửa 404 bị bọc thành 500** | 🟠 Cao | `{"detail":"404: Không tìm thấy dữ liệu cho topic này!"}` trả về HTTP 500. Xem giải thích bên dưới |
| 4 | **Kiểm tra band nửa điểm** | 🟠 Cao | 3 mẫu đều ra band nguyên, và cả 4 tiêu chí luôn bằng nhau (7-7-7-7 rồi 5-5-5-5). Nghi ngờ không bao giờ phát ra `.5` |
| 5 | **Phạt bài dưới độ dài tối thiểu** | 🟠 Cao | Bài Task 2 dài 98 từ (yêu cầu 250) vẫn được band 5.0 |
| 6 | **Bịt `/five-minute-grading`** | 🔴 Chặn | Endpoint duy nhất không khai báo security. Service đang public nên đây là lỗ mở ra cả Internet |
| 7 | **Cấp token riêng cho AIHUB**, tách khỏi token Wispace, có TTL thật | 🔴 Chặn | Token hiện tại `exp` năm **2100** và `role: Admin`. Token riêng cho phép tách usage và thu hồi độc lập |

**Không có mục "chuyển service vào private network".** Writing đang phục vụ ứng dụng Wispace chưa đi qua AIHUB nên chưa đóng được; đó là hướng tương lai, không phải việc của phase này. Xem [09 §M.3](09-security.md#m3-ai-writing-còn-public--rủi-ro-được-chấp-nhận-có-điều-kiện).

Vì service còn public, mục 6 quan trọng hơn hẳn: một endpoint không auth trên Internet là chỗ bất kỳ ai cũng đốt được tiền model.

### Vì sao mục 3 nguy hiểm hơn vẻ ngoài

```
{"topic":"environment"} -> HTTP 500 {"detail":"404: Không tìm thấy dữ liệu cho topic này!"}
```

Một trạng thái nghiệp vụ ("không có dữ liệu cho loại biểu đồ này") đang trả về 5xx. Theo [07 §I.3](07-reliability-and-errors.md#i3-circuit-breaker--opossum-key-theo-operation), AIHUB chỉ tính 5xx vào circuit breaker — nên **một khách gõ sai `chart_type` nhiều lần có thể mở breaker và làm sập operation đó cho mọi khách khác**.

Đúng phải là `404` (hoặc `422`), và AIHUB sẽ map thành lỗi client, không tính vào breaker.

Tạm thời AIHUB không thể tự chữa: phân biệt "500 thật" với "404 bị bọc" đòi phải đọc chuỗi `detail` — một heuristic dễ vỡ, không nên đưa vào adapter.

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
