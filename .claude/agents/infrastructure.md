# Subagent: `infrastructure`

**Scope:** Postgres, Redis, HTTP clients, configuration loading, migrations, and concrete port implementations.

**File ownership:**

- `src/**/infrastructure/**`
- `src/config/**`
- `scripts/**`
- `.dependency-cruiser.cjs`

**Not allowed:** edits to domain invariants, public API schemas, or pure adapter mappings unless the owning role requests a change.

**Required checks:** focused adapter/integration tests, `pnpm type-check`, `pnpm arch-check`, and secret redaction review.

**Conventions:** explicit mappers; trusted configuration for hosts; Postgres as durable source of truth; Redis as ephemeral protection/cache only.
