# AIHUB Integration Guide

For engineers connecting a backend to the AIHUB API. It covers the parts an
OpenAPI document cannot express: who holds which credential, how to sign user
assertions, and how to handle retries, timeouts, and errors.

The endpoint reference lives at `GET /docs`, generated from the same schemas
the server validates against. This guide is the surrounding context.

---

## 1. How the pieces fit

AIHUB sits between your backend and the private AI services. Your end users
never talk to AIHUB directly.

```text
Your user  →  your app  →  YOUR BACKEND  →  AIHUB  →  AI service
                           ↑
                           API key lives here, and nowhere else
```

Two credentials travel on every graded request, and they answer different
questions:

| Header             | Answers                       | Who creates it         |
| ------------------ | ----------------------------- | ---------------------- |
| `X-API-Key`        | Which organization is calling | AIHUB issues it to you |
| `X-User-Assertion` | Which of your users is acting | You sign it yourself   |

**The API key must stay on your server.** Embedding it in a mobile app, a
single-page app, or anything else a user can read hands your organization's
credential to that user. AIHUB has no way to detect this, and rate limits,
quotas, and billing are all attributed to the key.

Your users sign in to _your_ system, however you already do it — password,
Google, SSO. AIHUB has no login, no user accounts, and no sessions. It learns
who the user is only from the assertion your backend signs.

---

## 2. Before your first call

AIHUB gives you:

- an organization id (`org_...`)
- an API key (`aihub_sk_...`), shown **once** at creation time
- the base URL for your environment

You give AIHUB:

- an **issuer** string identifying your organization, conventionally a URL you
  control, e.g. `https://acme.edu`
- a **JWKS URL** serving your public keys, e.g.
  `https://acme.edu/.well-known/jwks.json`

Only the public half of your signing key ever leaves your infrastructure.
AIHUB verifies assertions but cannot create them — by design, so a compromise
of AIHUB cannot impersonate your users.

If you cannot host a JWKS endpoint, you may send the JWKS document itself and
AIHUB will store it. Prefer the URL: it lets you rotate keys without
contacting us.

### Storing the API key

It is shown once and stored only as a SHA-256 hash. AIHUB cannot recover it.
Keep it in your secret manager, never in source control. If it leaks, ask for
a revoke and a replacement; revocation takes effect immediately.

---

## 3. Signing a user assertion

An assertion is a short-lived JWT your backend signs immediately before
calling AIHUB. It is not a session token: do not cache it for long, and never
send it to a browser or mobile client.

### Required claims

| Claim | Value                  | Notes                                       |
| ----- | ---------------------- | ------------------------------------------- |
| `iss` | Your registered issuer | Must match exactly, character for character |
| `aud` | `"aihub"`              | Constant                                    |
| `sub` | Your user's id         | Any stable string, max 256 characters       |
| `jti` | A fresh unique id      | One per assertion; a UUID is fine           |
| `iat` | Issued-at, seconds     | Must not be more than 60s in the future     |
| `exp` | Expiry, seconds        | Lifetime capped at 300s by default          |

Header must carry `alg` (`RS256` or `ES256`) and `kid` matching a key in your
JWKS.

`HS256` and `alg: none` are rejected. So is a `kid` that matches more than one
usable key in your JWKS.

### Node.js

```js
import { SignJWT, importPKCS8 } from "jose";
import { randomUUID } from "node:crypto";

const privateKey = await importPKCS8(process.env.SIGNING_KEY_PEM, "RS256");

export async function mintAssertion(userId) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "acme-2026-01" })
    .setIssuer("https://acme.edu")
    .setAudience("aihub")
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}
```

### Python

```python
import time, uuid, jwt  # PyJWT

def mint_assertion(user_id: str) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": "https://acme.edu",
            "aud": "aihub",
            "sub": user_id,
            "jti": str(uuid.uuid4()),
            "iat": now,
            "exp": now + 300,
        },
        PRIVATE_KEY_PEM,
        algorithm="RS256",
        headers={"kid": "acme-2026-01"},
    )
```

### Java

```java
// com.nimbusds:nimbus-jose-jwt
var claims = new JWTClaimsSet.Builder()
    .issuer("https://acme.edu")
    .audience("aihub")
    .subject(userId)
    .jwtID(UUID.randomUUID().toString())
    .issueTime(new Date())
    .expirationTime(new Date(System.currentTimeMillis() + 300_000))
    .build();

var jwt = new SignedJWT(
    new JWSHeader.Builder(JWSAlgorithm.RS256).keyID("acme-2026-01").build(),
    claims);
jwt.sign(new RSASSASigner(privateKey));
String assertion = jwt.serialize();
```

### Which calls need one

Grading operations are user-scoped and require an assertion. Question
generation is organization-scoped and does not.

Sending an assertion where none is required is allowed — but it must still be
valid. AIHUB will not ignore a malformed one, because silently accepting
broken assertions hides integration bugs until they matter.

### Rotating keys

1. Publish the new public key in your JWKS, alongside the old one. Keep
   signing with the old key.
2. Wait at least 20 minutes so AIHUB's cache refreshes.
3. Start signing with the new key.
4. Wait until every assertion signed with the old key has expired.
5. Remove the old public key from your JWKS.

No coordination with AIHUB is needed. If AIHUB sees a `kid` it does not know,
it refetches your JWKS once — rate-limited to once every five minutes per
organization, so publish first and switch second.

---

## 4. Endpoints

Base path: `/v1/ielts/writing`. All operations are `POST` with
`Content-Type: application/json`.

| Path               | Assertion | `Idempotency-Key` | Max body | Timeout |
| ------------------ | --------- | ----------------- | -------: | ------: |
| `/task1/questions` | No        | Not used          |     8 KB |     10s |
| `/task2/questions` | No        | Optional          |     8 KB |     30s |
| `/task1/grade`     | **Yes**   | **Required**      |   256 KB |     60s |
| `/task2/grade`     | **Yes**   | **Required**      |   256 KB |     60s |

### Enumerated values

`chart_type` (Task 1) is case-sensitive and must be one of:
`Bar Chart`, `Line Graph`, `Pie Chart`, `Table`, `Map`, `Process Diagram`,
`Multiple Graphs`.

`question_type` (Task 2): `opinion`, `discussion`, `problem_solution`,
`advantages_disadvantages`, `two_part`.

`language` is optional and currently accepts `vi` only. Feedback is returned
in Vietnamese.

### A worked pair of calls

Generate a question:

```bash
curl -X POST https://api.example.com/v1/ielts/writing/task1/questions \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"chart_type": "Bar Chart"}'
```

```json
{
  "data": {
    "question_id": "85f98a4d-bbcb-4ccf-927c-8988aa623306",
    "question": "The graph shows estimated oil production capacity...",
    "chart_type": "Bar Chart",
    "image_url": "https://s3.example.com/ielts-task1/e9c9b064969b6492"
  },
  "meta": {
    "request_id": "req_01M23NTNTAMPQXEQAFAVBCVPS7",
    "service": "writing",
    "operation": "writing.task1.question.generate",
    "timing": {
      "downstream_ms": 660,
      "gateway_overhead_ms": 3,
      "total_ms": 663
    }
  }
}
```

Then grade an essay written against it. Three of the four required fields come
straight from the response above:

```bash
curl -X POST https://api.example.com/v1/ielts/writing/task1/grade \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Assertion: $ASSERTION" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "question": "The graph shows estimated oil production capacity...",
        "chart_type": "Bar Chart",
        "image_url": "https://s3.example.com/ielts-task1/e9c9b064969b6492",
        "essay": "The bar chart illustrates..."
      }'
```

The grading response carries `overall_band`, exactly four `criteria` entries in
a fixed order, `summary`, `suggestions`, `next_steps`, and `annotations` that
quote the essay. Bands are whole or half numbers between 0 and 9. See `/docs`
for the full schema.

---

## 5. The response envelope

Every successful response has the same shape:

```json
{ "data": {}, "meta": {} }
```

`data` is the operation's own contract. `meta` is identical everywhere:

| Field                        | Meaning                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `request_id`                 | AIHUB's id for this request. **Quote it in any support request** |
| `correlation_id`             | Echoed from your `X-Correlation-Id` header, if you sent one      |
| `service`, `operation`       | What ran                                                         |
| `timing.downstream_ms`       | Time the AI service took                                         |
| `timing.gateway_overhead_ms` | Time AIHUB added                                                 |
| `timing.total_ms`            | Total                                                            |

Send `X-Correlation-Id` with your own trace id to stitch your logs to ours.

Unknown fields in a request body are rejected rather than ignored, so a typo
fails loudly instead of being silently dropped.

---

## 6. Idempotency

Grading costs money and takes up to a minute. `Idempotency-Key` makes a retry
safe: the same key returns the stored result instead of grading again.

- Generate one key per logical submission — a UUID works.
- Reuse the **same** key when retrying that submission. A new key means a new
  grading run and a second charge.
- Keys are scoped to your organization and the operation. Records are kept for
  24 hours.
- A replayed response carries the header `Idempotent-Replay: true` and
  `timing.downstream_ms: 0`.

Reusing a key with a **different** body returns `409 IDEMPOTENCY_CONFLICT`.
That is deliberate: silently returning the earlier result for a different
essay would be worse than an error.

Two requests with the same key arriving at once are collapsed into one
downstream call; the second waits for the first.

Client errors are not stored. If a request fails validation, you may fix the
body and reuse the same key.

---

## 7. Timeouts and cancellation

Grading may take up to 60 seconds. **Set your client timeout to at least 90
seconds** for `/grade` calls. A 30-second client timeout is the most common
integration mistake here.

AIHUB's per-operation budget is a single clock: it is set when the request
arrives and is consumed as the request travels. It does not restart at any
layer.

If you disconnect early, AIHUB cancels the downstream call rather than letting
it finish for nobody — with one exception. If your request carried an
`Idempotency-Key` and the timeout was ours, the AI service is allowed to finish
in the background and its result is stored. You will get `504`, but retrying
with the same key returns the finished result without paying for a second run.

---

## 8. Errors

Every error has the same shape, and never leaks stack traces, internal URLs,
or database messages:

```json
{
  "error": {
    "code": "AI_SERVICE_TIMEOUT",
    "message": "AI service did not respond in time",
    "request_id": "req_01M23NT8MJW22AYX6FVT17F5XF",
    "retryable": true,
    "retry_after_ms": 2000
  }
}
```

**Branch on `code`, never on `message`.** Messages may be reworded; codes are
part of the contract. `retryable` tells you whether a retry can possibly help,
so you do not have to infer it from the status.

When present, `retry_after_ms` is in the body, not in a `Retry-After` header.

| HTTP | Code                            | What happened                                                    | What to do                                          |
| ---: | ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- |
|  400 | `INVALID_REQUEST`               | Body failed validation, or carried an unknown field              | Fix the request. Retrying is pointless              |
|  401 | `UNAUTHORIZED`                  | Missing, unknown, revoked, or expired API key                    | Check the credential                                |
|  401 | `USER_ASSERTION_REQUIRED`       | User-scoped operation called without an assertion                | Send `X-User-Assertion`                             |
|  401 | `INVALID_USER_ASSERTION`        | Bad signature, expired, wrong `iss`/`aud`, unknown `kid`         | Mint a fresh assertion; check issuer and JWKS       |
|  403 | `FORBIDDEN`                     | Key lacks the scope for this operation                           | Ask AIHUB to widen the key                          |
|  403 | `ENVIRONMENT_NOT_ALLOWED`       | Key is not valid for this environment                            | Use the key issued for that environment             |
|  404 | `NOT_FOUND`                     | No such route                                                    | Check path and method                               |
|  409 | `IDEMPOTENCY_CONFLICT`          | Same key, different body — or the first attempt is still running | Use a new key, or wait and retry the identical body |
|  413 | `PAYLOAD_TOO_LARGE`             | Body exceeded the operation's limit                              | Shorten the essay                                   |
|  429 | `RATE_LIMITED`                  | Too many requests per minute                                     | Back off for `retry_after_ms`, then retry           |
|  429 | `CONCURRENCY_LIMIT`             | Too many requests in flight at once                              | Reduce parallelism; retry in ~500ms                 |
|  429 | `QUOTA_EXCEEDED`                | Monthly quota exhausted                                          | Wait for the reset, or upgrade                      |
|  502 | `AI_SERVICE_ERROR`              | AI service returned an error                                     | Retry later if `retryable` is true                  |
|  502 | `AI_SERVICE_CONTRACT_VIOLATION` | AI service returned an unexpected shape                          | Do not retry. Report it with the `request_id`       |
|  503 | `AI_SERVICE_THROTTLED`          | AI service is throttling                                         | Back off and retry                                  |
|  503 | `AI_SERVICE_UNAVAILABLE`        | AI service unreachable                                           | Retry with backoff                                  |
|  503 | `IDENTITY_PROVIDER_UNAVAILABLE` | **Your** JWKS endpoint could not be reached                      | Check your own JWKS endpoint. The API key is fine   |
|  504 | `AI_SERVICE_TIMEOUT`            | Grading exceeded the budget                                      | Retry with the **same** `Idempotency-Key`           |
|  500 | `INTERNAL_ERROR`                | Fault on our side                                                | Retry later; report with the `request_id`           |

`IDENTITY_PROVIDER_UNAVAILABLE` is worth singling out. It is a `503`, not a
`401`, because nothing is wrong with your API key — AIHUB simply could not
fetch your public keys. Regenerating credentials will not help.

### Retry policy that works

- Retry only when `retryable` is `true`.
- Use exponential backoff with full jitter — random between zero and the cap,
  not a fixed delay. Fixed delays make every client retry in lockstep and
  knock the service over again just as it recovers.
- Cap at two or three attempts.
- Always resend the same `Idempotency-Key` when retrying a grade.

### Rate limit and concurrency are different problems

`RATE_LIMITED` counts requests per minute: **slow down**.

`CONCURRENCY_LIMIT` counts requests running at the same moment: **reduce
parallelism**. Your total per minute may be well within limits while thirty
essays grade simultaneously. The fix is a queue with a bounded worker pool,
not a longer delay.

---

## 9. Integration checklist

- [ ] API key stored server-side in a secret manager, never in a client build
- [ ] Signing private key never leaves your infrastructure
- [ ] JWKS endpoint publicly reachable over HTTPS, or JWKS document sent to AIHUB
- [ ] Assertions minted per request, ≤ 300s lifetime, with a fresh `jti`
- [ ] `Idempotency-Key` generated per submission and reused across retries
- [ ] Client timeout ≥ 90s for grading calls
- [ ] Error handling branches on `code`, not on `message` or status alone
- [ ] Retries limited to `retryable: true`, with jittered backoff
- [ ] `request_id` logged for every call, and `X-Correlation-Id` sent
- [ ] Bounded parallelism for grading

---

## 10. Getting help

Include the `request_id` from `meta` or from the error body. It identifies the
exact request in AIHUB's logs, including its timings and which AI service was
involved. Without it, a report is hard to trace.

Essay text, API keys, and assertions never appear in AIHUB logs, so a
`request_id` is the only handle we have.
