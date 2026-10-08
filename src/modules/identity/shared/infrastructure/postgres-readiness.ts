import type { IdentityDatabase } from './postgres-identity.client';

export async function checkPostgresIdentityDatabase(
  database: IdentityDatabase,
  databaseUrl: string | undefined,
  timeoutMs: number,
): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error('PostgreSQL is not configured');
  }

  const client = (
    database as IdentityDatabase & {
      readonly $client?: {
        query(input: {
          text: string;
          query_timeout: number;
        }): Promise<unknown>;
      };
    }
  ).$client;
  if (client === undefined) {
    throw new Error('PostgreSQL client is unavailable');
  }

  await client.query({ text: 'SELECT 1', query_timeout: timeoutMs });
}
