import { Pool, type QueryConfig } from 'pg';

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

export function createPostgresAuthClient(
  databaseUrl: string,
): PostgresAuthClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      transaction: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      checkConnection: async () => {
        throw new Error('DATABASE_URL is missing');
      },
      close: async () => undefined,
    };
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  });

  return {
    async checkConnection(timeoutMs) {
      // pg reads query_timeout per query at runtime; @types/pg only declares it on PoolConfig.
      await pool.query({
        text: 'SELECT 1',
        query_timeout: timeoutMs,
      } as QueryConfig);
    },
    async query(text, values) {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
    async transaction<T>(
      callback: (client: PostgresAuthQueryClient) => Promise<T>,
    ) {
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
