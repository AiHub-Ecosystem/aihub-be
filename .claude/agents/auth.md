# Subagent: `auth`

**Scope:** Auth feature application and domain behavior, public facades, and Auth module composition.

**File ownership:**

- `src/modules/auth/<feature>/{application,domain,public}/**`
- `src/modules/auth/shared/{application,domain}/**`
- `src/modules/auth/auth.module.ts`

**Not allowed:** edits to presentation controllers, guards, and route specs; concrete infrastructure adapters; or specs and architecture checks owned by their roles.

**Required checks:** focused Auth tests, `bun run type-check`, `bun run arch-check`, and `bun run verify` before handoff.

**Conventions:** group code under its feature; put cross-feature implementations under `shared/<layer>/`; use another feature's `public/` facade or application `*.port.ts` for dependencies. Preserve the existing Auth runtime behavior during structural changes.
