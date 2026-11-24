import { createFixturePrismaClient } from './fixture-prisma-client';

/** Test-only Prisma client used by the unchanged database-lane specs. */
export function createPostgresSandboxDispatchBudgetClient(
  databaseUrl: string,
): ReturnType<typeof createFixturePrismaClient> {
  return createFixturePrismaClient(
    databaseUrl,
    'Sandbox dispatch budget database is unavailable',
  );
}
