import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import {
  type PostgresPoolName,
  type PostgresPoolStatsSample,
  recordPostgresPoolError,
  setPostgresPoolStatsSource,
} from '@/common/observability/metrics';

const logger = new Logger('PostgresPool');
const pools = new Map<PostgresPoolName, Set<Pool>>();

setPostgresPoolStatsSource(() => {
  const samples: PostgresPoolStatsSample[] = [];
  for (const [name, registeredPools] of pools) {
    let total = 0;
    let idle = 0;
    let waiting = 0;
    for (const pool of registeredPools) {
      if (pool.ended) {
        registeredPools.delete(pool);
        continue;
      }
      total += pool.totalCount;
      idle += pool.idleCount;
      waiting += pool.waitingCount;
    }
    if (registeredPools.size === 0) {
      pools.delete(name);
    } else {
      samples.push({ pool: name, total, idle, waiting });
    }
  }
  return samples;
});

export function createPostgresPool(
  name: PostgresPoolName,
  config: PoolConfig,
): Pool {
  const pool = new Pool(config);
  const registeredPools = pools.get(name) ?? new Set<Pool>();
  registeredPools.add(pool);
  pools.set(name, registeredPools);
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
