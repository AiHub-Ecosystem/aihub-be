import { PrismaPg } from '@prisma/adapter-pg';
import { type PoolConfig, type QueryConfig } from 'pg';

import type { PostgresConnectionRole } from '@/common/observability/metrics';
import { createPostgresPool } from '@/common/postgres/postgres-pool';
import type {
  PrismaClientHolder,
  PrismaClientUrls,
  SharedPrismaClients,
} from '@/modules/persistence/application/persistence-client.port';
import { PrismaClient } from '@prisma-client/client';

/**
 * The shared Prisma clients (ADR-0088, #81).
 *
 * One process opens one pool per distinct connection URL, not one per module: a
 * Production tier whose three URLs are equal opens a single pool, and a tier
 * that separates control-plane reads opens exactly as many pools as it has
 * distinct databases. That makes the connection budget per database something a
 * reader can check, instead of a multiple of the number of modules.
 *
 * Nothing here reads the environment. Nest passes validated configuration and
 * CLI composition roots pass an explicit URL, so a command can only reach a
 * database the runtime secrets named.
 */

/**
 * The settings every control-plane pool already used: a 1 s connection timeout
 * matched to the interactive transaction's `maxWait`, a 30 s idle timeout, and
 * the largest maximum any pool on this role had (10, for Auth, Idempotency,
 * Metering, and Identity). Taking the largest never lowers a ceiling a module
 * already relied on; the smaller pools that move onto this one were under the
 * limit rather than over it.
 */
export function postgresPoolOptions(databaseUrl: string): PoolConfig {
  return {
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 1_000,
    idleTimeoutMillis: 30_000,
  };
}

export function createPrismaClient(
  role: PostgresConnectionRole,
  databaseUrl: string,
): PrismaClientHolder {
  const pool = createPostgresPool(role, postgresPoolOptions(databaseUrl));
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  return {
    prisma,
    pool,
    checkConnection: async (timeoutMs) => {
      // pg reads query_timeout per query at runtime; @types/pg only declares it
      // on PoolConfig.
      await pool.query({
        text: 'SELECT 1',
        query_timeout: timeoutMs,
      } as QueryConfig);
    },
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/**
 * Same first-use failure as the clients this replaces: no pool is built until a
 * URL names one, so a unit test cannot reach whatever PostgreSQL answers on the
 * default host.
 */
function unconfiguredPrismaClient(): PrismaClientHolder {
  const unconfigured = (): never => {
    throw new Error('PostgreSQL is not configured');
  };

  return {
    get prisma(): never {
      return unconfigured();
    },
    get pool(): never {
      return unconfigured();
    },
    checkConnection: async () => unconfigured(),
    close: async () => undefined,
  };
}

/**
 * The three clients, sharing one pool per distinct URL. A Production tier sets
 * one URL for all three roles; the first role to claim it names the pool's
 * metric label, which is why the claim order below is fixed.
 */
export function createSharedPrismaClients(
  urls: PrismaClientUrls,
): SharedPrismaClients {
  const pools = new Map<string, PrismaClientHolder>();

  const holderFor = (
    role: PostgresConnectionRole,
    databaseUrl: string | undefined,
  ): PrismaClientHolder => {
    if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
      return unconfiguredPrismaClient();
    }

    const existing = pools.get(databaseUrl);
    if (existing !== undefined) {
      return existing;
    }

    const created = createPrismaClient(role, databaseUrl);
    pools.set(databaseUrl, created);
    return created;
  };

  const runtime = holderFor('runtime', urls.databaseUrl);
  const controlPlane = holderFor('control-plane', urls.controlPlaneDatabaseUrl);
  const controlPlaneRead = holderFor(
    'control-plane-read',
    urls.controlPlaneReadDatabaseUrl,
  );

  return {
    runtime,
    controlPlane,
    controlPlaneRead,
    close: async () => {
      for (const holder of new Set(pools.values())) {
        await holder.close();
      }
    },
  };
}
