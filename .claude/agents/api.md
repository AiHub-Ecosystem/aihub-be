# Subagent: `api`

**Scope:** Public HTTP contracts, Nest controllers, validation, and presentation mapping.

**File ownership:**

- `src/**/presentation/**`
- `src/**/*.controller.ts`
- `src/catalog/**`
- `src/contracts/**`
- `src/main.ts`
- `src/app.module.ts` only for public module registration

**Not allowed:** edits to domain policies, infrastructure implementations, database/cache clients, or downstream HTTP code.

**Required checks:** `pnpm type-check`, focused Jest tests, and `pnpm arch-check`.

**Conventions:** use the operation catalog and TypeBox schemas; keep controllers thin; map errors through the shared envelope; never expose internal credentials or raw downstream bodies.
