import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';

/** Test-only Prisma client for the database lane's idempotency specs. */
export function createPostgresIdempotencyClient(databaseUrl: string) {
  return createFixturePrismaClient(databaseUrl);
}
