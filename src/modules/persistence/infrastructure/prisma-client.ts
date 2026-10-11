import { PrismaPg } from '@prisma/adapter-pg';

import type {
  PostgresConnectionRole,
  PostgresPoolName,
} from '@/common/observability/metrics';
import {
  checkPostgresPoolConnection,
  createPostgresPool,
  postgresPoolOptions,
} from '@/common/postgres/postgres-pool';
import { PrismaClient } from '@prisma-client/client';
import type {
  PrismaClientHolder,
  PrismaClientUrls,
  SharedPrismaClients,
} from './persistence-client';
import { isLifecycleProperty } from './prisma-raw';

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

export function createPrismaClient(
  role: PostgresPoolName,
  databaseUrl: string,
): PrismaClientHolder {
  const pool = createPostgresPool(role, postgresPoolOptions(databaseUrl));
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  return {
    prisma,
    pool,
    checkConnection: (timeoutMs) =>
      checkPostgresPoolConnection(pool, timeoutMs),
    close: async () => {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

/**
 * A client whose first use, not its construction, resolves the real one. A
 * deployment without a control-plane URL still has to assemble the module
 * graph, so a role without a URL hands out this and fails when it is used.
 */
function deferPrismaClient(getPrisma: () => PrismaClient): PrismaClient {
  return new Proxy({} as PrismaClient, {
    has(_target, property) {
      return property in getPrisma();
    },
    get(_target, property) {
      if (isLifecycleProperty(property)) {
        return undefined;
      }
      const prisma = getPrisma();
      const value = Reflect.get(prisma, property, prisma);
      return typeof value === 'function' ? value.bind(prisma) : value;
    },
  });
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
    prisma: deferPrismaClient(unconfigured),
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
