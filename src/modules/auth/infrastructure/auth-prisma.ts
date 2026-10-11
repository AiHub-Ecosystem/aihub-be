import { Buffer } from 'node:buffer';

import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';
import type {
  PostgresAuthClient,
  PostgresAuthQueryClient,
} from './postgres-auth.client';

export type AuthRepositoryClient = PrismaClient | PostgresAuthClient;
export type AuthSqlClient =
  | Prisma.TransactionClient
  | PrismaClient
  | PostgresAuthQueryClient;
export type AuthTransactionClient =
  | Prisma.TransactionClient
  | PostgresAuthQueryClient;

function normalizeRawValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Prisma.Decimal.isDecimal(value)) return value.toString();
  if (value instanceof Uint8Array && !Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  return value;
}

function normalizeRawRows<T extends Record<string, unknown>>(
  rows: readonly T[],
): readonly T[] {
  return rows.map((source) => {
    const row: Record<string, unknown> = {};
    for (const column of Object.keys(source)) {
      row[column] = normalizeRawValue(source[column]);
    }
    return row as T;
  });
}

function postgresError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const driverError = Reflect.get(error, 'meta')?.driverAdapterError;
  const cause =
    typeof driverError === 'object' && driverError !== null
      ? Reflect.get(driverError, 'cause')
      : undefined;
  const code =
    typeof cause === 'object' && cause !== null
      ? Reflect.get(cause, 'originalCode')
      : undefined;
  if (typeof code !== 'string') return error;
  const message = Reflect.get(cause as object, 'originalMessage');
  return Object.assign(
    new Error(typeof message === 'string' ? message : String(error)),
    { code, cause: error },
  );
}

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
  if (
    /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) &&
    !/\bRETURNING\b/i.test(text)
  ) {
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

function guardTransaction(transaction: Prisma.TransactionClient) {
  let active = true;
  const inFlight: Promise<unknown>[] = [];
  const guarded = new Proxy(transaction, {
    get(target, property) {
      const method = Reflect.get(target, property, target) as unknown;
      if (
        (property !== '$queryRawUnsafe' && property !== '$executeRawUnsafe') ||
        typeof method !== 'function'
      ) {
        return method;
      }
      return (...args: unknown[]) => {
        if (!active) {
          return Promise.reject(
            new Error('Auth transaction is no longer active'),
          );
        }
        const query = Reflect.apply(method, target, args) as Promise<unknown>;
        inFlight.push(query);
        void query.catch(() => undefined);
        return query;
      };
    },
  }) as Prisma.TransactionClient;

  return {
    client: guarded,
    async settle<T>(callback: () => Promise<T>): Promise<T> {
      let result!: T;
      let callbackError: { readonly value: unknown } | undefined;
      try {
        result = await callback();
      } catch (error) {
        callbackError = { value: error };
      }
      active = false;
      const results = await Promise.allSettled(inFlight);
      if (callbackError !== undefined) throw callbackError.value;
      const failed = results.find(
        (entry): entry is PromiseRejectedResult => entry.status === 'rejected',
      );
      if (failed !== undefined) throw postgresError(failed.reason);
      return result;
    },
  };
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
  return client.$transaction((transaction) => {
    const guard = guardTransaction(transaction);
    return guard.settle(() => callback(guard.client));
  }, CONTROL_PLANE_TRANSACTION_OPTIONS);
}

function isLegacyAuthClient(
  client: AuthRepositoryClient,
): client is PostgresAuthClient {
  return 'transaction' in client && typeof client.transaction === 'function';
}
