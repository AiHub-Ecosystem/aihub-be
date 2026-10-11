import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaClient } from '@prisma-client/client';

/** Test-only Prisma client used by the unchanged database-lane specs. */
export function createPostgresSandboxDispatchBudgetClient(
  databaseUrl: string,
): PrismaClient & { close(): Promise<void> } {
  if (databaseUrl.trim().length === 0) {
    throw new Error('Sandbox dispatch budget database is unavailable');
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return Object.assign(holder.prisma, { close: holder.close });
}
