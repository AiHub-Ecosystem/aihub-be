# AIHUB Local Demo

This guide runs the shipped Writing slice locally and sends a real request through:

```text
curl / Postman → AIHUB → AI Writing
```

It also exercises the organization API key and the customer-style user assertion
flow. There is no customer app or customer backend in this repository. The
`dev:assertion` script stands in for that backend by signing a short-lived JWT.

> **Cost warning:** Task 2 question generation and both grading operations reach
> model-backed AI Writing endpoints and may consume model quota. Start with Task
> 1 question generation when you only need a routing smoke test.

## What you need

- Node.js 22 or newer
- pnpm 11 (the repository pins `pnpm@11.20.0`)
- Docker Desktop or another Docker Compose implementation
- A valid AI Writing bearer token from the AI Writing team
- Ports `3000`, `5432`, and `6379` available locally

The demo uses:

| Component  | Local address                             | Purpose                                               |
| ---------- | ----------------------------------------- | ----------------------------------------------------- |
| AIHUB      | `http://localhost:3000`                   | Public gateway                                        |
| PostgreSQL | `localhost:5432`                          | Organizations, API keys, identity config, idempotency |
| Redis      | `localhost:6379`                          | Credential cache, rate limits, concurrency protection |
| AI Writing | configured by `DOWNSTREAM_AI_WRITING_URL` | Downstream AI service                                 |

## Choose a demo mode

The authenticated demo is recommended because it exercises the real API-key and
user-assertion guards. A faster smoke test is available when you only need to
check that the gateway starts and can reach AI Writing.

### Authenticated demo (recommended)

Follow the complete setup below. Keep
`AIHUB_ALLOW_UNAUTHENTICATED_DEV=false` in `.env`.

### Fast local smoke test (optional)

For a local-only smoke test without provisioning an organization, set this in
`.env`:

```dotenv
AIHUB_ALLOW_UNAUTHENTICATED_DEV=true
```

Then start AIHUB and call a question-generation endpoint without an API key.
This bypass is accepted only when `NODE_ENV=development` or `test`; it must
never be enabled in a deployed environment. It does not replace
`DOWNSTREAM_AI_WRITING_TOKEN`, which is still required for a successful call to
AI Writing. It also does not test API-key or user-assertion verification.

## 1. Install and configure the repository

From the repository root:

```bash
pnpm install
```

Create the local environment file.

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS/Linux:

```bash
cp .env.example .env
```

Open `.env` and set the downstream token:

```dotenv
DOWNSTREAM_AI_WRITING_TOKEN=<token supplied by the AI Writing team>
```

Keep the token, API key, and signing private key out of source control. The
default `.env.example` values are suitable for local development:

- `NODE_ENV=development`
- `PORT=3000`
- `DATABASE_URL=postgres://aihub:change-me@localhost:5432/aihub`
- `REDIS_URL=redis://localhost:6379`
- `DOWNSTREAM_AI_WRITING_URL=https://api-ielts-writing.aihubproduction.com`
- `DEMO_USER_ID=student_456`
- `DEMO_ASSERTION_ISSUER=https://demo.acme.edu`

Requests to `localhost` are treated as the `development` environment while
`NODE_ENV=development`, so no custom `Host` header is needed.

## 2. Start PostgreSQL and Redis

```bash
docker compose up -d
docker compose ps
```

Both containers should show a healthy state. Apply the control-plane schema:

```bash
pnpm migrate
```

If migration fails, check that `.env` exists and that PostgreSQL is ready:

```bash
docker compose logs postgres
```

## 3. Create demo credentials

Run the one-shot bootstrap script:

```bash
pnpm demo:bootstrap "Acme Edu"
```

The script performs all of the following:

1. Generates an RSA signing key pair for the demo customer backend.
2. Writes the private key to `demo-private.pem` and the public JWKS to
   `demo-jwks.json`. Both files are ignored by Git.
3. Creates an organization with the `writing` entitlement.
4. Registers the demo issuer and public JWKS with AIHUB.
5. Creates a development API key scoped to `writing.question.generate` and
   `writing.grade`.
6. Appends `DEMO_ORG_ID` and `DEMO_API_KEY` to `.env`.
7. Prints the API key and one initial `X-User-Assertion`.

The generated private key represents the private key that a real customer's
backend would hold. AIHUB verifies assertions with the public JWKS; it does not
create customer assertions.

`demo:bootstrap` is intentionally one-shot. It refuses to run again when
`.env` already contains `DEMO_API_KEY`, because doing so would create an
additional organization that is not recorded anywhere. Use the existing demo
credentials, or follow the reset procedure in [Cleanup](#cleanup).

## 4. Start AIHUB

Start the application in a separate terminal:

```bash
pnpm dev
```

The application loads `.env` at startup. Restart it after changing any
environment value.

Verify the health route:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

## 5. Prepare request credentials

Copy the `DEMO_API_KEY` value from the bootstrap output or from `.env` into a
local shell variable. Do not commit it or put it in browser code.

PowerShell:

```powershell
$env:AIHUB_BASE_URL = 'http://localhost:3000'
$env:AIHUB_API_KEY = '<paste DEMO_API_KEY here>'
```

Generate a fresh assertion immediately before a grading request:

```powershell
pnpm dev:assertion student_456
$env:AIHUB_ASSERTION = '<paste the JWT printed to stdout here>'
```

macOS/Linux:

```bash
export AIHUB_BASE_URL=http://localhost:3000
export AIHUB_API_KEY='<paste DEMO_API_KEY here>'
export AIHUB_ASSERTION="$(pnpm dev:assertion student_456)"
```

Assertions are valid for five minutes by default. Each assertion contains a
fresh `jti`, and its `sub` claim is the supplied user id.

## 6. Call the Writing API

### 6.1 Task 1 question generation (cheap routing check)

This is organization-scoped and does not require `X-User-Assertion`:

PowerShell:

```powershell
$headers = @{ 'X-API-Key' = $env:AIHUB_API_KEY }

Invoke-RestMethod `
  -Method Post `
  -Uri "$env:AIHUB_BASE_URL/v1/ielts/writing/task1/questions" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"chart_type":"Bar Chart"}' |
  ConvertTo-Json -Depth 10
```

macOS/Linux:

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/writing/task1/questions" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"chart_type":"Bar Chart"}'
```

A successful response has the common `{ "data", "meta" }` envelope. The
`meta.request_id` is generated by AIHUB and is the identifier to use when
reporting a problem.

### 6.2 Task 2 question generation

```powershell
$headers = @{ 'X-API-Key' = $env:AIHUB_API_KEY }

Invoke-RestMethod `
  -Method Post `
  -Uri "$env:AIHUB_BASE_URL/v1/ielts/writing/task2/questions" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"topic":"Technology","question_type":"opinion"}' |
  ConvertTo-Json -Depth 10
```

This operation is also organization-scoped. It accepts an optional
`Idempotency-Key` if replay-safe question generation is useful.

### 6.3 Task 2 grading (authenticated user flow)

Grading is user-scoped. It requires both the organization API key and a valid
user assertion. It also requires a new idempotency key for each logical
submission.

PowerShell:

```powershell
$idempotencyKey = [guid]::NewGuid().ToString()
$headers = @{
  'X-API-Key' = $env:AIHUB_API_KEY
  'X-User-Assertion' = $env:AIHUB_ASSERTION
  'Idempotency-Key' = $idempotencyKey
}
$body = @{
  question = 'With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?'
  topic = 'education'
  essay = 'The proliferation of online learning platforms has led some observers to claim that conventional classroom instruction is no longer relevant. While digital education has clear advantages, traditional teaching remains valuable for interaction and guidance.'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$env:AIHUB_BASE_URL/v1/ielts/writing/task2/grade" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $body |
  ConvertTo-Json -Depth 20
```

macOS/Linux:

```bash
IDEMPOTENCY_KEY="$(uuidgen)"

curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/writing/task2/grade" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Assertion: $AIHUB_ASSERTION" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "question": "With the rise of online learning platforms, some argue that traditional classroom education is becoming obsolete. To what extent do you agree or disagree?",
    "topic": "education",
    "essay": "The proliferation of online learning platforms has led some observers to claim that conventional classroom instruction is no longer relevant. While digital education has clear advantages, traditional teaching remains valuable for interaction and guidance."
  }'
```

The request may take several seconds because it reaches the real grading
service. The response should contain `meta.operation` equal to
`writing.task2.grade`.

### 6.4 Task 1 grading

Task 1 grading uses the same headers as Task 2 grading, but the body also
requires `chart_type` and a publicly reachable `image_url`:

```json
{
  "question": "The chart below shows the total number of minutes of telephone calls in the UK...",
  "chart_type": "Bar Chart",
  "image_url": "<a real chart image URL>",
  "essay": "The bar chart illustrates the total duration of telephone calls..."
}
```

Use the `image_url` returned by Task 1 question generation where possible.
Do not send `image_url` or `chart_type` to the Task 2 grading endpoint.

## 7. Verify idempotency

For a grading request, resend the identical body with the same
`Idempotency-Key`. AIHUB should return the stored successful result instead of
calling AI Writing again. The replay response is marked with:

```text
Idempotent-Replay: true
```

If the body changes while the key stays the same, AIHUB returns
`409 IDEMPOTENCY_CONFLICT`. A new logical submission needs a new key. When a
request fails validation, the idempotency record is not stored, so the body can
be fixed and retried.

## 8. Verify authentication failures

These checks confirm that the demo is using the real guards rather than the
local bypass.

| Check                                           | Expected status | Expected error code       |
| ----------------------------------------------- | --------------: | ------------------------- |
| Remove `X-API-Key`                              |             401 | `UNAUTHORIZED`            |
| Call a grading route without `X-User-Assertion` |             401 | `USER_ASSERTION_REQUIRED` |
| Use an expired or altered assertion             |             401 | `INVALID_USER_ASSERTION`  |
| Use a key without `writing.grade`               |             403 | `FORBIDDEN`               |
| Send an unknown body field                      |             400 | `INVALID_REQUEST`         |

The question-generation routes are organization-scoped, so they do not require
an assertion. If an assertion is supplied to any route, it must still be
valid; AIHUB does not silently ignore a broken assertion.

## 9. Run the Postman demo

Import [`aihub.postman_collection.json`](../aihub.postman_collection.json) into
Postman and set these collection variables:

| Variable        | Value                                               |
| --------------- | --------------------------------------------------- |
| `baseUrl`       | `http://localhost:3000`                             |
| `apiKey`        | The `DEMO_API_KEY` created by `demo:bootstrap`      |
| `userAssertion` | A fresh token from `pnpm dev:assertion student_456` |

Start with the four valid-routing requests (`1a` through `1d`), then run the
missing-assertion and idempotency scenarios. The collection also contains
negative cases that require a deliberately broken downstream stub, and two
metering cases that are marked blocked until the corresponding public metadata
exists. Those cases are not expected to pass against the default local setup.

If the collection needs regeneration after an API contract change:

```bash
pnpm generate:openapi
pnpm generate:postman
```

## 10. What the demo proves

For a grading request, the local flow is:

```text
X-API-Key
  → resolve organization and environment
X-User-Assertion
  → verify issuer, audience, timestamps, key id, and signature
  → extract the user id from `sub`
operation catalog and policy checks
  → validate, authorize, rate-limit, and enforce idempotency
Writing adapter
  → map the canonical request to AI Writing
downstream client
  → call AI Writing with the configured Phase 1 bearer token
public response
  → return the canonical `{ data, meta }` envelope
```

The customer app and customer backend are intentionally outside this demo. The
`dev-sign-assertion` script is only a local stand-in for the backend that would
normally authenticate the end user and sign the assertion with its private key.

## Troubleshooting

### `demo:bootstrap` says PostgreSQL is unavailable

Check the container and connection settings:

```bash
docker compose ps
docker compose logs postgres
pnpm migrate
```

Confirm that `DATABASE_URL` in `.env` matches the Compose configuration.

### The health route works but an API call returns `INTERNAL_ERROR`

The most common cause is a missing downstream token. Set
`DOWNSTREAM_AI_WRITING_TOKEN` in `.env` and restart `pnpm dev`.

### `UNAUTHORIZED`

Check that the request includes the raw `DEMO_API_KEY` in `X-API-Key`, that the
key was created for the `development` environment, and that
`AIHUB_ALLOW_UNAUTHENTICATED_DEV` is not being relied on unintentionally.

### `USER_ASSERTION_REQUIRED`

The grading route is user-scoped. Generate a fresh assertion and send it in
`X-User-Assertion`.

### `INVALID_USER_ASSERTION`

Generate a new token and check:

- the token has not expired;
- `DEMO_ASSERTION_ISSUER` matches the issuer registered by `demo:bootstrap`;
- the token was generated with the existing `demo-private.pem`;
- `demo-jwks.json` is the public key registered for the demo organization.

Do not replace only one half of the key pair. If the signing material changes,
the public key must be registered again with `identity:set`.

### `AI_SERVICE_UNAVAILABLE`, `AI_SERVICE_TIMEOUT`, or `AI_SERVICE_ERROR`

Check network access to `DOWNSTREAM_AI_WRITING_URL`, the downstream token, and
the AI Writing service status. The local gateway cannot make a downstream
service available.

### `DEMO_API_KEY` already exists when bootstrapping

This is the expected protection against creating orphaned demo organizations.
Use the existing credentials, or reset the disposable local database as
described below.

## Cleanup

Stop the application with `Ctrl+C`, then stop the dependency containers:

```bash
docker compose down
```

This preserves the PostgreSQL volume, so the demo organization and API key are
still available next time. To reset a disposable local database completely:

```bash
docker compose down -v
```

`down -v` permanently deletes the local Compose volumes, including all local
AIHUB control-plane data. Use it only when losing the local demo organization,
API keys, and idempotency records is acceptable.

## Related documentation

- [Repository quick start](../README.md)
- [Customer integration guide](integration-guide.md)
- [API contract](aihub_deliverable_1_api_contract_schema.md)
- [Request lifecycle](superpowers/specs/2026-09-07-aihub/02-request-lifecycle.md)
- [Authentication and identity design](superpowers/specs/2026-09-07-aihub/05-auth-identity.md)
- [Demo bootstrap script](../scripts/demo-bootstrap.mjs)
- [Demo assertion script](../scripts/dev-sign-assertion.mjs)
