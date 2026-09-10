# 06 — Routing & Adapter Design

← [Table of Contents](README.md) · [05 — Auth & Identity](05-auth-identity.md)

> The objective of this document is to answer question §18.8 from the brief: _How much effort is required to onboard a new AI Service?_ The litmus test is detailed in [§H.9](#h9-litmus-test-effort-to-add-ai-reading).

<a id="h1-operation-catalog--code-có-kiểu"></a>
<a id="h1-operation-catalog-typed-code"></a>

## H.1 Operation Catalog — Typed Code

The MVP consists of **4 operations**: question generation and grading for Task 1 and Task 2.

| Public Endpoint                          | Operation ID                      | Scope                       | Identity | Idempotency | Downstream Path             |
| ---------------------------------------- | --------------------------------- | --------------------------- | -------- | ----------- | --------------------------- |
| `POST /v1/ielts/writing/task1/questions` | `writing.task1.question.generate` | `writing.question.generate` | org      | none        | `/generate-question-task1`  |
| `POST /v1/ielts/writing/task2/questions` | `writing.task2.question.generate` | `writing.question.generate` | org      | optional    | `/question-generated-task2` |
| `POST /v1/ielts/writing/task1/grade`     | `writing.task1.grade`             | `writing.grade`             | **user** | required    | `/grading-feedback-task1`   |
| `POST /v1/ielts/writing/task2/grade`     | `writing.task2.grade`             | `writing.grade`             | **user** | required    | `/grading-feedback-task2`   |

```ts
export const OPERATIONS = {
  "writing.task1.question.generate": {
    method: "POST",
    path: "/v1/ielts/writing/task1/questions",
    requiredScope: "writing.question.generate",
    identityScope: "organization",
    execution: "sync",
    contentType: "application/json",
    idempotency: "none", // reads from DB, zero model cost, duplicate calls harmless
    maxBodyBytes: 8 * 1024,
    timeoutMs: 10_000,
    downstream: "ai-writing",
    downstreamPath: "/generate-question-task1",
    requestSchema: Task1QuestionRequest,
    responseSchema: Task1QuestionResponse,
  },
  "writing.task2.question.generate": {
    method: "POST",
    path: "/v1/ielts/writing/task2/questions",
    requiredScope: "writing.question.generate",
    identityScope: "organization",
    execution: "sync",
    contentType: "application/json",
    idempotency: "optional", // DOES invoke model -> incurs monetary cost
    maxBodyBytes: 8 * 1024,
    timeoutMs: 30_000,
    downstream: "ai-writing",
    downstreamPath: "/question-generated-task2",
    requestSchema: Task2QuestionRequest,
    responseSchema: Task2QuestionResponse,
  },
  "writing.task1.grade": {
    method: "POST",
    path: "/v1/ielts/writing/task1/grade",
    requiredScope: "writing.grade",
    identityScope: "user", // result belongs to a specific learner
    execution: "sync",
    contentType: "application/json",
    idempotency: "required",
    maxBodyBytes: 256 * 1024,
    timeoutMs: 60_000,
    downstream: "ai-writing",
    downstreamPath: "/grading-feedback-task1",
    requestSchema: GradeTask1Request,
    responseSchema: GradeResponse,
  },
  "writing.task2.grade": {
    /* identical structure, downstreamPath: '/grading-feedback-task2' */
  },
} as const satisfies Record<OperationId, OperationDef>;
```

A single canonical source yields: Fastify route definitions, guard configurations, `bodyLimit`, timeouts, OpenAPI 3.1 specifications, and documentation tables. **That is the entire rationale for placing it in code rather than in the DB** ([03 §E.5](03-database.md#why-the-routing-catalog-lives-in-code-not-db)).

Downstream URL in environment: `DOWNSTREAM_AI_WRITING_URL=http://ai-writing:8080`

### Why Task 1 and Task 2 Endpoints Are Separated

Strict per-task schemas (task 1 **requires** `image_url`, task 2 **forbids** it), clean validation errors, pristine generated SDKs, and granular pricing/scope controls. Merging into a single endpoint with a discriminator forces `oneOf` unions, leading to unhelpful validation diagnostics.

### Closed-Loop Workflow

```
generate question  -> returns question + image_url
                             ↓
student writes essay
                             ↓
grade essay        -> submits original question + image_url + essay
```

Matches precisely the `url` field that `/grading-feedback-task1` expects.

### Adapters Prove Their Value Immediately

Downstream named its endpoints `/generate-question-task1` but `/question-generated-task2` — **same conceptual operation, inverted naming conventions**. The public API preserves symmetry: `/v1/ielts/writing/task1/questions` and `/v1/ielts/writing/task2/questions`. Clients are insulated from upstream inconsistencies without requiring downstream teams to refactor legacy code.

<a id="h2-canonical-schemas"></a>

## H.2 Canonical Schemas

> Grounded directly in **real responses captured and committed to `test/fixtures/ai-writing/`**, not speculation.

```ts
// 7 verified values, CASE-SENSITIVE ('bar chart' -> downstream 500)
const CHART_TYPES = [
  "Bar Chart",
  "Line Graph",
  "Pie Chart",
  "Table",
  "Map",
  "Process Diagram",
  "Multiple Graphs",
] as const;

const QUESTION_TYPES = [
  "opinion",
  "discussion",
  "problem_solution",
  "advantages_disadvantages",
  "two_part",
] as const;

// Downstream currently emits feedback exclusively in Vietnamese.
// Widening the enum when Writing supports 'en' is backward-compatible.
const LANGUAGES = ["vi"] as const;

export const GradeTask1Request = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    chart_type: Type.Union(CHART_TYPES.map(Type.Literal)), // -> downstream 'topic'
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
    image_url: Type.String({ format: "uri", maxLength: 2_000 }), // -> downstream 'url'
    language: Type.Optional(Type.Union(LANGUAGES.map(Type.Literal))),
  },
  { additionalProperties: false }
);

export const GradeTask2Request = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 2_000 }),
    topic: Type.String({ minLength: 1, maxLength: 200 }), // true topic domain, e.g. 'education'
    essay: Type.String({ minLength: 1, maxLength: 20_000 }),
    language: Type.Optional(Type.Union(LANGUAGES.map(Type.Literal))),
  },
  { additionalProperties: false }
);

// Task 1 and Task 2 differ only in the first criterion.
const CRITERION_IDS = [
  "task_achievement", // task 1 only
  "task_response", // task 2 only
  "coherence_cohesion",
  "lexical_resource",
  "grammatical_range_accuracy",
] as const;

const Band = Type.Number({ minimum: 0, maximum: 9, multipleOf: 0.5 });

export const GradeResponse = Type.Object(
  {
    overall_band: Band,
    language: Type.Union(LANGUAGES.map(Type.Literal)),
    criteria: Type.Array(
      Type.Object({
        id: Type.Union(CRITERION_IDS.map(Type.Literal)),
        name: Type.String(), // 'Task Achievement' / 'Task Response'
        band: Band,
        band_reason: Type.String(),
        strengths: Type.Array(Type.String()),
        improvements: Type.Array(Type.String()), // empty array instead of sentinel 'None specified'
      }),
      { minItems: 4, maxItems: 4 }
    ),
    summary: Type.String(),
    suggestions: Type.Array(Type.String()),
    next_steps: Type.Array(Type.String()),
    annotations: Type.Array(
      Type.Object({
        // inline quotes and critiques
        criterion: Type.Union(CRITERION_IDS.map(Type.Literal)),
        issue: Type.String(), // 'inaccurate_data_support', etc.
        quote: Type.String(),
        explanation: Type.String(),
      })
    ),
  },
  { additionalProperties: false }
);

export const Task1QuestionRequest = Type.Object(
  {
    chart_type: Type.Optional(Type.Union(CHART_TYPES.map(Type.Literal))), // omitted = random
  },
  { additionalProperties: false }
);

export const Task1QuestionResponse = Type.Object(
  {
    question_id: Type.String(),
    question: Type.String(),
    chart_type: Type.Union(CHART_TYPES.map(Type.Literal)),
    image_url: Type.String({ format: "uri" }),
  },
  { additionalProperties: false }
);

export const Task2QuestionResponse = Type.Object(
  {
    question: Type.String(),
    topic: Type.String(),
    question_type: Type.Union(QUESTION_TYPES.map(Type.Literal)),
  },
  { additionalProperties: false }
);
```

### Five Decisions Derived Directly From Empirical Data

**`criteria` is an array — confirmed by production evidence.** Real responses return keys `1_task_achievement` for Task 1 and `1_task_response` for Task 2, with the remaining three criteria identical. Modeling these as 4 fixed object fields creates differing shapes forcing clients to write branching UI code. An array with stable `id` and localized `name` lets clients render with a single shared component; array order is guaranteed by downstream numeric prefixes.

**`chart_type` replaces `topic` in Task 1.** Downstream named the field `topic`, but its real expected value is the chart category (`Bar Chart`), not a subject matter — passing `"environment"` triggers a 500 error. Re-exporting `topic` in the public API perpetuates that exact confusion to external customers. For Task 2, `topic` legitimately represents subject matter, so it is retained.

**`multipleOf: 0.5` accepts both `int` and `float`.** Downstream returns `overall_band: 7.0` (float) alongside `band_score: 7` (int). `multipleOf: 0.5` satisfies both without type coercion — forcing strict float typing would erroneously reject valid integer scores.

**`improvements` normalizes sentinel strings.** Downstream outputs `["None specified"]` when there are no constructive suggestions. The adapter normalizes this into an empty array `[]` — allowing clients to perform clean `length === 0` checks instead of fragile string comparisons.

**`annotations` replaces `corrections`.** Initial architectural drafts anticipated replacement pairs `{original, suggestion}`. In reality, downstream emits `{quote, explanation}` — **critiques on excerpted sentences, not textual drop-in substitutions**. Calling this `corrections` would mislead client developers into constructing "click to accept change" UIs unsupported by the model.

**AIHUB does not recalculate `overall_band`.** Band rounding formulas are domain business rules of the IELTS writing service. The gateway validates score boundaries only.

### `additionalProperties: false` Fulfills US05

Properties outside the public contract **trigger 400 Bad Request**, never silent truncation. Silent stripping masks integration bugs for months. As defined in D1 §18:

```
Unknown field outside public contract         -> Reject 400
Valid field unsupported by target AI Service  -> Adapter transforms or drops per rules
```

### Why TypeBox Over Zod

Fastify **executes JSON Schema natively** — compilation applies to both validation and serialization. Zod requires bidirectional conversion layers. A single TypeBox definition generates: TypeScript types, runtime validators, and OpenAPI 3.1 schemas. The Data Dictionary in D1 §20 is generated automatically from these definitions.

<a id="h3-adapter-hàm-thuần-không-io"></a>
<a id="h3-adapters-pure-functions-zero-io"></a>

## H.3 Adapters: Pure Functions, Zero I/O

Revised from D1 §21:

```ts
interface DownstreamAdapter<TReq, TRes> {
  readonly operation: OperationId;
  readonly downstream: DownstreamId;

  buildRequest(req: TReq, ctx: RequestContext): DownstreamRequest;
  parseResponse(raw: InternalAIServiceResponse<unknown>): TRes;
  parseError?(status: number, body: unknown): DownstreamErrorHint | undefined;
}

type DownstreamRequest = {
  method: "GET" | "POST";
  path: string; // '/grading-feedback-task1' — NO host component
  body?: unknown;
  contentType?: string;
};
```

### Three Changes and Their Rationale

**1. Adapters do not perform HTTP execution.** They return a _descriptor_ of the request; the dispatcher handles network execution. Consequently, adapters are pure functions — zero networking, zero database calls, zero clock access. Golden fixture testing (brief §13.15) becomes "feed JSON in, assert JSON out" — **zero mocks required**.

**2. Adapters do not construct full URLs.** They know only the relative `path`; hosts are injected via environment variables keyed by `downstream`. Adapters never touch hostnames → eliminating the SSRF attack vector discussed in [03 §E.5](03-database.md#why-the-routing-catalog-lives-in-code-not-db).

**3. `parseError` is optional.** Transport and gateway errors (timeouts, connection drops, 5xx) are identical across AI services and handled universally by `DownstreamErrorMapper`. An adapter only implements `parseError` when a service returns domain-specific structured error payloads (e.g. `{"error_code":"MODEL_NOT_READY"}`). Making `mapError` mandatory in D1 previously forced every adapter to copy-paste identical boilerplate.

<a id="adapter-thật"></a>
<a id="adapter-thật--viết-từ-fixture-không-phải-suy-đoán"></a>
<a id="real-adapters-written-from-fixtures-not-speculation"></a>

### Real Adapters — Written From Fixtures, Not Speculation

```ts
const CRITERION_NAMES: Record<CriterionId, string> = {
  task_achievement: "Task Achievement",
  task_response: "Task Response",
  coherence_cohesion: "Coherence and Cohesion",
  lexical_resource: "Lexical Resource",
  grammatical_range_accuracy: "Grammatical Range and Accuracy",
};

/** Downstream returns ["None specified"] instead of an empty array. */
const clean = (xs: string[] = []) =>
  xs.filter((s) => s && s.trim().toLowerCase() !== "none specified");

/** data_micro: { criterion: { issue: { comments: [{quote, explanation}] } } } */
function toAnnotations(micro: Record<string, any> = {}) {
  return Object.entries(micro).flatMap(([criterion, issues]) =>
    Object.entries(issues ?? {}).flatMap(([issue, body]: [string, any]) =>
      (body?.comments ?? []).map((c: any) => ({
        criterion,
        issue,
        quote: c.quote,
        explanation: c.explanation,
      }))
    )
  );
}

/** Shared across both tasks — differs only in the primary criterion key. */
function parseGrading(raw: any): GradeRes {
  const d = raw?.data;
  if (!d?.evaluation || d.overall_band == null) {
    throw new ContractViolationError(
      "missing data.evaluation or data.overall_band"
    );
  }

  const criteria = Object.entries(d.evaluation)
    .sort(([a], [b]) => a.localeCompare(b)) // '1_...' < '2_...' — preserves downstream ordering
    .map(([key, v]: [string, any]) => {
      const id = key.replace(/^\d+_/, "") as CriterionId;
      if (!(id in CRITERION_NAMES)) {
        throw new ContractViolationError(`unknown criterion: ${key}`);
      }
      return {
        id,
        name: CRITERION_NAMES[id],
        band: v.band_score,
        band_reason: v.band_reason ?? "",
        strengths: clean(v.strengths),
        improvements: clean(v.areas_for_improvement),
      };
    });

  const oa = d["Overall Assessment"] ?? {};
  return {
    overall_band: d.overall_band,
    language: "vi",
    criteria,
    summary: oa.Summary ?? "",
    suggestions: clean(oa["Specific Suggestions"]),
    next_steps: clean(oa["Next Steps"]),
    annotations: toAnnotations(raw?.data_micro),
  };
}

export const gradeTask1Adapter: DownstreamAdapter<GradeTask1Req, GradeRes> = {
  operation: "writing.task1.grade",
  downstream: "ai-writing",

  buildRequest: (req) => ({
    method: "POST",
    path: "/grading-feedback-task1",
    body: {
      question: req.question,
      topic: req.chart_type, // canonical 'chart_type' -> downstream 'topic'
      essay: req.essay,
      url: req.image_url, // canonical 'image_url'  -> downstream 'url'
      // ctx.actorId INTENTIONALLY omitted from body — transmitted via signed internal JWT
    },
  }),

  parseResponse: parseGrading,
};

export const gradeTask2Adapter: DownstreamAdapter<GradeTask2Req, GradeRes> = {
  operation: "writing.task2.grade",
  downstream: "ai-writing",
  buildRequest: (req) => ({
    method: "POST",
    path: "/grading-feedback-task2",
    body: { question: req.question, topic: req.topic, essay: req.essay },
  }),
  parseResponse: parseGrading,
};

export const task1QuestionAdapter: DownstreamAdapter<
  Task1QuestionReq,
  Task1QuestionRes
> = {
  operation: "writing.task1.question.generate",
  downstream: "ai-writing",
  buildRequest: (req) => ({
    method: "POST",
    path: "/generate-question-task1",
    body: req.chart_type ? { topic: req.chart_type } : {},
  }),
  // Downstream wraps in a double envelope: { data: { data: {...} } }
  parseResponse: (raw: any) => {
    const d = raw?.data?.data ?? raw?.data;
    if (!d?.question || !d?.image_url) {
      throw new ContractViolationError("missing question or image_url");
    }
    return {
      question_id: d.question_id,
      question: d.question,
      chart_type: d.topic,
      image_url: d.image_url,
    };
  },
};

export const task2QuestionAdapter: DownstreamAdapter<
  Task2QuestionReq,
  Task2QuestionRes
> = {
  operation: "writing.task2.question.generate",
  downstream: "ai-writing",
  buildRequest: (req) => ({
    method: "POST",
    path: "/question-generated-task2",
    body: { topic: req.topic, question_type: req.question_type },
  }),
  // Flat envelope with naming divergent from task 1
  parseResponse: (raw: any) => {
    const d = raw?.data;
    if (!d?.description)
      throw new ContractViolationError("missing data.description");
    return {
      question: d.description, // 'description' -> 'question'
      topic: d.topic ?? "",
      question_type: d.instruction, // 'instruction'  -> 'question_type'
    };
  },
};
```

### Four Elements Intentionally Stripped by the Adapter

| Stripped Field                                                               | Rationale                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data.coT`                                                                   | Internal chain-of-thought (`layer1_errors`, `layer2_matching`, `layer3_calibration`). Leaks proprietary prompt engineering and gives hints to prompt extraction attackers. **Never exposed to clients** |
| `evaluation.*.feedback_detail`                                               | Merely a flattened stringification of `data_micro` (`'quote' -> explanation`). `annotations` preserves the structured version                                                                           |
| `data_micro.*.*.question_type`                                               | Task 1 returns `'bar_chart'`, Task 2 returns `'education'` — overloaded inconsistent semantics across tasks. Unusable                                                                                   |
| `success`, `original_type`, `converted`, `message`, `timestamp`, `data.task` | Envelope noise. Status is represented cleanly by HTTP status codes                                                                                                                                      |

`actorId` **is deliberately omitted from the request body**. User identity travels exclusively inside the cryptographically signed internal JWT; adding it to the body opens a secondary spoofing vector that downstream services might inadvertently trust.

### Pure Adapters Mean Tests Are Pure JSON Comparisons

```ts
it("maps real Task 1 grading response fixture", () => {
  const raw = require("../../test/fixtures/ai-writing/grade-task1.response.json");
  const out = gradeTask1Adapter.parseResponse(raw);
  expect(out.overall_band).toBe(7.0);
  expect(out.criteria.map((c) => c.id)).toEqual([
    "task_achievement",
    "coherence_cohesion",
    "lexical_resource",
    "grammatical_range_accuracy",
  ]);
  expect(out.criteria[1].improvements).toEqual([]); // sentinel filtered out
  expect(out.annotations[0].quote).toBe("a more than twentyfold increase");
  expect(JSON.stringify(out)).not.toContain("layer1_errors"); // coT never leaks
});
```

Zero mocks, zero network calls — the exact benefit of enforcing pure function adapters ([§H.3](#h3-adapters-pure-functions-zero-io)).

## H.4 Dispatcher — The Exclusive I/O Boundary

```ts
async dispatch(op, canonicalReq, ctx) {
  const adapter = this.registry.get(op);
  const dsReq   = adapter.buildRequest(canonicalReq, ctx);
  const token   = await this.tokenIssuer.mint(ctx, op);        // TTL 60s

  const t1 = performance.now();
  const res = await this.http.request(adapter.downstream, dsReq, {
    signal:    ctx.signal,                                     // cancelable
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

`x-request-deadline` is ~3 lines of code with massive impact: if AI Writing knows only 4 seconds remain before timeout, it will abort rather than launching a 20-second model run. Without it, downstreams burn expensive tokens for responses that callers have already abandoned.

<a id="h5-internal-contract--sửa-writing-mà-không-phá-app-hiện-tại"></a>
<a id="h5-internal-contract-modify-writing-without-breaking-existing-app"></a>

## H.5 Internal Contract — Updating Writing WITHOUT Breaking Existing Apps

Writing is live in production serving the existing Wispace client app. Wrapping its response into `{ data: ... }` would be a **breaking change**; **adding** top-level fields does not break anything (older clients safely ignore unrecognized fields).

Requirements for the Writing team are minimal:

```jsonc
// /grading-feedback-task1 — keep all existing fields intact, ONLY ADD 3 fields:
{
  "...": "...", // untouched existing payload

  "usage": { "input_tokens": 820, "output_tokens": 310, "total_tokens": 1130 },
  "models": [{ "provider": "openai", "name": "gpt-4o-mini" }],
  "metrics": { "ai_processing_ms": 790 },
}
```

- `/generate-question-task1` reads from DB → **omit `usage`**, do not return `0`.
- Operations invoking models multiple times → `usage` represents the **sum total for the entire operation**; breakdown lives in `usage.calls[]` (optional). Per D1 §15 and target architecture §16.

AIHUB seamlessly parses both flat and wrapped envelopes via 3 lines of code without configuration:

```ts
function splitEnvelope(body: any) {
  const { usage, models, metrics, data, ...rest } = body ?? {};
  return { data: data ?? rest, usage, models, metrics };
}
// Remove `?? rest` fallback once all AI services adhere to standard envelope.
```

Consequently, **Writing does not block AIHUB, and AIHUB does not block Writing** — development proceeds entirely in parallel.

`InternalResponseSchema.parse` validates AI Service conformance. Missing `usage` → **never throws errors**, merely sets `metering_status='missing_usage'` and records a metric. The customer's request succeeds uninterrupted; the instrumentation gap is our problem, not theirs.

### Action Items for the Writing Team — 7 Items by Priority

Derived from **direct empirical testing of all 4 endpoints** on 2026-09-07; fixtures located at `test/fixtures/ai-writing/`.

| #   | Action Item                                                                      | Priority   | Rationale                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Add `usage`/`models`/`metrics`** to responses (additive)                       | 🔴 Blocker | Current metering coverage is 0%. Grading takes 16–18s with multiple model calls, but reports zero token metrics                                                |
| 2   | **Strip `data.coT` from responses**                                              | 🔴 Blocker | Currently exposes `layer1_errors` / `layer2_matching` / `layer3_calibration`. AIHUB strips it, but downstream should not emit it                               |
| 3   | **Fix 404s erroneously masked as 500s**                                          | 🟠 High    | `{"detail":"404: Không tìm thấy dữ liệu cho topic này!"}` returns HTTP 500. See explanation below                                                              |
| 4   | **Verify half-band score emissions**                                             | 🟠 High    | All 3 test samples yielded integer scores with identical marks across all 4 criteria (7-7-7-7 and 5-5-5-5). High probability `.5` increments are never emitted |
| 5   | **Penalize essays below minimum word count**                                     | 🟠 High    | Task 2 essay of 98 words (250 minimum required) was awarded a Band 5.0                                                                                         |
| 6   | **Secure `/five-minute-grading`**                                                | 🔴 Blocker | Sole endpoint lacking security definitions. Because the service is public, this is wide open to the Internet                                                   |
| 7   | **Issue dedicated API token for AIHUB**, isolated from Wispace, with genuine TTL | 🔴 Blocker | Current token has `exp` in the year **2100** and `role: Admin`. Dedicated token isolates usage accounting and enables selective revocation                     |

**"Migrate service into private network" is intentionally omitted.** Writing is currently serving the live Wispace client and cannot be isolated yet; network isolation is future work, not Phase 2. See [09 §M.3](09-security.md#m3-ai-writing-remains-public-conditionally-accepted-risk).

Given public internet exposure, Item 6 is paramount: an unauthenticated endpoint on the public web allows anyone to consume downstream model quotas.

### Why Item 3 Is More Hazardous Than It Appears

```
{"topic":"environment"} -> HTTP 500 {"detail":"404: Không tìm thấy dữ liệu cho topic này!"}
```

A business domain condition ("no data available for this chart type") returns a 5xx server error. As defined in [07 §I.3](07-reliability-and-errors.md#i3-circuit-breaker--opossum-key-theo-operation), AIHUB feeds 5xx status codes directly into circuit breakers — meaning **a single client repeatedly submitting an invalid `chart_type` can trip the breaker and take down that operation for all other customers**.

Downstream must return `404` (or `422`), which AIHUB translates into a client error without tripping circuit breakers.

AIHUB cannot reliably self-heal this downstream flaw: distinguishing true 500s from masked 404s would require fragile regex parsing of error message strings — a brittle heuristic that does not belong in adapters.

## H.6 HTTP Client Configuration

```ts
new Pool(baseUrl, {
  connections: 64, // per downstream
  pipelining: 1, // long-lived AI requests -> pipelining useless, causes head-of-line blocking
  keepAliveTimeout: 60_000,
  headersTimeout: op.timeoutMs,
  bodyTimeout: op.timeoutMs,
});
```

Keep-alive is critical: TLS/TCP handshakes add ~30–50ms latency. Incurring connection negotiation overhead across multi-second AI calls without connection reuse degrades performance for zero benefit.

<a id="h7-client-ngắt-kết-nối-giữa-chừng--xử-lý-theo-tiền"></a>
<a id="h7-client-aborts-mid-request-financial-handling"></a>

## H.7 Client Aborts Mid-Request — Financial Handling

```
Has Idempotency-Key -> DO NOT abort downstream. Monetary cost is already incurred; complete
                       execution and store result so subsequent retries return cached data
                       without burning double tokens.
No Idempotency-Key  -> abort immediately to conserve remaining tokens.
```

Conventional intuition is "abort immediately to save resources". But when an operation carries an idempotency key, completing execution is actually **cheaper**: the client will almost certainly retry, and returning a cached result avoids paying model inference fees a second time. See [07 §I.5](07-reliability-and-errors.md#i5-timeouts-and-idempotency-keys-avoiding-double-charges).

## H.8 Directory Structure

```
src/
├─ catalog/          operations.ts              <- single source of truth
├─ contracts/        writing.ts  speaking.ts    TypeBox schemas
├─ gateway/          controller.ts  envelope.interceptor.ts
├─ auth/             api-key/  user-assertion/  authorization/
├─ downstream/
│  ├─ adapter.types.ts   registry.ts   dispatcher.ts
│  ├─ http-client.ts     error-mapper.ts        <- shared across all services
│  └─ writing/  grade-task1.adapter.ts  grade-task2.adapter.ts  question-*.adapter.ts
├─ internal-token/   issuer.ts  jwks.controller.ts
├─ idempotency/  metering/  rate-limit/  errors/  observability/
└─ cli/              org.ts  key.ts  identity.ts
```

Adheres tightly to §27 target architecture, with two modifications: added `catalog/` and `contracts/`, removed `routing/` (its logic dissolved into catalog + registry).

<a id="h9-phép-thử-thêm-ai-reading-tốn-bao-nhiêu"></a>
<a id="h9-litmus-test-effort-to-add-ai-reading"></a>

## H.9 Litmus Test: Effort to Add AI Reading

```
1. contracts/reading.ts                    TypeBox schema request + response
2. catalog/operations.ts                   add 1 entry: 'reading.analyze'
3. downstream/reading/analyze.adapter.ts   ~20 lines of pure mapping logic
4. .env                                    DOWNSTREAM_AI_READING_URL=...
5. test/fixtures/reading/*.json            golden fixtures
```

**Zero database migrations. Zero controller modifications. Zero changes to auth, rate limiting, metering, error mapping, or observability.** Routes generate automatically from the catalog; response envelopes wrap automatically in the interceptor.

If adding an AI service ever touches files outside these 5 areas, business logic has leaked beyond adapter boundaries — **use this as an architectural health metric**.

---

→ Next: [07 — Reliability & Errors](07-reliability-and-errors.md)
