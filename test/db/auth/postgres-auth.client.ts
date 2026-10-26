import {
  authQueryRows,
  authTransaction,
} from '@/modules/auth/shared/infrastructure/auth-prisma';
import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { Prisma, PrismaClient } from '@prisma-client/client';

/** Query API a database-lane fixture adds to its Prisma client for assertions. */
export interface PostgresAuthQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

/**
 * A Prisma client with the helpers database-lane specs assert through. It is
 * the same client a repository takes, so a fixture cannot pass on behavior the
 * runtime does not have.
 */
export type PostgresAuthClient = PrismaClient &
  PostgresAuthQueryClient & {
    checkConnection(timeoutMs: number): Promise<void>;
    /** The callback's handle is the guarded Prisma transaction, plus `query`. */
    transaction<T>(
      callback: (
        client: Prisma.TransactionClient & PostgresAuthQueryClient,
      ) => Promise<T>,
    ): Promise<T>;
    close(): Promise<void>;
  };

function withQuery(
  transaction: Prisma.TransactionClient,
): Prisma.TransactionClient & PostgresAuthQueryClient {
  return new Proxy(transaction, {
    get(target, property) {
      if (property === 'query') {
        return (text: string, values: readonly unknown[]) =>
          authQueryRows(target, text, values);
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  }) as Prisma.TransactionClient & PostgresAuthQueryClient;
}

function fixtureClient(
  prisma: PrismaClient,
  checkConnection: (timeoutMs: number) => Promise<void>,
  close: () => Promise<void>,
): PostgresAuthClient {
  const helpers = {
    query: (text: string, values: readonly unknown[]) =>
      authQueryRows(prisma, text, values),
    transaction: <T>(
      callback: (
        client: Prisma.TransactionClient & PostgresAuthQueryClient,
      ) => Promise<T>,
    ) =>
      authTransaction(prisma, (transaction) =>
        callback(withQuery(transaction)),
      ),
    checkConnection,
    close,
  };

  return new Proxy(prisma, {
    get(target, property) {
      if (property in helpers) {
        return helpers[property as keyof typeof helpers];
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const result: unknown = Reflect.apply(value, target, args);
        return result;
      };
    },
  }) as PostgresAuthClient;
}

/** Test-only factory for database-lane fixtures; production injects Prisma. */
export function createPostgresAuthClient(
  databaseUrl: string,
): PostgresAuthClient {
  if (databaseUrl.trim().length === 0) {
    const missingDatabaseUrl = (): never => {
      throw new Error('DATABASE_URL is missing');
    };
    return fixtureClient(
      new Proxy({} as PrismaClient, { get: () => missingDatabaseUrl() }),
      async () => missingDatabaseUrl(),
      async () => undefined,
    );
  }

  const holder = createPrismaClient('integration-test', databaseUrl);

  return fixtureClient(
    holder.prisma,
    (timeoutMs) => holder.checkConnection(timeoutMs),
    () => holder.close(),
  );
}
