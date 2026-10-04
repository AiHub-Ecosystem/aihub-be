import { type NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

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

/**
 * One pool shape for both identity clients. Drizzle does not introduce its own
 * connection settings, so a migrated adapter keeps the read/write separation,
 * the limits, and the shutdown lifecycle it already had.
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
): PostgresIdentityClient & PostgresIdentityTransactionalClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => missingDatabaseUrl(),
      transaction: async () => missingDatabaseUrl(),
      close: async () => undefined,
    };
  }

  const pool = new Pool(identityPoolOptions(databaseUrl));

  return {
    async query(
      text: string,
      values: readonly unknown[],
    ): Promise<readonly unknown[]> {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
    async transaction<T>(
      callback: (client: PostgresIdentityQueryClient) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({
          query: async (text: string, values: readonly unknown[]) => {
            const response = await client.query<Record<string, unknown>>(text, [
              ...values,
            ]);
            return response.rows;
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original database failure.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

export type IdentityDatabase = NodePgDatabase;

/**
 * One transaction, reachable two ways. `db` is the Drizzle surface the adapter
 * builds ordinary statements and PostgreSQL-specific ones through; `query` is
 * the seam the shared Organization Audit Event writer already speaks, so the
 * audit event and the configuration it records still commit or roll back
 * together on this same connection.
 */
export interface IdentityTransaction {
  readonly db: IdentityDatabase;
  query(text: string, values: readonly unknown[]): Promise<readonly unknown[]>;
}

export interface IdentityDrizzleClient {
  readonly db: IdentityDatabase;
  transaction<T>(run: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function identityTransaction(client: PoolClient): IdentityTransaction {
  return {
    db: drizzle(client),
    query: async (
      text: string,
      values: readonly unknown[],
    ): Promise<readonly unknown[]> => {
      const response = await client.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return response.rows;
    },
  };
}

/**
 * Same shape and same first-use failure as the raw client above. The `db` getter
 * is where a use would reach a pool, so nothing assembles one.
 */
function unconfiguredDrizzleClient(): IdentityDrizzleClient {
  return {
    get db(): never {
      return missingDatabaseUrl();
    },
    transaction: async () => missingDatabaseUrl(),
    close: async () => undefined,
  };
}

export function createIdentityDrizzleClient(
  databaseUrl: string,
): IdentityDrizzleClient {
  if (databaseUrl.trim().length === 0) {
    return unconfiguredDrizzleClient();
  }

  const pool = new Pool(identityPoolOptions(databaseUrl));

  return {
    db: drizzle(pool),
    transaction: async <T>(
      run: (tx: IdentityTransaction) => Promise<T>,
    ): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await run(identityTransaction(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original database failure.
        }
        throw error;
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}
