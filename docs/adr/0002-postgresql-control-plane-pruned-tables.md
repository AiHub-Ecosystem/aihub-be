# ADR-0002: PostgreSQL control plane with a pruned table set

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

The original brief listed 13 tables for the control plane. Stage A has few
organizations and an unfinalized pricing model; several proposed tables had no
independent lifecycle yet.

## Decision

PostgreSQL is the control-plane database, and the D2 schema uses 5 tables
instead of 13. The pruned tables, their rationale, and the exact trigger to
reintroduce each are recorded in
[03-database §E.5](../superpowers/specs/2026-09-07-aihub/03-database.md):

| Pruned table                          | Reintroduce when                                            |
| ------------------------------------- | ----------------------------------------------------------- |
| `plans`, `subscriptions`              | Pricing is finalized                                        |
| `organization_entitlements`           | Entitlements need independent expiry or attribution         |
| `api_key_scopes`                      | Virtually never                                             |
| `routing_rules`, `downstream_configs` | True canary/failover is required (see ADR-0008)             |
| `quota_configs`                       | Per-operation quotas are needed                             |
| `assets`                              | Speaking assets (Phase 4; later addressed by ADR-0065/0068) |
| `webhook_endpoints`                   | Async operations (Phase 4)                                  |

Creating tables for a non-existent business model designs for a requirement
that may never arrive; pruning is reversible, premature schema is not.

## Consequences

- Entitlements ship as `entitlements text[]` on the key row; quota policy lives
  in three columns on `organizations`.
- Persistence followed the later choice of Drizzle (ADR-0071) then Prisma
  (ADR-0088); the pruning decision is about the schema, not the ORM.
- The table list grew as real features landed (Identity, Auth, email delivery),
  each with its own rationale; the pruning stands for the original D2 scope.
