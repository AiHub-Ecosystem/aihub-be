# Control-plane database

The control-plane schema is described twice, on purpose: `prisma/schema.prisma`
is the shape, and `database/migrations/` is what builds a database. They are two
copies of one thing, so `pnpm check:prisma-drift` proves they still agree, and
a renamed column becomes a compile error in the repository that uses it rather
than a surprise at runtime. See [ADR-0088](../docs/adr/0088-prisma-for-control-plane-persistence.md).

Migrations remain what builds Production and Sandbox. There is no baseline step,
the runner is unchanged, and the Prisma CLI never enters the runtime image or
the migration container.

## Changing the schema

1. Edit `prisma/schema.prisma`. Model and field names are the TypeScript names
   the repositories already use; `@map` and `@@map` keep the physical column and
   table names.

2. Bring a database to the current migration state and generate the SQL:

   ```bash
   pnpm migrate
   DATABASE_URL=postgres://aihub:change-me@localhost:5432/aihub \
     pnpm generate:migration add_your_change
   ```

   The command writes `database/migrations/<next number>_add_your_change.sql`. It
   refuses to write when the schema and the database already agree, because a
   migration with no statements is a mistake, not a no-op.

3. Review the generated file and hand-edit it. Generation removes the second
   hand-maintained copy of the schema, not the review. This is where you add the
   objects the schema language cannot declare — `CHECK` constraints, triggers —
   and note the migration in the model's `///` comment so the next reader knows
   where to change them.

4. Apply and verify:

   ```bash
   pnpm migrate
   pnpm check:migrations      # expand-only contract, unchanged by this workflow
   pnpm check:prisma-drift    # the schema and the history still agree
   ```

`pnpm check:migrations` enforces the expand-only rules, so a generated file that
drops or renames a column still fails. Use its documented hatch only for a
genuine contract migration.

## Regenerating the client

`prisma generate` writes the client to `dist/generated/prisma`, outside `src/`
and outside version control. `pnpm type-check`, `pnpm test`, and `pnpm build`
run it themselves, so a fresh clone and CI never compile against a missing or
stale client. To run it by hand:

```bash
pnpm generate:prisma-client
```

Only infrastructure code may import it, under the `@prisma-client/*` alias.
`pnpm arch-check` reports an import from anywhere else, because Prisma types
never reach application or domain code.

## Upgrading to Prisma 8

Stay on Prisma 7.10.0 GA for now. Before upgrading to Prisma 8, rewrite the
schema's `@db.*` attributes (including `@db.Timestamptz(6)`, `@db.Date`, and
`type: Brin`) into type position, change `.take(n)` / `.skip(n)` to
`.limit(n)` / `.offset(n)`, and change raw SQL from `db.sql.raw` to
`db.raw.sql`. Prisma 8 release candidates also changed incompatibly between
rc.9 and rc.14, so defer the upgrade until a GA release and review its final
migration guidance. Partial and unique indexes becoming GA, and removing the
`partialIndexes` preview flag, is not sufficient reason to adopt an RC.
