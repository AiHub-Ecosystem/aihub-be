# 11 — Open Questions & Feedback Loop to D1

← [Table of Contents](README.md) · [10 — Deployment & Roadmap](10-deployment-roadmap.md)

# P. Open Questions

Every open question includes a **Recommended default** so engineering velocity is never blocked waiting for non-critical business alignment.

> **Update 2026-09-07:** All 4 AI Writing endpoints were probed against real environments using team-issued credentials.
> **P.1 and P.2 are resolved** — zero blockers remain for Phase 1. Fixtures committed under `test/fixtures/ai-writing/`.

<a id="p1-response-thật-của-grading-feedback-task12--chặn-phase-1"></a>
<a id="p1-real-response-for-grading-feedback-task12-phase-1-blocker"></a>

## P.1 Real Response Payloads for `/grading-feedback-task1|2` — ✅ **RESOLVED 2026-09-07**

Empirically verified across all 4 endpoints; real response fixtures stored in `test/fixtures/ai-writing/`. `parseResponse` fully implemented in [06 §H.3](06-routing-adapter.md#real-adapters-written-from-fixtures-not-speculation).

The prerequisite in the scaffold implementation plan — _"no Writing response parser is implemented until the unknown grading response fixture is resolved"_ — **is fully satisfied**.

Three contract refinements stemming from empirical data:

| Empirical Finding                                                                                                                 | Architectural Handling                                                         |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Response richer than initial design: `strengths[]`, `areas_for_improvement[]`, `band_reason`, `data_micro` with quote+explanation | Extended `GradeResponse`; expose nearly all fields except internal `coT`       |
| Feedback emitted exclusively in **Vietnamese**                                                                                    | Added `language` to request/response schemas, currently enum `['vi']`          |
| `corrections` assumed `{original, suggestion}`; actual payload is `{quote, explanation}`                                          | Renamed to `annotations` — critiques on excerpted text, not substitution diffs |

## P.2 `question_type` and `chart_type` — ✅ **FROZEN 2026-09-07**

`question_type` for Task 2: `opinion` verified working; retains 5 standard IELTS prompt types.

`chart_type` for Task 1 — **7 verified values, STRICTLY CASE-SENSITIVE**:

```
Bar Chart   Line Graph   Pie Chart   Table   Map   Process Diagram   Multiple Graphs
```

Lowercased `"bar chart"` → triggers downstream 500 error. `"Process"`, `"Diagram"`, `"Bar Graph"`, and `"Mixed Chart"` do not exist.

**Critical note:** Downstream calls this field `topic`, but the actual value represents a chart type rather than a topic domain — submitting `"environment"` yields a 500. Canonical schemas name this `chart_type`; the adapter translates to `topic` when dispatching downstream. For Task 2, `topic` legitimately represents subject domain and is preserved.

## P.2b Half-Band Increments — 🟡 **UNDER INVESTIGATION**

**Why it matters:** If downstream models never emit `.5` increments across individual criteria, that represents a genuine scoring bug directly impacting product educational value.

All 3 tested essays yielded integer scores with identical marks across all 4 criteria (7-7-7-7 and 5-5-5-5). `overall_band` is typed as `float`, whereas `band_score` is returned as `int`.

**Recommended default:** Schema enforces `multipleOf: 0.5` — cleanly accepting both `7` and `6.5` without false validation rejections. Writing service team must benchmark against calibration essays with established official band scores.

<a id="p3-mô-hình-bán-hàng"></a>
<a id="p3-sales-and-pricing-model"></a>

## P.3 Sales and Pricing Model

**Why it matters:** Dictates whether `metering_status='missing_usage'` acts as an alert or a request-blocking condition, and determines which SQL aggregation in [08 §K.2](08-metering-and-observability.md#k2-unfinalized-billing-model-measure-both) generates customer invoices.

**Recommended default:** Bill **per request** for initial design partners. AIHUB measures request counts with 100% precision independently of downstream AI Services, enabling immediate launch. Token metrics are recorded concurrently; once `unmetered` drops and stabilizes at 0, the business can seamlessly transition to token-based pricing.

## P.4 Default `rate_limit_rpm` and `max_concurrent`

**Why it matters:** Overly generous thresholds fail to protect AI Writing; overly aggressive limits artificially throttle legitimate customer traffic.

**Recommended default:** Baseline at **600 rpm / 20 concurrent**. Finalize via Phase 3 load testing: benchmark real downstream capacity, cap system-wide concurrency below that ceiling, and divide by expected tenant concurrency.

## P.5 Should User Assertion `aud` Include the Environment?

**Why it matters:** With `aud: "aihub"`, an assertion minted for staging could theoretically be replayed against production.

**Recommended default:** Retain `aud: "aihub"` as frozen in D1. API keys are already bound to specific environments, so an attacker still needs a valid production key; residual risk is negligible compared to the friction of forcing every customer to rewrite assertion signing pipelines. Revisit only if enterprise compliance audits mandate strict cross-environment token isolation.

---

<a id="q-những-thay-đổi-cần-đưa-ngược-vào-d1"></a>
<a id="q-changes-to-feed-back-to-d1"></a>

# Q. Changes to Feed Back to Deliverable 1

Concrete action checklist for `../../../aihub_deliverable_1_api_contract_schema.md` prior to freezing.

| #   | Modification                                                                                                                                           | Impacted D1 Section |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| 1   | **Replace Writing request/response schemas** with verified schemas. Current `content`/`language`/`level` placeholders are obsolete                     | §10, §20            |
| 2   | **Split Task 1 / Task 2** into 4 dedicated operations; update Operation Catalog and mapping tables                                                     | §19, §27            |
| 3   | **Add 6 new unified error codes** to the Master Error Mapping Matrix                                                                                   | §25                 |
| 4   | **Add `max_assertion_ttl_seconds`** to End-user Identity Contract; designate `jti` as **mandatory**                                                    | §8                  |
| 5   | **Explicitly specify `usage` omission when models are not invoked**, using `/generate-question-task1` as concrete reference                            | §15                 |
| 6   | **Add `metering_status`** to internal contract: `complete` / `missing_usage` / `not_applicable`                                                        | §15, §16            |
| 7   | **Resolve Speaking TBD placeholders** at async envelope boundary; media size/MIME deferred                                                             | §11, §12, §27       |
| 8   | **Codify internal contract as additive** — Writing adds `usage`/`models`/`metrics`, never wraps `data`                                                 | §15                 |
| 9   | Provide answers for all 18 questions in §32                                                                                                            | §32                 |
| 10  | **Omit `meta.models[]` from public responses** — eliminates conflict with LTA §32.7                                                                    | §16                 |
| 11  | Migrate `idempotency_required` boolean → 3-state `idempotency` enum (`none`, `optional`, `required`)                                                   | §27                 |
| 12  | **`topic` → `chart_type` enum (7 values)** for Task 1 (actual payload represents chart type, not topic)                                                | §10, §20, §27       |
| 13  | **Add `language` parameter** to grading request/response schemas, currently enum `['vi']`                                                              | §10, §16, §20       |
| 14  | **Expand `GradeResponse`** to reflect production response: `criteria[].strengths/improvements/band_reason`, `suggestions`, `next_steps`, `annotations` | §16, §20            |
| 15  | **Document downstream masked 500 error** in error mapping + Writing team action items                                                                  | §23, §25            |

Items 1–11 were synchronized into D1 on 2026-09-07; items 12–15 emerged following live API testing.

## Answers for D1 §32 (18 Decisions Frozen Prior to Implementation)

| #   | Question                                     | Decision Adopted                                                                                                                                    |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `X-API-Key` or `Authorization: Bearer`?      | **`X-API-Key`** — cleanly disambiguated from internal JWTs which use `Authorization`                                                                |
| 2   | Do API keys require `live/test` modes?       | **No.** Environment is derived strictly from hostname; keys bind via `allowed_environments`                                                         |
| 3   | Are environments derived from hostnames?     | **Settled: Yes**                                                                                                                                    |
| 4   | `/v1` path prefix or version headers?        | **`/v1` path prefix**                                                                                                                               |
| 5   | Reject unknown properties with 400?          | **Yes** — `additionalProperties: false`, zero exceptions                                                                                            |
| 6   | `usage` behavior when no model call occurs   | **Omit**, not `null`, not `0`                                                                                                                       |
| 7   | Scope of public LLM model/breakdown exposure | **Aggregate token counts only.** `models[]` and `usage.calls[]` remain internal — per LTA §32.7                                                     |
| 8   | Customer JWKS URL or uploaded public keys?   | **Both** — `jwks_url` prioritized, `public_keys_jwks` supported as fallback                                                                         |
| 9   | Maximum assertion TTL limit                  | **300s default**, configurable per tenant                                                                                                           |
| 10  | Which operations mandate user assertions?    | `writing.task1.grade`, `writing.task2.grade`. Question generation is organization-scoped                                                            |
| 11  | `writing.grade` synchronous or async?        | **Synchronous**, 60s timeout                                                                                                                        |
| 12  | `speaking.grade` synchronous or async?       | **Async** — contract frozen in [02 §D.5](02-request-lifecycle.md#d5-lifecycle-3--async-media-phase-4-contract-chốt-ngay), implementation in Phase 4 |
| 13  | Speaking multipart upload or `asset_id`?     | **`asset_id`** via presigned cloud upload in Phase 4                                                                                                |
| 14  | Maximum audio size / supported MIME types    | ⏳ Open — Phase 4. Does not block freezing D1                                                                                                       |
| 15  | Idempotency requirements across operations   | `required` for grading; `optional` for task 2 generation; `none` for task 1 generation                                                              |
| 16  | Apply scopes and entitlements in D2?         | **Yes** — [05 §G.10](05-auth-identity.md#g10-authorization), zero added database queries                                                            |
| 17  | Missing usage on metering-critical calls     | **Pass through** + flag `metering_status='missing_usage'` + alert. See [§P.3](#p3-sales-and-pricing-model)                                          |
| 18  | Inventory of v1 public error codes           | 18 canonical error codes in [07 §J.2](07-reliability-and-errors.md#j2-error-code-inventory-v1)                                                      |

---

# R. Alignment With Core Architectural Principles (Brief §17)

| Guiding Principle                               | Implementation in This Architecture                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avoid over-engineering                          | 5 tables instead of 13; no queues, object storage, K8s, Vault, or Tempo in MVP                                                                      |
| Public contracts outlive implementations        | Catalog + TypeBox are single sources of truth; adapters absorb downstream anomalies                                                                 |
| Fail closed for auth & authorization            | [05 §G.10](05-auth-identity.md#g10-authorization); zero branches allow authorization pass-through on Redis failure                                  |
| Never trust self-asserted identity              | Organization derived from API key, environment from hostname, user from signed assertion                                                            |
| Explicit tenant isolation                       | `UNIQUE(issuer)`; `iss` matched to organization; user identity flows only via internal JWT                                                          |
| Never retry generative POSTs blindly            | [07 §I.2](07-reliability-and-errors.md#i2-retries-distinguishing-untransmitted-from-unknown-state) — distinguishes untransmitted from unknown state |
| Never guess token counts in gateway             | `missing_usage` telemetry, never synthetic tokenization                                                                                             |
| Redis is never source of truth                  | Completely codified in [04 — Redis](04-redis.md)                                                                                                    |
| No Kafka/K8s/service-mesh without justification | [10 §N.5](10-deployment-roadmap.md#n5-triggers-to-exit-this-architecture) — concrete quantitative exit triggers                                     |
| Every technology justified by workload          | [01 §B](01-context-and-stack.md#b-recommended-tech-stack-matrix) — "Rationale" column                                                               |
| Prioritize simple migration paths               | Phases 0→5; expand-only schema migrations; `splitEnvelope` transitional parsing                                                                     |
| State assumptions when uncertain                | [§P](#p-open-questions) — every question accompanied by "Recommended default"                                                                       |
