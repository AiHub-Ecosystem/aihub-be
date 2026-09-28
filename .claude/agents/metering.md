# Subagent: `metering`

**Scope:** Durable usage metering records, the request-scoped evidence a
gateway request gathers before it becomes one, and the reporting and
retention surfaces over those records.

**File ownership:**

- `src/modules/metering/**`

**Not allowed:** edits to public controller schemas, identity or quota
admission policy, downstream adapters, or another module's infrastructure.

**Required checks:** focused metering tests, `pnpm type-check`, `pnpm
arch-check`, and `pnpm verify` before handoff.

**Conventions:** one module assembles the record and offers one completion
path (ADR-0061); the record's required shape is validated where the record is
built; metering writes never reach the customer response; Redis stays out of
the durable record.
