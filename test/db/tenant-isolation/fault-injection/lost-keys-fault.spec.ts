import { randomUUID } from 'node:crypto';

import type { GradedAdmissionRequest } from '@/modules/gateway/application/graded-admission.port';
import { quotaPeriod } from '@/modules/gateway/application/quota-period';
import type { QuotaUsageSourcePort } from '@/modules/gateway/application/quota-usage-source.port';
import { RedisConcurrencyLimiter } from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  type RedisGatewayClient,
  createRedisGatewayClient,
} from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';
import { quotaKeyForMonth } from '@/modules/gateway/infrastructure/redis-quota-counter';
import { RedisQuotaSeeder } from '@/modules/gateway/infrastructure/redis-quota-seed';
import { PostgresUsageRepository } from '@/modules/metering/infrastructure/postgres-usage.repository';
import { PostgresMonthlyBillableUsage } from '@/modules/metering/public/quota-reconciliation';
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

import {
  metricValue,
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
  const source: QuotaUsageSourcePort = {
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
    ).resolves.toEqual({ stage: 'quota', quota: DURABLE_USAGE });
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
    const rateKey = `aihub:v1:rl:${limited.apiKeyId}:${Math.floor(minuteStart / 60_000)}`;

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
      await new Promise((resolve) => setTimeout(resolve, 200));
      active -= 1;
      await decision.lease.release();
    };

    const first = Array.from({ length: 6 }, run);
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
