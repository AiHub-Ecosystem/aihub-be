import { PrismaPg } from '@prisma/adapter-pg';

import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { PrismaClient } from '@prisma-client/client';
import type { PostgresMeteringClient } from './prisma-metering.client';

/** Compatibility factory used by unchanged database-lane fixtures. */
export function createPostgresMeteringClient(
  databaseUrl: string,
): PostgresMeteringClient {
  if (databaseUrl.trim().length === 0) {
    const missingDatabaseUrl = (): never => {
      throw new Error('DATABASE_URL is missing');
    };
    return {
      query: async () => missingDatabaseUrl(),
      transaction: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const pool = createPostgresPool('integration-test', {
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    query: <Row extends object = Record<string, unknown>>(
      text: string,
      values: readonly unknown[],
    ) => prisma.$queryRawUnsafe<readonly Row[]>(text, ...values),
    transaction: (callback) =>
      prisma.$transaction((transaction) =>
        callback({
          query: <Row extends object = Record<string, unknown>>(
            text: string,
            values: readonly unknown[],
          ) => transaction.$queryRawUnsafe<readonly Row[]>(text, ...values),
        }),
      ),
    close: async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  };
}
