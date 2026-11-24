import { randomUUID } from 'node:crypto';

import type { GradedAdmissionRequest } from '@/modules/gateway/application/graded-admission.port';
import { ORGANIZATION_RETRY_BUDGET_POLICY } from '@/modules/gateway/application/graded-request/retry-budget-policy';
import { rateLimitWindow } from '@/modules/gateway/application/rate-limit-window';
import { RedisConcurrencyLimiter } from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';
import type { MonthlyBillableUsagePort } from '@/modules/metering/application/billing/monthly-billable-usage.port';
import { PostgresMonthlyBillableUsage } from '@/modules/metering/infrastructure/billing/postgres-monthly-billable-usage';
import { RedisQuotaSeeder } from '@/modules/metering/infrastructure/quota/redis-quota-seed';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/usage-recording/postgres-usage.repository';
import {
  quotaKeyForMonth,
  quotaPeriod,
} from '@/modules/metering/public/quota-counter';
import {
  type PrismaClientHolder,
  createPrismaClient,
} from '@/modules/persistence/persistence.module';

import { createTestPool, testDatabaseUrl } from '../../shared/database';
import {
  ORGANIZATION_A,
  type TenantIsolationFixture,
  createTenantIsolationRedis,
} from '../fixtures';

import type { TcpFaultProxy } from '../../../support/tcp-fault-proxy';
import {
  eventually,
  metricValue,
  postgresThroughProxy,
  redisAnswers,
  redisTarget,
  resetAndSeedTenants,
} from './fault-targets';

// Scenario 5 of #328 (2026-10-09), with #371: the shared Redis loses the
// quota, rate-limit, and in-flight keys while requests run. A lost quota
// counter must come back from durable usage, never as zero, and admission
// must stay bounded.
const DURABLE_USAGE = 7;
const NOOP_LOGGER = { warn: () => undefined, log: () => undefined };

let pool: ReturnType<typeof createTestPool>;
let raw: ReturnType<typeof createTenantIsolationRedis>;
let gatewayRedis: RedisGatewayClient;
let holder: PrismaClientHolder;
let fixture: TenantIsolationFixture;
let durableReads: number;
let admission: RedisGradedAdmission;

function quotaKey(organizationId: string): string {
  return quotaKeyForMonth(organizationId, quotaPeriod(new Date()).key);
}

function request(
  overrides: Partial<GradedAdmissionRequest> = {},
): GradedAdmissionRequest {
  return {
    apiKeyId: fixture.organizationA.apiKey.id,
    rateLimitRpm: 1_000,
    organizationId: ORGANIZATION_A,
    requestId: `req_${randomUUID()}`,
    operation: 'writing.task2.grade',
    monthlyRequestQuota: 100,
    hardStopOnQuota: false,
    retryBudgetPolicy: ORGANIZATION_RETRY_BUDGET_POLICY,
    ...overrides,
  };
}

function seeds(outcome: string): Promise<number> {
  return metricValue('aihub_quota_counter_seeds_total', { outcome });
}

beforeAll(async () => {
  pool = createTestPool();
  raw = createTenantIsolationRedis();
  const target = redisTarget();
  const client = createRedisGatewayClient(
    `redis://${target.host}:${target.port}${target.database}`,
  );
  if (client === undefined) throw new Error('Gateway Redis client missing');
  gatewayRedis = client;
  await redisAnswers(client);
  holder = createPrismaClient('integration-test', testDatabaseUrl());
});

beforeEach(async () => {
  fixture = await resetAndSeedTenants(pool, raw);
  const usage = new PostgresUsageRepository(holder.prisma);
  for (let index = 0; index < DURABLE_USAGE; index += 1) {
    await usage.insert({
      requestId: `req_${randomUUID()}`,
      organizationId: ORGANIZATION_A,
      apiKeyId: fixture.organizationA.apiKey.id,
      service: 'writing',
      operation: 'writing.task2.grade',
      environment: 'production',
      outcome: 'success',
      httpStatus: 200,
      billableRequests: 1,
      meteringStatus: 'complete',
      totalMs: 1,
      billingBasis: 'response',
    });
  }
  durableReads = 0;
  const durable = new PostgresMonthlyBillableUsage(holder.prisma);
  const source: MonthlyBillableUsagePort = {
    billableCount: (organizationId, from, to) => {
      durableReads += 1;
      return durable.billableCount(organizationId, from, to);
    },
  };
  admission = new RedisGradedAdmission(
    gatewayRedis,
    () => Date.now(),
    Math.random,
    NOOP_LOGGER,
    new RedisQuotaSeeder(gatewayRedis, source),
  );
  await raw.del(quotaKey(ORGANIZATION_A));
});

afterAll(async () => {
  await holder.close();
  await gatewayRedis.quit();
  await raw.quit();
  await pool.end();
});

describe('Redis keys lost under load', () => {
  it('rebuilds a lost quota counter from durable usage, once, for concurrent first requests', async () => {
    const seededBefore = await seeds('seeded');

    const decisions = await Promise.all(
      Array.from({ length: 10 }, () => admission.consume(request())),
    );

    expect(new Set(decisions.map(({ stage }) => stage))).toEqual(
      new Set(['admitted']),
    );
    expect(await raw.get(quotaKey(ORGANIZATION_A))).toBe(String(DURABLE_USAGE));
    expect(await raw.ttl(quotaKey(ORGANIZATION_A))).toBeGreaterThan(0);
    expect(durableReads).toBe(1);
    expect(await seeds('seeded')).toBe(seededBefore + 1);
  });

  it('refuses a hard-stop Organization whose durable usage already meets its quota', async () => {
    // Read as zero, the lost counter would admit the whole month again.
    await expect(
      admission.consume(
        request({ monthlyRequestQuota: DURABLE_USAGE, hardStopOnQuota: true }),
      ),
    ).resolves.toMatchObject({ stage: 'quota', quota: DURABLE_USAGE });
    expect(await raw.get(quotaKey(ORGANIZATION_A))).toBe(String(DURABLE_USAGE));
  });

  it('keeps rate-limit admission bounded when its window key is deleted mid-minute', async () => {
    const minuteStart = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    const fixedMinute = new RedisGradedAdmission(
      gatewayRedis,
      () => minuteStart,
      Math.random,
      NOOP_LOGGER,
      new RedisQuotaSeeder(gatewayRedis, { billableCount: async () => 0 }),
    );
    const limited = request({
      apiKeyId: `ak_${randomUUID()}`,
      rateLimitRpm: 10,
    });
    const rateKey = `aihub:v1:rl:${limited.apiKeyId}:${rateLimitWindow(limited.apiKeyId, minuteStart).index}`;

    const admitted: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      if (index === 15) await raw.del(rateKey);
      const decision = await fixedMinute.consume({
        ...limited,
        requestId: `req_${randomUUID()}`,
      });
      admitted.push(decision.stage);
    }

    // One lost window resets the count once: at most twice the limit passes.
    const passed = admitted.filter((stage) => stage === 'admitted').length;
    expect(passed).toBeGreaterThan(10);
    expect(passed).toBeLessThanOrEqual(20);
  });

  it('keeps concurrency bounded when the in-flight set is deleted under load', async () => {
    const limiter = new RedisConcurrencyLimiter(gatewayRedis, NOOP_LOGGER);
    const maxConcurrent = 3;
    let active = 0;
    let peakActive = 0;
    let refused = 0;

    const run = async (): Promise<void> => {
      const decision = await limiter.acquire({
        organizationId: ORGANIZATION_A,
        maxConcurrent,
        requestId: `req_${randomUUID()}`,
        environment: 'production',
      });
      if (!decision.allowed) {
        refused += 1;
        return;
      }
      active += 1;
      peakActive = Math.max(peakActive, active);
      // real-timer-ok: the fault-injection lane waits for Redis and database recovery behavior
      await new Promise((resolve) => setTimeout(resolve, 200));
      active -= 1;
      await decision.lease.release();
    };

    const first = Array.from({ length: 6 }, run);
    // real-timer-ok: the fault-injection lane waits for Redis and database recovery behavior
    await new Promise((resolve) => setTimeout(resolve, 50));
    await raw.del(`aihub:v1:inflight:${ORGANIZATION_A}`);
    const second = Array.from({ length: 6 }, run);
    await Promise.all([...first, ...second]);

    // The deleted set forgets the running leases once: at most twice the
    // limit runs together, the excess is still refused, and nothing leaks.
    expect(peakActive).toBeGreaterThan(maxConcurrent);
    expect(peakActive).toBeLessThanOrEqual(2 * maxConcurrent);
    expect(refused).toBeGreaterThan(0);
    expect(await raw.zcard(`aihub:v1:inflight:${ORGANIZATION_A}`)).toBe(0);
  });
});

describe('a lost quota counter whose durable usage source is down', () => {
  let proxy: TcpFaultProxy;
  let proxiedHolder: PrismaClientHolder;
  let unverifiable: RedisGradedAdmission;

  beforeAll(async () => {
    const target = await postgresThroughProxy();
    proxy = target.proxy;
    proxiedHolder = createPrismaClient('integration-test', target.url);
    // Built as metering.module.ts builds it, with PostgreSQL behind the proxy.
    unverifiable = new RedisGradedAdmission(
      gatewayRedis,
      () => Date.now(),
      Math.random,
      NOOP_LOGGER,
      new RedisQuotaSeeder(
        gatewayRedis,
        new PostgresMonthlyBillableUsage(proxiedHolder.prisma),
      ),
    );
  });

  afterEach(async () => {
    await proxy.setMode('normal');
  });

  afterAll(async () => {
    await proxiedHolder.close();
    await proxy.close();
  });

  it('fails a hard-stop Organization closed and admits others as quota_unverified, never reading the lost counter as zero', async () => {
    const failedBefore = await seeds('failed');
    await proxy.setMode('refuse');

    await expect(
      unverifiable.consume(
        request({ monthlyRequestQuota: 100, hardStopOnQuota: true }),
      ),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
    await expect(unverifiable.consume(request())).resolves.toMatchObject({
      stage: 'admitted',
      quotaUnverified: true,
    });
    // No count was written in place of the durable one.
    expect(await raw.get(quotaKey(ORGANIZATION_A))).toBeNull();
    expect(await seeds('failed')).toBeGreaterThanOrEqual(failedBefore + 2);
  });

  it('rebuilds the counter from durable usage once the source returns', async () => {
    await proxy.setMode('refuse');
    await expect(unverifiable.consume(request())).resolves.toMatchObject({
      quotaUnverified: true,
    });

    await proxy.setMode('normal');
    // The pool may still hold its breaker open for a second after the
    // refusals, so the first rebuild can fail once more.
    let decision = await unverifiable.consume(request());
    await eventually(async () => {
      if (!('quotaUnverified' in decision)) return true;
      decision = await unverifiable.consume(request());
      return false;
    }, 5_000);

    expect(decision).toMatchObject({ stage: 'admitted' });
    expect(decision).not.toHaveProperty('quotaUnverified');
    expect(await raw.get(quotaKey(ORGANIZATION_A))).toBe(
      String(DURABLE_USAGE + 1),
    );
  });
});
