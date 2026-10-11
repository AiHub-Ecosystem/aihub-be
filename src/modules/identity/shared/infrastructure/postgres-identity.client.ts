import { Buffer } from 'node:buffer';

import { PrismaPg } from '@prisma/adapter-pg';
import { type PoolConfig } from 'pg';

import type { PostgresPoolName } from '@/common/observability/metrics';
import { createPostgresPool } from '@/common/postgres/postgres-pool';
import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { Prisma, PrismaClient } from '@prisma-client/client';

export interface PostgresIdentityClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
  close(): Promise<void>;
}

export interface PostgresIdentityQueryClient {
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface PostgresIdentityTransactionalClient
  extends PostgresIdentityQueryClient {
  transaction<T>(
    callback: (client: PostgresIdentityQueryClient) => Promise<T>,
  ): Promise<T>;
}

class PostgresIdentityTransactionExpiredError extends Error {
  constructor() {
    super('Identity transaction is no longer active');
    this.name = 'PostgresIdentityTransactionExpiredError';
  }
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
): readonly unknown[] {
  return rows.map((source) => {
    const row: Record<string, unknown> = {};
    for (const column of Object.keys(source)) {
      row[column] = normalizeRawValue(source[column]);
    }
    return row;
  });
}

function queryRows(
  client: PrismaRawQueryClient,
  text: string,
  values: readonly unknown[],
): Promise<readonly unknown[]> {
  // shortcut: route only no-RETURNING DML to executeRaw; extend if a new statement form is added.
  if (
    /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) &&
    !/\bRETURNING\b/i.test(text)
  ) {
    return client.$executeRawUnsafe(text, ...values).then(() => []);
  }
  return client
    .$queryRawUnsafe<readonly Record<string, unknown>[]>(text, ...values)
    .then(normalizeRawRows);
}

function identityClient(
  getPrisma: () => PrismaClient,
  close: () => Promise<void>,
): PostgresIdentityClient & PostgresIdentityTransactionalClient {
  return {
    query: (text, values) => queryRows(getPrisma(), text, values),
    transaction: <T>(
      callback: (client: PostgresIdentityQueryClient) => Promise<T>,
    ) =>
      getPrisma().$transaction(async (transaction) => {
        let active = true;
        const queries: Promise<readonly unknown[]>[] = [];
        const transactionClient: PostgresIdentityQueryClient = {
          query: (text, values) => {
            if (!active) {
              return Promise.reject(
                new PostgresIdentityTransactionExpiredError(),
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

/**
 * Shared by standalone Identity clients so their pool limits and timeouts stay
 * aligned with the control-plane pools.
 */
function identityPoolOptions(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  };
}

/**
 * A deployment without a control-plane URL still has to assemble the module
 * graph, so both clients resolve without a pool and fail on first use. Building
 * a pool with no URL instead would let a unit test reach whatever PostgreSQL
 * happens to answer on the default host.
 */
function missingDatabaseUrl(): never {
  throw new Error('DATABASE_URL is missing');
}

export function createPostgresIdentityClient(
  databaseUrl: string,
  poolName: PostgresPoolName = 'identity',
): PostgresIdentityClient & PostgresIdentityTransactionalClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => missingDatabaseUrl(),
      transaction: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const pool = createPostgresPool(poolName, identityPoolOptions(databaseUrl));
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  return identityClient(
    () => prisma,
    async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  );
}

/**
 * Adapts the shared control-plane client to the transitional Identity query
 * seam. The callback defers reading the client so an unconfigured deployment
 * can still assemble its Nest module graph and fail only on first use.
 */
export function createIdentityTransactionRunner(
  getPrisma: () => PrismaClient,
): PostgresIdentityClient & PostgresIdentityTransactionalClient {
  return identityClient(getPrisma, async () => undefined);
}

/** Historical name retained for the unchanged database-lane fixtures. */
export type IdentityDrizzleClient = PostgresIdentityClient &
  PostgresIdentityTransactionalClient;

/** Historical fixture factory; the returned client now runs through Prisma. */
export function createIdentityDrizzleClient(
  databaseUrl: string,
): IdentityDrizzleClient {
  return createPostgresIdentityClient(databaseUrl, 'identity');
}
