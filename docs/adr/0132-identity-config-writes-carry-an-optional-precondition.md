# ADR-0132: The identity configuration write carries an optional precondition

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-30 in [#579](https://github.com/AiHub-Ecosystem/aihub-be/issues/579).
- Date: 2026-10-30
- Related: [ADR-0049](0049-owner-managed-organization-identity-configuration.md), [ADR-0055](0055-owner-only-organization-identity-configuration-read.md), [ADR-0127](0127-public-api-uri-major-versioning.md), [#430](https://github.com/AiHub-Ecosystem/aihub-be/issues/430), [#473](https://github.com/AiHub-Ecosystem/aihub-be/issues/473), [#579](https://github.com/AiHub-Ecosystem/aihub-be/issues/579), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)

## Context

`PUT /v1/organizations/{organization_id}/identity-config` replaces the whole configuration: issuer, JWKS URL or inline keys, allowed algorithms, and assertion lifetime. Writes are already serialized by row locks, so two requests never interleave. What is missing is a way for a writer to say which state it was based on. Two owners who read the same configuration, each change a different field, and each send a `PUT`, leave only the second document, and neither is told. `Idempotency-Key` does not help: it recognises one request sent twice, not two requests built on the same starting point.

The risk grows with Organizations that have several owners and with the operator CLI, which writes the same table with its own SQL (#430). Adding a precondition is additive when it is optional and breaking when it is required (ADR-0127), so it is cheapest to add before customers build on the current shape.

## Decision

- **Scope.** Only the identity configuration `PUT` takes a precondition. `PATCH /v1/organizations/{organization_id}` renames an Organization and `PATCH …/members/{username}` changes a role. Each writes one value the caller has already chosen, and the policy that guards it runs under row locks. Both are exempt. A later `PATCH` that edits several fields reopens the question for that route.
- **Shape.** `GET` and `PUT` return the configuration's revision as a strong `ETag`, such as `"7"`. `PUT` accepts `If-Match: "7"` to say it replaces revision 7, and `If-None-Match: *` to say it creates a configuration only when none exists. The request body does not change. Clients treat the tag as opaque. `GET` of an unconfigured Organization sends no `ETag`.
- **Revision.** The row gains a `revision` that a database trigger raises by one whenever the issuer, source, algorithms, lifetime, or status changes, and keeps when an update changes none of them. Because the trigger runs for every writer, the operator CLI is covered without changing it, and a change back to an earlier content still gets a new revision, so a stale writer cannot mistake it for the state it read.
- **Stale write.** A mismatch answers `412 PRECONDITION_FAILED`, a new non-retryable error code. The write changes nothing: it does not raise `jwks_cache_version`, clear the JWKS cache, or record an audit event. The comparison happens in the write's transaction under a lock on the configuration row, so a second writer cannot slip in between the check and the write. An `If-Match` that is not one quoted positive integer, an `If-None-Match` other than `*`, a repeated header, or both headers together answers `400 INVALID_REQUEST`. A caller who is not an active owner is refused with the same `403` as before, whatever a well-formed precondition says; a malformed header is refused with `400` first, as a malformed body is. The body is validated, and a remote JWKS source fetched, before the comparison, so a stale write whose source is unreachable sees the JWKS error rather than `412`.
- **Optional for all of `/v1`.** A request without a precondition behaves as it always has: the last writer wins. `/v1` never answers `428 Precondition Required`, because requiring the header is a breaking change under ADR-0127. A required precondition is a candidate for the first breaking contract change that `/v2` waits for (#1374), not a reason to open `/v2` on its own.
- **Two counters.** `jwks_cache_version` keys the JWKS cache and is raised by the application when it saves. `revision` is the public validator, raised by the database for every writer. They are kept apart so that a cache key never becomes a client-visible value, and a client-visible value never depends on a cache.
- **Delete and create again.** A row that is deleted and created again starts at revision 1. No route or command deletes a configuration, so a stale tag cannot match a recreated one. A future delete path must keep the revision going.
- **Operator path.** The operator CLI uses the same revision (#430). When it goes through the same use case it takes an optional `--expect-revision`. That change belongs to #430.

## Consequences

An optional request header, a response header, and a new error code are additive, so the contract moves by a minor version. The new error code reaches Customer Web: its policy file in `AiHub-Frontend` lists the code before AIHUB ships it. The Customer Web BFF must forward `If-Match`, `If-None-Match`, and `ETag` before a screen can use the precondition; until then a screen writes unconditionally, as today.

A client that never sends the header is unprotected from a lost update, exactly as before. The protection is for clients that choose it.

## Confirmation

Approved by AIHUB owner @lengocanh2005it on 2026-10-30 in #579. A database-lane spec runs two writes from the same revision and shows exactly one succeeds, shows that a stale write leaves the configuration, `jwks_cache_version`, and audit trail unchanged, and shows that a change written outside the owner route raises the revision. Controller specs cover the header forms and the `412` and `400` answers.
