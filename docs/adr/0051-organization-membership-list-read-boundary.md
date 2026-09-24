# ADR-0051: Organization membership list read boundary

- Status: Accepted
- Related issue: #134

Active owners and admins may read memberships for one named Organization through `GET /v1/organizations/:organizationId/members`, the Organization Membership List, distinct from the caller-scoped Organization Roster. The `status` filter selects exactly `active` or `disabled` Membership Status and defaults to `active`; there is no `all` value. The response is `{ data: { members: [{ username, role, status }] }, meta: { request_id } }`; the path supplies the Organization scope, so the response does not repeat its ID. Results use immutable username ascending, expose no User Account ID or email, and are initially unpaginated. An account's Local Account Status does not affect membership filtering or appear in the response: a disabled account with an active membership remains in the active membership view.

Suspended Organizations and callers outside the active owner/admin roles receive the same Safe Authorization Denial. An empty result is a successful empty `members` array; an invalid membership projection fails the whole read rather than returning partial data. Authorization and membership rows reflect one point-in-time snapshot: a change committed before that snapshot applies to the request, while a change committed afterward may take effect on the next request after the current read completes. The read does not lock membership rows.
