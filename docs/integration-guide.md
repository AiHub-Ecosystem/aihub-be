# AIHUB Customer Integration Guide

For engineers connecting a backend to the AIHUB API. It covers the parts an
OpenAPI document cannot express: who holds which credential, how to identify
your end users (plainly or with signed assertions), and how to handle retries,
timeouts, and errors.

The endpoint reference lives at `GET /docs`, generated from the same schemas
the server validates against. This guide is the surrounding context.

Every grading request needs an `X-User-Identity` value, but a JWKS is optional.
Choose the identity mode saved for your Organization:

| Mode                  | When it applies                            | Value in `X-User-Identity`               | JWKS needed?                                      |
| --------------------- | ------------------------------------------ | ---------------------------------------- | ------------------------------------------------- |
| Declared User ID      | No active identity configuration           | Your stable user ID as plain text        | No                                                |
| Signed User Assertion | An owner has enabled identity verification | A short-lived JWT signed by your backend | Yes: configure a JWKS URL or public JWKS document |

Start with section 1a if you do not need signed verification. Read section 3
only when you choose Signed User Assertions. Section 2 explains the shared
onboarding steps and the optional signed-mode setup. The Customer Sandbox for
Writing is a separate environment with its own key and allowance; see section
3b.

---

## 1. How the pieces fit

AIHUB sits between your backend and the private AI services. Your end users
never talk to AIHUB directly.

```text
Your user  →  your app  →  YOUR BACKEND  →  AIHUB  →  AI service
                           ↑
                           API key lives here, and nowhere else
```

Two headers travel on every grading request, and they answer different
questions:

| Header            | Answers                       | Who creates it         |
| ----------------- | ----------------------------- | ---------------------- |
| `X-API-Key`       | Which organization is calling | AIHUB issues it to you |
| `X-User-Identity` | Which of your users is acting | Your backend sets it   |

**The API key must stay on your server.** Embedding it in a mobile app, a
single-page app, or anything else a user can read hands your organization's
credential to that user. AIHUB has no way to detect this, and rate limits,
quotas, and usage attribution depend on the key.

Your learners sign in to _your_ product, however you already do it — password,
Google, SSO, or another provider. AIHUB also has accounts and sessions for its
Organization control plane, but grading does not use those to identify your
learners. For grading, AIHUB gets the learner identity only from
`X-User-Identity`.

`X-User-Identity` is required on every grading request. Its value takes one of
two forms. Your Organization's saved identity configuration decides which one,
never the shape of the value:

| Your organization                | `X-User-Identity` carries                               |
| -------------------------------- | ------------------------------------------------------- |
| No active identity configuration | A **Declared User ID**: your own user id, as plain text |
| Active identity configuration    | A **Signed User Assertion**: a short-lived JWT you sign |

Without an active identity configuration, AIHUB treats the value as a Declared
User ID and does not need a JWKS. With an active configuration, AIHUB requires
a valid Signed User Assertion; a plain value is rejected with
`401 INVALID_USER_IDENTITY`. There is no fallback after signed verification is
enabled.

---

## 1a. Quick start: identify users without signing

A new Organization can grade as soon as it has an API key and the operation's
scope. If it has no active identity configuration, send your own stable
identifier for the end user in `X-User-Identity`:

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/writing/task2/grade" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Identity: student_456" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "question": "Should schools provide more arts education?",
        "topic": "education",
        "essay": "..."
      }'
```

Rules for a Declared User ID (the same rule applies to a signed assertion's
`sub`):

- 1-256 visible ASCII characters (`0x21`-`0x7E`), with no spaces.
- Compared exactly as sent: `Student@X.com` and `student@x.com` are two users.
  Send the same value for the same person every time.
- Prefer an opaque, stable id over an email address. AIHUB stores the value in
  usage records and forwards it to the AI services as-is, so an email address
  becomes personal data held by AIHUB.

**The trade-off.** AIHUB trusts a Declared User ID exactly as far as it trusts
your API key. Anyone holding the key can name any user in your Organization, so
usage attributed per user is only as reliable as your key handling. Other
Organizations are never affected: the Organization always comes from the API
key. Enable Signed User Assertions if you need AIHUB to verify that your
backend vouched for each user.

---

## 2. Before your first call

### Onboarding lifecycle

AIHUB and your team complete these steps in order:

1. **Choose the capabilities and environment.** Decide which operations you
   need (`writing.grade`, `speaking.grade`, or both) and whether you are setting
   up staging, production, or the separate Writing Sandbox in section 3b. Use a
   key authorized for that environment and scope.
2. **Create your Organization and API key.** Register an AIHUB account, then
   create your Organization through `POST /v1/organizations`. A new
   Organization receives every currently available capability, so no sales
   conversation or emailed request is needed. Create a key under
   `/v1/organizations/{organization_id}/api-keys`; a key is shown only once,
   so save it in your server-side secret manager immediately. Keep each
   environment's key and base URL paired. Inviting teammates and recovering
   access are self-serve too, so you only need an AIHUB administrator when
   you want commercial limits or an entitlement changed on an existing
   Organization.
3. **Choose an identity mode.** Declared User IDs need no identity
   configuration, issuer, signing key, or JWKS. To use Signed User Assertions,
   an active Organization owner configures the issuer and one public-key
   source, then your backend signs assertions with the corresponding private
   key. The configuration applies to the Organization in every environment;
   do not alternate issuer values between requests.
4. **Verify staging.** Make at least one successful request for each enabled
   operation with the staging key and base URL. Send a Declared User ID if the
   Organization has no active identity configuration; otherwise send a fresh
   Signed User Assertion. In signed mode, also check expected failures such as
   a missing or expired assertion, a wrong issuer, and an unknown `kid`.
5. **Move to production.** After staging works, use the production key and
   production base URL. Keep the same Organization identity mode and send the
   matching form of `X-User-Identity`. Never use a staging key against
   production.

Onboarding is complete when the required Organization, scope, environment, and
API key are ready and your team has saved a successful staging `request_id` for
support. An identity configuration is required only if you chose Signed User
Assertions.

### Details to have ready

Registering an Organization and creating a key are self-serve, so nothing here
is sent to AIHUB by email. These are the values you supply to those endpoints.

| Item                        | Required for         | Rule                                                                                                   |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| Organization name           | Every integration    | Your display or legal name                                                                             |
| Capabilities                | Every integration    | Granted automatically to a new Organization; ask an operator to change them on an existing one         |
| Environment                 | Every integration    | Staging, production, or Sandbox for Writing; each uses its matching key and base URL                   |
| Issuer (`iss`)              | Signed mode only     | Exact string; it must match the assertion character for character                                      |
| JWKS source                 | Signed mode only     | Configure exactly one: a publicly reachable HTTPS URL or a public JWKS document                        |
| Signing algorithm and `kid` | First signed request | Use a supported algorithm (`RS256` or `ES256`) and a `kid` identifying exactly one matching public key |

For a new Organization, the name is the only field that is really yours to
choose. Signed User Assertion values:

```text
Identity mode: signed
Issuer: https://<your-domain>
JWKS URL: https://<your-domain>/.well-known/jwks.json
Current kid: <key-id>
Signing algorithm: RS256
```

Do not send API keys, signing private keys, or user passwords in an email,
ticket, request body, or source repository. Exchange credentials through the
agreed secure channel and store them in a secret manager.

### Configure Signed User Assertions (optional)

An active Organization owner can configure identity verification through the
Organization control-plane API. This uses an AIHUB User Access JWT, not the
Organization API key used for grading:

```http
PUT /v1/organizations/{organization_id}/identity-config
Authorization: Bearer <AIHUB_USER_ACCESS_TOKEN>
Content-Type: application/json
```

The request must include an `issuer` and exactly one key source: `jwks_url` or
`public_keys_jwks`. A remote URL must use publicly reachable HTTPS. The
supported algorithms are `RS256` and `ES256`; the default maximum assertion
lifetime is 300 seconds and can be configured from 1 to 3,600 seconds. See
`GET /docs` for the complete request schema and validation rules. Never send a
private key. This setting is saved once for the Organization; do not send
issuer or JWKS values as grading headers.

### What AIHUB gives you

- an organization id (`org_...`)
- an API key (`aihub_sk_...`), shown **once** at creation time
- the base URL for your environment
- the enabled capabilities, scopes, and environment binding for the key

**Declared mode:** no issuer or JWKS is sent to AIHUB. Your backend sends the
stable user ID in `X-User-Identity` on each grading request.

**Signed mode:** configure an issuer and either a JWKS URL or the public JWKS
document through the control-plane API above. Only public keys leave your
infrastructure. AIHUB does not hold your Organization's private signing key,
so it cannot create assertions for your learners. The separate demo-only
Sandbox mint route creates assertions only for the dedicated demo Organization.
A JWKS URL lets you rotate keys without updating the saved document; with an
inline JWKS, update the saved configuration before signing with a new key.

### Staging and production rules

The API key determines the organization and is also restricted to one or more
allowed environments. The hostname determines the environment; clients do not
select it with a request header. Keep staging and production credentials in
separate secret-manager entries and configure the base URL alongside the
matching key.

Identity configuration is Organization-owned and applies to all of that
Organization's environments. If using Signed User Assertions, use a compatible
issuer and key set for staging and production; change the environment-specific
API key and base URL, not the identity mode or issuer per request. If your
environments cannot share one Organization-level identity configuration,
contact your AIHUB administrator before onboarding.

`DEMO_ASSERTION_ISSUER=https://demo.acme.edu`, `demo-private.pem`, and
`demo-jwks.json` belong only to the repository's local demo. They are not
production onboarding values and must never be copied into a customer
deployment.

### Storing the API key

It is shown once and stored only as a SHA-256 hash. AIHUB cannot recover it.
Keep it in your secret manager, never in source control. If it leaks, ask for
a revoke and a replacement; revocation takes effect immediately.

---

## 3. Optional: verify end users with a Signed User Assertion

Use this section only if your Organization chooses signed identity
verification. JWKS and signed assertions are not required for grading in
Declared User ID mode (section 1a). A Signed User Assertion proves that your
backend's signing key, not merely your API key, vouched for the user. Once an
identity configuration is active, every user-scoped call must carry one.

An assertion is a short-lived JWT your backend signs immediately before
calling AIHUB. It is not a session token: do not cache it for long, and never
send it to a browser or mobile client.

### Required claims

| Claim | Value                  | Notes                                       |
| ----- | ---------------------- | ------------------------------------------- |
| `iss` | Your registered issuer | Must match exactly, character for character |
| `aud` | `"aihub"`              | Constant                                    |
| `sub` | Your user's id         | 1-256 visible ASCII characters, no spaces   |
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
are user-scoped and require `X-User-Identity`. The required value is a Declared
User ID when there is no active identity configuration, or a Signed User
Assertion when there is one. In signed mode, the assertion's `sub` claim is the
learner identity AIHUB accepts.

### Rotating keys

1. Publish the new public key in your JWKS, alongside the old one. Keep
   signing with the old key.
2. Wait at least 20 minutes so AIHUB's cache refreshes.
3. Start signing with the new key.
4. Wait until every assertion signed with the old key has expired.
5. Remove the old public key from your JWKS.

This procedure applies when AIHUB reads your JWKS URL. No per-rotation approval
is needed, but publish the new key before signing with its `kid`. If you use the
inline-JWKS option, have an active Organization owner update the saved public
JWKS before step 3; AIHUB cannot discover a new key from an old saved document.

If AIHUB sees a `kid` it does not know, it refetches a configured JWKS URL once
— rate-limited to once every five minutes per organization. Keep both keys
published during the overlap window, and notify your integration contact if the
issuer, JWKS URL, algorithm, or rotation process itself changes.

---

## 3a. Demo sandbox: testing without a signing key

Everything in section 3 assumes you are the one signing. If you are exercising
AIHUB from a terminal or a test console rather than from your own backend,
the demo sandbox can sign for you.

**This is not how you integrate.** A customer with a backend signs assertions
from their own identity provider, exactly as described above, and never calls
this route. This route is for the dedicated demo Organization and its
server-held Sandbox API key. Customer Sandbox API keys use their own
Organization Identity Configuration and cannot call this mint route.

It runs on the sandbox hostname with a dedicated demo Organization and key. A
sandbox key is refused on the production hostname and a production key is
refused on the sandbox hostname, both with
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

The assertion goes into `X-User-Identity` on a normal grading call, against the
sandbox hostname:

```bash
ASSERTION=$(curl -sS -X POST 'https://sandbox.aihubproduction.com/v1/sandbox/assertions'   -H "X-API-Key: $SANDBOX_API_KEY" -H 'Content-Type: application/json'   -d '{"user_id":"student_456"}' | python -c 'import json,sys; print(json.load(sys.stdin)["data"]["assertion"])')

curl -sS -X POST 'https://sandbox.aihubproduction.com/v1/ielts/speaking/grading'   -H "X-API-Key: $SANDBOX_API_KEY"   -H "X-User-Identity: $ASSERTION"   -F 'audio=@/path/to/sample.wav'   -F 'part=1'   -F 'question_id=p1_do-you-enjoy-living-in-your-city-or-hometown'   -F 'prompt_text=Do you enjoy living in your city or hometown?'   -F 'test_type=Practice'
```

Note the path. Grading operations live under `/v1/ielts/...`, not `/v1/...`;
`/v1/speaking/grading` is a 404 and is a common first mistake.

### Shared sandbox allowance

Sandbox requests reach the same AI services as production traffic and incur real
AI cost, but customers are not billed for Sandbox usage. Every AI dispatch,
including demo Speaking calls, shares a hard ceiling of 500 dispatches per UTC
month. The demo Organization also keeps its own configured quota. A dispatch
counts even if the downstream call fails or times out. The Customer Sandbox
allowance and the shared ceiling are separate from production usage and quota.

Sandbox usage is recorded against the sandbox Environment. The request-count
ceiling bounds the number of AI calls; it is not a USD spending limit.

---

## 3b. Customer Sandbox Environment

The Customer Sandbox backend supports customer Organization keys for trying
the live Writing grading API without using the Organization's production quota
or receiving a customer bill. An active Organization owner or admin creates a
separate API key restricted to the `sandbox` Environment and `writing.grade`.
Keep production and Sandbox keys separate; a Sandbox key cannot call the
production hostname. Customer Sandbox supports Writing Task 1 and Task 2.
Speaking remains available to the dedicated demo Organization only.

Use `https://sandbox.aihubproduction.com` as the base URL when Sandbox is
enabled for your deployment. The request uses the same Organization Identity
Configuration as production: send a Declared User ID when no active
configuration exists, or a Signed User Assertion when it does. Customer
Organization keys cannot call `POST /v1/sandbox/assertions`; that route remains
restricted to the dedicated demo Organization. Use section 4 and `GET /docs`
for the Writing request and response schemas.

Sandbox dispatches are limited to 25 per Customer Organization per UTC calendar
month and 500 across the entire Sandbox Environment per month. The global
allowance includes the demo Organization, so it may be exhausted before a
Customer Organization uses its individual 25 requests. AIHUB returns
`429 QUOTA_EXCEEDED` at either limit until the next UTC month. During normal
operation, Sandbox also limits each key to 5 requests per minute, each
Organization to one concurrent grading request, and the whole Environment to
ten concurrent grading requests. These Redis-backed burst controls follow the
existing degraded-mode policy; the durable monthly allowance remains the hard
spending boundary. If the durable Sandbox quota store is unavailable, the
gateway fails closed.

Each downstream Writing dispatch consumes one allowance, including a downstream
error or timeout. A completed request replayed with the same `Idempotency-Key`
returns its stored result without another AI call or allowance unit, even when
the quota has run out. These request limits cap the number of calls, not their
exact cost in USD.

---

## 4. Endpoints

All public grading operations are `POST` routes. Writing and Speaking
JSON-by-URL use `Content-Type: application/json`; Speaking file grading uses
`multipart/form-data`.

| Path                              | `X-User-Identity`                              | `Idempotency-Key` | Max body | AIHUB timeout |
| --------------------------------- | ---------------------------------------------- | ----------------- | -------: | ------------: |
| `/v1/ielts/writing/task1/grade`   | Required; plain ID or JWT by Organization mode | Required          |   256 KB |           60s |
| `/v1/ielts/writing/task2/grade`   | Required; plain ID or JWT by Organization mode | Required          |   256 KB |           60s |
| `/v1/ielts/speaking/grading`      | Required; plain ID or JWT by Organization mode | None              |   26 MiB |           60s |
| `/v1/ielts/speaking/grading-json` | Required; plain ID or JWT by Organization mode | None              |   256 KB |           30s |

Two routes are not grading operations and appear here only so the list is
complete:

| Path                           | `X-User-Identity` | `Idempotency-Key` | Notes                                            |
| ------------------------------ | ----------------- | ----------------- | ------------------------------------------------ |
| `/v1/sandbox/assertions`       | Not used          | None              | Dedicated demo Organization only; see section 3a |
| `/v1/ielts/speaking/questions` | Not used          | None              | Public question catalog; no API key needed       |

`/v1/sandbox/assertions` takes an API key and a `user_id` in its body; it does
not take `X-User-Identity` because issuing that value is what the route does.
`/v1/ielts/speaking/questions` takes neither credential and is described in
the Speaking grading section.

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
  -H "X-User-Identity: $USER_IDENTITY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "question": "The chart below shows the total number of minutes (in billions) of telephone calls in the UK, divided into three categories, from 1995-2002. Summarise the information by selecting a reporting the main features, and make comparisons where relevant.",
        "chart_type": "Bar Chart",
        "image_url": "https://s3.wispace.app/ielts-task1/ca95bd4ab522946d",
        "essay": "The bar chart illustrates the total duration, measured in billions of minutes, of telephone calls made in the United Kingdom across three categories between 1995 and 2002. Overall, local fixed line calls were the most popular type throughout the entire period, although their share declined after 1999."
      }'
```

The `image_url` above is a real, reachable URL; the API host is a placeholder
for your own deployment. The difference is deliberate: the AI Writing service
fetches the chart itself, outside your request, so the image URL must be
publicly readable with no signature and no credential. Replace it with your
own chart's URL when you supply your own essay.

The `image_url` above points at a sample chart AIHUB hosts, showing UK
telephone call minutes from 1995 to 2002, and the question and essay in that
request describe that same chart. Task 1 grading always needs an image you can
reach: it is graded on the chart and the essay together, so a mismatched or
missing image makes the result meaningless. Send a URL for your own chart.

The grading response carries `overall_band`, exactly four `criteria` entries in
a fixed order, `summary`, `suggestions`, `next_steps`, and `annotations` that
quote the essay. Bands are whole or half numbers between 0 and 9. See `/docs`
for the full schema.

### Speaking grading

Speaking questions come from AIHUB, not from you. Fetch the catalog, pick one,
and send the `question_id` it returns back with the audio. The route is public:
it needs no API key and no assertion.

```bash
curl -sS "$AIHUB_BASE_URL/v1/ielts/speaking/questions?part=1"
```

```json
{ "data": { "part": 1, "questions": [
  { "question_id": "p1_do-you-enjoy-living-in-your-city-or-hometown",
    "part": 1,
    "prompt_text": "Do you enjoy living in your city or hometown?",
    "audio_url": "https://..." }
] }, "meta": { ... } }
```

Each entry also carries a signed `audio_url` for the sample answer, and
`prompt_text` is the exact prompt to show your learner. Send both the
`question_id` and the `prompt_text` from the same entry. Omit `part` to list
all parts at once.

`POST /v1/ielts/speaking/grading` accepts one audio file and the fields below. The
route is synchronous, user-scoped, and does not currently provide an
idempotent replay. A client retry can therefore start another grading run.

| Field         | Required | Rule                                                                                  |
| ------------- | -------- | ------------------------------------------------------------------------------------- |
| `audio`       | Yes      | One `wav`, `mp3`, `m4a`, `webm`, or `ogg` file; at least 100 bytes and at most 25 MiB |
| `part`        | Yes      | Integer `1`, `2`, or `3`                                                              |
| `question_id` | Yes      | Non-empty id copied from `GET /v1/ielts/speaking/questions`                           |
| `prompt_text` | No       | Prompt used for relevance analysis                                                    |
| `test_type`   | No       | `Practice` or `Full-test`                                                             |
| `test_code`   | No       | Identifier shared by questions in one full test                                       |
| `transcript`  | No       | Existing transcript when the provider supports skipping STT                           |

The multipart request itself is capped at 26 MiB, so a full 25 MiB audio file
fits together with its multipart framing. The 25 MiB file cap mirrors the AI
Speaking service's own limit.

Send the learner identity only through `X-User-Identity`; do not send a
`user_id` form field. AIHUB derives the downstream identity from the End-User ID:
the verified `sub` claim, or your Declared User ID when your organization has no
active identity configuration. The response uses the common `{ "data", "meta" }` envelope; see
`/docs` for the complete Speaking response schema.

`POST /v1/ielts/speaking/grading-json` is the URL fallback. It accepts the same
Speaking metadata but replaces `audio` with `audio_url`. The URL must be HTTPS
on the exact host `s3.wispace.app`, may include query parameters for a
signed object URL, and may be at most 2,048 characters. AIHUB rejects embedded
credentials, fragments, other hosts/schemes/ports, and unknown fields before
dispatch. AIHUB validates but does not download the URL; the provider owns
retrieval and does not follow redirects.

This public sample is a candidate's answer to the matching Part 1 question,
not audio of the examiner reading the prompt. Its URL has no signature or
credentials and can be fetched without authentication.

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/speaking/grading-json" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Identity: $AIHUB_USER_IDENTITY" \
  -H 'Content-Type: application/json' \
  -d '{
    "audio_url": "https://s3.wispace.app/ielts-task1/speaking-answers/part-1/do-you-enjoy-living-in-your-city-or-hometown.webm",
    "part": 1,
    "question_id": "p1_do-you-enjoy-living-in-your-city-or-hometown",
    "prompt_text": "Do you enjoy living in your city or hometown?",
    "test_type": "Practice"
  }'
```

---

## 5. The response envelope

Every successful grading response has the same shape:

```json
{ "data": {}, "meta": {} }
```

`data` is the operation's own contract. Grading responses share these `meta`
fields:

| Field                        | Meaning                                                           |
| ---------------------------- | ----------------------------------------------------------------- |
| `request_id`                 | AIHUB's id for this request. **Quote it in any support request**  |
| `correlation_id`             | Echoed from your `X-Correlation-Id` header, if you sent one       |
| `service`, `operation`       | What ran                                                          |
| `timing.downstream_ms`       | Elapsed time for the downstream HTTP call, including network time |
| `timing.gateway_overhead_ms` | Time AIHUB spent outside that downstream call                     |
| `timing.total_ms`            | Total time measured by the grading response                       |

Send `X-Correlation-Id` with your own trace id to stitch your logs to ours.

Unknown fields in a request body are rejected rather than ignored, so a typo
fails loudly instead of being silently dropped.

---

## 6. Idempotency

Writing grading can take up to a minute and may consume your plan's usage
allowance. For Writing, `Idempotency-Key` makes a retry safe: the same key
returns the stored result instead of grading again. The current Speaking routes
have no idempotency support, so avoid retrying them automatically unless your
product can accept another grading run.

- Generate one key per logical submission — a UUID works.
- Reuse the **same** key when retrying that submission. A new key means a new
  grading run and consumes another request allowance. Sandbox requests are
  free to the customer but use the Sandbox dispatch allowance.
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
least 90 seconds** for Writing `/grade` calls. Speaking multipart grading also
has a 60-second budget; use at least 90 seconds for
`/v1/ielts/speaking/grading`. The budget includes audio upload, so large files
on slow links need a proportionally larger client timeout. Speaking JSON-by-URL
has a 30-second budget; use at least 60 seconds for
`/v1/ielts/speaking/grading-json`. A client timeout equal to the server budget
is unsafe because connection setup and response transfer also consume time.

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
|  401 | `USER_IDENTITY_REQUIRED`        | User-scoped operation called without `X-User-Identity`                                       | Send `X-User-Identity`                                                                                |
|  401 | `INVALID_USER_IDENTITY`         | Declared User ID breaks the rule, or the Signed User Assertion failed verification           | Declared: fix the value. Signed: mint a fresh assertion; check issuer, `kid`, and JWKS                |
|  403 | `FORBIDDEN`                     | Key lacks the scope for this operation                                                       | Ask your Organization owner or AIHUB support to enable the scope and issue an appropriate key         |
|  403 | `ENVIRONMENT_NOT_ALLOWED`       | Key is not valid for this environment                                                        | Use the key issued for that environment                                                               |
|  404 | `NOT_FOUND`                     | No such route                                                                                | Check path and method                                                                                 |
|  409 | `IDEMPOTENCY_CONFLICT`          | Writing reused a key with a different body, or an identical Writing request is still running | Different body: use a new key; in-flight request: wait, then retry the same key and body              |
|  413 | `PAYLOAD_TOO_LARGE`             | Request body exceeded the operation's limit                                                  | Reduce the essay or audio size to fit the route limit                                                 |
|  429 | `RATE_LIMITED`                  | Too many requests per minute                                                                 | Back off for `retry_after_ms`, then retry                                                             |
|  429 | `CONCURRENCY_LIMIT`             | Too many requests in flight at once                                                          | Reduce parallelism; retry in ~500ms                                                                   |
|  429 | `QUOTA_EXCEEDED`                | Monthly quota exhausted                                                                      | Wait for the reset or contact AIHUB about your quota                                                  |
|  502 | `AI_SERVICE_ERROR`              | AI service returned an error                                                                 | Retry later if `retryable` is true                                                                    |
|  502 | `AI_SERVICE_CONTRACT_VIOLATION` | AI service returned an unexpected shape                                                      | Do not retry. Report it with the `request_id`                                                         |
|  503 | `AI_SERVICE_THROTTLED`          | AI service is throttling                                                                     | Back off and retry                                                                                    |
|  503 | `AI_SERVICE_UNAVAILABLE`        | AI service unreachable                                                                       | Retry with backoff                                                                                    |
|  503 | `IDENTITY_PROVIDER_UNAVAILABLE` | AIHUB could not read identity configuration, or could not load public keys in signed mode    | Retry; if using signed mode, check the configured JWKS source. The API key is fine                    |
|  504 | `AI_SERVICE_TIMEOUT`            | Grading exceeded the budget                                                                  | Writing: retry with the **same** `Idempotency-Key`; Speaking: retry only if another run is acceptable |
|  500 | `INTERNAL_ERROR`                | Fault on our side                                                                            | Retry later; report with the `request_id`                                                             |

`IDENTITY_PROVIDER_UNAVAILABLE` means AIHUB could not read the Organization's
identity configuration, or could not use its JWKS source in signed mode. A
configuration-store outage can affect either identity mode. It is a `503`, not
a `401`: the API key is not the problem, and regenerating it will not help.

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

- [ ] AIHUB account registered and Organization created through `POST /v1/organizations`
- [ ] Capabilities confirmed for the Organization; any change on an existing Organization requested from an operator
- [ ] Staging and production base URLs recorded separately
- [ ] API key stored server-side in a secret manager, never in a client build
- [ ] Staging and production keys stored separately and used only with their allowed environment
- [ ] Decided between Declared User IDs and Signed User Assertions
- [ ] `X-User-Identity` included on every grading request; its value matches the Organization's saved identity mode
- [ ] Signed only: signing private key never leaves your infrastructure
- [ ] Signed only: active Organization owner configured the exact issuer and one public JWKS source
- [ ] Signed only: current `kid` and signing algorithm match exactly one usable JWKS key
- [ ] At least one successful staging request verified before production access

### Every request

- [ ] Declared: the same stable, opaque id for the same learner on every call
- [ ] Signed: assertions minted per request, ≤ 300s lifetime, with a fresh `jti`
- [ ] `X-User-Identity` contains the learner identity; no client-supplied `user_id` is sent
- [ ] `Idempotency-Key` generated per Writing submission and reused across retries
- [ ] Speaking: catalog fetched from `GET /v1/ielts/speaking/questions`; the submitted `question_id` and `prompt_text` come from the same entry
- [ ] Speaking audio is one supported file within the documented size limit
- [ ] Client timeout is ≥ 90s for Writing and Speaking multipart; ≥ 60s for Speaking JSON-by-URL
- [ ] Error handling branches on `code`, not on `message` or status alone
- [ ] Retries limited to `retryable: true`, with jittered backoff; do not blindly retry Speaking
- [ ] `request_id` logged for every call, and `X-Correlation-Id` sent
- [ ] Bounded parallelism for grading

### Key rotation and changes

- [ ] New public key published before any assertion uses its `kid`
- [ ] Old and new keys overlap until all old assertions have expired
- [ ] Issuer, JWKS source, and allowed-algorithm changes saved in the Organization config before the signer changes
- [ ] Updated inline JWKS saved before signing with a new `kid`

---

## 10. Getting help

Include the `request_id` from `meta` or from the error body. It identifies the
exact request in AIHUB's logs, including its timings and which AI service was
involved. Without it, a report is hard to trace.

Essay text, API keys, and assertions never appear in AIHUB logs, so a
`request_id` is the only handle we have.
