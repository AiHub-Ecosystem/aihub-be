# ADR-0010: Meter both request counts and token metrics from day one

- Status: Accepted (retroactive record)
- Date: decided 2026-09-07 in the implementation specification suite; file written 2026-11-07

## Context

The sales model was not finalized when the system was designed. Historical
telemetry cannot be retroactively generated: whatever is not recorded on day
one is gone.

## Decision

Every graded request records both dimensions from day one:

- `billable_requests` is always present.
- `*_tokens` are present whenever the AI service reports them.

`metering_status` makes the incompleteness explicit instead of hiding it:

| Value              | Condition                                                                     |
| ------------------ | ----------------------------------------------------------------------------- |
| `complete`         | AI service returned complete usage data                                       |
| `missing_usage`    | Operation invokes a model but the AI service failed to return usage           |
| `not_applicable`   | Reserved for future non-model operations                                      |
| `quota_unverified` | Quota could not be validated (e.g. Redis outage); request was allowed through |

**Never fabricate `0` for missing usage.** Fabricating zero is cheap now and
impossible to reverse later — last month's dropped data cannot spontaneously
regenerate, and a falsified ledger poisons every future pricing decision.

## Consequences

- The `unmetered` figure dictates whether token billing is legally permissible
  before client contracts are signed — the discovery happens in the data, not
  after the commitment.
- Metering/billing evidence is a durable Postgres concern (ADR-0016 records
  the boundary); the metering pipeline never "fills in" gaps.
- Retention follows ADR-0023 (13 months), sized for billing disputes, not
  analytics.
