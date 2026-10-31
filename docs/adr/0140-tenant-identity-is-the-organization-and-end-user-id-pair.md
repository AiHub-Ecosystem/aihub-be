# ADR-0140: Tenant identity is the pair (Organization, End-User ID), carried as headers

- Status: Accepted — approved by AIHUB owner @lengocanh2005it on 2026-10-31 in [#70](https://github.com/AiHub-Ecosystem/aihub-be/issues/70).
- Date: 2026-10-31
- Related: [ADR-0053](0053-optional-user-identity-verification.md), [ADR-0057](0057-graded-request-order-is-a-declared-contract.md), [ADR-0109](0109-adopt-postgres-row-level-security-as-tenant-backstop.md), [ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md), [#70](https://github.com/AiHub-Ecosystem/aihub-be/issues/70), [#71](https://github.com/AiHub-Ecosystem/aihub-be/issues/71), [#72](https://github.com/AiHub-Ecosystem/aihub-be/issues/72), [#73](https://github.com/AiHub-Ecosystem/aihub-be/issues/73), [#74](https://github.com/AiHub-Ecosystem/aihub-be/issues/74)

## Context

An Organization signs a User Assertion whose `sub` is any identifier it chooses, or declares an End-User ID without signing ([ADR-0053](0053-optional-user-identity-verification.md)). Verification proves which Organization vouched for the value. It does not make the value unique across Organizations, so two Organizations can legitimately use `user_42` for two unrelated learners.

AIHUB authenticates the Organization from the API key and resolves the End-User ID against that Organization's identity configuration, so its own records are Organization-scoped. The AI services behind it are different: AI Speaking v2.4 stores each graded question and reads results back to aggregate Part and Test results, and its aggregation checks the submitted `user_id` as the only owner. If AIHUB passed a tenant-local identifier into that namespace, one Organization's results could be combined with or read back as another's.

#72 chose how to carry tenant identity downstream; the decision lived only in an issue comment. This record keeps it and states its limits.

## Decision

1. **Identity is the pair `(Organization, End-User ID)`.** The Organization comes from the API key. The End-User ID, and whether it was verified (`signed_assertion`) or declared (`declared_id`), come from the resolved User Identity. A customer request cannot supply or override any of the three; identically named customer headers and `organization_id` or `user_id` fields are rejected or ignored, never forwarded.
2. **AIHUB sends the pair as headers, not as a qualified identifier.** Every AI Speaking request carries `X-AIHUB-Organization-Id` (the opaque `org_...` value unchanged), `X-AIHUB-User-Id` (unchanged, visible ASCII, at most 256 characters) and `X-AIHUB-User-Identity-Mode`. No composite or hashed identifier is built. AI Writing receives none today because it takes no user identifier; if a Writing API needs one it uses the same headers.
3. **The provider owns partitioning, and AIHUB cannot prove it from outside.** A provider scopes every stored record, read, aggregation and cache by the pair. A record belonging to another Organization or user answers not-found, not forbidden, so the response does not confirm it exists. #70 closes only on written provider evidence about the version AIHUB production calls, recorded in the provider contract documents; evidence for a version that is not deployed does not count.
4. **AIHUB-owned records include the Organization wherever they mention an End-User ID.** Idempotency, usage, upload and replay records qualify their keys and filters by Organization, and tests pin it ([#1441](https://github.com/AiHub-Ecosystem/aihub-be/issues/1441), [#1442](https://github.com/AiHub-Ecosystem/aihub-be/issues/1442)). PostgreSQL row-level security stays an accepted backstop for AIHUB's own database ([ADR-0109](0109-adopt-postgres-row-level-security-as-tenant-backstop.md)); it does not reach the providers' storage.
5. **Retrieval by an identifier needs an AIHUB-side ownership check.** When AIHUB exposes an operation that returns a stored Speaking result by response, part or test identifier, AIHUB checks the pair itself before forwarding rather than relying only on the provider's not-found. No such operation exists today; the requirement belongs to the Public API v2 design ([ADR-0138](0138-batch-ai-service-breaking-changes-into-public-v2.md), [#1374](https://github.com/AiHub-Ecosystem/aihub-be/issues/1374)).
6. **The trust boundary is the Organization.** AIHUB guarantees isolation between Organizations. It does not guarantee isolation between users inside one Organization: the customer's backend decides which learner a `sub` names. Whether that is the final model is [#74](https://github.com/AiHub-Ecosystem/aihub-be/issues/74).

## Alternatives

- **Qualify the identifier** (`org_x:user_42`, or a hash of the pair): rejected. It rewrites the key under which the provider already stores history, so existing records stop matching; AIHUB would own a mapping and its lifecycle; and the provider could not partition or audit by Organization because it never sees one.
- **Isolate only in AIHUB:** impossible for data the providers store.
- **Rely on row-level security:** it protects AIHUB's database, not the providers'.

## Consequences

- Tenant isolation of provider-held data depends on provider behaviour AIHUB can only evidence, not enforce. Until the evidence covers the deployed version, #70 stays open.
- The headers are as trusted as the provider credential that accompanies them. Replacing that with a signed internal token is [#73](https://github.com/AiHub-Ecosystem/aihub-be/issues/73), a hardening of this decision rather than a change to it.
- Records a provider stored before it partitioned by Organization carry no Organization. How they are treated is the provider's to state and AIHUB does not migrate them.
- A new AI service that stores or caches anything per user is not integrated until its contract names how it scopes by the pair and the evidence is recorded.
