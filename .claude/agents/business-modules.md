# Subagent: `business-modules`

**Scope:** Business modules without a dedicated role file: avatar, content-proxy, idempotency, persistence, secrets, speaking, uploads, and the writing application/domain code. The shared API, infrastructure, and testing roles still own their layers inside these modules.

**File ownership:**

- `src/modules/avatar/**`
- `src/modules/content-proxy/**`
- `src/modules/idempotency/**`
- `src/modules/persistence/**`
- `src/modules/secrets/**`
- `src/modules/speaking/**`
- `src/modules/uploads/**`
- `src/modules/writing/**`

**Not allowed:** edits to API presentation, concrete infrastructure adapters, or specs owned by their roles.

**Required checks:** focused module tests, `bun run type-check`, `bun run arch-check`, and `bun run verify` before handoff.

**Conventions:** the narrower-claim rule in AGENTS.md wins inside these modules: `src/**/presentation/**` belongs to api and `src/**/infrastructure/**` to infrastructure. Keep use cases, vocabulary, and policies beside the module that owns them.
