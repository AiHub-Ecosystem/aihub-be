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

      for (const call of [lookup, write]) {
        expect(isPostgresUnavailable(rejection(call.result))).toBe(true);
        expect(call.ms).toBeLessThan(boundMs);
      }

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

it('keeps serving through a slow Postgres', async () => {
  await proxy.setMode('normal');
  const holder = createPrismaClient('integration-test', proxiedUrl);
  const authenticator = new ApiKeyAuthenticator(
    new PostgresApiKeyRepository(holder.prisma),
    noCache,
    noFailures,
    () => TEST_NOW,
  );
  const credential = {
    value: fixture.organizationA.apiKey.raw,
    environment: 'production',
    clientIp: '198.51.100.9',
  };
  try {
    // A slow link delays each round trip; the pool connects before it slows.
    await authenticator.authenticate(credential);
    await proxy.setMode('slow');
    const lookup = await timed(() => authenticator.authenticate(credential));
    expect(lookup.result).toMatchObject({
      status: 'fulfilled',
      value: { organizationId: ORGANIZATION_A },
    });
    expect(lookup.ms).toBeLessThan(STALLED_BOUND_MS);
  } finally {
    await proxy.setMode('normal');
    await holder.close();
  }
}, 30_000);
