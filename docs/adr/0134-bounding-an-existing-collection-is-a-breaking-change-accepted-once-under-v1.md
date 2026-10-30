# ADR-0134: Bounding an existing collection is a breaking change, accepted once under /v1

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-30 in [#1411](https://github.com/AiHub-Ecosystem/aihub-be/issues/1411).
- Date: 2026-10-30
- Amends: [ADR-0127](0127-public-api-uri-major-versioning.md)
- Related: [ADR-0028](0028-organization-roster-read-boundary.md), [ADR-0051](0051-organization-membership-list-read-boundary.md), [ADR-0130](0130-collection-routes-are-paginated-by-limit-and-cursor.md), [ADR-0133](0133-the-cross-organization-roster-is-paginated-by-organization.md), [#276](https://github.com/AiHub-Ecosystem/aihub-be/issues/276), [#896](https://github.com/AiHub-Ecosystem/aihub-be/issues/896), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374), [#1411](https://github.com/AiHub-Ecosystem/aihub-be/issues/1411), [#1412](https://github.com/AiHub-Ecosystem/aihub-be/issues/1412)

## Context

Three `/v1` routes returned a whole collection and now return a page: the Organization member list and the open invitation list (#276, contract 1.2.0), and the cross-Organization roster (#896, contract 1.4.0), whose embedded `members[]` is also capped. ADR-0130 called the optional `limit` and `cursor` parameters and the `next_cursor` field compatible. ADR-0127 calls changing the meaning of an existing field breaking. The two were never reconciled, and the compatibility gate cannot reconcile them: it sees an added optional parameter and an added response property, and passes.

The meaning did change. An array such as `members[]` or `invitations[]` used to be the complete collection; it is now one page. A client that ignores `next_cursor` receives a shorter list and no error.

## Decision

- **Classification.** Bounding a collection that was returned whole is a breaking change in meaning, whatever the OpenAPI diff says. A passing compatibility gate is not evidence that collection semantics are unchanged.
- **Accepted once, under `/v1`.** The three bounds above stay in `/v1` as an owner-approved exception to ADR-0127 rather than moving to `/v2`, on this evidence, gathered on 2026-10-30:
  - Production held 6 Organizations, at most 1 active member in any of them, no open invitation, and no user in more than 1 Organization, so no response was cut. Customer Web calls only the roster, through its BFF, and no consumer of the member or invitation lists is known.
  - The normal rollback target (contract 1.3.0 for the roster, 1.1.4 for the other two) ignores `limit` and `cursor` on the roster and the invitation list and returns the whole collection, so a client that treats a missing `next_cursor` as the end of the list keeps working. Its member list has a closed query and answers `400` to `limit` and `cursor`; no known client sends them, which is why this is acceptable and not a general rollback guarantee.
  - The alternative, keeping the unbounded response under `/v1`, leaves a response that grows without limit, which ADR-0130 rules out.
- **From now on.** A new collection route is paginated in its first release (ADR-0130). Bounding any other collection that is returned whole needs the same kind of evidence (what changed, which consumers read it, what production holds, what rollback does) and a new decision; it does not ride on ADR-0130.
- **A collection may stay unbounded** only when an enforced per-Organization limit bounds its size, and the Integration Guide states that limit. `GET /v1/organizations/{organization_id}/api-keys` is the case today: it lists only active keys, and key creation refuses a 51st active key inside its transaction. If that limit is raised or removed, the route paginates first. The route description does not yet state the limit; adding it is a documentation-only contract change that waits for the next contract release.
- **Meaning of the array.** For a route that publishes `next_cursor`, the array in the response is one page. Integration Guide readers follow `next_cursor` until it is `null`.
- **Unknown query parameters.** A route rejects a query parameter its contract does not document with `400 INVALID_REQUEST`, as the closed query schema in `parseRequestQuery` does everywhere. Adding that check to a route that took no parameters is not breaking: a parameter the contract never documented was never part of it. The Integration Guide tells clients to send only documented parameters. This settles the roster (#896) and the member and invitation lists (#276).
- **Member visibility.** Before ADR-0133 the roster showed every member of every Organization to any member (ADR-0028). The earlier visibility is kept: [#1412](https://github.com/AiHub-Ecosystem/aihub-be/issues/1412) lets any active member list active members through the paginated route, which widens the access ADR-0051 set and needs its own ADR. Until it ships, a plain member of an Organization of more than 100 members sees the first 100 in the roster and no more. Removing the embedded `members[]` from the roster is breaking and waits for #1412 and `/v2` (#1374).
- **Review.** A change that adds `limit` or `cursor` to a response array that already exists cites this ADR in its change summary. The path-scoped presentation rule says so, because the reviewer reads those rules when a diff touches presentation.

## Consequences

Nothing changes at runtime and the contract version does not move: this ADR records a classification, an exception, and rules. The Integration Guide and `CONTEXT.md` stop saying the member list, the invitation list, and the roster are unpaginated.

The rollout order is: AIHUB 1.4.0, live in production on 2026-10-30; then Customer Web following roster pages (AiHub-Frontend#117), which has not shipped and matters only above 100 Organizations. AiHub-Frontend#117 requires Customer Web to treat a missing `next_cursor` as the end of the list, so it will work against both the current release and its rollback target. This ADR does not claim Customer Web is rolled out.

The compatibility gate still cannot see this class of change. The review rule above is the control; a mechanical check is worth adding if the class recurs.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-30 in #1411. The route descriptions of `organizations.members.list`, `organizations.invitations.list`, and `organizations.me.members.list` already state that a response is a page. The `api_keys` limit is enforced in `create-organization-api-key.ts` (`ACTIVE_API_KEY_LIMIT`) and is covered by `test/db/identity/organization-api-key.spec.ts`.
