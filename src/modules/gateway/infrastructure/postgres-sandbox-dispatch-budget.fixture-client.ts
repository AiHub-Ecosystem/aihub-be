import { PrismaPg } from '@prisma/adapter-pg';

import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { PrismaClient } from '@prisma-client/client';
import {
  type SandboxDispatchBudgetClient,
  createPrismaSandboxDispatchBudgetClient,
} from './prisma-sandbox-dispatch-budget.client';

/** Compatibility factory for the unchanged database-lane specs. */
export function createPostgresSandboxDispatchBudgetClient(
  databaseUrl: string,
): SandboxDispatchBudgetClient {
  if (databaseUrl.trim().length === 0) {
    const unavailable = (): never => {
      throw new Error('Sandbox dispatch budget database is unavailable');
    };
    return {
      query: async () => unavailable(),
      execute: async () => unavailable(),
      transaction: async () => unavailable(),
      close: async () => undefined,
    };
  }

  const pool = createPostgresPool('integration-test', {
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return createPrismaSandboxDispatchBudgetClient(
    () => prisma,
    async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  );
}
