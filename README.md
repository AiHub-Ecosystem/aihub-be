# AIHUB Backend

AIHUB is a B2B multi-tenant AI API Gateway and identity broker. The backend is a single NestJS/Fastify application. The first MVP slice is the Writing service; the gateway owns organization identity, scopes, metering, quota, idempotency, and typed dispatch while Writing owns its business data and model behavior.

## Quick start

```text
pnpm install
pnpm dev
```

The bootstrap health route is `GET http://localhost:3000/health`. The Writing
question route requires a real API key when `AIHUB_ALLOW_UNAUTHENTICATED_DEV`
is not enabled.

For a local authenticated run, copy `.env.example` to `.env`, start
PostgreSQL and Redis, then apply the control-plane migration:

```text
docker compose up -d
pnpm migrate
pnpm cli org:create --name "Acme Edu" --entitlements writing
pnpm cli key:create --org org_... --name "Local backend" --scopes writing.question.generate --envs development
```

Schedule `pnpm cli idempotency:cleanup` from the deployment environment once
per night to remove expired idempotency records. The command reports the
deleted row count and exits non-zero when PostgreSQL is unavailable.

The key command prints the raw API key once. Store it outside the repository
and send it as `X-API-Key`.

## Verification

```text
pnpm test
pnpm type-check
pnpm arch-check
pnpm verify
```

`pnpm verify` runs Biome, strict TypeScript, Jest, and the Clean Architecture dependency check.

## Source layout

```text
src/common/       shared errors, request context, and redaction
src/catalog/      typed operation routing metadata
src/contracts/    TypeBox boundary contracts
src/modules/      identity, gateway, and Writing application seams
src/downstream/   pure AI-service request/response adapter seams
test/             integration/e2e tests when external boundaries exist
```

Read [CONTEXT.md](CONTEXT.md) for the short glossary, then the [spec index](docs/superpowers/specs/2026-09-07-aihub/README.md) before changing behavior. Shared workflow rules live in [AGENTS.md](AGENTS.md); Claude-specific routing lives in [CLAUDE.md](CLAUDE.md) and `.claude/`.

The Writing grading response contract is resolved. The live service was called on 2026-09-07, the captured responses are committed under `test/fixtures/ai-writing/`, and the shared grading parser is implemented against them.

The rule that produced that fixture still stands for every other service: never write a parser from a guess. Capture a real response first, commit it as a fixture, and map from that.
