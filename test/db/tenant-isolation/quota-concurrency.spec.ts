import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { RedisConcurrencyLimiter } from '../../../src/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  RedisQuotaCounter,
  quotaKeyForMonth,
} from '../../../src/modules/gateway/infrastructure/redis-quota-counter';
import { QuotaGuard } from '../../../src/modules/gateway/presentation/quota.guard';
import { generateApiKey } from '../../../src/modules/identity/domain/api-key';

import { createTestPool } from '../database';

import {
  ORGANIZATION_A,
  ORGANIZATION_B,
  SHARED_MONTH,
  TEST_NOW,
  type TenantIsolationRedisClients,
  createTenantIdentity,
  createTenantIsolationRedisClients,
  resetTenantIsolation,
  seedTenantIsolation,
} from './fixtures';

const NOOP_LOGGER = {
  warn: () => undefined,
  log: () => undefined,
};

function quotaContext(organizationId: string): ExecutionContextHost {
  return new ExecutionContextHost([
    {
      aihubAuth: {
        organizationId,
        monthlyRequestQuota: 1,
        hardStopOnQuota: true,
      },
    },
  ]);
}

let pool: ReturnType<typeof createTestPool>;
let redisClients: TenantIsolationRedisClients;

beforeAll(() => {
  pool = createTestPool();
  redisClients = createTenantIsolationRedisClients();
});

beforeEach(async () => {
  await resetTenantIsolation(pool, redisClients.raw);
  await seedTenantIsolation(
    pool,
    await createTenantIdentity('https://tenant-a.example.test', 'tenant-a-key'),
    await createTenantIdentity('https://tenant-b.example.test', 'tenant-b-key'),
    generateApiKey(TEST_NOW),
    generateApiKey(TEST_NOW),
  );
});

afterAll(async () => {
  await pool.end();
  await redisClients.raw.quit();
});

describe('tenant isolation for Redis counters', () => {
  it('keeps quota consumption and allowance state separate for the same month', async () => {
    const counter = new RedisQuotaCounter(
      redisClients.gateway,
      () => TEST_NOW,
      NOOP_LOGGER,
    );

    await counter.increment({ organizationId: ORGANIZATION_A });
    await counter.increment({ organizationId: ORGANIZATION_A });
    await counter.increment({ organizationId: ORGANIZATION_B });

    await expect(
      counter.read({ organizationId: ORGANIZATION_A }),
    ).resolves.toBe(2);
    await expect(
      counter.read({ organizationId: ORGANIZATION_B }),
    ).resolves.toBe(1);
    await expect(
      redisClients.raw.get(quotaKeyForMonth(ORGANIZATION_A, SHARED_MONTH)),
    ).resolves.toBe('2');
    await expect(
      redisClients.raw.get(quotaKeyForMonth(ORGANIZATION_B, SHARED_MONTH)),
    ).resolves.toBe('1');
  });

  it('does not use one Organization exhaustion to block another Organization admission', async () => {
    const counter = new RedisQuotaCounter(
      redisClients.gateway,
      () => TEST_NOW,
      NOOP_LOGGER,
    );
    await counter.increment({ organizationId: ORGANIZATION_A });
    const guard = new QuotaGuard(counter, () => TEST_NOW);

    await expect(
      guard.canActivate(quotaContext(ORGANIZATION_A)),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(guard.canActivate(quotaContext(ORGANIZATION_B))).resolves.toBe(
      true,
    );
  });

  it('does not let one Organization consume another Organization concurrency lease', async () => {
    const limiter = new RedisConcurrencyLimiter(
      redisClients.gateway,
      () => TEST_NOW.getTime(),
      NOOP_LOGGER,
    );

    const firstA = await limiter.acquire({
      organizationId: ORGANIZATION_A,
      maxConcurrent: 1,
      requestId: 'req_concurrency_a_1',
    });
    const firstB = await limiter.acquire({
      organizationId: ORGANIZATION_B,
      maxConcurrent: 1,
      requestId: 'req_concurrency_b_1',
    });
    const secondA = await limiter.acquire({
      organizationId: ORGANIZATION_A,
      maxConcurrent: 1,
      requestId: 'req_concurrency_a_2',
    });

    expect(firstA.allowed).toBe(true);
    expect(firstB.allowed).toBe(true);
    expect(secondA).toEqual({
      allowed: false,
      retryAfterMs: 500,
    });
    if (firstA.allowed) {
      await firstA.lease.release();
    }
    await expect(
      redisClients.raw.zcard(`aihub:v1:inflight:${ORGANIZATION_A}`),
    ).resolves.toBe(0);
    await expect(
      redisClients.raw.zcard(`aihub:v1:inflight:${ORGANIZATION_B}`),
    ).resolves.toBe(1);
  });
});
