# ADR-0135: A method a route does not accept answers 404

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-30 in [#1404](https://github.com/AiHub-Ecosystem/aihub-be/issues/1404).
- Date: 2026-10-30
- Related: [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [ADR-0134](0134-bounding-an-existing-collection-is-a-breaking-change-accepted-once-under-v1.md), [#305](https://github.com/AiHub-Ecosystem/aihub-be/issues/305), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374), [#1404](https://github.com/AiHub-Ecosystem/aihub-be/issues/1404)

## Context

`DELETE /v1/ielts/writing/task2/grade` answers `404 NOT_FOUND`, the same as a path that does not exist (checked in Production on 2026-10-09, #305). A `405 Method Not Allowed` with an `Allow` header would tell an integrator that the URL is right and the method is wrong. ADR-0129 left the question out of scope.

The `404` is not a choice the HTTP filter makes. Fastify's router, which Nest runs on, keeps one route table per method and answers `404` for a method it has no route for; probed on 2026-10-30, `DELETE` and `PUT` on a path registered for `GET` answer `404` with no `Allow`. Nothing in AIHUB raises a `405`. The `[405, NOT_FOUND]` entry in `http-exception.filter.ts` is a leftover that only a library or a future change could reach.

## Decision

- **Keep `404 NOT_FOUND`.** A request with a method the route does not accept answers `404 NOT_FOUND` with the standard envelope and no `Allow` header, like an unknown path. AIHUB does not add `405`, a `METHOD_NOT_ALLOWED` error code, or an `Allow` header.
- **Why.**
  - A route that belongs to another environment has to look absent. The Sandbox mint route answers `404` before API-key authentication in Production, and `sandbox-api-key.guard.ts` answers `NOT_FOUND` likewise. A `405` computed from the route catalog would answer `405` to `GET /v1/sandbox/assertions` in Production while `POST` answers `404`, so it would show that the route exists. A `405` that is environment-aware needs a second lookup beside the router, for every route.
  - A real `405` needs a router lookup by path, an error code, a Customer Web policy change merged first (otherwise `Customer Web contract` fails and a red `main` skips deployment), the `Allow` header, a documented response on about fifty operations, and a minor contract version. The gain is a clearer answer to a mistake that no integrator has reported; the Integration Guide already tells readers to check the path and the method against OpenAPI.
- **What is not the reason.** The suspicion in #1404 that a `405` lets a caller enumerate paths does not hold: `/openapi.json` and `/docs` are public and list every path. This ADR does not rest on it.
- **A 405 raised by code is still a 404.** The filter answers an `HttpException` with status `405` as `404 NOT_FOUND`, in status and in code. Before this ADR it would have sent HTTP `405` with a `NOT_FOUND` body and no `Allow`; the mapping now matches the decision.
- **Compatibility.** A wrong method was never a documented outcome of the contract, so answering it differently later is not a breaking change (compare ADR-0134 on undocumented query parameters). Nothing changes now, and the contract version does not move.
- **Revisit when** the first `/v2` opens (#1374), where a new error code can ride with a change that is already breaking, or when an Active Consumer reports being misled by the `404`. A `405` would then be environment-aware or limited to routes served in every environment.

## Consequences

Integrators who send the wrong method keep seeing `404`. The Integration Guide says so, in the error table and beside the note on `/v1/speaking/grading`. Two specs fix the behaviour: one against the application (`DELETE` on a graded route and `PUT` on a management route answer `404 NOT_FOUND` with no `Allow`) and one on the filter (a `405` becomes `404`).

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-30 in #1404. `organization-membership.controller.spec.ts` and `http-exception.filter.spec.ts` carry the specs above.
