# ADR-0166: AIHUB serves the legacy content backend's public lists

- Status: Superseded by [ADR-0167](0167-v2-ielts-practice-content-cursor-pagination.md)
- Date: 2026-11-14
- Related: [ADR-0009](0009-pure-downstream-adapters.md), [ADR-0059](0059-non-dispatch-public-api-routes-have-their-own-registry.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [#1914](https://github.com/AiHub-Ecosystem/aihub-be/pull/1914), [#1916](https://github.com/AiHub-Ecosystem/aihub-be/issues/1916), [#455](https://github.com/AiHub-Ecosystem/aihub-be/issues/455)

## Context

The team asked AIHUB to serve four lists that the legacy content backend at `https://backend.aihubproduction.com` already answers without authentication: Writing templates (`GET /api/WritingTemplate`, selected by an `X-Task-Type` header), the Speaking library (`GET /api/Speaking/library`), and the Listening and Reading test lists (`GET /v1/listening/tests`, `GET /v1/reading/tests`). The request was explicit that no authentication is needed.

The legacy backend is not an AI Service. AIHUB sends it no internal JWT, nothing about it is graded or metered, and no Organization or End-User ID is involved. Two of the four paths use the legacy `/api/` prefix, which sits outside the versioned Public API Contract (ADR-0127). Some fields in the legacy responses are per-user (`attemptCount`, `user_attempt_count`, `done_count`, `not_done_count`), and Writing templates carry their author's `userId` and `userName`.

## Decision

- A `content-proxy` module serves the four routes. They are non-dispatch routes: they do not enter the Operation Catalog, the graded-request chain, quota, or metering (ADR-0059).
- The host comes from trusted configuration, `AIHUB_LEGACY_BACKEND_URL`, which defaults to the production legacy backend. Callers cannot choose a host.
- The routes take no caller authentication and resolve no Organization. AIHUB forwards no user identity upstream, so per-user fields always show the anonymous view.
- `/v1/listening/tests` and `/v1/reading/tests` are Public API Routes, registered in the public route registry and published in the `/v1` contract from `1.13.0`. They accept `page` and `pageSize`, the names the legacy backend honours. `/api/WritingTemplate` and `/api/Speaking/library` keep the legacy paths the callers already use; ADR-0127 places them outside the versioned contract, so they are served but not published in OpenAPI.
- Request input is validated with closed schemas at the boundary. Responses are mapped, not passed through: the legacy body is cleaned to closed public schemas built from captured fixtures, then checked. Undeclared upstream fields, including the Writing template author, are dropped. A required field that disappears or changes type is an `AI_SERVICE_CONTRACT_VIOLATION`.
- Mapping lives in the infrastructure client rather than in a pure adapter under `src/downstream` (ADR-0009), because no dispatch runs through the downstream seam here. The client still holds no policy beyond map, validate, and translate errors.
- Upstream failures reuse the existing `AI_SERVICE_*` codes rather than adding codes the Customer Web contract would first have to list: a `4xx` is `AI_SERVICE_ERROR` (502), a `5xx` or connection failure is `AI_SERVICE_UNAVAILABLE` (503), the 10-second deadline is `AI_SERVICE_TIMEOUT` (504), and a body that is not JSON or does not match is `AI_SERVICE_CONTRACT_VIOLATION` (502).
- The client does not retry, has no circuit breaker, and caches nothing. AIHUB adds no rate limit of its own to these routes; that follow-up is [#1916](https://github.com/AiHub-Ecosystem/aihub-be/issues/1916).

## Considered options

- An nginx `proxy_pass` to the legacy host needs no application code, but the legacy body, including the author fields, reaches the caller unchanged, failures do not use AIHUB's error envelope, and nothing records the contract.
- A pass-through forwarder in the application has the same exposure and adds a hop without adding a contract.
- Dispatching through the Operation Catalog would make each route carry a scope, a User Identity, quota, metering, and an internal token, none of which apply, and would widen `OperationId` with routes that grade nothing (ADR-0059).
- Republishing the two `/api/` routes under `/v1` would bring them into the versioned contract, but the callers asked for the legacy paths; moving them is a later, separate change.

## Consequences

- The two `/v1` routes are part of the published contract, so removing or renaming them is a breaking change under ADR-0127. The `/api/` routes and the module can be removed without a contract change.
- A legacy schema change that removes or retypes a required field turns that route into `502` until the public schema is updated from a new capture. New upstream fields are dropped silently.
- Per-user counts are never personal to the caller. A frontend that needs them must call a route that knows the user.
- Anonymous traffic reaches the legacy backend through one Node process with no AIHUB limit until #1916 and the edge limit in #455 land.

## Reopen when

- A caller needs the per-user view: the routes would then need caller authentication and a way to forward the user to the legacy backend.
- Traffic or latency shows the legacy backend or the AIHUB process strained: add a short response cache or a stricter limit.
- The legacy backend gains its own versioned API, or the `/api/` routes need to join the versioned contract.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-11-14 in #1914. The routes it describes are the behavior #1914 ships.
