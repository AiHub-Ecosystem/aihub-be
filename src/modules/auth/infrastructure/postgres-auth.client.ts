import { Buffer } from 'node:buffer';

import { createPrismaClient } from '@/modules/persistence/persistence.module';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';

export interface PostgresAuthQueryClient {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
}

export interface PostgresAuthTransactionClient extends PostgresAuthQueryClient {
  $executeRawUnsafe(
    query: string,
    ...values: readonly unknown[]
  ): Promise<number>;
}

/** Test-only query adapter retained for the unchanged database-lane fixtures. */
export interface PostgresAuthClient extends PostgresAuthQueryClient {
  /** Available on the Prisma-backed fixture adapter for raw outbox inserts. */
  $executeRawUnsafe?(
    query: string,
    ...values: readonly unknown[]
  ): Promise<number>;
  checkConnection(timeoutMs: number): Promise<void>;
  transaction<T>(
    callback: (client: PostgresAuthQueryClient) => Promise<T>,
  ): Promise<T>;
  close(): Promise<void>;
}

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
    $executeRawUnsafe: (text, ...values) =>
      getPrisma()
        .$executeRawUnsafe(text, ...values)
        .catch((error) => {
          throw postgresError(error);
        }),
    checkConnection,
    transaction: <T>(
      callback: (client: PostgresAuthQueryClient) => Promise<T>,
    ) =>
      getPrisma().$transaction(async (transaction) => {
        let active = true;
        const queries: Promise<unknown>[] = [];
        const transactionClient: PostgresAuthTransactionClient = {
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
          $executeRawUnsafe: (text, ...values) => {
            if (!active) {
              return Promise.reject(
                new Error('Auth transaction is no longer active'),
              );
            }
            const query = transaction
              .$executeRawUnsafe(text, ...values)
              .catch((error) => {
                throw postgresError(error);
              });
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
      $executeRawUnsafe: async () => missingDatabaseUrl(),
      transaction: async () => missingDatabaseUrl(),
      checkConnection: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const holder = createPrismaClient('integration-test', databaseUrl);

  return authClient(() => holder.prisma, holder.checkConnection, holder.close);
}
