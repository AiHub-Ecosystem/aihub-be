import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (ADR-0088).
 *
 * The CLI is a development dependency used only to generate the typed client
 * and to check that `prisma/schema.prisma` still agrees with the migration
 * history. No runtime code reads a Prisma connection URL: the application
 * builds its clients from validated configuration through the shared factory,
 * and this file never appears in the runtime image or the migration container.
 *
 * The datasource URL is optional and is read only by the commands that compare
 * a live database against the schema. `prisma generate` has to work on a fresh
 * clone with no database at all, so an absent URL is not an error here; the
 * drift check sets it and fails on its own if the diff is not empty.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.AIHUB_DRIFT_CHECK_DATABASE_URL ?? '',
  },
});
