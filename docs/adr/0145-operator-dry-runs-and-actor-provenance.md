# ADR-0145: Preview usage retention and persist operator actor provenance

- Status: Accepted
- Date: 2026-11-02
- Related issue: [#426](https://github.com/AiHub-Ecosystem/aihub-be/issues/426)
- Amends: [ADR-0023](0023-thirteen-month-usage-retention.md), [ADR-0044](0044-organization-suspension-boundary.md), [ADR-0097](0097-billing-statements-adjustments-and-closed-months.md), and [ADR-0111](0111-revoke-reported-public-writing-charts.md)

## Context

Issue #426 requires every operator mutation to be previewable and requires an
audit record to say how a named actor was established. The implementation
added a non-mutating `usage:prune --dry-run true` preview, which conflicts with
ADR-0023's earlier decision that the command has no dry-run. The CLI also
reported `--actor` as self-declared before a write, while its durable records
stored only the linked account or username.

## Decision

`usage:prune --dry-run true` is supported. It calculates the same effective
cutoff as the write command and reports the eligible counts for usage records,
dispatch attempts, and Writing chart revocation audit records without deleting
rows. This supersedes ADR-0023's no-dry-run decision and replaces the separate
manual count query in the runbook. The first Production run still requires a
verified backup. The preview is a count at one instant, not a reservation; the
write run captures its own cutoff and may observe different rows.

Persist `actor_source` on Organization audit events, Writing chart revocation
audit events, billing adjustments, and billing month closures. Its values are
`authenticated_user`, `self_declared_operator`, or `legacy_unknown`. Existing
rows receive `legacy_unknown`; a Bearer mutation writes `authenticated_user`,
and a CLI command whose actor is supplied through `--actor` writes
`self_declared_operator`. Organization Audit reads include the source in each
event, and billing statement output includes it beside the actor.

`self_declared_operator` records provenance; it does not authenticate the
operator. Keep `actor_user_account_id` non-null and continue requiring an active
AIHUB account for Organization and chart audit events. The field does not add
an `actor_kind`, grant authority, or claim that the typed username is verified
as the person running the process. Commands without a named actor remain
outside this provenance change.

The additive migration uses a non-null `legacy_unknown` default, so older
application versions can continue inserting rows while a rollout overlaps.
New writers supply their source explicitly. Rolling back application code
does not require dropping the columns or discarding the recorded values.

## Consequences

Operators can review usage retention counts before deletion and can distinguish
authenticated actors from self-declared CLI attribution in durable audit data.
Records created before provenance was recorded remain honestly marked as
unknown. A dry-run count can differ from the later write if rows change between
the two invocations.
