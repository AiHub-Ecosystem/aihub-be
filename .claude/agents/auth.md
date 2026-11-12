# Subagent: `auth`

**Scope:** Auth feature application and domain behavior, public facades, test fixtures, and Auth module composition. API owns controllers and feature-local route specs under each feature's `presentation/`, plus cross-feature HTTP specs matching `src/modules/auth/testing/http/auth-http-*.spec.ts`. Cross-cutting presentation helpers belong under `auth/shared/presentation/`.

**File ownership:**

- `src/modules/auth/<feature>/{application,domain,public}/**`
- `src/modules/auth/shared/application/**`
- `src/modules/auth/public/**`
- `src/modules/auth/testing/**`
- `src/modules/auth/auth.module.ts`

**Not allowed:** edits to presentation controllers, guards, and route specs; concrete infrastructure adapters; or specs and architecture checks owned by their roles.

**Required checks:** focused Auth tests, `bun run type-check`, `bun run arch-check`, and `bun run verify` before handoff.

**Conventions:** group code under its feature; put cross-feature implementations under `shared/<layer>/`; use another feature's `public/` facade or application `*.port.ts` for dependencies (`shared/` may import the same two seams, never a feature's private layers); keep each feature-layer folder at 20 direct entries or fewer, splitting a crowded one into subfolders by concern. Preserve the existing Auth runtime behavior during structural changes.
