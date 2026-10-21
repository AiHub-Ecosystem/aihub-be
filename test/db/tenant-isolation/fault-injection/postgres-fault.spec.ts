import { randomUUID } from 'node:crypto';

import {
  QUERY_TIMEOUT_MARGIN_MS,
  REQUEST_POSTGRES_TIMEOUTS,
} from '@/common/postgres/postgres-pool';
import { isPostgresUnavailable } from '@/common/postgres/postgres-unavailable-error';
import { ApiKeyAuthenticator } from '@/modules/identity/api-keys/application/api-key-authenticator';
import type {
  ApiKeyCachePort,
  AuthFailureCounterPort,
} from '@/modules/identity/api-keys/application/api-key-authenticator.port';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';
import { PostgresApiKeyRepository } from '@/modules/identity/api-keys/infrastructure/postgres-api-key.repository';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/postgres-usage.repository';
import { createPrismaClient } from '@/modules/persistence/persistence.module';

import { createTestPool } from '../../shared/database';
import {
  ORGANIZATION_A,
  TEST_NOW,
  type TenantIsolationFixture,
  createTenantIdentity,
  createTenantIsolationRedis,
  resetTenantIsolation,
  seedTenantIsolation,
} from '../fixtures';

import {
  eventually,
  postgresThroughProxy,
  rejection,
  timed,
} from './fault-targets';
import type { FaultMode, TcpFaultProxy } from './tcp-fault-proxy';

// A refused or unreachable server fails at connectionTimeoutMillis (1 s); a
// server that stops answering an open connection fails at query_timeout.
const REFUSED_BOUND_MS = 2_000;
const STALLED_BOUND_MS =
  REQUEST_POSTGRES_TIMEOUTS.statement_timeout + QUERY_TIMEOUT_MARGIN_MS + 1_500;

const noCache: ApiKeyCachePort = {
  get: async () => undefined,
  set: async () => undefined,
  setMiss: async () => undefined,
  delete: async () => undefined,
};

const noFailures: AuthFailureCounterPort = {
  get: async () => 0,
  recordFailure: async () => 0,
};

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let proxy: TcpFaultProxy;
let proxiedUrl: string;
let fixture: TenantIsolationFixture;

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  const target = await postgresThroughProxy();
  proxy = target.proxy;
  proxiedUrl = target.url;
});

beforeEach(async () => {
  await proxy.setMode('normal');
  await resetTenantIsolation(pool, raw);
  fixture = await seedTenantIsolation(
    pool,
    await createTenantIdentity('https://tenant-a.example.test', 'tenant-a-key'),
    await createTenantIdentity('https://tenant-b.example.test', 'tenant-b-key'),
    generateOrganizationApiKey(TEST_NOW),
    generateOrganizationApiKey(TEST_NOW),
  );
});

afterAll(async () => {
  await proxy.close();
  await pool.end();
  await raw.quit();
});

function usageRecord() {
  return {
    requestId: `req_${randomUUID()}`,
    organizationId: ORGANIZATION_A,
    apiKeyId: fixture.organizationA.apiKey.id,
    service: 'writing',
    operation: 'writing.task2.grade',
    environment: 'production',
    outcome: 'success' as const,
    httpStatus: 200,
    billableRequests: 1,
    meteringStatus: 'not_applicable' as const,
    totalMs: 1,
    billingBasis: 'response' as const,
  };
}

describe.each<[FaultMode, number]>([
  ['refuse', REFUSED_BOUND_MS],
  ['hang', STALLED_BOUND_MS],
])('Postgres while it is %s', (mode, boundMs) => {
  it('fails API-key lookup and usage writes as a retryable outage inside the bound, then recovers without leaking connections', async () => {
    const holder = createPrismaClient('integration-test', proxiedUrl);
    const authenticator = new ApiKeyAuthenticator(
      new PostgresApiKeyRepository(holder.prisma),
      noCache,
      noFailures,
      () => TEST_NOW,
    );
    const usage = new PostgresUsageRepository(holder.prisma);
    const credential = {
      value: fixture.organizationA.apiKey.raw,
      environment: 'production',
      clientIp: '198.51.100.8',
    };

    try {
      // Open pooled connections first, so the stall hits a live connection.
      await expect(
        authenticator.authenticate(credential),
      ).resolves.toMatchObject({ organizationId: ORGANIZATION_A });

      await proxy.setMode(mode);
      const lookup = await timed(() => authenticator.authenticate(credential));
      const write = await timed(() => usage.insert(usageRecord()));

      // The identity store answers the outage itself; a usage write's driver
      // error is mapped by the exception filter, which reads the same test.
      expect(rejection(lookup.result)).toMatchObject({
        code: 'DATABASE_UNAVAILABLE',
        httpStatus: 503,
        retryable: true,
        retryAfterMs: 1_000,
      });
      expect(isPostgresUnavailable(rejection(write.result))).toBe(true);
      expect(Math.max(lookup.ms, write.ms)).toBeLessThan(boundMs);

      await proxy.setMode('normal');
      await eventually(async () => {
        await authenticator.authenticate(credential);
        return true;
      }, 5_000);
      await usage.insert(usageRecord());
      await eventually(
        // Every pooled connection is idle again: none is held checked out.
        async () => holder.pool.idleCount === holder.pool.totalCount,
        5_000,
      );
      expect(holder.pool.totalCount).toBeLessThanOrEqual(10);
    } finally {
      await proxy.setMode('normal');
      await holder.close();
    }
  }, 30_000);
});

it('answers or refuses retryably inside the bound while Postgres is slow, then recovers', async () => {
  const holder = createPrismaClient('integration-test', proxiedUrl);
  const authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(holder.prisma),
    noCache,
    noFailures,
    () => TEST_NOW,
  );
  const usage = new PostgresUsageRepository(holder.prisma);
  const credential = {
    value: fixture.organizationA.apiKey.raw,
    environment: 'production',
    clientIp: '198.51.100.9',
  };
  try {
    await authenticator.authenticate(credential);

    // Each round trip now waits; a call either completes or meets one of the
    // pool's bounds (1 s to connect, query_timeout to answer) as a 503.
    await proxy.setMode('slow');
    const lookup = await timed(() => authenticator.authenticate(credential));
    const write = await timed(() => usage.insert(usageRecord()));

    const lookupOutcome =
      lookup.result.status === 'fulfilled'
        ? lookup.result.value.organizationId
        : (lookup.result.reason as { readonly code?: string }).code;
    const writeOutcome =
      write.result.status === 'fulfilled'
        ? 'written'
        : isPostgresUnavailable(write.result.reason)
          ? 'unavailable'
          : 'other failure';
    expect([ORGANIZATION_A, 'DATABASE_UNAVAILABLE']).toContain(lookupOutcome);
    expect(['written', 'unavailable']).toContain(writeOutcome);
    expect(Math.max(lookup.ms, write.ms)).toBeLessThan(STALLED_BOUND_MS);

    await proxy.setMode('normal');
    await eventually(async () => {
      await authenticator.authenticate(credential);
      return true;
    }, 5_000);
  } finally {
    await proxy.setMode('normal');
    await holder.close();
  }
}, 30_000);
