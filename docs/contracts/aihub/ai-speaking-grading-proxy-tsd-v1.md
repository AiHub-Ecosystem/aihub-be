# AIHUB D2 AI Speaking Grading Proxy

Technical Specification Document (TSD)

- Status: Approved
- Version: v1.0
- Date: 2026-09-14
- Scope owner: AIHUB Tech Lead
- Review roles: AI Speaking service owner; WISPACE integration owner
- Review date: 2026-09-14
- Approval: AI Speaking service owner and WISPACE integration owner confirmed approval on 2026-09-14
- Related issues: #24, #25, #27, #28
- JSON-by-URL extension decision: accepted in #28 on 2026-09-15
- Production handoff evidence update: authenticated multipart and JSON smoke passed on 2026-09-15

This document specifies the synchronous D2 Speaking grading proxy, including
the JSON-by-URL fallback in issue #28. It does not redefine the future
asynchronous Speaking grading job.

The executable boundary is src/contracts/speaking/grading.ts; the redacted
live-shape fixture is test/fixtures/ai-speaking/grading.response.json and is
the common response evidence for both transports; and
the downstream contract is
docs/contracts/ai-services/ai-speaking-grading-v1.md. OpenAPI and Postman
artifacts remain generated from executable source. This TSD is the
human-facing contract and review record.

## 1. Endpoint and base URL

| Surface                        | Method | Path                            | Content type        |
| ------------------------------ | ------ | ------------------------------- | ------------------- |
| AIHUB public                   | POST   | /v1/ielts/speaking/grading      | multipart/form-data |
| AIHUB public                   | POST   | /v1/ielts/speaking/grading-json | application/json    |
| Downstream AI Speaking service | POST   | /api/v1/speaking/grading        | multipart/form-data |
| Downstream AI Speaking service | POST   | /api/v1/speaking/grading-json   | application/json    |

Canonical AIHUB host convention:

| Environment | Base URL                             |
| ----------- | ------------------------------------ |
| Development | https://dev-api.aihub.example.com/v1 |
| Production  | https://api.aihub.example.com/v1     |

AIHUB resolves the environment from Host, but Host is client-supplied and is
not an absolute source of truth. The reverse proxy/load balancer in front of
each deployment must validate or overwrite Host to match the authentic
deployment domain/TLS SNI before forwarding to AIHUB; application startup also
rejects placeholder host configuration. Deployment-specific hostnames must be
recorded in the environment handoff, and clients cannot select an environment
or downstream host with a custom request field or header.

The downstream origin is trusted configuration
DOWNSTREAM_AI_SPEAKING_URL; the dispatcher appends the fixed downstream path.
The workbook shorthand /Speaking/Grading is an alias, not another route.

The future public POST /v1/speaking/grade asset/job operation is separate.

## 2. Naming

| Name               | Value                                       |
| ------------------ | ------------------------------------------- |
| Operation ids      | `speaking.grading`, `speaking.grading-json` |
| Required scope     | speaking.grade                              |
| Public capability  | Speaking grading                            |
| Downstream service | AI Speaking service                         |
| Execution          | Synchronous                                 |

AI Service means a downstream domain service behind AIHUB. Model Provider
means an upstream foundational model service invoked by an AI Service. The
term Provider is not used for both concepts.

The terms Speaking grading proxy and Speaking grading job are distinct:
the proxy is the current synchronous handoff; the job is the deferred durable
async operation.

## 3. Request headers

| Header           | Required     | Source and rule                                                              |
| ---------------- | ------------ | ---------------------------------------------------------------------------- |
| X-API-Key        | Yes          | Organization credential; validated before dispatch                           |
| X-User-Identity  | Yes          | Organization-signed assertion; verified before dispatch                      |
| X-Correlation-Id | No           | Echoed in meta when present                                                  |
| Content-Type     | Yes          | `multipart/form-data` for file grading or `application/json` for JSON-by-URL |
| Idempotency-Key  | No semantics | Speaking v1 does not consume it and provides no replay guarantee             |

AIHUB generates the primary request_id; a client-supplied X-Request-Id is not
the primary tracing id.

The outbound request adds x-client-id and x-secret-key from
environment-specific server configuration. They are never request fields,
browser values, fixtures, logs, public responses, or ordinary business data.

The client must not send a `user_id` form or JSON field. AIHUB derives
downstream `user_id` from the End-User ID resolved from `X-User-Identity`: the
verified assertion `sub` claim for an Organization with an active identity
configuration, otherwise the Declared User ID (ADR-0053).

## 4. Response envelope

A successful response is HTTP 200 with the shared envelope:

    {
      "data": { "...normalized scoring groups..." },
      "meta": {
        "request_id": "generated-by-aihub",
        "correlation_id": "optional-client-value",
        "service": "speaking",
        "operation": "speaking.grading",
        "timing": {
          "downstream_ms": 0,
          "gateway_overhead_ms": 0,
          "total_ms": 0
        }
      }
    }

correlation_id is omitted when the request did not send one. The JSON
transport uses `operation: "speaking.grading-json"`; all other envelope rules
are identical. AI Speaking
service envelopes, credentials, assertions, audio, raw service detail, and
service-private ids do not cross this boundary.

## 5. Mapper rules

### Public request to downstream request

| Public source        | Downstream field          | Rule                                   |
| -------------------- | ------------------------- | -------------------------------------- |
| Multipart audio      | audio                     | Forward the bounded bytes and filename |
| End-User ID          | user_id                   | Server-derived; never a body field     |
| part                 | part                      | Forward after boundary validation      |
| question_id          | question_id               | Forward after non-empty validation     |
| Optional text fields | Same names                | Forward only when present              |
| Server configuration | x-client-id, x-secret-key | Inject at dispatcher/HTTP boundary     |

For JSON-by-URL grading, `audio_url` replaces the multipart `audio` file and
the same verified identity and metadata mapping applies. The downstream path
is fixed by the operation catalog for each transport. The adapter is a pure
mapper; host selection, credentials, timeout, cancellation, and HTTP status
translation belong to infrastructure.

### Downstream response to public response

The mapper accepts only a successful AI Speaking service body with status "success" and
an object data. It emits only the normalized groups in section 6.

- `pronunciation_detail.words`, each word's `syllables` and `phonemes`,
  `language_analysis.grammar_errors`, and
  `language_analysis.vocabulary_upgrades` must already be arrays; a singleton
  object or `null` is a contract violation.
- `fluency_metrics` may be `null`, and nullable metrics remain null; they are
  not changed to zero.
- test_type may be a string, null, or omitted in the public response.
- provider-only `performance_timing` telemetry, including `llm_seconds`, is
  dropped and never crosses the public boundary.
- session_id, test_id, user_id, unknown service-private top-level fields, and
  raw service detail are dropped.
- Missing groups, wrong types, invalid ranges, or unapproved nested shapes
  produce AI_SERVICE_CONTRACT_VIOLATION.

## 6. Data dictionary

### Public multipart request

| Field       | Required | Contract                                                                                      |
| ----------- | -------- | --------------------------------------------------------------------------------------------- |
| audio       | Yes      | Exactly one file; extension wav, mp3, m4a, webm, or ogg; minimum 100 bytes; parser cap 25 MiB |
| part        | Yes      | Integer 1, 2, or 3                                                                            |
| question_id | Yes      | Non-empty string                                                                              |
| prompt_text | No       | String if present; provider default is `null`                                                 |
| test_type   | No       | `Practice` (default) or `Full-test`                                                           |
| test_code   | No       | String if present; provider default is `null`                                                 |
| transcript  | No       | String if present; provider default is `null`                                                 |

null is not accepted for multipart text fields. Unknown or duplicate fields
are invalid. The total multipart wire-body ceiling is 25 MiB
(26,214,400 bytes), including multipart overhead. The parser also applies a
64 KiB per-text-field defense limit. The extension allowlist is the supported
type contract; MIME metadata is not a separate trust boundary.

### Public JSON-by-URL request

| Field       | Required | Contract                                                                                                                               |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| audio_url   | Yes      | HTTPS URL on `s3.wispace.app` (S3-compatible SeaweedFS origin); maximum 2,048 characters; query parameters are allowed for signed URLs |
| part        | Yes      | Integer 1, 2, or 3                                                                                                                     |
| question_id | Yes      | Non-empty string                                                                                                                       |
| prompt_text | No       | String or `null`; provider default is `null`                                                                                           |
| test_type   | No       | `Practice` (default) or `Full-test`                                                                                                    |
| test_code   | No       | String or `null`; provider default is `null`                                                                                           |
| transcript  | No       | String or `null`; provider default is `null`                                                                                           |

The gateway rejects non-HTTPS schemes, non-approved hosts, non-default ports,
embedded credentials, fragments, and any URL longer than 2,048 characters. It
does not resolve or download the URL. The JSON request body is capped at 256
KiB. AI Speaking owns retrieval, does not
follow redirects, enforces the 25 MiB downloaded-audio ceiling, and must finish
retrieval and grading within the shared 30-second operation deadline.
These provider-side guarantees are not enforceable by AIHUB while it deliberately
avoids fetching customer URLs. The authenticated Production JSON smoke recorded
in #28 on 2026-09-15 used a real WAV object on `s3.wispace.app` and returned the
normalized response through AIHUB. It proves the end-to-end retrieval path;
no-redirect, downloaded-audio ceiling, and deadline behavior remain obligations
of the AI Speaking service under this contract.

### Derived and server-only values

| Value                      | Source                                               | Public request field? |
| -------------------------- | ---------------------------------------------------- | --------------------- |
| user_id                    | End-User ID from X-User-Identity                     | No                    |
| AI Speaking service origin | DOWNSTREAM_AI_SPEAKING_URL                           | No                    |
| x-client-id                | DOWNSTREAM_AI_SPEAKING_CLIENT_ID or secret provider  | No                    |
| x-secret-key               | DOWNSTREAM_AI_SPEAKING_SECRET_KEY or secret provider | No                    |

### Normalized public response data

| Group                                   | Required fields and constraints                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| question_id                             | Non-empty string                                                                                                                              |
| test_type                               | Optional string or null                                                                                                                       |
| scorability                             | is_scorable boolean; confidence string; display_band boolean; message_vi string or null                                                       |
| estimated_band                          | overall, fluency_coherence, lexical_resource, grammatical_range_accuracy, pronunciation; each number 0–9 in 0.5 steps                         |
| transcript                              | text string; word_count integer >= 0; duration_seconds number >= 0                                                                            |
| relevance                               | on_topic boolean; score 0–1; feedback_vi string or null                                                                                       |
| fluency_metrics                         | Object or `null`; speech_rate_wpm, pause_count, mean_length_run_words are each non-negative or null                                           |
| pronunciation_detail                    | summary counts (good_count, fair_count, poor_count), each integer >= 0, and words array                                                       |
| pronunciation_detail.words[]            | word, quality_score 0–100, quality_class, syllables[], phonemes[]                                                                             |
| syllables[]                             | letters, nullable stress_level 0–2, nullable predicted_stress 0–2, stress_score 0–100, quality_score 0–100, non-negative audio_extent_ms pair |
| phonemes[]                              | phone, quality_score 0–100, sound_most_like, nullable stress_level 0–2, non-negative audio_extent_ms pair, non-negative char_index[]          |
| language_analysis.grammar_errors[]      | sentence, error_segment, correction, error_type, explanation_vi                                                                               |
| language_analysis.vocabulary_upgrades[] | original_word, suggested_word, cefr_level, optional context, reason_vi                                                                        |
| feedback                                | summary_vi, strong_point_vi, action_plan_vi                                                                                                   |

## 7. Detailed AI Speaking service errors

| Service status | Meaning                                          | AIHUB behavior                                                   |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| 400            | Invalid or missing metadata/audio                | Map to shared service error; do not expose detail                |
| 401            | Missing or invalid downstream credentials        | Map to shared service error; investigate server configuration    |
| 413            | AI Speaking service audio/request limit exceeded | Map to shared service error; AIHUB boundary 413 remains distinct |
| 422            | Downstream parameter/schema validation failure   | Map to shared service error; do not expose detail                |
| 429            | Downstream throttling                            | Map to AI_SERVICE_THROTTLED                                      |
| 5xx            | Downstream or pipeline failure                   | Map to retryable AI_SERVICE_ERROR                                |

The AI Speaking service may return machine-readable diagnostic detail, but it is
never returned to clients or logged raw. Internal telemetry may retain only
sanitized private_endpoint, downstream_status, downstream_error_code, and
downstream_ms fields. Credential headers, raw audio, raw responses, assertions,
and private identifiers are redacted or excluded.

## 8. Public error shape

Every public error uses the shared envelope:

    {
      "error": {
        "code": "AI_SERVICE_TIMEOUT",
        "message": "AI service did not respond in time",
        "request_id": "generated-by-aihub",
        "retryable": true,
        "retry_after_ms": 2000
      }
    }

retry_after_ms is optional and is carried in the body, not a Retry-After
header. Clients branch on code, never on message text. Messages never expose
stack traces, internal URLs, database messages, service detail, credentials,
assertions, audio, or raw downstream bodies.

retryable describes whether a transient retry could help; it does not promise
that a retry is safe. Speaking has no idempotent replay.

## 9. Error matrix

| Boundary or condition                                        | HTTP | Public code                   | Retryable                  |
| ------------------------------------------------------------ | ---: | ----------------------------- | -------------------------- |
| Invalid multipart, unknown/duplicate field, invalid metadata |  400 | INVALID_REQUEST               | No                         |
| Missing/unknown/expired AIHUB API key                        |  401 | UNAUTHORIZED                  | No                         |
| Missing user identity                                        |  401 | USER_IDENTITY_REQUIRED        | No                         |
| Invalid user assertion                                       |  401 | INVALID_USER_IDENTITY         | No                         |
| Key lacks speaking.grade                                     |  403 | FORBIDDEN                     | No                         |
| Key not valid for environment                                |  403 | ENVIRONMENT_NOT_ALLOWED       | No                         |
| Route not found                                              |  404 | NOT_FOUND                     | No                         |
| AIHUB multipart wire body over 26 MiB or audio over 25 MiB   |  413 | PAYLOAD_TOO_LARGE             | No                         |
| Organization rate limit exceeded                             |  429 | RATE_LIMITED                  | Yes                        |
| Organization concurrency limit exceeded                      |  429 | CONCURRENCY_LIMIT             | Yes                        |
| Shared quota exhausted, if enabled                           |  429 | QUOTA_EXCEEDED                | Policy-dependent           |
| Duplicate/in-flight idempotency key                          |  409 | IDEMPOTENCY_CONFLICT          | Not emitted by Speaking v1 |
| AI Speaking service 4xx, including 400/401/413               |  502 | AI_SERVICE_ERROR              | No                         |
| AI Speaking service 5xx                                      |  502 | AI_SERVICE_ERROR              | Yes                        |
| AI Speaking service 2xx fails normalized contract            |  502 | AI_SERVICE_CONTRACT_VIOLATION | No                         |
| AI Speaking service throttling (429)                         |  503 | AI_SERVICE_THROTTLED          | Yes                        |
| AI Speaking service unreachable                              |  503 | AI_SERVICE_UNAVAILABLE        | Yes                        |
| Organization JWKS unavailable                                |  503 | IDENTITY_PROVIDER_UNAVAILABLE | Yes                        |
| Speaking deadline exceeded                                   |  504 | AI_SERVICE_TIMEOUT            | Yes, but not replay-safe   |
| Unexpected AIHUB failure                                     |  500 | INTERNAL_ERROR                | No                         |

AI Speaking service 401 is deliberately not public UNAUTHORIZED: the client credential
was already accepted, and the failure is at the server-to-service boundary.
AI Speaking service 413 is deliberately not AIHUB PAYLOAD_TOO_LARGE.
The unavailable mapping covers transport/reachability failures; D2 has no
circuit-breaker implementation.

## 10. Operational and security notes

- The operation has one 60-second deadline covering upload and downstream
  network time. Cancellation follows the client connection and aborts the
  downstream call.
- Clients should configure a request timeout of at least 90 seconds to allow
  the 60-second server deadline plus upload and response transit.
- AIHUB does not add automatic retries inside this request path. A client
  retry can start another grading run; use it only when duplicate grading is
  acceptable.
- Rate and concurrency protection use shared AIHUB guards. Speaking v1 has no
  durable idempotency record or replay response.
- AI Speaking service origin and credentials are environment-specific server
  configuration. Clients cannot choose hosts or credentials.
- Logs contain request ids, non-sensitive status categories, and only the
  sanitized downstream telemetry named in section 7. API keys, assertions,
  internal tokens, audio, essays, credentials, and raw downstream responses
  never enter logs.
- Health, deployment, and rollback procedures follow the existing operations
  runbook. Credential rotation is an operational configuration change, not a
  public contract field.
- Metering, durable usage records, billing, object storage, async workers,
  polling, and result retention are outside D2.
- The contract must be identical across Dev and Production. Current evidence is
  the authenticated Production smoke accepted as the Dev-gate substitute in
  #24 and the Production handoff smoke recorded in #25; a future Dev environment
  check is separate follow-up work.
- JSON-by-URL grading is a synchronous fallback at
  `POST /v1/ielts/speaking/grading-json`; it validates an approved URL but does
  not download it. The asynchronous Speaking grading job remains a separate
  roadmap contract.
- Breaking changes to field types, ranges, nullability, enums, or error
  semantics require a new version and role-owned review. The executable
  schema, redacted fixture, tests, generated artifacts, and this TSD must be
  updated together before approval.
- This Approved TSD is the shared human vocabulary for generated Postman
  artifacts, the test UI, Production smoke, and Deli 3 endpoint expansion;
  executable schemas remain the machine-readable source of truth.

## Traceability and review

| TSD section                   | Executable behavior                                                                              | Fixture evidence                                                 | Smoke evidence                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------ |
| 1. Endpoint/base URL          | src/catalog/operation-catalog.ts; speaking controller                                            | N/A — transport configuration                                    | #25 Production handoff smoke (200)               |
| 2. Naming                     | src/catalog/operation-catalog.ts                                                                 | N/A — catalog metadata                                           | #25 operation handoff                            |
| 3. Request headers            | speaking controller; multipart parser                                                            | N/A — request metadata                                           | #25 authenticated request                        |
| 4. Response envelope          | src/contracts/speaking/grading.ts; shared envelope filter                                        | grading.response.json (redacted)                                 | #25 public 200 response                          |
| 5. Mapper rules               | speaking-grading.adapter.ts; speaking-grading-response.adapter.ts                                | grading.response.json (redacted shape)                           | #25 forwarded grading request                    |
| 6. Data dictionary            | speaking schema; fastify-speaking-multipart.parser.ts                                            | grading.response.json (normalized groups)                        | #25 valid audio/metadata request                 |
| 7. AI Speaking service errors | http-operation-dispatcher.ts; dispatcher tests                                                   | N/A — status mappings                                            | #25 success boundary; negative paths automated   |
| 8. Public error shape         | common error envelope/filter                                                                     | N/A — error envelope                                             | #25 response envelope; negative paths automated  |
| 9. Error matrix               | dispatcher; error-code registry; controller tests                                                | N/A — status mappings                                            | #25 production handoff; negative paths automated |
| 10. Operational/security      | request-lifecycle hook; deadline/cancellation dispatcher; per-route body limits; redaction tests | Redacted fixture contains no secrets/audio                       | #25 accepted Production smoke                    |
| JSON-by-URL extension         | JSON schema, URL policy, catalog, JSON adapter/controller                                        | Same redacted fixture; provider JSON fixture has the same schema | #28 authenticated Production JSON smoke          |

| Review role               | Status   | Owner                     | Review date | Follow-up date |
| ------------------------- | -------- | ------------------------- | ----------- | -------------- |
| AIHUB Tech Lead           | Approved | AIHUB Tech Lead           | 2026-09-14  | N/A — approved |
| AI Speaking service owner | Approved | AI Speaking service owner | 2026-09-14  | N/A — approved |
| WISPACE integration owner | Approved | WISPACE integration owner | 2026-09-14  | N/A — approved |

| Review item                                    | Owner role                | Follow-up date      | Status                                                    |
| ---------------------------------------------- | ------------------------- | ------------------- | --------------------------------------------------------- |
| Redacted fixture and normalized scoring groups | AI Speaking service owner | N/A — approved      | Resolved                                                  |
| Error matrix and integration handoff           | WISPACE integration owner | N/A — approved      | Resolved                                                  |
| JSON URL retrieval/no-redirect/25 MiB/30s gate | AI Speaking service owner | Contract operations | Production smoke passed; provider-owned guarantees remain |

This TSD is Approved based on the service owner and WISPACE approvals
confirmed on 2026-09-14. Any future unresolved point must name one role owner
and a follow-up date before a version change is approved.

The older docs/aihub_long_term_architecture.md contains a conflicting
async/JSON and 10 MB media description. For this D2 slice, the implementation
specification, executable schema, fixture, and this TSD take precedence; the
legacy conflict is recorded rather than silently changing the older document.
