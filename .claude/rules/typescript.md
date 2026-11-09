---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript rules

- Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`, `allowUnreachableCode` (false), and `allowUnusedLabels` (false) green. The unused/import flags are a second defense layer beside oxlint `no-unused-vars`, so nobody removes them as redundant.
- Keep `skipLibCheck` (false, in both `tsconfig.json` and `tsconfig.scripts.json`) green: dependency and generated declaration files are type-checked, so a drifted `.d.ts` fails the gate instead of surfacing as wrong runtime behavior. Import only a package's public surface — a deep path the package's `exports` map does not list is a resolution error, not something to route around.
- Do not use `any`, broad `as` casts, non-null assertions, or `@ts-ignore` to bypass a boundary.
- Use named exports and explicit return types on exported functions, ports, and public methods.
- Use the `node:` protocol for Node built-ins.
- Keep TypeBox schemas at transport boundaries and derive types from them; application/domain code should consume inferred types.
- Prefer small discriminated unions over stringly typed flags.
