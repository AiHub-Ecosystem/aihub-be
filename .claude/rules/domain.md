---
paths:
  - "src/**/domain/**"
---

# Domain layer rules

- Domain code is pure TypeScript and contains entities, value objects, invariants, and domain errors only.
- Do not import NestJS, Fastify, TypeBox, `undici`, `jose`, Prisma, Drizzle, Postgres, Redis, environment loaders, or filesystem/network APIs.
- Do not import from `application`, `infrastructure`, or `presentation`; domain depends only on itself and standard-library value types.
- Never read request headers or environment variables. Pass validated values explicitly.
- Use interfaces for data-only shapes and classes/functions only when behavior or invariants need them.
- No `any`, unsafe casts, hidden mutable global state, or transport DTOs in domain code.
