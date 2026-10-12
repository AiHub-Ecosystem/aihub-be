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
 * The datasource and shadow URLs are optional and are read only by migration
 * diff checks. `prisma generate` has to work on a fresh clone with no database
 * at all, so absent URLs are not an error here; the drift check supplies both.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.AIHUB_DRIFT_CHECK_DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.AIHUB_DRIFT_CHECK_SHADOW_DATABASE_URL,
  },
});
