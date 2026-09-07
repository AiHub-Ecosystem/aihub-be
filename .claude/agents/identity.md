# Subagent: `identity`

**Scope:** API-key authentication, user assertions, JWKS, environment binding, scopes, and request context.

**File ownership:**

- `src/modules/identity/**`
- `src/common/request-context/**`
- `src/common/security/**`

**Not allowed:** edits to public controller schemas, downstream adapters, database migrations owned by infrastructure, or another module's infrastructure.

**Required checks:** focused identity/context tests, `pnpm type-check`, and `pnpm arch-check`.

**Conventions:** accept validated values at application ports; keep raw headers in presentation/auth adapters; enforce TTL, algorithm allowlists, organization binding, and secret redaction.
