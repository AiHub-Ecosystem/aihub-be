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
- When two values of the same primitive type can be swapped and the swap is a defect rather than a mistake a compiler already refuses, brand them: a `unique symbol` key plus a factory that names the kind. Brand the whole group at once; a partial brand is worse than none, because it reads as protected where it is not. Do not brand a named field the compiler already discriminates, and do not brand a value that never meets a second kind.
- No `any`, unsafe casts, hidden mutable global state, or transport DTOs in domain code.
