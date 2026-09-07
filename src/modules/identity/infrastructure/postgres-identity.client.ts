import { Pool } from 'pg';

import type { PostgresIdentityClient } from './postgres-api-key.repository';

export function createPostgresIdentityClient(
  databaseUrl: string,
): PostgresIdentityClient {
  if (databaseUrl.trim().length === 0) {
    return {
      query: async () => {
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
    async query(
      text: string,
      values: readonly unknown[],
    ): Promise<readonly unknown[]> {
      const result = await pool.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return result.rows;
    },
    close: async () => {
      await pool.end();
    },
  };
}
