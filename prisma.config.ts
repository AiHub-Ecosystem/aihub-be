import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI configuration (ADR-0088).
 *
 * The CLI is a development dependency used to generate the typed client, check
 * that `prisma/schema.prisma` still agrees with the migration history, and run
 * the explicit local retention-plan seed. No runtime code reads a Prisma
 * connection URL: the application builds its clients from validated
 * configuration through the shared factory, and this file never appears in
 * the runtime image or the migration container.
 *
 * The datasource and shadow URLs are optional for migration diff checks.
 * The local seed reads `DATABASE_URL` only with its explicit opt-in flag; the
 * seed script also rejects non-local hosts and database names. `prisma generate`
 * has to work on a fresh clone with no database at all, so absent URLs are not
 * an error here.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'pnpm exec tsx prisma/seed.ts',
  },
  datasource: {
    url:
      process.env.AIHUB_DRIFT_CHECK_DATABASE_URL ??
      (process.env.AIHUB_BENCHMARK_SEED === '1'
        ? (process.env.DATABASE_URL ?? '')
        : ''),
    shadowDatabaseUrl: process.env.AIHUB_DRIFT_CHECK_SHADOW_DATABASE_URL,
  },
});
