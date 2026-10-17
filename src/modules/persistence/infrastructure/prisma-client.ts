import { PrismaPg } from '@prisma/adapter-pg';

import type {
  PostgresConnectionRole,
  PostgresPoolName,
} from '@/common/observability/metrics';
import {
  OPERATOR_POSTGRES_TIMEOUTS,
  type PostgresTimeouts,
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

/**
 * What each role replaces. On the way in, every module opened a pool of its own;
 * a role now holds the sum of the pools of the modules it serves, so merging
 * roles into one pool keeps the concurrency they had apart:
 *
 * - `runtime`: Auth 10, Idempotency 10, Metering 10, Avatar 5, Speaking audio 5,
 *   Sandbox budget 4.
 * - `control-plane`: the Identity write pool (10) and the one transaction
 *   runner that replaces the Identity repositories' own clients (10).
 * - `control-plane-read`: the Identity read pool (10).
 *
 * #383 owns tuning; `aihub_postgres_pool_waiting` is the signal.
 */
const POOL_CONNECTIONS: Readonly<Record<PostgresPoolName, number>> = {
  runtime: 44,
  'control-plane': 20,
  'control-plane-read': 10,
  'integration-test': 10,
};

interface PrismaClientOptions {
  readonly roles?: readonly PostgresConnectionRole[];
  readonly timeouts?: PostgresTimeouts;
}

export function createPrismaClient(
  role: PostgresPoolName,
  databaseUrl: string,
  options: PrismaClientOptions = {},
): PrismaClientHolder {
  if (databaseUrl.trim().length === 0) {
    return unconfiguredPrismaClient();
  }

  const roles = options.roles ?? (role === 'integration-test' ? [] : [role]);
  const connections =
    roles.length === 0
      ? POOL_CONNECTIONS[role]
      : roles.reduce((sum, served) => sum + POOL_CONNECTIONS[served], 0);
  const pool = createPostgresPool(
    role,
    postgresPoolOptions(databaseUrl, connections, options.timeouts),
    roles,
  );
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

export function createOperatorPrismaClient(
  role: PostgresPoolName,
  databaseUrl: string,
): PrismaClientHolder {
  return createPrismaClient(role, databaseUrl, {
    timeouts: OPERATOR_POSTGRES_TIMEOUTS,
  });
}

/**
 * A client whose first use, not its construction, resolves the real one. A
 * deployment without a control-plane URL still has to assemble the module
 * graph, so a role without a URL hands out this and fails when it is used.
 */
function deferPrismaClient(getPrisma: () => PrismaClient): PrismaClient {
  // `close` is probed by repositories that close a client they were handed,
  // as `this.client.close?.()` or `'close' in this.client`. A shared client
  // has none, and probing an unconfigured one must not be the first use that
  // fails, or shutting down a database-free application throws.
  const isProbe = (property: PropertyKey): boolean =>
    isLifecycleProperty(property) || property === 'close';

  return new Proxy({} as PrismaClient, {
    has(_target, property) {
      if (isProbe(property)) {
        return false;
      }
      return property in getPrisma();
    },
    get(_target, property) {
      if (isProbe(property)) {
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

  const roleUrls: readonly (readonly [
    PostgresConnectionRole,
    string | undefined,
  ])[] = [
    ['runtime', urls.databaseUrl],
    ['control-plane', urls.controlPlaneDatabaseUrl],
    ['control-plane-read', urls.controlPlaneReadDatabaseUrl],
  ];
  const rolesFor = (url: string): readonly PostgresConnectionRole[] =>
    roleUrls.flatMap(([role, candidate]) => (candidate === url ? [role] : []));

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

    const created = createPrismaClient(role, databaseUrl, {
      roles: rolesFor(databaseUrl),
    });
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

/**
 * Test-only: a client with a pool of its own for the unchanged database-lane
 * specs, which open their own connection rather than receive the shared one.
 * No production module constructs it (ADR-0088, "Test-only compatibility
 * exceptions").
 */
export function createFixturePrismaClient(
  databaseUrl: string,
  unavailableMessage = 'DATABASE_URL is missing',
): PrismaClient & { close(): Promise<void> } {
  if (databaseUrl.trim().length === 0) {
    throw new Error(unavailableMessage);
  }

  const holder = createPrismaClient('integration-test', databaseUrl);
  return Object.assign(holder.prisma, { close: () => holder.close() });
}
