# Control-plane database

The control-plane schema is described twice, on purpose: `prisma/schema.prisma`
is the shape, and `database/migrations/` is what builds a database. They are two
copies of one thing, so `pnpm check:prisma-drift` proves they still agree, and
a renamed column becomes a compile error in the repository that uses it rather
than a surprise at runtime. See [ADR-0088](../docs/adr/0088-prisma-for-control-plane-persistence.md).

Migrations remain what builds Production and Sandbox. There is no baseline step,
the runner is unchanged, and the Prisma CLI never enters the runtime image or
the migration container. `@prisma/client` lists the CLI as an optional peer, so
`.pnpmfile.cjs` drops that peer; `pnpm why prisma --prod` prints nothing, and a
dependency bump that changes the answer shows up in `pnpm-lock.yaml`.

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

The client lives in `dist/`, so `nest-cli.json` sets `deleteOutDir: false`:
Nest would otherwise empty `dist/` on `pnpm dev` and remove the client it was
about to need. `pnpm build` clears `dist/` itself before it compiles and
generates the client afterwards, so a stale build never survives it.
