import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaClient } from '@prisma-client/client';
import {
  type PostgresAuthClient,
  authQueryRows,
  authTransaction,
} from './auth-prisma';

export type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './auth-prisma';

/**
 * The query-shaped adapter over the shared Prisma path. Statements and
 * transactions go through the same helpers production repositories use, so a
 * fixture cannot pass on behavior the runtime does not have.
 */
function authClient(
  prisma: PrismaClient,
  checkConnection: (timeoutMs: number) => Promise<void>,
  close: () => Promise<void>,
): PostgresAuthClient {
  return {
    query: (text, values) => authQueryRows(prisma, text, values),
    checkConnection,
    transaction: (callback) =>
      authTransaction(prisma, (transaction) =>
        callback({
          query: (text, values) => authQueryRows(transaction, text, values),
        }),
      ),
    close,
  };
}

/** Test-only factory for unchanged database-lane fixtures; production injects Prisma. */
export function createPostgresAuthClient(
  databaseUrl: string,
): PostgresAuthClient {
  if (databaseUrl.trim().length === 0) {
    const missingDatabaseUrl = (): never => {
      throw new Error('DATABASE_URL is missing');
    };
    return {
      query: async () => missingDatabaseUrl(),
      transaction: async () => missingDatabaseUrl(),
      checkConnection: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const holder = createPrismaClient('integration-test', databaseUrl);

  return authClient(holder.prisma, holder.checkConnection, holder.close);
}
