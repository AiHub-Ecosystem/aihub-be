# ADR-0130: Collection routes are paginated by limit and cursor

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-29 in [#276](https://github.com/AiHub-Ecosystem/aihub-be/issues/276).
- Date: 2026-10-29
- Related: [ADR-0040](0040-organization-audit-read-boundary.md), [ADR-0051](0051-organization-membership-list-read-boundary.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0129](0129-public-route-and-response-convention.md), [#276](https://github.com/AiHub-Ecosystem/aihub-be/issues/276), [#896](https://github.com/AiHub-Ecosystem/aihub-be/issues/896)

## Context

The `/v1` Public API previously exposed unbounded collection listing routes, specifically `GET /v1/organizations/{organization_id}/members` and `GET /v1/organizations/{organization_id}/invitations`. For large organizations, querying and serializing every member or invitation in a single HTTP response causes unbounded memory consumption, latency spikes, and payload inflation.

Organization audit events were already cursor-paginated under ADR-0040, but AIHUB lacked an agreed, uniform pagination convention for resource collections. Issue #276 tracks bounding membership and open invitation lists, and issue #896 addresses the cross-Organization roster. AIHUB needs a single, consistent pagination convention across all current and future collection endpoints.

## Decision

- **Parameters.** Collection listing routes accept two optional query parameters: `limit` and `cursor`. The parameter `limit` is an integer constrained to a default of 100 and a maximum of 500. Values outside the [1, 500] range are refused with `400 INVALID_REQUEST` rather than clamped, preventing silent truncation that could be confused with the end of a collection. Audit events retain their existing page bounds (default 50, maximum 200) because audit records carry heavier payloads (target labels, structured detail blobs, request metadata, and actors).
- **Response Shape.** Collection responses place results in `data.<collection>` alongside a required `data.next_cursor` property. `data.next_cursor` is a non-empty opaque string when further items exist, and `null` on the terminal page. An empty collection returns an empty array and `next_cursor: null`.
- **Cursor Semantics.** A cursor is a position indicator only; it conveys no authorization and grants no access. Caller authentication, tenant scope, caller role permissions, organization active status, and query filters (such as active vs. disabled membership status) are re-evaluated on every page request. The cursor carries a scope tag, an unkeyed truncated SHA-256 of the Organization ID and the active filters. The tag detects a cursor replayed under another scope; it is an integrity check, not a secret and not a security boundary. Submitting a cursor minted under one scope to another Organization or different filter criteria fails with `400 INVALID_REQUEST` with details, without introducing a new error code. A malformed or stale cursor fails the same way.
- **Keyset Ordering.** Pagination uses deterministic keyset ordering. Members are ordered by immutable username ascending. Open invitations are ordered by creation timestamp descending, then `id` ascending. Implementations fetch `limit + 1` rows to determine whether a subsequent page exists without issuing an expensive count query. For membership, authorization verification and row retrieval remain within a single query snapshot (per ADR-0051).
- **Live Reads.** A collection traversal is a live read, not a point-in-time snapshot. Rows inserted before the current cursor position appear only after restarting the traversal from the beginning. Rows deleted, expired, or modified to no longer match the filter between requests may disappear from subsequent pages. Any row that remains unchanged throughout the traversal is returned exactly once.
- **Scope and Adoption.** This convention applies immediately to the Organization membership list and open invitation list in `/v1` (issue #276). The cross-Organization roster (issue #896) and all future collection listing routes follow this convention.

## Consequences

Clients with large collections must paginate by forwarding `data.next_cursor` until `null` is received. Adding optional query parameters and an extensible `next_cursor` field preserves backwards compatibility under `/v1` (ADR-0127), while immediately bounding gateway and database resource consumption. Published OpenAPI schemas and documentation reflect the pagination parameters, bounds, and live-read semantics.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-29 in #276. Verified by route/controller unit tests, database-lane integration tests for keyset navigation and scope isolation, and API documentation/contract drift tests.
