import { Buffer } from 'node:buffer';

import type { PostgresPoolName } from '@/common/observability/metrics';
import { createPrismaClient } from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';

/** Test-only query API for unchanged database-lane fixtures; production injects Prisma. */
export interface PostgresIdentityClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

/** Test-only transaction handle for unchanged database-lane fixtures. */
export interface PostgresIdentityQueryClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

/** Test-only transaction runner for unchanged database-lane fixtures. */
export interface PostgresIdentityTransactionalClient
  extends PostgresIdentityClient {
  transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T>;
}

export type IdentityRepositoryClient =
  | PrismaClient
  | PostgresIdentityTransactionalClient;

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

function normalizeRawValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Prisma.Decimal.isDecimal(value)) {
    return value.toString();
  }
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

function normalizeRawRows(
  rows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return rows.map((source) => {
    const row: Record<string, unknown> = {};
    for (const column of Object.keys(source)) {
      row[column] = normalizeRawValue(source[column]);
    }
    return row;
  });
}

/**
 * Executes Identity SQL through Prisma. The query-client branch serves only
 * unchanged database-lane fixtures; production injects Prisma directly.
 */
export async function identityRows(
  client: PrismaRawQueryClient | PostgresIdentityQueryClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  if ('query' in client) {
    return (await client.query(text, values)) as readonly Record<
      string,
      unknown
    >[];
  }

  if (
    /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) &&
    !/\bRETURNING\b/i.test(text)
  ) {
    await client.$executeRawUnsafe(text, ...values);
    return [];
  }

  const rows = await client.$queryRawUnsafe<readonly Record<string, unknown>[]>(
    text,
    ...values,
  );
  return normalizeRawRows(rows);
}

function guardTransaction(
  transaction: Prisma.TransactionClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
): Promise<unknown> {
  let active = true;
  const queries: Promise<unknown>[] = [];
  const guardedTransaction = new Proxy(transaction, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (
        (property === '$queryRawUnsafe' || property === '$executeRawUnsafe') &&
        typeof value === 'function'
      ) {
        return (...args: unknown[]) => {
          if (!active) {
            return Promise.reject(
              new PostgresIdentityTransactionExpiredError(),
            );
          }
          const query = Promise.resolve(Reflect.apply(value, target, args));
          queries.push(query);
          void query.catch(() => undefined);
          return query;
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return (async () => {
    let result: unknown;
    let callbackError: { readonly value: unknown } | undefined;
    try {
      result = await callback(guardedTransaction);
    } catch (error) {
      callbackError = { value: error };
    }
    active = false;

    const queryResults = await Promise.allSettled(queries);
    if (callbackError !== undefined) {
      throw callbackError.value;
    }
    const failedQuery = queryResults.find(
      (query): query is PromiseRejectedResult => query.status === 'rejected',
    );
    if (failedQuery !== undefined) {
      throw failedQuery.reason;
    }
    return result;
  })();
}

function runPrismaTransaction<T>(
  prisma: PrismaClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    (transaction) => guardTransaction(transaction, callback) as Promise<T>,
    CONTROL_PLANE_TRANSACTION_OPTIONS,
  );
}

function legacyTransactionAsPrisma(
  client: PostgresIdentityQueryClient,
): Prisma.TransactionClient {
  return {
    $queryRawUnsafe: async <T = unknown>(text: string, ...values: unknown[]) =>
      (await client.query(text, values)) as T,
    $executeRawUnsafe: async (text: string, ...values: unknown[]) => {
      await client.query(text, values);
      return 0;
    },
  } as unknown as Prisma.TransactionClient;
}

export function identityTransaction<T>(
  client: IdentityRepositoryClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const prismaTransaction = Reflect.get(client, '$transaction');
  if (typeof prismaTransaction === 'function') {
    return runPrismaTransaction(client as PrismaClient, callback);
  }
  return (client as PostgresIdentityTransactionalClient).transaction(
    (transaction) => callback(legacyTransactionAsPrisma(transaction)),
  );
}

/**
 * Wraps the shared Prisma client with Identity's ADR-0083 transaction guard.
 * The callback receives Prisma's transaction client directly.
 */
export function createIdentityTransactionRunner(
  getPrisma: () => PrismaClient,
): PrismaClient {
  return new Proxy({} as PrismaClient, {
    get(target, property) {
      if (
        property === 'then' ||
        property === 'onModuleInit' ||
        property === 'onModuleDestroy' ||
        property === 'onApplicationBootstrap' ||
        property === 'onApplicationShutdown' ||
        property === 'beforeApplicationShutdown'
      ) {
        return undefined;
      }
      if (property === 'constructor') {
        return PrismaClient;
      }
      if (Object.prototype.hasOwnProperty.call(target, property)) {
        return Reflect.get(target, property, target);
      }
      const prisma = getPrisma();
      if (property === '$transaction') {
        return (callback: unknown, options?: unknown) => {
          if (typeof callback !== 'function') {
            return Reflect.apply(
              prisma.$transaction as (...args: unknown[]) => unknown,
              prisma,
              [callback, options],
            );
          }
          return prisma.$transaction(
            (transaction) =>
              guardTransaction(
                transaction,
                callback as (tx: Prisma.TransactionClient) => Promise<unknown>,
              ),
            CONTROL_PLANE_TRANSACTION_OPTIONS,
          );
        };
      }
      const value = Reflect.get(prisma, property, prisma);
      return typeof value === 'function' ? value.bind(prisma) : value;
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

type TestIdentityClient = PrismaClient &
  PostgresIdentityTransactionalClient & {
    close(): Promise<void>;
  };

function testIdentityClient(
  prisma: PrismaClient,
  close: () => Promise<void>,
): TestIdentityClient {
  const runtimeClient = createIdentityTransactionRunner(() => prisma);
  return new Proxy(runtimeClient as TestIdentityClient, {
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
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Test-only factory for database-lane specs; no production module may use it. */
export function createPostgresIdentityClient(
  databaseUrl: string,
  poolName: PostgresPoolName = 'identity',
): TestIdentityClient {
  if (databaseUrl.trim().length === 0) {
    const missingPrisma = new Proxy({} as PrismaClient, {
      get: () => missingDatabaseUrl(),
    });
    return testIdentityClient(missingPrisma, async () => undefined);
  }

  const holder = createPrismaClient(poolName, databaseUrl);
  return testIdentityClient(holder.prisma, holder.close);
}

/** Historical name retained for unchanged database-lane fixtures. */
export type IdentityDrizzleClient = TestIdentityClient;

/** Historical fixture factory; runtime Identity providers inject Prisma directly. */
export function createIdentityDrizzleClient(
  databaseUrl: string,
): IdentityDrizzleClient {
  return createPostgresIdentityClient(databaseUrl, 'identity');
}
