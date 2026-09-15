# AIHUB Local Demo

This guide runs the shipped Writing slice and the synchronous Speaking grading
proxy locally, sending real requests through:

```text
curl / Postman → AIHUB → AI Writing or AI Speaking
```

It also exercises the organization API key and the customer-style user assertion
flow. There is no customer app or customer backend in this repository. The
`dev:assertion` script stands in for that backend by signing a short-lived JWT.

> **Cost warning:** Writing grading reaches model-backed AI services and may
> consume provider quota. Speaking also requires valid
> provider configuration and an audio file.

## What you need

- Node.js 22 or newer
- pnpm 11 (the repository pins `pnpm@11.20.0`)
- Docker Desktop or another Docker Compose implementation
- A valid AI Writing bearer token from the AI Writing team (for Writing calls)
- AI Speaking Dev URL and server-side `x-client-id`/`x-secret-key` values (for
  Speaking calls; obtain them from the provider/WISPACE owner)
- Ports `3000`, `5432`, and `6379` available locally

The demo uses:

| Component   | Local address                              | Purpose                                               |
| ----------- | ------------------------------------------ | ----------------------------------------------------- |
| AIHUB       | `http://localhost:3000`                    | Public gateway                                        |
| PostgreSQL  | `localhost:5432`                           | Organizations, API keys, identity config, idempotency |
| Redis       | `localhost:6379`                           | Credential cache, rate limits, concurrency protection |
| AI Writing  | configured by `DOWNSTREAM_AI_WRITING_URL`  | Downstream AI service                                 |
| AI Speaking | configured by `DOWNSTREAM_AI_SPEAKING_URL` | Synchronous multipart and JSON-by-URL grading service |

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

Then start AIHUB and call a grading endpoint without an API key.
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
AIHUB_RUNTIME_SECRET_SOURCE=env
DOWNSTREAM_AI_WRITING_TOKEN=<token supplied by the AI Writing team>
```

To run the Speaking demo, also set the provider-owned Dev configuration. These
values stay in `.env` or a secret manager; they are never sent by the client:

```dotenv
DOWNSTREAM_AI_SPEAKING_URL=<AI Speaking Dev origin>
DOWNSTREAM_AI_SPEAKING_CLIENT_ID=<Dev client id>
DOWNSTREAM_AI_SPEAKING_SECRET_KEY=<Dev secret key>
```

The explicit `env` source is allowed only for local development and tests. The
runtime-secret provider validates both active downstream credential bundles at
startup, so fill the Speaking values before starting the gateway even when a
particular request flow is not being exercised. Restart AIHUB after changing
any downstream setting.

For Dev/Staging/Production, use the Vault Agent-rendered JSON source instead of
placing credentials in deployment environment variables. See the [Vault
runtime-secret runbook](operations/vault-runtime-secrets.md).

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
3. Creates an organization with the `writing` and `speaking` entitlements.
4. Registers the demo issuer and public JWKS with AIHUB.
5. Creates a development API key scoped to `writing.grade` and
   `speaking.grade`.
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

### 6.1 Task 2 grading (authenticated user flow)

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

### 6.2 Task 1 grading

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

Use a chart image URL that your application already owns or has permission to
share with the downstream grading service.
Do not send `image_url` or `chart_type` to the Task 2 grading endpoint.

### 6.3 Speaking grading (synchronous multipart proxy)

Speaking grading is user-scoped and requires the organization API key plus a
fresh `X-User-Assertion`. The client uploads one audio file and sends `part`
and `question_id`; AIHUB derives the downstream `user_id` from the verified
assertion. Do not send `user_id` from the client.

The accepted audio extensions are `wav`, `mp3`, `m4a`, `webm`, and `ogg`. The
file must be at least 100 bytes and the whole multipart request is capped at
25 MiB. The examples below assume a local `sample.wav` that is safe to send to
the configured AI Speaking Dev service.

PowerShell 7:

```powershell
$headers = @{
  'X-API-Key' = $env:AIHUB_API_KEY
  'X-User-Assertion' = $env:AIHUB_ASSERTION
}
$form = @{
  audio = Get-Item -LiteralPath '.\sample.wav'
  part = '1'
  question_id = 'p1_hometown'
  prompt_text = 'Do you enjoy living in your hometown?'
  test_type = 'Practice'
}

Invoke-RestMethod `
  -Method Post `
  -Uri "$env:AIHUB_BASE_URL/v1/ielts/speaking/grading" `
  -Headers $headers `
  -Form $form |
  ConvertTo-Json -Depth 30
```

macOS/Linux:

```bash
curl -sS -X POST "$AIHUB_BASE_URL/v1/ielts/speaking/grading" \
  -H "X-API-Key: $AIHUB_API_KEY" \
  -H "X-User-Assertion: $AIHUB_ASSERTION" \
  -F "audio=@sample.wav;type=audio/wav" \
  -F 'part=1' \
  -F 'question_id=p1_hometown' \
  -F 'prompt_text=Do you enjoy living in your hometown?' \
  -F 'test_type=Practice'
```

The response uses the common `{ "data", "meta" }` envelope and has
`meta.operation` equal to `speaking.grading`. The normalized data contains the
scorability, estimated band, transcript, relevance, fluency, pronunciation,
language-analysis, and feedback groups. Provider `performance_timing` is
intentionally omitted; gateway timing remains in `meta.timing`. The current
automated fixture is contract-based; run an authenticated Dev smoke test before
treating the provider response shape as live-compatible.

### 6.4 Speaking grading by approved audio URL

The JSON fallback uses the same headers and metadata but sends an approved
object URL instead of an uploaded file. AIHUB accepts only HTTPS URLs on
`s3.wispace.app`, allows query parameters for signed URLs, and does not
download the object itself. Do not send `user_id`; it is derived from the
assertion.

PowerShell 7:

```powershell
$json = @{
  audio_url = 'https://s3.wispace.app/audio/sample.mp3?signature=demo'
  part = 1
  question_id = 'p1_hometown'
  prompt_text = 'Do you enjoy living in your hometown?'
  test_type = 'Practice'
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "$env:AIHUB_BASE_URL/v1/ielts/speaking/grading-json" `
  -Headers $headers `
  -ContentType 'application/json' `
  -Body $json |
  ConvertTo-Json -Depth 30
```

macOS/Linux:

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

The response uses the same normalized envelope with
`meta.operation` equal to `speaking.grading-json`. The 30-second Speaking
deadline and no-idempotency behavior are unchanged.

## 7. Verify idempotency

For a Writing grading request, resend the identical body with the same
`Idempotency-Key`. AIHUB should return the stored successful result instead of
calling AI Writing again. The replay response is marked with:

```text
Idempotent-Replay: true
```

If the body changes while the key stays the same, AIHUB returns
`409 IDEMPOTENCY_CONFLICT`. A new logical submission needs a new key. When a
request fails validation, the idempotency record is not stored, so the body can
be fixed and retried. Speaking grading is synchronous but currently has no
idempotency key; do not expect an idempotent replay header for that route.

## 8. Verify authentication failures

These checks confirm that the demo is using the real guards rather than the
local bypass.

| Check                                           | Expected status | Expected error code       |
| ----------------------------------------------- | --------------: | ------------------------- |
| Remove `X-API-Key`                              |             401 | `UNAUTHORIZED`            |
| Call a grading route without `X-User-Assertion` |             401 | `USER_ASSERTION_REQUIRED` |
| Use an expired or altered assertion             |             401 | `INVALID_USER_ASSERTION`  |
| Use a key without `writing.grade`               |             403 | `FORBIDDEN`               |
| Use a key without `speaking.grade`              |             403 | `FORBIDDEN`               |
| Send an unknown body field                      |             400 | `INVALID_REQUEST`         |

All retained Writing routes are user-scoped, so they require a valid assertion.
AIHUB does not silently ignore a broken assertion.

## 9. Run the Postman demo

Import [`aihub.postman_collection.json`](../aihub.postman_collection.json) into
Postman and set these collection variables:

| Variable        | Value                                               |
| --------------- | --------------------------------------------------- |
| `baseUrl`       | `http://localhost:3000`                             |
| `apiKey`        | The `DEMO_API_KEY` created by `demo:bootstrap`      |
| `userAssertion` | A fresh token from `pnpm dev:assertion student_456` |

Start with the two valid grading requests (`1a` and `1b`), then run the
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
  → validate, authorize, rate-limit, and apply operation-specific replay policy
Writing adapter (JSON)
  → map the canonical request to AI Writing
Speaking parser and adapter (multipart or JSON-by-URL)
  → map the canonical request to AI Speaking
downstream client
  → call each service with its trusted, environment-specific credentials
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

The most common cause is missing runtime-secret configuration. For local
development, set `AIHUB_RUNTIME_SECRET_SOURCE=env` plus
`DOWNSTREAM_AI_WRITING_TOKEN`, `DOWNSTREAM_AI_SPEAKING_CLIENT_ID`, and
`DOWNSTREAM_AI_SPEAKING_SECRET_KEY` in `.env`, then restart `pnpm dev`. For a
Vault Agent deployment, check the rendered file path and required bundle keys;
the process fails closed when the file is absent or malformed.

### `AI_SERVICE_ERROR` or `AI_SERVICE_TIMEOUT` on Speaking

Confirm that the configured Speaking origin is the Dev service, the provider
credentials belong to that environment, and the audio file is supported and
within the 25 MiB limit. Provider credentials are server-side only; do not put
them in curl, Postman, browser code, or the multipart form.

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
