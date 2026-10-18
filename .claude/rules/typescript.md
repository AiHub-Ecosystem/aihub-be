---
paths:
  - "src/**/*.ts"
  - "test/**/*.ts"
---

# TypeScript rules

- Keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, and `noUnusedParameters` green. The last two are a second defense layer beside oxlint `no-unused-vars`, so nobody removes them as redundant.
- Do not use `any`, broad `as` casts, non-null assertions, or `@ts-ignore` to bypass a boundary.
- Use named exports and explicit return types on exported functions, ports, and public methods.
- Use the `node:` protocol for Node built-ins.
- Keep TypeBox schemas at transport boundaries and derive types from them; application/domain code should consume inferred types.
- Prefer small discriminated unions over stringly typed flags.
