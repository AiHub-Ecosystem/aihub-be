# ADR-0133: The cross-Organization roster is paginated by Organization

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-30 in [#896](https://github.com/AiHub-Ecosystem/aihub-be/issues/896).
- Date: 2026-10-30
- Amends: [ADR-0028](0028-organization-roster-read-boundary.md)
- Related: [ADR-0134](0134-bounding-an-existing-collection-is-a-breaking-change-accepted-once-under-v1.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [ADR-0130](0130-collection-routes-are-paginated-by-limit-and-cursor.md), [#896](https://github.com/AiHub-Ecosystem/aihub-be/issues/896), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)

## Context

`GET /v1/organizations/me/members` returns every Organization the caller belongs to, and inside each one every active member. ADR-0028 left it unpaginated on purpose and named pagination as the follow-up "if roster size requires it". Two things are unbounded: the number of Organizations (a user may create at most three, but may be invited to any number) and the number of members in each. One response can therefore grow without limit, which ADR-0130 already ruled out for the other collection routes.

Customer Web reads this route to decide where to send a user after sign-in and to build the Organization directory. It does not read `members[]`.

## Decision

- **The page is a page of Organizations.** The route accepts `limit` and `cursor`. `limit` is an integer from 1 to 100, default 100; a value outside the range answers `400 INVALID_REQUEST`, as in ADR-0130. The maximum is 100 rather than 500 because each row carries a member list.
- **Order.** Organizations are ordered by `organization_id` ascending, the order the route already used. The cursor holds the last `organization_id` returned. A page never splits one Organization.
- **Members are capped, not paged.** Each Organization lists its first 100 active members by username. A new required `member_count` gives the total number of active members, so a client can tell that the list is cut. The members of a larger Organization remain reachable through `GET /v1/organizations/{organization_id}/members`, which ADR-0130 paginates; that route needs an owner or admin role, so a plain member of a large Organization cannot read the rest. That gap stays open until a member-readable members route exists (see below).
- **Response.** `data.next_cursor` is required: a non-empty string when more Organizations exist, `null` on the last page. An empty roster returns an empty array and `null`.
- **Cursor.** The cursor is bound to the caller's user, through the shared cursor codec. A cursor from another caller, a malformed one, and a stale one answer `400 INVALID_REQUEST`, with no new error code.
- **Live reads.** As in ADR-0130, a traversal is a live read. Membership is checked again on every page, so an Organization the caller left between pages disappears, and one the caller joined behind the cursor appears only on a new traversal. Suspended Organizations stay in the roster, as ADR-0028 requires.
- **Closed query.** The route takes a closed query schema, as the other collection routes do, so a query parameter other than `limit` and `cursor` answers `400 INVALID_REQUEST`. The route ignored every query parameter before. This narrows what a request may carry; the repository accepts it because the route had no documented parameters and Customer Web sends none, and the changelog names it.
- **Compatibility.** Both optional query parameters and the two new response fields are additive for `/v1` clients that ignore unknown fields. A client with fewer than 100 Organizations that never sends `limit` sees one page. A client that treated `members[]` as complete for an Organization of more than 100 members now sees a cut list; `member_count` is how it learns that. A client that sent an undocumented query parameter now gets `400`. [ADR-0134](0134-bounding-an-existing-collection-is-a-breaking-change-accepted-once-under-v1.md) classifies this bounding as breaking in meaning and records why it is accepted once under `/v1`.
- **Cost.** The response is bounded; the database work per page is bounded by the active members of at most 100 Organizations, because `member_count` needs a count over all of an Organization's active members. The membership key and the page size keep that acceptable; a stored count is the next step if a profile shows otherwise.

## Consequences

The contract moves by a minor version. Customer Web's pinned contract and its e2e mock gain the two fields before AIHUB ships them (a response missing a required field fails the mock's schema check). Customer Web must follow `next_cursor` to list more than 100 Organizations; below that nothing changes for it.

Capping members is a deliberate half-measure: it bounds the response without a second route. The clean end state is a members route that a plain member may read, after which the embedded `members[]` can be removed. Removing it is a breaking change, so it is a candidate for the first `/v2` change (#1374), not a reason to open `/v2` on its own.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-30 in #896. A database-lane spec covers a page boundary between Organizations, an Organization of more than 100 members reporting its total in `member_count`, an invalid or foreign or stale cursor, a membership removed between pages, a suspended Organization, disabled members, a last page that is exactly full, and a cursor past the last row. Unit and controller specs cover the `limit` bounds and the response shape.
