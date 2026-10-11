import {
  isRowlessWrite,
  normalizeRawRows,
  postgresError,
  runGuardedTransaction,
} from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import type { Prisma, PrismaClient } from '@prisma-client/client';

/** Query-shaped handle the unchanged database-lane fixtures still pass. */
export interface PostgresAuthQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

/** Test-only query adapter retained for the unchanged database-lane fixtures. */
export interface PostgresAuthClient extends PostgresAuthQueryClient {
  checkConnection(timeoutMs: number): Promise<void>;
  transaction<T>(
    callback: (client: PostgresAuthQueryClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export type AuthRepositoryClient = PrismaClient | PostgresAuthClient;
export type AuthSqlClient =
  | Prisma.TransactionClient
  | PrismaClient
  | PostgresAuthQueryClient;
export type AuthTransactionClient =
  | Prisma.TransactionClient
  | PostgresAuthQueryClient;

function isLegacyQueryClient(
  client: AuthSqlClient,
): client is PostgresAuthQueryClient {
  return 'query' in client && typeof client.query === 'function';
}

function isPrismaExecuteClient(
  client: AuthSqlClient,
): client is Prisma.TransactionClient | PrismaClient {
  return '$executeRawUnsafe' in client;
}

function isPrismaQueryClient(
  client: AuthSqlClient,
): client is Prisma.TransactionClient | PrismaClient {
  return '$queryRawUnsafe' in client;
}

/** Raw row types stay explicit at Prisma's untyped SQL boundary. */
export function authQueryRows<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  client: AuthSqlClient,
  text: string,
  values: readonly unknown[],
): Promise<readonly T[]> {
  // Unchanged database-lane fixtures still pass the query-only compatibility adapter.
  if (isLegacyQueryClient(client)) {
    return client.query(text, values) as Promise<readonly T[]>;
  }
  if (isRowlessWrite(text)) {
    if (!isPrismaExecuteClient(client)) {
      throw new Error('Auth SQL client does not expose Prisma raw SQL methods');
    }
    const query = client
      .$executeRawUnsafe(text, ...values)
      .then(() => [] as readonly T[])
      .catch((error) => {
        throw postgresError(error);
      });
    void query.catch(() => undefined);
    return query;
  }
  if (!isPrismaQueryClient(client)) {
    throw new Error('Auth SQL client does not expose Prisma raw SQL methods');
  }
  const query = client
    .$queryRawUnsafe<readonly T[]>(text, ...values)
    .then(normalizeRawRows)
    .catch((error) => {
      throw postgresError(error);
    });
  void query.catch(() => undefined);
  return query;
}

export function authExecute(
  client: AuthSqlClient,
  text: string,
  values: readonly unknown[],
): Promise<void> {
  if (isLegacyQueryClient(client)) {
    return client.query(text, values).then(() => undefined);
  }
  if (!isPrismaExecuteClient(client)) {
    throw new Error('Auth SQL client does not expose Prisma raw SQL methods');
  }
  const query = client
    .$executeRawUnsafe(text, ...values)
    .then(() => undefined)
    .catch((error) => {
      throw postgresError(error);
    });
  void query.catch(() => undefined);
  return query;
}

export function authTransaction<T>(
  client: AuthRepositoryClient,
  callback: (transaction: AuthTransactionClient) => Promise<T>,
): Promise<T> {
  if (isLegacyAuthClient(client)) {
    return client.transaction(
      callback as (transaction: PostgresAuthQueryClient) => Promise<T>,
    );
  }
  return client.$transaction(
    (transaction) =>
      runGuardedTransaction(transaction, callback, {
        expired: () => new Error('Auth transaction is no longer active'),
        mapFailure: postgresError,
      }),
    CONTROL_PLANE_TRANSACTION_OPTIONS,
  );
}

function isLegacyAuthClient(
  client: AuthRepositoryClient,
): client is PostgresAuthClient {
  return 'transaction' in client && typeof client.transaction === 'function';
}
