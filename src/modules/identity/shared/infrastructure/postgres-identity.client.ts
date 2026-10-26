import {
  createPrismaClient,
  isLifecycleProperty,
  isRowlessWrite,
  normalizeRawRows,
  runGuardedTransaction,
} from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { type Prisma, PrismaClient } from '@prisma-client/client';

/**
 * What a repository takes: the shared Prisma client, or the runner that wraps
 * it. Test fixtures are Prisma clients too, so a repository has one shape.
 */
export type IdentityRepositoryClient = PrismaClient;

/** Query API a database-lane fixture adds to its Prisma client for assertions. */
export interface PostgresIdentityQueryClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

/** The fixture's transaction helper, over the same guarded Prisma transaction. */
export interface PostgresIdentityTransactionalClient
  extends PostgresIdentityQueryClient {
  transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T>;
}

type PrismaRawQueryClient = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

class PostgresIdentityTransactionExpiredError extends Error {
  constructor() {
    super('Identity transaction is no longer active');
    this.name = 'PostgresIdentityTransactionExpiredError';
  }
}

/** Executes Identity SQL through Prisma, mapping rows back to `pg` types. */
export async function identityRows(
  client: PrismaRawQueryClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  if (isRowlessWrite(text)) {
    await client.$executeRawUnsafe(text, ...values);
    return [];
  }

  const rows = await client.$queryRawUnsafe<readonly Record<string, unknown>[]>(
    text,
    ...values,
  );
  return normalizeRawRows(rows);
}

function runPrismaTransaction<T>(
  prisma: PrismaClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    (transaction) =>
      runGuardedTransaction(transaction, callback, {
        expired: () => new PostgresIdentityTransactionExpiredError(),
      }),
    CONTROL_PLANE_TRANSACTION_OPTIONS,
  );
}

export function identityTransaction<T>(
  client: IdentityRepositoryClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return runPrismaTransaction(client, callback);
}

/**
 * Wraps the shared Prisma client with Identity's ADR-0083 transaction guard.
 * The callback receives Prisma's transaction client directly.
 */
export function createIdentityTransactionRunner(
  prisma: PrismaClient,
): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(target, property) {
      if (isLifecycleProperty(property)) {
        return undefined;
      }
      if (property === 'constructor') {
        return PrismaClient;
      }
      if (Object.prototype.hasOwnProperty.call(target, property)) {
        const value: unknown = Reflect.get(target, property, target);
        return value;
      }
      if (property === '$transaction') {
        return (callback: unknown, options?: unknown) => {
          if (typeof callback !== 'function') {
            return Reflect.apply(
              Reflect.get(prisma, '$transaction', prisma) as (
                ...args: unknown[]
              ) => unknown,
              prisma,
              [callback, options],
            );
          }
          return runPrismaTransaction(
            prisma,
            callback as (tx: Prisma.TransactionClient) => Promise<unknown>,
          );
        };
      }
      const value: unknown = Reflect.get(prisma, property, prisma);
      if (typeof value !== 'function') {
        return value;
      }
      const bound: unknown = value.bind(prisma);
      return bound;
    },
  });
}

/**
 * A deployment without a control-plane URL still has to assemble the module
 * graph, so the test fixture resolves without a pool and fails on first use.
 */
function missingDatabaseUrl(): never {
  throw new Error('DATABASE_URL is missing');
}

/** A Prisma client with the query helpers a database-lane spec asserts through. */
export type IdentityFixtureClient = PrismaClient &
  PostgresIdentityTransactionalClient & {
    close(): Promise<void>;
  };

function testIdentityClient(
  prisma: PrismaClient,
  close: () => Promise<void>,
): IdentityFixtureClient {
  const runtimeClient = createIdentityTransactionRunner(prisma);
  return new Proxy(runtimeClient as IdentityFixtureClient, {
    get(target, property, receiver) {
      if (property === 'query') {
        return (text: string, values: readonly unknown[]) =>
          identityRows(runtimeClient, text, values);
      }
      if (property === 'transaction') {
        return <T>(
          callback: (transaction: PostgresIdentityQueryClient) => Promise<T>,
        ) =>
          runtimeClient.$transaction((transaction) =>
            callback({
              query: (text, values) => identityRows(transaction, text, values),
            }),
          );
      }
      if (property === 'close') {
        return close;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return value;
    },
  });
}

/** Test-only factory for database-lane specs; no production module may use it. */
export function createPostgresIdentityClient(
  databaseUrl: string,
): IdentityFixtureClient {
  if (databaseUrl.trim().length === 0) {
    const missingPrisma = new Proxy({} as PrismaClient, {
      get: () => missingDatabaseUrl(),
    });
    return testIdentityClient(missingPrisma, async () => undefined);
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return testIdentityClient(holder.prisma, () => holder.close());
}
