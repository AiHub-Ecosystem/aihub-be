# ADR-0088: Prisma is the control-plane persistence standard

- Status: Accepted
- Date: 2026-10-10
- Supersedes: [ADR-0071](0071-drizzle-for-control-plane-persistence.md)
- Related issues: [#395](https://github.com/AiHub-Ecosystem/aihub-be/issues/395), [#246](https://github.com/AiHub-Ecosystem/aihub-be/issues/246), [#39](https://github.com/AiHub-Ecosystem/aihub-be/issues/39), [#40](https://github.com/AiHub-Ecosystem/aihub-be/issues/40), [#81](https://github.com/AiHub-Ecosystem/aihub-be/issues/81), [#383](https://github.com/AiHub-Ecosystem/aihub-be/issues/383), [#227](https://github.com/AiHub-Ecosystem/aihub-be/issues/227)
- Related: [ADR-0083](0083-email-delivery-transaction-handle-lifetime.md)

## Context

ADR-0071 chose Drizzle after comparing raw `pg`, Drizzle, and TypeORM. Prisma was not evaluated, and the runtime spec rejected it on an unmeasured claim that it "struggles with" `text[]`, `ON CONFLICT`, partial indexes, and BRIN. Adoption stayed small: on 2026-10-10, 7 files import Drizzle, all in Identity, against 32 `postgres-*` implementations and 35 SQL migrations. The owner wants one schema file as the source of truth, migrations generated from it, a generated typed client, and a stack the expected contributors already know.

## Decision

Prisma replaces Drizzle as the control-plane persistence standard. The decision is final; it is not gated on a spike. The first slice is a tracer that proves how each constraint below is met, and its benchmark is appended to this record. The one exit is the runtime fit: if `@prisma/adapter-pg` cannot run on the existing `pg` pool, so that #81 and #383 no longer apply, stop and reopen #395.

**Endpoint.** Every `postgres-*` implementation uses Prisma: the generated client where it can express the query, and TypedSQL where it cannot (row locks and their order, `SKIP LOCKED`, `pg_advisory_xact_lock`, `FILTER (WHERE …)` aggregates). No separate raw `pg` query path remains, and `drizzle-orm` and `@nestjs/drizzle` are removed. A repository that stays outside Prisma needs its own recorded exception in this file.

**Client and version.** Use the current Prisma major (7.x), whose client has no Rust query engine, through `@prisma/adapter-pg` on a `pg` pool. One `PrismaClient` exists per distinct connection URL in a process: runtime (`DATABASE_URL`), control-plane write, and control-plane read. URLs that are equal share one instance and one pool. CLI commands call the same factory with an explicit URL. Pool metrics are labelled by connection role instead of by module.

**Transactions.** Prisma owns transactions. Each module's transaction runner moves to an interactive `$transaction`, Identity first. During the transition the existing `query(text, values)` seam is reimplemented on `tx.$queryRawUnsafe`, so repositories that have not moved share the same transaction as those that have, and the Email Delivery writer keeps the caller-owned handle that ADR-0083 defines. The ADR-0083 guard — expire the handle when the callback settles, drain in-flight calls, then commit or roll back — is preserved. The seam is removed as each module completes. Interactive transactions set `maxWait: 1_000` and `timeout: 5_000` explicitly in one place; #383 owns tightening them.

**Schema and migrations.** `schema.prisma` is created by `prisma db pull` against a database built from all existing migrations, then renamed to match the current TypeScript names. Objects the schema cannot declare (partial unique indexes, triggers, `CHECK` constraints, BRIN) live only in SQL, each with a `///` comment in the schema naming its migration. Prisma generates new migration SQL (`prisma migrate diff … --script`) into `database/migrations/`, where it is reviewed and hand-edited as needed. The existing runner (`scripts/cli/migrate.mjs`, `schema_migrations`) keeps applying migrations, so Production and Sandbox need no baseline and the runtime image gains no Prisma CLI. `scripts/checks/check-migrations.mjs` keeps enforcing expand-only. CI adds a drift check: apply every migration to an empty database, then require an empty `migrate diff` against `schema.prisma`.

**Build and boundaries.** The generated client is written outside `src/`, ignored by Git, and generated before `type-check` and the SWC build. `prisma` is a development dependency used only in the build stage. Only `**/infrastructure/**` may import the generated client, and `pnpm arch-check` enforces it. Infrastructure maps rows to application port types; Prisma types never reach application or domain code.

**Order.** (1) Tracer: the 7 Drizzle files in Identity, the Identity transaction runner, `postgres-organization-invitation.repository.ts`, and the idempotency `ON CONFLICT` statement; Drizzle is removed in this slice so the repository never carries two ORMs. (2) Idempotency (#39). (3) The remaining modules one slice each, with the lock-heavy repositories (`auth-mfa`, `local-auth`, the email outbox claim, the Sandbox dispatch budget) last.

## Consequences

- The spec rows that rejected Prisma (`01-context-and-stack.md`, `03-database.md` §E.1) now name Prisma.
- #246 is answered by the endpoint above. #39 moves to Prisma, #40 takes the migration workflow above, and #81 closes as the shared client lands slice by slice.
- `$queryRawUnsafe` returns `bigint`, `numeric`, `bytea`, and timestamp values differently from `pg`. Each slice relies on its existing repository and integration specs to catch the difference in its row mapping.
- Migration SQL is still reviewed by hand; generation removes the second hand-maintained copy of the schema, not the review.

## Considered options

- **Keep Drizzle and finish it (ADR-0071).** Rejected by the owner: Drizzle had reached 7 of 32 implementations, so switching cost about what finishing would, and Prisma's schema-first workflow and team familiarity were preferred.
- **Prisma for schema and migrations only, queries unchanged.** Rejected: queries would keep hand-written or Drizzle types next to `schema.prisma`, restoring the two sources of truth this change removes, and the typed client would go unused.
- **`prisma migrate deploy` with a baseline.** Rejected: it needs a `prisma/migrations` layout, a baseline of every existing migration on Production and Sandbox, the Prisma CLI in the migration container, and a rewritten expand-only check, while the existing runner already applies generated SQL.
- **Keep transactions on `pg` until a whole module moves.** Rejected: Prisma cannot join a transaction opened on a `pg` client, so migrated repositories could not write inside the transactions they belong to.
