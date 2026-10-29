import { Logger } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryConfig } from 'pg';

import {
  type PostgresConnectionRole,
  type PostgresPoolName,
  type PostgresPoolStatsSample,
  recordPostgresPoolError,
  setPostgresPoolStatsSource,
} from '@/common/observability/metrics';

const logger = new Logger('PostgresPool');
const pools = new Map<PostgresPoolName, Set<Pool>>();
const rolesByPool = new WeakMap<Pool, readonly PostgresConnectionRole[]>();

export type PostgresTimeouts = Pick<
  PoolConfig,
  'statement_timeout' | 'lock_timeout' | 'idle_in_transaction_session_timeout'
>;

export const REQUEST_POSTGRES_TIMEOUTS = {
  statement_timeout: 4_000,
  lock_timeout: 1_000,
  idle_in_transaction_session_timeout: 10_000,
} as const satisfies PostgresTimeouts;

/** How long past statement_timeout the client waits before giving up itself. */
export const QUERY_TIMEOUT_MARGIN_MS = 1_000;

export const OPERATOR_POSTGRES_TIMEOUTS = {
  statement_timeout: 300_000,
  lock_timeout: 30_000,
  idle_in_transaction_session_timeout: 60_000,
} as const satisfies PostgresTimeouts;

setPostgresPoolStatsSource(() => {
  const samples: PostgresPoolStatsSample[] = [];
  for (const [name, registeredPools] of pools) {
    let total = 0;
    let idle = 0;
    let waiting = 0;
    const roles = new Set<PostgresConnectionRole>();
    for (const pool of registeredPools) {
      if (pool.ended) {
        registeredPools.delete(pool);
        continue;
      }
      total += pool.totalCount;
      idle += pool.idleCount;
      waiting += pool.waitingCount;
      for (const role of rolesByPool.get(pool) ?? []) {
        roles.add(role);
      }
    }
    if (registeredPools.size === 0) {
      pools.delete(name);
    } else {
      samples.push({ pool: name, roles: [...roles], total, idle, waiting });
    }
  }
  return samples;
});

type PoolConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: Error | boolean) => void,
) => void;

/**
 * A pool that never lends out a connection still inside a transaction (#1285).
 *
 * A client-side query timeout rejects the caller but leaves the server
 * transaction open, and the Prisma adapter then releases the connection as
 * healthy. The next borrower would run inside that transaction and could
 * commit a failed request's writes, or hold its locks. A connection whose last
 * ready-for-query status is not idle is therefore destroyed when it is
 * released: closing the socket makes PostgreSQL roll back and free its locks.
 * Nothing is retried; the caller already holds its error.
 */
class TransactionSafePool extends Pool {
  constructor(
    config: PoolConfig,
    private readonly onDiscard: (
      client: PoolClient,
      transactionStatus: string,
    ) => void,
  ) {
    super(config);
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: PoolConnectCallback): void;
  override connect(
    callback?: PoolConnectCallback,
  ): Promise<PoolClient> | undefined {
    if (callback === undefined) {
      return super.connect().then((client) => this.guard(client));
    }
    // pg-pool's own query() borrows through this callback form.
    super.connect((error, client, done) => {
      if (client === undefined) {
        callback(error, client, done);
        return;
      }
      const guarded = this.guard(client);
      callback(error, guarded, (releaseError) => {
        guarded.release(releaseError);
      });
    });
    return undefined;
  }

  private guard(client: PoolClient): PoolClient {
    const release = client.release.bind(client);
    client.release = (error?: Error | boolean): void => {
      if (error !== undefined && error !== false) {
        release(error);
        return;
      }
      const status = client.getTransactionStatus();
      if (status === 'I') {
        release();
        return;
      }
      this.onDiscard(client, status ?? 'unknown');
      release(new Error('PostgreSQL connection left a transaction open'));
    };
    return client;
  }
}

export function createPostgresPool(
  name: PostgresPoolName,
  config: PoolConfig,
  /** The connection roles the pool serves, reported beside its counts. */
  roles: readonly PostgresConnectionRole[] = [],
): Pool {
  // Clients whose own error was already counted.
  const erroredClients = new WeakSet<PoolClient>();
  const pool = new TransactionSafePool(config, (client, transactionStatus) => {
    // The connection is ended at once, so a driver error still on its way is
    // never emitted; the discard counts as the pool error unless the client
    // already reported one.
    try {
      if (!erroredClients.has(client)) {
        recordPostgresPoolError(name, undefined);
      }
    } catch {
      // An observability failure must not keep the connection in the pool.
    }
    try {
      logger.warn(
        JSON.stringify({
          event: 'postgres_connection_discarded',
          pool: name,
          transaction_status: transactionStatus,
        }),
      );
    } catch {
      // An observability failure must not keep the connection in the pool.
    }
  });
  rolesByPool.set(pool, roles);
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
    client.on('error', (error: Error) => {
      erroredClients.add(client);
      reportError(error);
    });
  });

  return pool;
}

/**
 * Settings shared Prisma pools use across control-plane connection roles.
 * `max` is the connections the roles sharing the pool held apart.
 */
export function postgresPoolOptions(
  databaseUrl: string,
  max: number,
  timeouts: PostgresTimeouts = REQUEST_POSTGRES_TIMEOUTS,
): PoolConfig {
  const statementTimeoutMs = timeouts.statement_timeout;
  return {
    connectionString: databaseUrl,
    max,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
    ...timeouts,
    // statement_timeout is enforced by the server, so a server that stops
    // answering on an open connection would hold the query forever.
    ...(typeof statementTimeoutMs === 'number'
      ? { query_timeout: statementTimeoutMs + QUERY_TIMEOUT_MARGIN_MS }
      : {}),
  };
}

export async function checkPostgresPoolConnection(
  pool: Pool,
  timeoutMs: number,
): Promise<void> {
  // pg reads query_timeout at runtime; @types/pg only declares it on PoolConfig.
  await pool.query({
    text: 'SELECT 1',
    query_timeout: timeoutMs,
  } as QueryConfig);
}
