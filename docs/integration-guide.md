# AIHUB Customer Integration Guide

For engineers connecting a backend to the AIHUB API. It covers the parts an
OpenAPI document cannot express: who holds which credential, how to identify
your end users (plainly or with signed assertions), and how to handle retries,
timeouts, and errors.

The endpoint reference lives at `GET /docs`, generated from the same schemas
the server validates against. This guide is the surrounding context.

The current API major is `/v1`. Choose a contract in the `/docs` version
selector, and read the [Public API changelog](../CHANGELOG.md) for customer-visible
changes by contract version.

## Compatibility promise

The URI major version applies to the whole Public API Contract. All current
customer API routes use `/v1`. Within a major, adding a public route or response
field is additive when existing fields keep their meaning and type. Adding an
optional request field is compatible when existing callers can omit it. AIHUB
documents a new optional request field for client use only after the deployed
release and its normal rollback target both accept it. Request bodies continue
to reject unknown fields.

Clients must ignore response fields they do not recognize and must not reject a
response only because it contains an extra field.

Clients using a JSON deserializer should configure it to ignore unknown object
properties. In Java with Jackson, also give open enum values a fallback:

```java
ObjectMapper mapper = new ObjectMapper()
    .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
    .enable(DeserializationFeature.READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE);
```

Mark the fallback enum constant with `@JsonEnumDefaultValue`. In other
languages, use the equivalent lenient response-field handling and represent
open enums with an unknown-value case. Every `switch` over `error.code` or an
open enum needs a default branch.

Within a supported major, AIHUB may add response headers without changing the
meaning of existing headers. Clients must ignore headers they do not recognize;
an unfamiliar response header alone must not make an otherwise valid response
fail.

Response enum values are closed unless their OpenAPI schema has
`x-extensible-enum`. AIHUB may add values to `error.code` and Organization Audit
event `action`; clients must handle unknown values with fallback logic. For an
unknown error code, fall back to HTTP status and `error.retryable`. For an
unknown Audit action, use generic handling rather than failing the event page.
Marking a previously closed response enum as extensible is itself breaking;
clients need that change announced before AIHUB sends a new value. Each new
error code and value added to an open enum is an additive change and appears
under `Added` in the dated `CHANGELOG.md` entry for its release.

Removing or renaming a route, existing field, or error code; making a request
field required; narrowing accepted request values; changing an existing field's
type or meaning; removing a response enum value; or adding a value to a closed
response enum is breaking and may require customer changes.

AIHUB introduces a new URI major only for a breaking contract change. A
compatible release stays on the current major; it does not create a duplicate
major with the same contract.

A change to how grading behaves is not a contract change. When a model, prompt,
or rubric behind an operation changes so that the same input can receive a
different band, the contract, its version, and its changelog stay as they are.
AIHUB announces the change in the [grading changes log](grading-changes.md);
see [Grading behavior changes](#grading-behavior-changes).

AIHUB sets a baseline Content-Security-Policy, X-Frame-Options: DENY,
X-Content-Type-Options: nosniff, and Referrer-Policy: no-referrer on every
response.

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

## AIHUB account login through the Customer Web BFF

The Customer Web browser does not call AIHUB login directly. Its BFF sends
`POST /v1/auth/web-sessions` with the Customer Web client secret header and the
user's email and password. A `201` response contains the Web Session token for
the BFF to store in its host-only, HttpOnly cookie. If the password is correct
and the account has TOTP enabled, AIHUB instead answers `202` with
`{"data":{"status":"MFA_REQUIRED"}}` and issues no session token. The BFF
then submits the same email and password plus `mfa_code`, containing either a
six-digit TOTP code or an unused recovery code.

There is no server-side login challenge: the browser keeps the password only in
transient form memory while the user enters the second factor, and clears it on
success, cancellation, or form reset. Do not place it in local/session storage,
URLs, telemetry, or logs. Both responses are `no-store`; a page reload starts a
new login attempt.

After five failed proofs for one caller IP and email in 15 minutes, or 20
failed proofs from one caller IP in five minutes, AIHUB returns
`429 RATE_LIMITED` before checking another password or second factor. The
response includes `Retry-After` in whole seconds and `error.retry_after_ms` in
milliseconds; wait for the longer exhausted window before trying again.

Password verification and hashing use a bounded process-wide queue. If that
queue is full or your request waits too long, AIHUB returns retryable
`503 AUTH_ARGON2_CAPACITY` with `Retry-After` and `error.retry_after_ms`; wait
for that interval before retrying the password operation.

## AIHUB account registration and email verification

`POST /v1/auth/register` creates an AIHUB User Account that stays pending until
its email is verified, and sends a verification link to that address.

- **Registering again before verifying replaces the pending registration.** A
  registration for an email whose account is still pending takes the new
  username and password, makes every earlier verification link unusable, and
  sends a new one. The answer is the same `201` a new email gets. Only an email
  whose account is already active, or a username another account holds,
  answers `409 AUTH_IDENTITY_UNAVAILABLE`. One limit: an address can receive at
  most nine authentication emails a day. When that ceiling is full, a
  registration answers `email_delivery_status: "suppressed"` and guarantees
  nothing was sent — for an email that already has a pending registration this
  also means nothing was replaced: the earlier username, password and
  verification link all stay exactly as they were, and the last delivered link
  keeps working.
- **A registration that is never verified expires after seven days.** Its email
  and username become free to register again.
- **An email address has one form.** The local part must be ASCII (letters,
  digits, and the usual atom characters, with single dots between them), and the
  domain is stored in its ASCII (punycode) form, so `user@bücher.de` and
  `user@xn--bcher-kva.de` are the same address. A domain label that mixes scripts
  (a Cyrillic letter among Latin ones), a non-ASCII local part, and a numeric
  top-level domain answer `400 INVALID_REQUEST`, like any other malformed
  address, on registration, login, resend, password recovery, and invitation.

The link's token is verified either by the browser through
`POST /v1/auth/verify-email`, or by the Customer Web BFF through
`POST /v1/auth/web-sessions/verification`. Both take the same optional field:

- `password`: the password chosen in the registration the link belongs to.
  AIHUB is introducing a rule that a verification link needs it, so that the
  person who owns the mailbox activates an account only with a password they
  chose or know. A link issued while the rule is on is refused without it.
  Until then, links verify without a password, and a password you send must
  still match.

A missing or wrong password answers `400 AUTH_VERIFICATION_PASSWORD_INVALID`.
The link stays usable: ask the user to check the password they registered with.
After five wrong passwords the link stops working, and the user registers again
with the same email to get a new one. A link that is unknown, already used,
replaced or expired answers `400 AUTH_VERIFICATION_TOKEN_INVALID` as before.
Collect the password on the page the link opens, keep it only in form memory,
and never put it in a URL, storage, telemetry or a log.

### When email delivery is backed up

`POST /v1/auth/register`, `POST /v1/auth/resend-verification`,
`POST /v1/auth/forgot-password` and
`POST /v1/organizations/{organization_id}/invitations` send a link that works
for a limited time: 24 hours for a verification or an invitation, one hour for a
password reset. AIHUB queues the email and sends it in the background. If the
queue is so far behind that a new email would very likely arrive after its link
expired, the route refuses the request instead of accepting it:

```json
{
  "error": {
    "code": "EMAIL_DELIVERY_BACKLOGGED",
    "message": "Email delivery is delayed; try again later",
    "retryable": true,
    "retry_after_ms": 300000
  }
}
```

The status is `503`, and `Retry-After` (whole seconds) repeats
`retry_after_ms`. AIHUB refuses once the oldest waiting email of that kind has
waited three quarters of the link's lifetime: 18 hours for a verification or an
invitation, 45 minutes for a password reset. Nothing is created by a refused
request, and it does not count against the route's rate limit, so retry it
after the wait with the same input. The wait is capped at 15 minutes; if the
queue is still behind, the next attempt is refused again.

Show the user a "try again later" message, not a failure of the address they
typed. The refusal depends only on the state of the queue, never on whether an
account exists for the email.

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

#### Avoid overwriting another owner's change

`PUT` replaces the whole configuration. When several owners may edit it, make
the write conditional so a change based on an older read is refused instead of
silently replacing a newer one:

1. `GET .../identity-config` returns an `ETag` header, such as `"7"`. Treat the
   value as opaque.
2. `PUT` it back in `If-Match`: `If-Match: "7"`. If the configuration has
   changed since, AIHUB answers `412 PRECONDITION_FAILED` and changes nothing.
   Read it again, merge your change, and resend with the new `ETag`.
3. To create the first configuration only when none exists, send
   `If-None-Match: *`. A `412` means someone created it first.

A successful `PUT` returns the new `ETag`. The header is optional throughout
`/v1`, and without it the last write wins, as before; requiring it would be a
breaking change. Send one `If-Match` with one quoted value, or
`If-None-Match: *`, not both; any other form answers `400 INVALID_REQUEST`.

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
Keep it in your secret manager, never in source control. If it leaks, an active
Organization owner or admin can replace it without contacting AIHUB:

- `POST /v1/organizations/{organization_id}/api-keys/{api_key_id}/rotate`
  creates a replacement with the same name, scopes, and expiry and revokes the
  leaked key in one step, so there is no window in which both work. The new key
  is shown once in that response.
- `DELETE /v1/organizations/{organization_id}/api-keys/{api_key_id}` revokes the
  key and issues no replacement; create one with
  `POST /v1/organizations/{organization_id}/api-keys`.

Both routes take the signed-in user's Bearer User Access token, not an API key.
Prefer rotation: it replaces the key in one step, with no moment when the leaked
key still works and no replacement missing. Deploy the new key to your clients
right away; clients still sending the old key are refused.

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

A user id is only meaningful together with your Organization: two
Organizations may use the same `sub` for different people, and AIHUB keeps them
apart (see
[ADR-0140](adr/0140-tenant-identity-is-the-organization-and-end-user-id-pair.md)).

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

It runs only on the sandbox hostname when the application process also has
Sandbox runtime scope. Requests to the production hostname and requests handled
by a Production process return `404` before API-key authentication. The mint
route is limited to 5 requests per minute per key. Its assertions use the
`aihub:sandbox` audience, which the identity verifier accepts only in Sandbox;
customer assertions continue to use the `aihub` audience.

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
cannot be aimed at an organization you do not own, and Production will reject
it even if it is presented there. `expires_at` is seconds since the epoch;
sandbox assertions last an hour rather than the five minutes a production
tenant is capped at.

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
`/v1/speaking/grading` is a 404 and is a common first mistake. A method the route does not accept is a 404 too, with no `Allow` header; check the method against OpenAPI.

### Shared sandbox allowance

Sandbox requests reach the same AI services as production traffic and incur real
AI cost, but customers are not billed for Sandbox usage. Every AI dispatch,
including demo Speaking calls, shares a hard ceiling of 500 dispatches per UTC
month. Separately, each Organization gets a durable monthly dispatch allowance
applied across all of its keys, clients, and skills. A dispatch counts even if
the downstream call fails or times out. The Customer Sandbox
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

Sandbox dispatches are limited per Customer Organization per UTC calendar month
and to 500 across the entire Sandbox Environment per month. The default
per-Organization allowance is 25 in October 2026, the month the allowance
policy was deployed, and 5 in every month after it. The
per-Organization allowance is shared by every key and both skills of that
Organization, and an operator may replace it for a specific month; the global
ceiling includes the demo Organization, so it may be exhausted before a
Customer Organization uses its individual allowance. AIHUB returns
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
the quota has run out. Speaking has no idempotent replay: an explicit retry is a
new attempt and can consume another unit. These request limits cap the number of
calls, not their exact cost in USD.

## 3c. Account Avatar (Customer Web)

An AIHUB User Account can have one Avatar. These routes use the signed-in
user's access token (`Authorization: Bearer ...`), never an API key, and act
only on that account; no route takes an account id.

- `GET /v1/me/avatar` answers `200` with `data.avatar` set to `null` when the
  account has no Avatar. That is a normal state: render the username fallback.
  Otherwise `data.avatar.url` is the image's public origin URL on
  `https://s3.wispace.app`. Load it with a plain `<img>` or unauthenticated
  `GET`; AIHUB does not proxy it. An image that fails to load is a separate
  condition from `avatar: null`.
- To set or replace it, call `POST /v1/me/avatar/uploads` with
  `{ "content_type": "image/png", "byte_size": 1234 }`, then `PUT` the bytes to
  the returned `upload_url` with **all three** returned headers
  (`Content-Type`, `Content-Length`, `Cache-Control`) unchanged, within five
  minutes. Then call `POST /v1/me/avatar/uploads/{asset_id}/complete` within
  one hour of the `PUT`, which answers with the Avatar, including its `url`.
  A completion later than that answers `404` and deletes the object, so upload
  again. JPEG, PNG, and WebP up to
  2 MiB are accepted.
- `DELETE /v1/me/avatar` removes it and always answers `204`.

Every upload gets a new URL, so a cached image is never shown under the wrong
Avatar. A removed or replaced image can remain in browser caches for up to an
hour. `409 AVATAR_CHANGED` means another request changed the Avatar first:
read it again before retrying. `503 AVATAR_STORAGE_UNAVAILABLE` is retryable
and includes a short `retry_after_ms` hint. Storage calls stop at the request's
10-second deadline; retry a timed-out completion with the same asset ID.

---

## 3d. Writing Task 1 chart uploads

An API key with `writing.grade` can upload a chart for a Writing Task 1 grade.
The request must include the same `X-User-Identity` value as grading: a
Declared User ID when the Organization has no active identity configuration,
or a Signed User Assertion when it does. The upload is bound to the
Organization, End User, and API-key environment. The no-key Customer Web demo
stays in its fixed Mock mode.

Create an intent with `POST /v1/ielts/writing/task1/chart-uploads` and
`{ "content_type": "image/png", "byte_size": 1234 }`. JPEG, PNG, and WebP are
accepted up to 10 MiB compressed and 20 megapixels. SVG is rejected. Upload
bytes directly to the signed `POST` URL as `multipart/form-data`, including
every returned `fields` entry and the file under the `file` field, then call
`POST /v1/ielts/writing/task1/chart-uploads/{asset_id}/complete`. An expired
five-minute URL can be refreshed while the one-hour intent is open; refresh
does not extend the intent. Completion downloads the complete staged object,
decodes and verifies the image, applies EXIF orientation, strips source
metadata, and re-encodes it before publishing. The sanitized output is also
limited to 10 MiB; completion returns `413 PAYLOAD_TOO_LARGE` and rejects the
intent if re-encoding exceeds that limit. Malformed or mismatched images are
rejected with `400`. `503 WRITING_CHART_STORAGE_UNAVAILABLE` is retryable, and
an Organization past its hourly limit receives `429 RATE_LIMITED` with
`retry_after_ms` and a `Retry-After` header.

Put the completion response's `image_url` into the existing Task 1
`image_url` grading field. A completed image is publicly readable by anyone
who learns its URL. AIHUB schedules deletion 24 hours after publication; the
15-minute cleanup job deletes it on the first successful run after that
deadline. Do not upload a chart you cannot expose publicly. AIHUB also deletes
private incomplete objects 24 hours after the intent expires. Each Organization is limited to five new intents and five
successful publications per rolling hour. Uploads do not consume grading
quota or create grading or billing records.

The shared chart delivery origin is `https://s3.wispace.app`; URLs include the
environment-specific public bucket path. The upload service remains unavailable
until the matching chart buckets are configured. Public rollout also waits for
the abuse contact and the provider URL-fetch security gate tracked in #376.

To report a chart hosted by AIHUB, email
[lengocanhpyne363@gmail.com](mailto:lengocanhpyne363@gmail.com) with its public
URL and a short description of the concern. AIHUB's target is to triage the
report and respond within one business day.

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
| `/v1/ielts/speaking/grading-json` | Required; plain ID or JWT by Organization mode | None              |   256 KB |           60s |

These routes are not grading operations and appear here only so the list is
complete:

| Path                                    | `X-User-Identity`                              | `Idempotency-Key` | Notes                                                                      |
| --------------------------------------- | ---------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| `/v1/sandbox/assertions`                | Not used                                       | None              | Dedicated demo Organization only; see section 3a                           |
| `/v1/ielts/speaking/questions`          | Not used                                       | None              | Public question catalog; no API key needed                                 |
| `/v1/speaking/audio/uploads`            | Required; plain ID or JWT by Organization mode | None              | Requires `speaking.grade`; create, refresh, and complete recording uploads |
| `/v1/ielts/writing/task1/chart-uploads` | Required; plain ID or JWT by Organization mode | None              | Chart upload intent; see section 3d                                        |

`/v1/sandbox/assertions` takes an API key and a `user_id` in its body; it does
not take `X-User-Identity` because issuing that value is what the route does.
`/v1/ielts/speaking/questions` takes neither credential and is described in
the Speaking grading section. The create, refresh, and complete
`/v1/speaking/audio/uploads` routes require an API key with `speaking.grade`
and take `X-User-Identity` because the recording is attributed to that exact
End-User ID.

### Enumerated values

`chart_type` (Task 1) is case-sensitive and must be one of:
`Bar Chart`, `Line Graph`, `Pie Chart`, `Table`, `Map`, `Process Diagram`,
`Multiple Graphs`.

`language` is optional and currently accepts `vi` only. Feedback is returned
in Vietnamese.

### Text length limits

| Field      | Operations     | Length         |
| ---------- | -------------- | -------------- |
| `question` | Task 1, Task 2 | 1–2,000 units  |
| `topic`    | Task 2         | 1–200 units    |
| `essay`    | Task 1, Task 2 | 1–20,000 units |

A unit is a UTF-16 code unit, the unit of JavaScript's `String.length`. A
character outside the Basic Multilingual Plane, such as most emoji, counts as 2. A JSON Schema validator counts code points by default, so it can accept a
text that AIHUB refuses with `400 INVALID_REQUEST`. Check these fields with
`String.length` or the equivalent UTF-16 length in your language, for example
`len(text.encode("utf-16-le")) // 2` in Python.

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
fetches the chart itself, outside your request. Use an HTTPS URL from any
public host; it must be readable with an unauthenticated GET and must not rely
on credentials or an expiring signature. AIHUB rejects URLs with embedded
credentials, a port other than 443, a literal IP address that is not public, or
a host name that cannot be public (a name without a dot, `localhost`, or a name
under `.local`, `.home.arpa`, or `.internal`).
AIHUB does not resolve hostnames; AI Writing checks every resolved IPv4 and
IPv6 address before fetching and rejects non-public or special-use destinations.
It also rejects redirects, limits the response to 10 MiB, and applies a
10-second total fetch deadline. Replace it with your own chart's URL when you
supply your own essay.

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

### Retaining a Speaking recording

The grading route above forwards bytes to the AI Speaking service and keeps
nothing. To store a recording as a durable AIHUB asset, upload it directly to
object storage instead. Audio bytes never pass through AIHUB. The create,
refresh, and complete routes all require an API key with `speaking.grade`.

1. `POST /v1/speaking/audio/uploads` with
   `{ "content_type": "audio/wav", "byte_size": 204800 }`. It answers `201`
   with an `asset_id`, an `upload_url`, `method: "PUT"`, the two headers you
   must send unchanged (`Content-Type`, `Content-Length`), `expires_at` for
   that URL, and `intent_expires_at` for the upload itself.
2. `PUT` the bytes to `upload_url` with exactly those headers, within five
   minutes.
3. `POST /v1/speaking/audio/uploads/{asset_id}/complete` within one hour of
   step 1. It verifies the stored object's type and size, then answers `201`
   with the asset and `retention_expires_at` 30 days later. Repeating a
   successful completion answers `200` with the same asset.

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/speaking/audio/uploads" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Identity: $ASSERTION" \
  -H 'Content-Type: application/json' \
  -d '{"content_type":"audio/wav","byte_size":204800}'
```

```json
{
  "data": {
    "asset_id": "aud_01JQ8Z5R3M7T2VXK4YB6HD8C0E",
    "upload_url": "https://s3.wispace.app/orgs/org_.../original?X-Amz-...",
    "method": "PUT",
    "headers": { "Content-Type": "audio/wav", "Content-Length": "204800" },
    "expires_at": "2026-10-03T12:05:00Z",
    "intent_expires_at": "2026-10-03T13:00:00Z"
  },
  "meta": { "request_id": "req_..." }
}
```

The URL is short-lived while the upload stays open for an hour. If it expires
first, `POST /v1/speaking/audio/uploads/{asset_id}/refresh` issues a new
five-minute URL for the same asset, key, content type, and byte size; it does
not extend the one-hour window. AIHUB chooses the object key, so no filename
and no Organization or End-User ID is ever taken from your request body.

Accepted `content_type` values are exactly `audio/wav`, `audio/mpeg`,
`audio/mp4`, `audio/webm`, and `audio/ogg`; aliases such as `audio/x-wav` are
refused. `byte_size` must be from 100 bytes through 25 MiB. Completion reads
the object's storage-reported metadata, so a `PUT` whose real bytes differ
from what you declared is refused and its object deleted.

`404` means the intent is gone, expired, or belongs to another Organization or
End-User ID. A completion sent before storage has the object yet is retryable
until the intent expires. `503 SPEAKING_AUDIO_STORAGE_UNAVAILABLE` is retryable
and leaves the intent open.

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

| Field                        | Meaning                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request_id`                 | AIHUB's id for this request. **Quote it in any support request**                                                                                                        |
| `correlation_id`             | Echoed from your `X-Correlation-Id` header, if you sent one                                                                                                             |
| `service`, `operation`       | What ran                                                                                                                                                                |
| `timing.downstream_ms`       | Elapsed time for the downstream HTTP call, including network time                                                                                                       |
| `timing.gateway_overhead_ms` | AIHUB time outside downstream HTTP within `total_ms`; excludes usage-record persistence                                                                                 |
| `timing.total_ms`            | From ingress until the grading result is ready; includes parsing, authentication, identity, rate limits, quota, and gateway work, but excludes usage-record persistence |

These values describe gateway processing time, not client-observed end-to-end
latency. `total_ms` is sampled before AIHUB writes the usage record; measure the
HTTP response at your client if you need the full time until the response is
received.

Send `X-Correlation-Id` with your own trace id to stitch your logs to ours.

Unknown fields in a request body are rejected rather than ignored, so a typo
fails loudly instead of being silently dropped.

### Collection pagination

The Organization membership list (`GET /v1/organizations/{organization_id}/members`)
and open invitation list (`GET /v1/organizations/{organization_id}/invitations`)
are paginated using `limit` and `cursor` query parameters:

- `limit` (optional integer): maximum items per page, from 1 to 500, default 100.
  Values outside this range are rejected with `400 INVALID_REQUEST` rather than clamped.
- `cursor` (optional string): an opaque continuation token returned as `data.next_cursor`
  from a previous page.

Both responses return `data.next_cursor`: a non-empty string when more rows
exist, and `null` on the last page. To fetch all items, continue querying with
`cursor=<next_cursor>` until `data.next_cursor` is `null`.

```json
{
  "data": {
    "invitations": [],
    "next_cursor": "eyJ2IjoxLC..."
  },
  "meta": {
    "request_id": "req_01J00000000000000000000000"
  }
}
```

The Organization roster (`GET /v1/organizations/me/members`) follows the same
`limit` and `cursor` convention with two differences:

- A page holds whole Organizations, ordered by `organization_id`, and `limit` is
  capped at 100 (default 100). It never splits one Organization across pages.
- Each Organization lists only its first 100 active members, ordered by username.
  `member_count` is the total number of active members; when it is larger than
  the length of `members`, read the rest from
  `GET /v1/organizations/{organization_id}/members`, which owners and admins can
  call.

A cursor is bound to the user who received it. A traversal is a live read:
membership is checked again on every page. The roster rejects query parameters
other than `limit` and `cursor` with `400 INVALID_REQUEST`.

Rules that hold for every collection route:

- Where a response carries `data.next_cursor`, the array beside it is one page,
  not the whole collection. Follow `next_cursor` until it is `null`, and treat a
  response without `next_cursor` as the last page.
- Send only the query parameters a route documents. A route answers
  `400 INVALID_REQUEST` to any other, including on routes that once ignored them.
- `GET /v1/organizations/{organization_id}/api-keys` is not paginated: it lists
  only active keys, and an Organization holds at most 50 of them.

A cursor represents a position in the collection order and never conveys authorization:
caller permissions, tenant scope, and Organization active status are re-evaluated on
every request. The cursor is bound to the Organization ID (and to the `status` filter for
memberships); supplying a cursor issued for another Organization or different filter
refuses the request with `400 INVALID_REQUEST`.

Collection traversals are live reads, not point-in-time snapshots. Rows inserted before
the current cursor position appear only after restarting the traversal from the beginning,
and rows deleted, expired, or modified between requests may disappear from subsequent
pages. Any row that remains unchanged throughout traversal is returned exactly once.

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
- Same-key retries share an Organization-wide rolling 60-second budget: at most
  10% of first attempts, with a minimum of one retry. If the budget is spent,
  AIHUB returns `429 RATE_LIMITED` with `Retry-After`; wait before repeating.
- A replayed response carries the header `Idempotent-Replay: true` and
  `timing.downstream_ms: 0`.

At exhausted Production monthly quota, an admitted retry with the same key and
body still returns a completed Writing result without grading, billing, or
consuming another quota unit. The retry budget refusal takes precedence. New
keys, in-flight requests, and a reused key with a different body do not bypass
the exhausted quota.

Reusing a key with a **different** body returns `409 IDEMPOTENCY_CONFLICT`.
That is deliberate: silently returning the earlier result for a different
essay would be worse than an error.

If an identical request is already in flight, the second request returns
`409 IDEMPOTENCY_CONFLICT` immediately; AIHUB does not hold the connection open.
That refusal is `retryable` and carries `retry_after_ms` and `Retry-After`:
wait, then retry with the same key and identical body. A successful first
attempt is returned as a replay. A different body is never retryable and carries
no hint.

Client errors are not stored. If a request fails validation, you may fix the
body and reuse the same key.

An API key is checked once, when a request arrives. A request admitted before
its key expired or was revoked runs to completion and is billed once; it is not
cut off part way. If you lose that response and the key has since expired, a
retry with the old key is refused with `401 UNAUTHORIZED` before AIHUB looks up
the stored result. Retry with another active key of the same organization,
allowed in the same environment, sending the same `Idempotency-Key`, the same
body, and the same `X-User-Identity` user: within the 24 hours the record is
kept, AIHUB returns the stored result as a replay without grading or billing
again. The stored result is keyed by organization, operation, and
`Idempotency-Key`, not by the API key that made the request.

---

## 7. Timeouts and cancellation

Writing grading has a 60-second AIHUB budget. **Set your client timeout to at
least 90 seconds** for Writing `/grade` calls. Speaking multipart grading also
has a 60-second budget; use at least 90 seconds for
`/v1/ielts/speaking/grading`. The budget includes audio upload, so large files
on slow links need a proportionally larger client timeout. Speaking JSON-by-URL
also has a 60-second budget; use at least 90 seconds for
`/v1/ielts/speaking/grading-json`. A client timeout equal to the server budget
is unsafe because connection setup and response transfer also consume time.

AIHUB's per-operation budget is a single clock: it is set when the request
arrives and is consumed as the request travels. It does not restart at any
layer.

If you disconnect early, AIHUB cancels the downstream call rather than letting
it finish for nobody — with one Writing exception. If the Writing request
carried an `Idempotency-Key` and the timeout was ours, the AI service is allowed
to finish in the background and its result is stored. You will get `504`, and
retrying with the same key returns the finished result. What you pay: the `504`
itself is free, and the grading that finished is billed **once**, when it
finishes, whether or not you ever fetch it; it counts once toward your monthly
quota at the same moment. Retries that return it are free, however many there
are. Speaking has no such replay guarantee.

### Billing month

A request is billed in the **UTC** calendar month in which AIHUB finished
handling it. For a customer in Vietnam (UTC+7), October's bill therefore starts
at 07:00 on 1 October and ends at 06:59:59 on 1 November, local time. Only
successful Production requests are billed; failures, replays, and Sandbox calls
are not.

---

## 8. Errors

Every error has the same shape, and never leaks stack traces, internal URLs,
or database messages:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Rate limit exceeded",
    "request_id": "req_01M23NT8MJW22AYX6FVT17F5XF",
    "retryable": true,
    "retry_after_ms": 2000
  }
}
```

**Branch on `code`, never on `message`.** Messages may be reworded; codes are
part of the contract. `retryable` tells you whether a retry can possibly help,
so you do not have to infer it from the status.

`retry_after_ms` is present only when AIHUB knows how long to wait. Every
response that carries it also carries a `Retry-After` header with the same wait
in whole seconds, rounded up, so a standard HTTP client or retry library can
read it.

These are all the refusals that can carry a hint. A code outside the table never
does: `AI_SERVICE_TIMEOUT` and `AI_SERVICE_THROTTLED` carry none, so use your
own backoff there. A row marked "when" carries the hint only in that case, so
read the field when present and fall back to your own backoff when it is
missing. A hint that AIHUB spreads with random jitter arrives with a different
value for each client, so clients refused at the same moment are not all told to
come back at the same instant:

| Refusal                                                                                  | `retry_after_ms`                                                                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMITED` (per-key rate)                                                            | Until your key's window resets, plus 0–999 ms                                                                                           |
| `RATE_LIMITED` (same-key retry budget)                                                   | 60 s, plus 0–999 ms                                                                                                                     |
| `RATE_LIMITED` (API key authentication failures)                                         | 5 minutes: the window of 20 failures                                                                                                    |
| `RATE_LIMITED` (when account sign-in, verification, or password recovery knows the wait) | Until the longest exhausted window resets; without a known wait, neither the field nor `Retry-After` is sent                            |
| `RATE_LIMITED` (when an Organization invitation knows the wait)                          | Until the exhausted window resets (15 minutes or 24 hours); without a known wait the field is absent                                    |
| `RATE_LIMITED` (Writing chart uploads)                                                   | 1 hour, the whole rolling window                                                                                                        |
| `CONCURRENCY_LIMIT`                                                                      | 500–999 ms                                                                                                                              |
| `CONCURRENCY_LIMIT` (Speaking upload ceiling)                                            | 1000–1999 ms                                                                                                                            |
| `IDEMPOTENCY_CONFLICT` (request in flight)                                               | 2000–2999 ms                                                                                                                            |
| `QUOTA_EXCEEDED`                                                                         | Until the next UTC month starts (can be weeks), plus a fixed 0–10 minute offset                                                         |
| `REDIS_UNAVAILABLE`                                                                      | 1000–1999 ms                                                                                                                            |
| `DATABASE_UNAVAILABLE`                                                                   | 1000–1999 ms                                                                                                                            |
| `AVATAR_STORAGE_UNAVAILABLE`                                                             | 1000–1999 ms                                                                                                                            |
| `SPEAKING_AUDIO_STORAGE_UNAVAILABLE`                                                     | 1000–1999 ms                                                                                                                            |
| `WRITING_CHART_STORAGE_UNAVAILABLE`                                                      | 1000–1999 ms                                                                                                                            |
| `AUTH_ARGON2_CAPACITY`                                                                   | 1000–1999 ms                                                                                                                            |
| `EMAIL_DELIVERY_BACKLOGGED`                                                              | The time the oldest waiting email has left before its link expires, between 30 seconds and 15 minutes, plus 0–999 ms                    |
| `IDENTITY_PROVIDER_UNAVAILABLE` (when the JWKS source failed or is in a cooldown)        | The remaining cooldown (30 s after a cold failure), plus 0–999 ms; absent for any other cause, such as the identity configuration store |
| `AI_SERVICE_UNAVAILABLE` (when AIHUB has stopped sending to the AI service)              | The time left before AIHUB tries the AI service again, at most 30 s; absent when the AI service itself refused or could not be reached  |
| `AI_SERVICE_ERROR` (when the AI service answered `503` with its own `Retry-After`)       | That wait, read from the AI service's `Retry-After`; absent for any other status                                                        |
| `AUDIO_UNREADABLE` (when the AI service answered `503` with its own `Retry-After`)       | The same wait. The refusal stays `retryable: false`: send a new recording, not the same file again                                      |

Every row with a hint also sends `Retry-After`. The header and the field never
disagree: the header is the field rounded up to whole seconds.

Outage refusals carry a spread hint too. Honour it rather than retrying on a
fixed interval: clients that all retry one second after an outage arrive
together and can overload a dependency that has just recovered.

The quota offset is fixed per Organization, so Organizations stopped by their
quota do not all return at 00:00 UTC on the 1st. A quota refusal is `retryable`,
but only after that wait, so do not spend retry attempts on it.

`RETRY_BUDGET_UNAVAILABLE` is not in the table because AIHUB no longer returns
it; a Redis failure while checking graded admission is `REDIS_UNAVAILABLE`.

The table below covers the customer-facing AI grading operations. It does not
try to list every error from account, Organization, or other control-plane
routes. Signed identity configuration has additional setup errors in the
separate table below.

| HTTP | Code                            | What happened                                                                                                                              | What to do                                                                                                         |
| ---: | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
|  400 | `INVALID_REQUEST`               | Body failed validation, or carried an unknown field                                                                                        | Fix the request. Retrying is pointless                                                                             |
|  401 | `UNAUTHORIZED`                  | Missing, unknown, revoked, or expired API key                                                                                              | Check the credential                                                                                               |
|  401 | `USER_IDENTITY_REQUIRED`        | User-scoped operation called without `X-User-Identity`                                                                                     | Send `X-User-Identity`                                                                                             |
|  401 | `INVALID_USER_IDENTITY`         | Declared User ID breaks the rule, or the Signed User Assertion failed verification                                                         | Declared: fix the value. Signed: mint a fresh assertion; check issuer, `kid`, and JWKS                             |
|  403 | `FORBIDDEN`                     | Key lacks the scope for this operation                                                                                                     | Ask your Organization owner or AIHUB support to enable the scope and issue an appropriate key                      |
|  403 | `ENVIRONMENT_NOT_ALLOWED`       | Key is not valid for this environment                                                                                                      | Use the key issued for that environment                                                                            |
|  404 | `NOT_FOUND`                     | No such route, or a method the route does not accept                                                                                       | Check path and method                                                                                              |
|  409 | `IDEMPOTENCY_CONFLICT`          | Writing reused a key with a different body, or an identical Writing request is still running                                               | Different body: use a new key; in-flight request: wait for `Retry-After`, then retry the same key and body         |
|  410 | `API_VERSION_RETIRED`           | The URI names a retired Public API major (`retryable: false`); `details.successor_major` and `details.successor_docs` name its replacement | Move to the successor major; retrying is pointless                                                                 |
|  413 | `PAYLOAD_TOO_LARGE`             | Request body exceeded the operation's limit                                                                                                | Reduce the essay or audio size to fit the route limit                                                              |
|  422 | `AUDIO_UNREADABLE`              | The Speaking audio could not be decoded (`retryable: false`)                                                                               | Check the file is a real recording in a supported format, then send a new one; resending the same file fails again |
|  429 | `RATE_LIMITED`                  | Request rate or Organization same-key retry budget exceeded                                                                                | Wait for `Retry-After` (the same wait as `retry_after_ms`) before retrying                                         |
|  429 | `CONCURRENCY_LIMIT`             | Too many requests in flight at once                                                                                                        | Reduce parallelism; retry after `Retry-After` (500–999 ms)                                                         |
|  429 | `QUOTA_EXCEEDED`                | Monthly quota exhausted                                                                                                                    | Wait for the reset or contact AIHUB about your quota                                                               |
|  502 | `AI_SERVICE_ERROR`              | AI service returned an error, including a request timeout it asks you to repeat                                                            | Retry later if `retryable` is true                                                                                 |
|  502 | `AI_SERVICE_CONTRACT_VIOLATION` | AI service returned an unexpected shape                                                                                                    | Do not retry. Report it with the `request_id`                                                                      |
|  503 | `AI_SERVICE_THROTTLED`          | AI service is throttling                                                                                                                   | Back off and retry                                                                                                 |
|  503 | `AI_SERVICE_UNAVAILABLE`        | AI service unreachable or not accepting requests                                                                                           | Retry with backoff                                                                                                 |
|  503 | `EMAIL_DELIVERY_BACKLOGGED`     | The email queue is too far behind to deliver a link before it expires (registration, resend, password recovery, invitation)                | Retry after `retry_after_ms`; the refused request created nothing and used no rate limit                           |
|  503 | `DATABASE_UNAVAILABLE`          | AIHUB's database could not be reached, did not answer in time, or timed out a statement                                                    | Retry with backoff; observe `retry_after_ms` and `Retry-After` when present                                        |
|  503 | `IDENTITY_PROVIDER_UNAVAILABLE` | AIHUB could not read identity configuration, or could not load public keys in signed mode                                                  | Retry; if using signed mode, check the configured JWKS source. The API key is fine                                 |
|  503 | `REDIS_UNAVAILABLE`             | AIHUB could not safely check graded admission or acquire/release its concurrency permit                                                    | Retry after `retry_after_ms`; AIHUB does not admit using local counters                                            |
|  503 | `RETRY_BUDGET_UNAVAILABLE`      | Reserved: AIHUB no longer returns this code; a Redis failure while checking graded admission is `REDIS_UNAVAILABLE`                        | If you handle it, treat it as `REDIS_UNAVAILABLE`: retry after `retry_after_ms`                                    |
|  504 | `AI_SERVICE_TIMEOUT`            | Grading exceeded the budget                                                                                                                | Writing: retry with the **same** `Idempotency-Key`; Speaking: retry only if another run is acceptable              |
|  500 | `INTERNAL_ERROR`                | Fault on our side                                                                                                                          | Retry later; report with the `request_id`                                                                          |

### Signed identity configuration errors

These errors apply when an Organization owner calls
`PUT /v1/organizations/{organization_id}/identity-config`. Common malformed
request errors use `INVALID_REQUEST` from the table above.

| HTTP | Code                                    | What happened                                                              | What to do                                                                                                                                           |
| ---: | --------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
|  400 | `IDENTITY_JWKS_URL_UNSAFE`              | The configured JWKS URL is not an allowed public HTTPS URL                 | Use a publicly reachable HTTPS URL; private or local addresses are rejected                                                                          |
|  400 | `IDENTITY_JWKS_INVALID`                 | The supplied JWKS is malformed or has no usable supported key              | Validate the JWKS and ensure a supported public signing key with a unique `kid` is present                                                           |
|  401 | `AUTH_USER_ACCESS_TOKEN_REQUIRED`       | The Bearer User Access token is missing                                    | Sign in and send `Authorization: Bearer <AIHUB_USER_ACCESS_TOKEN>`                                                                                   |
|  401 | `AUTH_USER_ACCESS_TOKEN_INVALID`        | The User Access token is invalid, expired, or the account is not active    | Sign in again to obtain a valid token                                                                                                                |
|  403 | `FORBIDDEN`                             | The caller is not an active Organization owner                             | Ask an active owner to configure identity                                                                                                            |
|  409 | `ORGANIZATION_IDENTITY_ISSUER_CONFLICT` | Another Organization already uses this issuer                              | Use the issuer uniquely assigned to this Organization                                                                                                |
|  412 | `PRECONDITION_FAILED`                   | `If-Match` or `If-None-Match` no longer describes the stored configuration | Read the configuration again, merge your change, and resend with the new `ETag`                                                                      |
|  503 | `IDENTITY_JWKS_SOURCE_UNAVAILABLE`      | AIHUB could not fetch the configured remote JWKS source                    | Check public reachability and TLS, then retry according to `retryable`                                                                               |
|  503 | `IDENTITY_CONFIG_CACHE_UNAVAILABLE`     | AIHUB could not clear cached identity configuration after saving           | Read the current configuration with `GET /v1/organizations/{organization_id}/identity-config` before retrying; the write may already have been saved |

`IDENTITY_PROVIDER_UNAVAILABLE` on a grading request means AIHUB could not
read the Organization's identity configuration, or could not use its JWKS
source in signed mode. A configuration-store outage can affect either identity
mode. It is a `503`, not a `401`: the API key is not the problem, and
regenerating it will not help.

### Retry policy that works

- Retry only when `retryable` is `true`.
- Honour `Retry-After` when the response has one: never retry sooner.
- Add your own jitter on top of it, and use exponential backoff with full
  jitter when there is no hint — random between zero and the cap, not a fixed
  delay. Fixed delays make every client retry in lockstep and knock the service
  over again just as it recovers.
- Cap at two or three attempts.
- Always resend the same `Idempotency-Key` when retrying a Writing grade; do not
  blindly retry Speaking.

### Rate-limit header fields

Responses from a rate-limited route, `429` refusals included, describe your
API key's per-minute limit in the `RateLimit-Policy` and `RateLimit` fields of
[draft-ietf-httpapi-ratelimit-headers-11](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers-11):

```http
RateLimit-Policy: "per-key";q=600;w=60
RateLimit: "per-key";r=41;t=13
```

- `q` is your key's limit per window, and `w` the window: 60 seconds.
- `r` is how many requests the key has left in the current window, and `t` the
  whole seconds until that window resets.
- Each key has a fixed one-minute window that starts at its own offset into the
  minute, so different keys do not reset together. When `r` reaches `0`, a new
  window starts after `t` seconds.
- On a `429` for the per-key rate, `Retry-After` can be one second later than
  `t`: it adds jitter on top of the reset and is never earlier. Wait for
  `Retry-After`.
- A `429` for the same-key retry budget or the monthly quota also carries
  these fields. There `r` can be above `0`, because that refusal was not about
  the per-minute rate.

The fields describe your own key only. They are advisory while the draft is not
final, so the syntax may change with a later revision. Use them to slow down
before you are refused. The monthly quota is not reported in these fields; a
route for reading quota usage is tracked in #150.

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
- [ ] Branch on known `error.code` values; for an unknown code, use HTTP status
      and `error.retryable`, never the message
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

AIHUB support is staffed Monday to Friday, 09:00 to 18:00 Vietnam time (UTC+7),
excluding Vietnamese public holidays. Outside those hours, response is best
effort. During an incident that affects your Organization, AIHUB emails your
Organization owner contact when the incident is confirmed, as it progresses,
and when it is resolved. AIHUB has no public status page.

## Deprecation headers

A route or major slated to retire publishes `Deprecation`, `Sunset`, and a
`Link: rel="successor-version"` header. `Deprecation` is the RFC 9745 structured
date (`@` followed by Unix seconds) when the route was deprecated; it may be in
the past. `Sunset` is the HTTP-date when the route stops responding, and is not
earlier than the deprecation date. In the OpenAPI `x-deprecated-sunset` object,
`deprecationAt` and `sunsetAt` carry those separate dates. AIHUB keeps a
superseded major available for at least 12 months after its successor is
released and publishes the sunset date with that release. Before sunset, AIHUB
reviews customer traffic and contacts affected Organizations. If customers are
still migrating, the sunset may be extended by an explicit owner decision and
a newly published date.
A major's headers cover every route under it, grading calls included; a route
with its own earlier sunset keeps that one. Requests to a retired major, on any
path or method, return `410 Gone` with error code `API_VERSION_RETIRED`, a
`details` object naming `retired_major`, `successor_major`, and
`successor_docs`, and a `Link: rel="successor-version"` header. `/docs` and
`/openapi/vN.json` serve only supported majors.

## Grading behavior changes

The model, prompt, and rubric behind an operation can change while the response
shape stays the same, and a band can move for the same input. If you keep your
own validation set, you cannot see this from a response: AIHUB does not expose
model identity or a grading version.

AIHUB records each such change in the [grading changes log](grading-changes.md).
It tells you at least 14 days ahead when a planned change is expected to move
bands noticeably, and no later than the day a smaller or urgent change takes
effect. For a change announced ahead of time, AIHUB also emails your
Organization owner contact. When AIHUB detects a shift it was not told about,
it announces the shift once confirmed, with the evidence.

AIHUB does not promise that scores stay the same, re-grade results already
returned, roll back for a single customer, or compensate for a shift, and you
cannot pin a grading behavior. Re-check your validation set against each entry,
and contact support with a `request_id` if it breaks (see "Getting help").
