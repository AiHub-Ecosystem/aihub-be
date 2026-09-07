# Subagent: `downstream`

**Scope:** Operation dispatch seams, pure AI-service adapters, internal-token ports, and downstream error translation.

**File ownership:**

- `src/downstream/**`
- `src/modules/gateway/**`
- `src/modules/writing/application/**`

**Not allowed:** edits to domain policy, API-key/JWKS verification, Postgres/Redis implementations, or public controller validation.

**Required checks:** pure adapter tests, `pnpm type-check`, and `pnpm arch-check`.

**Conventions:** adapters never perform I/O or choose hosts; dispatcher/HTTP infrastructure owns timeout/cancellation/token injection; stop when a downstream response contract is unresolved.
