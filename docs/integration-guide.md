# AIHUB Customer Integration Guide

For engineers connecting a backend to the AIHUB API. It covers the parts an
OpenAPI document cannot express: who holds which credential, how to sign user
assertions, and how to handle retries, timeouts, and errors.

The endpoint reference lives at `GET /docs`, generated from the same schemas
the server validates against. This guide is the surrounding context.

Before making production calls, complete the onboarding flow in section 2. The
short version is: AIHUB issues an organization API key, your backend publishes
the public key material used to verify your assertions, both sides verify the
integration in staging, and only then do you switch to the production base URL
and production credential. The signing private key always stays in your
infrastructure.

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

### Onboarding lifecycle

AIHUB and your team complete these steps in order:

1. **Choose the capabilities and environment.** Tell AIHUB which operations you
   need (`writing.grade`, `speaking.grade`, or both) and whether the request is
   for staging or production. Do not build a client around a production
   credential before staging has passed.
2. **AIHUB creates the organization and API credential.** AIHUB creates or
   confirms your organization, enables the requested entitlements, and issues an
   API key with explicit environment and scope permissions. The raw key is shown
   once. Store it in your server-side secret manager immediately.
3. **You provide signing identity metadata.** Send AIHUB the exact issuer and
   either a publicly reachable HTTPS JWKS URL or the public JWKS document. AIHUB
   registers this identity configuration against your organization. Never send a
   private key. Keep the issuer stable; if staging and production use different
   issuers or JWKS documents, tell AIHUB before registration because the identity
   configuration is part of the organization trust boundary.
4. **Run the staging verification.** Publish the JWKS, mint a short-lived
   assertion from your backend, and call each requested operation with the
   staging base URL and staging-authorized API key. Verify both a successful
   response and expected failures such as a missing assertion, an expired
   assertion, a wrong issuer, and an unknown `kid`.
5. **Approve production and switch credentials.** After staging passes, AIHUB
   confirms the production organization/key, scopes, and base URL. Change only
   environment configuration in your backend: use the production API key and
   base URL, keep the private signing key server-side, and send a fresh
   assertion. A staging key must never be used against production.

The onboarding is complete when AIHUB has confirmed the organization, scopes,
identity configuration, and environment-specific key, and your team has saved a
successful staging request id for support traceability.

### Information to send AIHUB

Send one onboarding record per organization. The issuer and JWKS values are
configuration, not headers that change from request to request.

| Item                   | Required value                               | Rule                                                                |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Organization name      | Your display or legal name                   | Used by AIHUB to identify the tenant                                |
| Capabilities           | `writing.grade`, `speaking.grade`, or both   | AIHUB maps these to entitlements and API-key scopes                 |
| Environment            | Staging or production                        | Keys are restricted to their allowed environment                    |
| Issuer (`iss`)         | Exact string, for example `https://acme.edu` | Must match the assertion character for character                    |
| JWKS URL               | HTTPS URL serving public keys                | Preferred; must be reachable by AIHUB without a private network hop |
| Public JWKS            | JWKS JSON document                           | Fallback when you cannot host a JWKS URL                            |
| Current key id (`kid`) | The `kid` used by your signer                | Must identify exactly one usable key in the JWKS                    |
| Signing algorithm      | `RS256` or `ES256`                           | `HS256` and `none` are rejected                                     |
| Technical contact      | Integration owner and incident contact       | Needed for staging failures and key rotation notices                |

You can use this template in the onboarding ticket. Leave credentials out of the
ticket:

```text
Organization name: <name>
Environment: staging
Capabilities: writing.grade, speaking.grade
Issuer: https://<your-domain>
JWKS URL: https://<your-domain>/.well-known/jwks.json
Current kid: <key-id>
Signing algorithm: RS256
Technical contact: <name and secure contact>
```

Do not send API keys, signing private keys, or user passwords in an email,
ticket, request body, or source repository. Exchange credentials through the
agreed secure channel and store them in a secret manager.

Identity registration is a control-plane onboarding action handled by AIHUB. It
is not a public grading call, and you do not send the issuer or JWKS as a
per-request header.

### What AIHUB gives you

- an organization id (`org_...`)
- an API key (`aihub_sk_...`), shown **once** at creation time
- the base URL for your environment
- the enabled capabilities, scopes, and environment binding for the key

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

### Staging and production rules

The API key determines the organization and is also restricted to one or more
allowed environments. The hostname determines the environment; clients do not
select it with a request header. Keep staging and production credentials in
separate secret-manager entries and configure the base URL alongside the
matching key.

The identity configuration is organization-owned. The normal setup uses the
same issuer and JWKS URL in both environments and changes only the API key and
base URL. If you need different signing identities for staging and production,
raise that before onboarding so AIHUB can register the correct organization
configuration; do not alternate `iss` values per request.

`DEMO_ASSERTION_ISSUER=https://demo.acme.edu`, `demo-private.pem`, and
`demo-jwks.json` belong only to the repository's local demo. They are not
production onboarding values and must never be copied into a customer
deployment.

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

All current grading operations - Writing Task 1, Writing Task 2, and Speaking -
are user-scoped and require an assertion. The `sub` claim is the only source of
learner identity that AIHUB trusts.

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

This procedure applies when AIHUB reads your JWKS URL. No per-rotation approval
is needed, but publish the new key before signing with its `kid`. If you use the
uploaded-JWKS fallback, send the updated public JWKS to AIHUB before step 3;
AIHUB cannot discover a new key from an old uploaded document.

If AIHUB sees a `kid` it does not know, it refetches a configured JWKS URL once
— rate-limited to once every five minutes per organization. Keep both keys
published during the overlap window, and notify your integration contact if the
issuer, JWKS URL, algorithm, or rotation process itself changes.

---

## 3a. The sandbox, for testing without a signing key

Everything in section 3 assumes you are the one signing. If you are exercising
AIHUB from a terminal or a test console rather than from your own backend,
there is a sandbox that signs for you.

**This is not how you integrate.** A customer with a backend signs assertions
from their own identity provider, exactly as described above, and never calls
this route. The sandbox exists so that people testing AIHUB do not have to hold
an organization's private key to do it.

It runs on its own hostname and its own environment, with its own organization
and its own API keys. A sandbox key is refused on the production hostname and a
production key is refused on the sandbox hostname, both with
`ENVIRONMENT_NOT_ALLOWED`.

### Minting

```bash
curl -sS -X POST 'https://sandbox.aihubproduction.com/v1/sandbox/assertions'   -H "X-API-Key: $SANDBOX_API_KEY"   -H 'Content-Type: application/json'   -d '{"user_id":"student_456"}'
```

```json
{
  "data": {
    "assertion": "eyJhbGciOiJSUzI1NiIsImtpZCI6InNhbmRib3gtMjAyNi0wOSJ9...",
    "user_id": "student_456",
    "expires_at": 1789610600
  },
  "meta": { "request_id": "req_01M2PE7DDP2B6SM85DY0ENPWMC" }
}
```

`user_id` is the only thing you choose. Issuer, audience, algorithm, key id,
organization, and lifetime are all decided server-side — a sandbox assertion
cannot be aimed at an organization you do not own. `expires_at` is seconds since
the epoch; sandbox assertions last an hour rather than the five minutes a
production tenant is capped at.

Only API keys belonging to the sandbox organization may mint. Every other key is
refused, and a deployment with no sandbox configured answers `404`.

### Using it

The assertion goes into `X-User-Assertion` on a normal grading call, against the
sandbox hostname:

```bash
ASSERTION=$(curl -sS -X POST 'https://sandbox.aihubproduction.com/v1/sandbox/assertions'   -H "X-API-Key: $SANDBOX_API_KEY" -H 'Content-Type: application/json'   -d '{"user_id":"student_456"}' | python -c 'import json,sys; print(json.load(sys.stdin)["data"]["assertion"])')

curl -sS -X POST 'https://sandbox.aihubproduction.com/v1/ielts/speaking/grading'   -H "X-API-Key: $SANDBOX_API_KEY"   -H "X-User-Assertion: $ASSERTION"   -F 'audio=@/path/to/sample.wav'   -F 'part=1'   -F 'question_id=p1_hometown'   -F 'prompt_text=Do you enjoy living in your hometown?'   -F 'test_type=Practice'
```

Note the path. Grading operations live under `/v1/ielts/...`, not `/v1/...`;
`/v1/speaking/grading` is a 404 and is a common first mistake.

### It is not free

Sandbox requests reach the same AI services as production traffic and cost the
same money. The sandbox organization carries a monthly request quota with a hard
stop, plus a low rate limit and concurrency ceiling, so exceeding it returns
`QUOTA_EXCEEDED` rather than running up a bill. Treat it as a small budget for
hand-testing, not a free tier.

Usage is metered exactly as production usage is, and recorded against the
sandbox environment.

---

## 4. Endpoints

All public grading operations are `POST` routes. Writing and Speaking
JSON-by-URL use `Content-Type: application/json`; Speaking file grading uses
`multipart/form-data`.

| Path                              | Assertion | `Idempotency-Key` | Max body | Timeout |
| --------------------------------- | --------- | ----------------- | -------: | ------: |
| `/v1/ielts/writing/task1/grade`   | **Yes**   | **Required**      |   256 KB |     60s |
| `/v1/ielts/writing/task2/grade`   | **Yes**   | **Required**      |   256 KB |     60s |
| `/v1/ielts/speaking/grading`      | **Yes**   | **None**          |   26 MiB |     60s |
| `/v1/ielts/speaking/grading-json` | **Yes**   | **None**          |   256 KB |     30s |

One route is not a grading operation and appears here only so the list is
complete:

| Path                     | Assertion | `Idempotency-Key` | Notes                               |
| ------------------------ | --------- | ----------------- | ----------------------------------- |
| `/v1/sandbox/assertions` | **No**    | **None**          | Sandbox organization only — see §3a |

It takes an API key and no assertion, because issuing one is what it does.

### Enumerated values

`chart_type` (Task 1) is case-sensitive and must be one of:
`Bar Chart`, `Line Graph`, `Pie Chart`, `Table`, `Map`, `Process Diagram`,
`Multiple Graphs`.

`language` is optional and currently accepts `vi` only. Feedback is returned
in Vietnamese.

### A worked grading call

Supply the prompt and essay from your own application:

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

### Speaking grading

`POST /v1/ielts/speaking/grading` accepts one audio file and the fields below. The
route is synchronous, user-scoped, and does not currently provide an
idempotent replay. A client retry can therefore start another grading run.

| Field         | Required | Rule                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `audio`       | Yes      | One `wav`, `mp3`, `m4a`, `webm`, or `ogg` file; at least 100 bytes and at most 25 MiB |
| `part`        | Yes      | Integer `1`, `2`, or `3`                                                              |
| `question_id` | Yes      | Non-empty question-bank identifier                                                    |
| `prompt_text` | No       | Prompt used for relevance analysis                                                    |
| `test_type`   | No       | For example `Practice` or `Full-test`                                                 |
| `test_code`   | No       | Identifier shared by questions in one full test                                       |
| `transcript`  | No       | Existing transcript when the provider supports skipping STT                           |

The multipart request itself is capped at 26 MiB, so a full 25 MiB audio file
fits together with its multipart framing. The 25 MiB file cap mirrors the AI
Speaking service's own limit.

Send the learner identity only through `X-User-Assertion`; do not send a
`user_id` form field. AIHUB derives the downstream identity from the verified
`sub` claim. The response uses the common `{ "data", "meta" }` envelope; see
`/docs` for the complete Speaking response schema.

`POST /v1/ielts/speaking/grading-json` is the URL fallback. It accepts the same
Speaking metadata but replaces `audio` with `audio_url`. The URL must be HTTPS
on the exact host `s3.wispace.app`, may include query parameters for a
signed object URL, and may be at most 2,048 characters. AIHUB rejects embedded
credentials, fragments, other hosts/schemes/ports, and unknown fields before
dispatch. AIHUB validates but does not download the URL; the provider owns
retrieval and does not follow redirects.

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/speaking/grading-json" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Assertion: $AIHUB_ASSERTION" \
  -H 'Content-Type: application/json' \
  -d '{
    "audio_url": "https://s3.wispace.app/audio/sample.mp3?signature=demo",
    "part": 1,
    "question_id": "p1_hometown",
    "prompt_text": "Do you enjoy living in your hometown?",
    "test_type": "Practice"
  }'
```

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

Writing grading costs money and can take up to a minute. For Writing,
`Idempotency-Key` makes a retry safe: the same key returns the stored result
instead of grading again. The current Speaking multipart route has no
idempotency support, so avoid retrying it automatically unless your product can
accept another grading run.

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

If an identical request is already in flight, the second request returns
`409 IDEMPOTENCY_CONFLICT` immediately; AIHUB does not hold the connection open.
Wait for the first attempt to finish, then retry with the same key and identical
body. A successful first attempt is returned as a replay.

Client errors are not stored. If a request fails validation, you may fix the
body and reuse the same key.

---

## 7. Timeouts and cancellation

Writing grading has a 60-second AIHUB budget. **Set your client timeout to at
least 90 seconds** for Writing `/grade` calls. Speaking grading has a
60-second budget; use a client timeout of at least 90 seconds for
`/v1/ielts/speaking/grading`. The budget covers the upload too, so large files
on slow links need a proportionally larger client timeout. A client timeout
equal to the server budget is unsafe
because connection setup and response transfer also consume time.

AIHUB's per-operation budget is a single clock: it is set when the request
arrives and is consumed as the request travels. It does not restart at any
layer.

If you disconnect early, AIHUB cancels the downstream call rather than letting
it finish for nobody — with one Writing exception. If the Writing request
carried an `Idempotency-Key` and the timeout was ours, the AI service is allowed
to finish in the background and its result is stored. You will get `504`, but
retrying with the same key returns the finished result without paying for a
second run. Speaking has no such replay guarantee.

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

| HTTP | Code                            | What happened                                                                                | What to do                                                                                            |
| ---: | ------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
|  400 | `INVALID_REQUEST`               | Body failed validation, or carried an unknown field                                          | Fix the request. Retrying is pointless                                                                |
|  401 | `UNAUTHORIZED`                  | Missing, unknown, revoked, or expired API key                                                | Check the credential                                                                                  |
|  401 | `USER_ASSERTION_REQUIRED`       | User-scoped operation called without an assertion                                            | Send `X-User-Assertion`                                                                               |
|  401 | `INVALID_USER_ASSERTION`        | Bad signature, expired, wrong `iss`/`aud`, unknown `kid`                                     | Mint a fresh assertion; check issuer and JWKS                                                         |
|  403 | `IDENTITY_CONFIG_REQUIRED`      | Your Organization has no active user identity configuration                                  | Ask an owner to complete setup; if already configured, contact AIHUB support                          |
|  403 | `FORBIDDEN`                     | Key lacks the scope for this operation                                                       | Ask AIHUB to widen the key                                                                            |
|  403 | `ENVIRONMENT_NOT_ALLOWED`       | Key is not valid for this environment                                                        | Use the key issued for that environment                                                               |
|  404 | `NOT_FOUND`                     | No such route                                                                                | Check path and method                                                                                 |
|  409 | `IDEMPOTENCY_CONFLICT`          | Writing reused a key with a different body, or an identical Writing request is still running | Different body: use a new key; in-flight request: wait, then retry the same key and body              |
|  413 | `PAYLOAD_TOO_LARGE`             | Body exceeded the operation's limit                                                          | Shorten the essay                                                                                     |
|  429 | `RATE_LIMITED`                  | Too many requests per minute                                                                 | Back off for `retry_after_ms`, then retry                                                             |
|  429 | `CONCURRENCY_LIMIT`             | Too many requests in flight at once                                                          | Reduce parallelism; retry in ~500ms                                                                   |
|  429 | `QUOTA_EXCEEDED`                | Monthly quota exhausted                                                                      | Wait for the reset, or upgrade                                                                        |
|  502 | `AI_SERVICE_ERROR`              | AI service returned an error                                                                 | Retry later if `retryable` is true                                                                    |
|  502 | `AI_SERVICE_CONTRACT_VIOLATION` | AI service returned an unexpected shape                                                      | Do not retry. Report it with the `request_id`                                                         |
|  503 | `AI_SERVICE_THROTTLED`          | AI service is throttling                                                                     | Back off and retry                                                                                    |
|  503 | `AI_SERVICE_UNAVAILABLE`        | AI service unreachable                                                                       | Retry with backoff                                                                                    |
|  503 | `IDENTITY_PROVIDER_UNAVAILABLE` | **Your** JWKS endpoint could not be reached                                                  | Check your own JWKS endpoint. The API key is fine                                                     |
|  504 | `AI_SERVICE_TIMEOUT`            | Grading exceeded the budget                                                                  | Writing: retry with the **same** `Idempotency-Key`; Speaking: retry only if another run is acceptable |
|  500 | `INTERNAL_ERROR`                | Fault on our side                                                                            | Retry later; report with the `request_id`                                                             |

`IDENTITY_PROVIDER_UNAVAILABLE` is worth singling out. It is a `503`, not a
`401`, because nothing is wrong with your API key — AIHUB simply could not
fetch your public keys. Regenerating credentials will not help.

### Retry policy that works

- Retry only when `retryable` is `true`.
- Use exponential backoff with full jitter — random between zero and the cap,
  not a fixed delay. Fixed delays make every client retry in lockstep and
  knock the service over again just as it recovers.
- Cap at two or three attempts.
- Always resend the same `Idempotency-Key` when retrying a Writing grade; do not
  blindly retry Speaking.

### Rate limit and concurrency are different problems

`RATE_LIMITED` counts requests per minute: **slow down**.

`CONCURRENCY_LIMIT` counts requests running at the same moment: **reduce
parallelism**. Your total per minute may be well within limits while thirty
essays grade simultaneously. The fix is a queue with a bounded worker pool,
not a longer delay.

---

## 9. Integration checklist

### Customer onboarding

- [ ] Organization name, requested capabilities, and technical contact sent to AIHUB
- [ ] Staging and production base URLs recorded separately
- [ ] API key stored server-side in a secret manager, never in a client build
- [ ] Staging and production keys stored separately and used only with their allowed environment
- [ ] Signing private key never leaves your infrastructure
- [ ] Issuer agreed with AIHUB and copied exactly into the signer configuration
- [ ] JWKS endpoint publicly reachable over HTTPS, or public JWKS document sent to AIHUB
- [ ] Current `kid` and signing algorithm match exactly one usable JWKS key
- [ ] Staging assertion and at least one successful request verified before production access

### Every request

- [ ] Assertions minted per request, ≤ 300s lifetime, with a fresh `jti`
- [ ] `X-User-Assertion` contains the learner identity; no client-supplied `user_id` is sent
- [ ] `Idempotency-Key` generated per Writing submission and reused across retries
- [ ] Speaking audio is one supported file within the documented size limit
- [ ] Client timeout is ≥ 90s for Writing and ≥ 60s for Speaking
- [ ] Error handling branches on `code`, not on `message` or status alone
- [ ] Retries limited to `retryable: true`, with jittered backoff; do not blindly retry Speaking
- [ ] `request_id` logged for every call, and `X-Correlation-Id` sent
- [ ] Bounded parallelism for grading

### Key rotation and changes

- [ ] New public key published before any assertion uses its `kid`
- [ ] Old and new keys overlap until all old assertions have expired
- [ ] Issuer, JWKS URL, algorithm, or rotation changes reported to AIHUB
- [ ] Updated uploaded JWKS sent to AIHUB before switching keys when the URL fallback is used

---

## 10. Getting help

Include the `request_id` from `meta` or from the error body. It identifies the
exact request in AIHUB's logs, including its timings and which AI service was
involved. Without it, a report is hard to trace.

Essay text, API keys, and assertions never appear in AIHUB logs, so a
`request_id` is the only handle we have.
