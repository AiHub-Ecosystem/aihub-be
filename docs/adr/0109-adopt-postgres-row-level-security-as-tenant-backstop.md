# ADR-0109: Adopt PostgreSQL row-level security as a tenant-isolation backstop

- Status: Accepted; implementation blocked by #298
- Date: 2026-10-18
- Decided by: AIHUB owner `@lengocanh2005it`, 2026-10-18
- Related issues: [#469](https://github.com/AiHub-Ecosystem/aihub-be/issues/469) (this decision), [#80](https://github.com/AiHub-Ecosystem/aihub-be/issues/80) (implementation), [#298](https://github.com/AiHub-Ecosystem/aihub-be/issues/298) (prerequisite), [#81](https://github.com/AiHub-Ecosystem/aihub-be/issues/81), [#79](https://github.com/AiHub-Ecosystem/aihub-be/issues/79), [#349](https://github.com/AiHub-Ecosystem/aihub-be/issues/349), [#705](https://github.com/AiHub-Ecosystem/aihub-be/issues/705)
- Related ADRs: [ADR-0088](0088-prisma-for-control-plane-persistence.md), [ADR-0090](0090-adopt-layered-clean-architecture-dependency-rule.md), [ADR-0103](0103-budget-postgresql-connections-on-shared-cluster.md)

## Context

Tenant scoping is enforced in one place today: every Organization-scoped query carries an explicit `organization_id` predicate taken from `RequestContext`. The cross-tenant suite (#79), the route credential and scope check, and the planned predicate check (#705) test that discipline, but nothing in the database refuses a query that forgets its predicate. Such a query still works and returns another tenant's rows.

The application's predicate is also not independent of authentication. The `organizationId` in the `WHERE` clause comes from the record that authenticated the caller, so a wrong `organizationId` (for example a forged cached API-key record, #349) passes both checks.

PostgreSQL row-level security (RLS) can refuse rows whose `organization_id` disagrees with a value the session declares. It has no effect for a superuser, a role with `BYPASSRLS`, or a table owner without `FORCE ROW LEVEL SECURITY`. The runtime connection does not yet use least-privilege roles that AIHUB owns; that is #298. A policy enabled before #298 lands would be present but inert, which is worse than none because it invites a false claim of protection.

The current schema has 15 tables with an `organization_id` column whose rows belong to exactly one Organization: `api_keys`, `billing_adjustments`, `billing_month_closures`, `dispatch_attempts`, `idempotency_records`, `organization_audit_events`, `organization_identity_configs`, `organization_invitations`, `organization_members`, `sandbox_allowance_overrides`, `sandbox_dispatch_reservations`, `speaking_audio_assets`, `speaking_audio_upload_intents`, `usage_records`, and `writing_chart_uploads`. The `organizations` table is keyed by the Organization's own ID. `idempotency_records.organization_id` is nullable for the Account Idempotency Scope (ADR-0041).

## Decision

Adopt RLS as a second line of tenant isolation, behind the application's own Organization scoping, once #298 is in place.

1. **The application predicate stays mandatory.** Every Organization-scoped query keeps its explicit `organization_id` predicate. RLS is a backstop; no query may rely on it as its only scoping, and Organization identity is never recovered from the database session (AGENTS.md).
2. **Precondition.** Enable no policy in any environment until the request-serving role is not a superuser, does not own the protected tables, and lacks `BYPASSRLS` (#298). A test must prove the policies are in force for that role, not merely declared.
3. **Transaction-scoped tenant setting.** Request-serving code sets the Organization with `set_config('aihub.organization_id', <id>, true)` inside the transaction that runs the query, taking the value from `RequestContext`. It is never set at session or connection level, so a pooled connection (ADR-0088, #81) cannot carry one tenant's setting into another request. The same rule applies to the read client.
4. **Fail closed.** Policies compare `organization_id` with `current_setting('aihub.organization_id', true)` for both `USING` and `WITH CHECK`. A transaction that has not declared an Organization sees and writes no protected rows.
5. **Table scope.** Every table whose rows belong to exactly one Organization gets a policy. Rollout is phased: the first slice covers `usage_records`, `idempotency_records`, `api_keys`, and `organization_identity_configs` (#80); the remaining tables listed above follow in later slices. A migration that adds a table with an `organization_id` column adds its policy in the same change, or records why the table is exempt.
6. **Pre-tenant lookups.** Some reads happen before an Organization is known: API-key authentication by hash, listing a User Account's memberships, and Account-scoped idempotency rows with a null `organization_id`. Each goes through a narrow, named path that returns only what that lookup needs, never a blanket bypass. #80 chooses the mechanism (for example a `SECURITY DEFINER` function or a dedicated role) and records it.
7. **Cross-Organization work bypasses explicitly.** Migrations and fleet-wide jobs (usage pruning, quota reconciliation, idempotency and upload sweeps, billing close, Operator CLI commands) run under a separate role or path that is documented and unreachable from request-serving code. They do not inherit a bypass from the request-serving role.
8. **Proof in the tenant-isolation lane.** The lane gains cases showing that a query deliberately written without its predicate returns no rows, that a reused pooled connection does not inherit the previous tenant, and that a forged `organizationId` with the correct session setting returns no rows.

## Consequences

- #80 is the implementation slice and stays blocked by #298. Its acceptance criteria, including the independence requirement in its 2026-10-13 comment, apply as written, with the table scope widened by item 5.
- Repository code must open a transaction for every Organization-scoped read that RLS protects, and set the tenant inside it. Reads that run outside a transaction today must move into one, and each protected transaction adds a `set_config` round trip.
- Operator, migration, and job credentials become distinct from the request-serving credential, which #298 and the deployment runbooks must describe for production and Sandbox, including rollback.
- Until #298 lands, isolation still rests on the application predicate and its checks (#79, #705). This ADR does not claim database-enforced isolation before the precondition and the item 2 test both hold.
- Reconsider this decision if #298 settles on a role model that cannot keep request-serving sessions from changing their own tenant setting, because the backstop's independence depends on it.
