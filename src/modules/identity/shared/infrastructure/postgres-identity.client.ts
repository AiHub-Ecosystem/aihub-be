import {
  createPrismaClient,
  isLifecycleProperty,
  isRowlessWrite,
  normalizeRawRows,
  runGuardedTransaction,
} from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { type Prisma, PrismaClient } from '@prisma-client/client';

/** Test-only query API for unchanged database-lane fixtures; production injects Prisma. */
export interface PostgresIdentityQueryClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

/** Test-only transaction runner for unchanged database-lane fixtures. */
export interface PostgresIdentityTransactionalClient
  extends PostgresIdentityQueryClient {
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

/**
 * A handle for the fixtures' query-shaped transaction. It speaks raw SQL only,
 * so a repository reached through it must use nothing else. The cast is the
 * boundary: Prisma's methods return `PrismaPromise`, which a plain promise
 * cannot be.
 */
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

// Read, not `in`: the runner and the fixtures are proxies that answer through
// `get`, so the property is not on the proxy's own target.
function isPrismaClient(
  client: IdentityRepositoryClient,
): client is PrismaClient {
  return typeof Reflect.get(client, '$transaction') === 'function';
}

/**
 * The generated client behind a repository client, for a statement it can
 * express. A repository that uses it is driven only through clients that carry
 * one; a query-only fixture reaching it is a wiring mistake and fails loudly.
 */
export function identityPrisma(client: IdentityRepositoryClient): PrismaClient {
  if (isPrismaClient(client)) {
    return client;
  }
  throw new Error('The Identity store needs a generated Prisma client');
}

export function identityTransaction<T>(
  client: IdentityRepositoryClient,
  callback: (transaction: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (isPrismaClient(client)) {
    return runPrismaTransaction(client, callback);
  }
  return client.transaction((transaction) =>
    callback(legacyTransactionAsPrisma(transaction)),
  );
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
        return Reflect.get(target, property, target);
      }
      if (property === '$transaction') {
        return (callback: unknown, options?: unknown) => {
          if (typeof callback !== 'function') {
            return Reflect.apply(
              prisma.$transaction as (...args: unknown[]) => unknown,
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
  const runtimeClient = createIdentityTransactionRunner(prisma);
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
): TestIdentityClient {
  if (databaseUrl.trim().length === 0) {
    const missingPrisma = new Proxy({} as PrismaClient, {
      get: () => missingDatabaseUrl(),
    });
    return testIdentityClient(missingPrisma, async () => undefined);
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return testIdentityClient(holder.prisma, holder.close);
}

/** Historical name retained for unchanged database-lane fixtures. */
export type IdentityDrizzleClient = TestIdentityClient;

/** Historical fixture factory; runtime Identity providers inject Prisma directly. */
export function createIdentityDrizzleClient(
  databaseUrl: string,
): IdentityDrizzleClient {
  return createPostgresIdentityClient(databaseUrl);
}
