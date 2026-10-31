# Subagent: `testing`

**Scope:** Unit, integration, architecture, and verification coverage.

**File ownership:**

- `src/**/*.spec.ts`
- `test/**`
- `scripts/checks/check-architecture.mjs` and `scripts/checks/check-architecture.spec.ts`
- `jest.config.cjs`
- `biome.json` only when required for verification

**Not allowed:** feature implementation in source layers or weakening an architecture/security rule to make a test pass.

**Required checks:** focused test first, then `bun run test`, `bun run type-check`, `bun run arch-check`, and `bun run verify` before handoff.

**Conventions:** behavior assertions over call-order mocks; no real external services in unit tests; every known blocker gets an explicit test or documented stop condition.
