# ADR-0008: The operation catalog lives in code, not in the database

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

The initial brief proposed configuring operations and downstream endpoints via
database tables (`routing_rules`, `downstream_configs`). Brief §13.14 listed
"SSRF via configurable downstream URLs" as a threat.

## Decision

Operations and their downstream URLs are defined in code
(`src/catalog/`, `src/contracts/`), never in the database.

- Adapters are inherently code: adding an AI service means writing an adapter
  and deploying. Database configuration does not avoid that deployment — it
  only fragments the source of truth across two places.
- A TypeScript catalog is type-checked: a scope mismatch or schema mistake is a
  compiler error, not a production outage.
- **Downstream URLs in the database are an SSRF vector.** Anyone who can write
  to such a table can redirect AIHUB to `169.254.169.254` — and AIHUB carries
  an internal JWT (ADR-0005). The cheapest mitigation is to make downstream
  URLs non-configurable via database. Host selection stays in trusted
  configuration (security rules).

## Consequences

- `docs/adr/` tables `routing_rules` and `downstream_configs` stay pruned
  (ADR-0002) until a genuine canary/failover requirement forces a revisit —
  and any reintroduction must keep hosts out of tenant-writable tables.
- The catalog is the single place `openapi.json` and `/docs` are generated
  from; contract changes flow from source, not from hand-edited artifacts.
- Per-environment endpoint differences are configuration values, not rows.
