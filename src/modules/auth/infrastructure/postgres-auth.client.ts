import { Buffer } from 'node:buffer';

import { PrismaPg } from '@prisma/adapter-pg';
import { type PoolConfig, type QueryConfig } from 'pg';

import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';

export interface PostgresAuthQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface PostgresAuthClient extends PostgresAuthQueryClient {
  checkConnection(timeoutMs: number): Promise<void>;
  transaction<T>(
    callback: (client: PostgresAuthQueryClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

export const POSTGRES_AUTH_CLIENT = Symbol('POSTGRES_AUTH_CLIENT');

type PrismaRawQueryClient = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe'
>;

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

function postgresError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) {
    return error;
  }
  const driverError = Reflect.get(error, 'meta')?.driverAdapterError;
  const cause =
    typeof driverError === 'object' && driverError !== null
      ? Reflect.get(driverError, 'cause')
      : undefined;
  const code =
    typeof cause === 'object' && cause !== null
      ? Reflect.get(cause, 'originalCode')
      : undefined;
  if (typeof code !== 'string') {
    return error;
  }
  const message = Reflect.get(cause as object, 'originalMessage');
  return Object.assign(
    new Error(typeof message === 'string' ? message : String(error)),
    { code, cause: error },
  );
}

function queryRows(
  client: PrismaRawQueryClient,
  text: string,
  values: readonly unknown[],
): Promise<readonly Record<string, unknown>[]> {
  // shortcut: route only no-RETURNING DML to executeRaw; extend if a new statement form is added.
  if (
    /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) &&
    !/\bRETURNING\b/i.test(text)
  ) {
    return client
      .$executeRawUnsafe(text, ...values)
      .then(() => [])
      .catch((error) => {
        throw postgresError(error);
      });
  }
  return client
    .$queryRawUnsafe<readonly Record<string, unknown>[]>(text, ...values)
    .then(normalizeRawRows)
    .catch((error) => {
      throw postgresError(error);
    });
}

function authClient(
  getPrisma: () => PrismaClient,
  checkConnection: (timeoutMs: number) => Promise<void>,
  close: () => Promise<void>,
): PostgresAuthClient {
  return {
    query: (text, values) => queryRows(getPrisma(), text, values),
    checkConnection,
    transaction: <T>(
      callback: (client: PostgresAuthQueryClient) => Promise<T>,
    ) =>
      getPrisma().$transaction(async (transaction) => {
        let active = true;
        const queries: Promise<readonly Record<string, unknown>[]>[] = [];
        const transactionClient: PostgresAuthQueryClient = {
          query: (text, values) => {
            if (!active) {
              return Promise.reject(
                new Error('Auth transaction is no longer active'),
              );
            }
            const query = queryRows(transaction, text, values);
            queries.push(query);
            void query.catch(() => undefined);
            return query;
          },
        };

        let result!: T;
        let callbackError: { readonly value: unknown } | undefined;
        try {
          result = await callback(transactionClient);
        } catch (error) {
          callbackError = { value: error };
        }
        active = false;

        const queryResults = await Promise.allSettled(queries);
        if (callbackError !== undefined) {
          throw callbackError.value;
        }
        const failedQuery = queryResults.find(
          (query): query is PromiseRejectedResult =>
            query.status === 'rejected',
        );
        if (failedQuery !== undefined) {
          throw failedQuery.reason;
        }
        return result;
      }, CONTROL_PLANE_TRANSACTION_OPTIONS),
    close,
  };
}

export function createAuthTransactionRunner(
  getPrisma: () => PrismaClient,
  checkConnection: (timeoutMs: number) => Promise<void> = async () => undefined,
  close: () => Promise<void> = async () => undefined,
): PostgresAuthClient {
  return authClient(getPrisma, checkConnection, close);
}

/** Compatibility factory used by unchanged database-lane fixtures. */
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

  const options: PoolConfig = {
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  };
  const pool = createPostgresPool('integration-test', options);
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  return authClient(
    () => prisma,
    async (timeoutMs) => {
      // pg reads query_timeout per query at runtime; @types/pg only declares it on PoolConfig.
      await pool.query({
        text: 'SELECT 1',
        query_timeout: timeoutMs,
      } as QueryConfig);
    },
    async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  );
}
