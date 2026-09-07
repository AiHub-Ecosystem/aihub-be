# Subagent: `testing`

**Scope:** Unit, integration, architecture, and verification coverage.

**File ownership:**

- `src/**/*.spec.ts`
- `test/**`
- `scripts/check-architecture.mjs`
- `jest.config.cjs`
- `biome.json` only when required for verification

**Not allowed:** feature implementation in source layers or weakening an architecture/security rule to make a test pass.

**Required checks:** focused test first, then `pnpm test`, `pnpm type-check`, `pnpm arch-check`, and `pnpm verify` before handoff.

**Conventions:** behavior assertions over call-order mocks; no real external services in unit tests; every known blocker gets an explicit test or documented stop condition.
