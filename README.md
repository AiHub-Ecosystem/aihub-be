# AIHUB Backend

AIHUB gives education platforms a server-to-server API for IELTS Writing and
Speaking assessment. Your backend sends a grading request to AIHUB and receives
the result; keep AIHUB credentials on your server, never in a browser or mobile
app.

## Customer API

| Capability                             | Endpoint                               | Request                     |
| -------------------------------------- | -------------------------------------- | --------------------------- |
| Grade IELTS Writing Task 1             | `POST /v1/ielts/writing/task1/grade`   | JSON essay request          |
| Grade IELTS Writing Task 2             | `POST /v1/ielts/writing/task2/grade`   | JSON essay request          |
| Grade IELTS Speaking audio             | `POST /v1/ielts/speaking/grading`      | Multipart audio upload      |
| Grade IELTS Speaking from an audio URL | `POST /v1/ielts/speaking/grading-json` | JSON request with audio URL |

For a customer-facing API docs UI, show these four downstream grading
operations. The public Speaking question catalog at
`GET /v1/ielts/speaking/questions` is a separate supporting endpoint, not an AI
service proxy. Account, sign-in, and Organization-management routes are also
outside that product docs scope. The backend's generated `/docs` reference
currently covers the complete API, not just the customer integration surface.

## Authentication at a Glance

Grading requests use an Organization API key in `X-API-Key` and an end-user
identity in `X-User-Identity`. By default, the identity can be your stable user
ID as plain text; this mode does not require JWKS. Signed User Assertions are
optional and apply only when an Organization enables signed identity
verification. The [integration guide](docs/integration-guide.md) explains both
modes, onboarding, request formats, retries, and error codes.

## Local Development

Use Node.js 22.22.3 or newer and pnpm 11. The full local setup, environment
configuration, and demo requests are in the [local demo guide](docs/local-demo.md).

```bash
pnpm install
pnpm dev
```

The local health check is `GET http://localhost:3000/health`. Run the repository
verification suite with `pnpm verify`.
