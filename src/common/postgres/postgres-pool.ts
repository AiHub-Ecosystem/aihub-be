import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import {
  type PostgresPoolName,
  recordPostgresPoolError,
} from '@/common/observability/metrics';

const logger = new Logger('PostgresPool');

export function createPostgresPool(
  name: PostgresPoolName,
  config: PoolConfig,
): Pool {
  const pool = new Pool(config);
  const seenErrors = new WeakSet<Error>();

  const reportError = (error: Error): void => {
    if (seenErrors.has(error)) return;
    seenErrors.add(error);

    let sqlstateClass = 'unknown';
    try {
      sqlstateClass = recordPostgresPoolError(
        name,
        'code' in error ? error.code : undefined,
      );
    } catch {
      // An observability failure must not make a database error unhandled.
    }
    try {
      logger.error(
        JSON.stringify({
          event: 'postgres_pool_error',
          pool: name,
          sqlstate_class: sqlstateClass,
        }),
      );
    } catch {
      // An observability failure must not make a database error unhandled.
    }
  };

  pool.on('error', reportError);
  pool.on('connect', (client: PoolClient) => {
    client.on('error', reportError);
  });

  return pool;
}
