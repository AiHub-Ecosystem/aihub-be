# ADR-0167: Publish IELTS practice content on /v2 with cursor pagination

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-11-14
- Date: 2026-11-14
- Supersedes: [ADR-0166](0166-proxy-legacy-content-backend-lists.md)
- Related: [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [ADR-0130](0130-collection-routes-are-paginated-by-limit-and-cursor.md), [ADR-0142](0142-a-released-contract-defect-is-corrected-through-an-accepted-change-entry.md)

## Context

ADR-0166 temporarily proxied four unauthenticated endpoints (`/api/WritingTemplate`, `/api/Speaking/library`, `/v1/listening/tests`, `/v1/reading/tests`) directly from the legacy backend. As identified in review, this deviated from AIHUB architectural conventions:

1. Exam content routes should live under the `/vN/ielts/<skill>/...` prefix (ADR-0129).
2. Collection routes must paginate with `limit` and `cursor`, returning `{ data: { <collection>, next_cursor } }` (ADR-0130), rather than upstream `page`/`pageSize` and camelCase metadata.
3. Upstream response properties used camelCase (`taskType`, `imageUrl`), inconsistent with AIHUB's snake_case schema conventions.
4. Public `/v1` is deprecated (sunset 2027-11-02 per ADR-0127), so new feature additions belong on active major `/v2`.
5. No client or frontend has integrated the unversioned `/api/*` or temporary `/v1` routes yet.

## Decision

1. **Retire temporary routes**: Remove `/api/WritingTemplate`, `/api/Speaking/library`, `/v1/listening/tests`, and `/v1/reading/tests`. Removing the two `/v1` routes from `/v1` contract 1.13.0 is recorded as an accepted breaking change in `accepted-breaking-changes.json` under ADR-0142 since no consumer integrated them in the few hours since publication.
2. **Publish on /v2**: Publish five clean, unauthenticated endpoints on `/v2` under the `ielts` prefix:
   - `GET /v2/ielts/writing/task1/templates`
   - `GET /v2/ielts/writing/task2/templates`
   - `GET /v2/ielts/speaking/library`
   - `GET /v2/ielts/listening/tests`
   - `GET /v2/ielts/reading/tests`
3. **Cursor pagination**: All five routes accept optional `limit` (integer 1..200, default 20) and `cursor` (opaque base64url string encoding `{ page: number }`), conforming to ADR-0130. Responses return `{ data: { <items>, next_cursor } }`.
4. **Canonical snake_case schemas**: Response items are strictly mapped from upstream payloads into canonical snake_case TypeBox schemas. Author fields (`user_id`, `user_name`) and user attempt metrics (`user_attempt_count`, `attempt_count`) are dropped from anonymous public responses.
5. **Contract versioning**: `/v1` moves to `1.14.0` (with accepted deletion entry); `/v2` contract moves to `2.7.0`.

## Consequences

- The public API surface for IELTS practice content is consistent with ADR-0129 and ADR-0130 across all skills.
- The temporary `/api/*` and `/v1` endpoints are completely removed.
- Clients paginate uniformly via `limit` and `cursor`.
