import { createFixturePrismaClient } from '@/modules/persistence/persistence.module';

/** Test-only Prisma client used by the unchanged database-lane specs. */
export function createPostgresSandboxDispatchBudgetClient(databaseUrl: string) {
  return createFixturePrismaClient(
    databaseUrl,
    'Sandbox dispatch budget database is unavailable',
  );
}
