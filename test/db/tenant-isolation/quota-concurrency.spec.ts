import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { RedisConcurrencyLimiter } from '@/modules/gateway/infrastructure/redis-concurrency-limiter';
import {
  RedisOrganizationRetryBudget,
  type RedisOrganizationRetryBudgetClient,
} from '@/modules/gateway/infrastructure/redis-organization-retry-budget';
import {
  RedisQuotaCounter,
  quotaKeyForMonth,
} from '@/modules/gateway/infrastructure/redis-quota-counter';
import { RedisQuotaSeeder } from '@/modules/gateway/infrastructure/redis-quota-seed';
import { QuotaGuard } from '@/modules/gateway/presentation/quota.guard';
import { generateOrganizationApiKey } from '@/modules/identity/api-keys/application/organization-api-key-generator';

import { createTestPool } from '../shared/database';

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
      headers: {},
      aihubAuth: {
        organizationId,
        monthlyRequestQuota: 1,
        hardStopOnQuota: true,
      },
    },
  ]);
}

/** A quota counter that rebuilds a missing month from no durable usage. */
function quotaCounter(): RedisQuotaCounter {
  return new RedisQuotaCounter(
    redisClients.gateway,
    () => TEST_NOW,
    NOOP_LOGGER,
    new RedisQuotaSeeder(redisClients.gateway, {
      billableCount: async () => 0,
    }),
  );
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
    generateOrganizationApiKey(TEST_NOW),
    generateOrganizationApiKey(TEST_NOW),
  );
});

afterAll(async () => {
  await pool.end();
  await redisClients.raw.quit();
});

describe('tenant isolation for Redis counters', () => {
  // Presence-shaped: the counts on each Organization's own counter.
  it('keeps quota consumption and allowance state separate for the same month', async () => {
    const counter = quotaCounter();

    // Admission rebuilds each month's counter before anything increments it.
    await counter.read({ organizationId: ORGANIZATION_A });
    await counter.increment({ organizationId: ORGANIZATION_A });
    await counter.increment({ organizationId: ORGANIZATION_A });

    // Absence: A's two increments must not have touched B's counter, so an
    // unscoped read that shared one key for both Organizations would not leave
    // B at zero.
    await expect(
      redisClients.raw.get(quotaKeyForMonth(ORGANIZATION_B, SHARED_MONTH)),
    ).resolves.toBeNull();

    await counter.read({ organizationId: ORGANIZATION_B });
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

  // Refusal-shaped: an exhausted Organization refuses, a different one is admitted.
  it('does not use one Organization exhaustion to block another Organization admission', async () => {
    const counter = quotaCounter();
    await counter.read({ organizationId: ORGANIZATION_A });
    await counter.increment({ organizationId: ORGANIZATION_A });
    const guard = new QuotaGuard(counter, () => TEST_NOW);

    await expect(
      guard.canActivate(quotaContext(ORGANIZATION_A)),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(guard.canActivate(quotaContext(ORGANIZATION_B))).resolves.toBe(
      true,
    );
  });

  // Refusal-shaped: a second lease for A is refused while B still holds one.
  it('does not let one Organization consume another Organization concurrency lease', async () => {
    const limiter = new RedisConcurrencyLimiter(
      redisClients.gateway,
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
    if (secondA.allowed) {
      throw new Error('expected the second request to be refused');
    }
    expect(secondA.retryAfterMs).toBeGreaterThan(0);
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

  it('bounds a five-times same-key retry storm across two Redis clients', async () => {
    const secondRedis = redisClients.raw.duplicate();
    await new Promise<void>((resolve, reject) => {
      secondRedis.once('ready', resolve);
      secondRedis.once('error', reject);
    });
    const secondClient: RedisOrganizationRetryBudgetClient = {
      eval: async (script, numberOfKeys, ...args) => {
        const result = await secondRedis.eval(
          script,
          numberOfKeys,
          ...args.map(String),
        );
        if (typeof result !== 'number') {
          throw new Error('Redis eval result is invalid');
        }
        return result;
      },
      quit: () => secondRedis.quit(),
    };
    const firstInstance = new RedisOrganizationRetryBudget(
      '',
      redisClients.gateway,
      () => 0,
      NOOP_LOGGER,
    );
    const secondInstance = new RedisOrganizationRetryBudget(
      '',
      secondClient,
      () => 0,
      NOOP_LOGGER,
    );
    let requestNumber = 0;
    const consume = (
      budget: RedisOrganizationRetryBudget,
      organizationId: string,
      idempotencyKey: string,
      operation: 'writing.task1.grade' | 'writing.task2.grade',
    ) =>
      budget.consume({
        organizationId,
        idempotencyKey,
        operation,
        requestId: `req_retry_storm_${requestNumber++}`,
      });

    try {
      const firstAttempts = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          consume(
            firstInstance,
            ORGANIZATION_A,
            `storm-${index}`,
            index % 2 === 0 ? 'writing.task1.grade' : 'writing.task2.grade',
          ),
        ),
      );
      expect(firstAttempts.every(({ allowed }) => allowed)).toBe(true);

      const retries = await Promise.all(
        Array.from({ length: 40 }, (_, index) => {
          const firstAttempt = index % 10;
          return consume(
            index % 2 === 0 ? firstInstance : secondInstance,
            ORGANIZATION_A,
            `storm-${firstAttempt}`,
            firstAttempt % 2 === 0
              ? 'writing.task1.grade'
              : 'writing.task2.grade',
          );
        }),
      );
      const admittedIngress =
        firstAttempts.filter(({ allowed }) => allowed).length +
        retries.filter(({ allowed }) => allowed).length;

      expect(retries.filter(({ allowed }) => allowed)).toHaveLength(1);
      expect(admittedIngress).toBeLessThanOrEqual(10 * 1.1);

      const lowVolumeFirst = await consume(
        firstInstance,
        ORGANIZATION_B,
        'single-first-attempt',
        'writing.task1.grade',
      );
      const lowVolumeRetries = await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          consume(
            index % 2 === 0 ? firstInstance : secondInstance,
            ORGANIZATION_B,
            'single-first-attempt',
            'writing.task1.grade',
          ),
        ),
      );

      expect(lowVolumeFirst.allowed).toBe(true);
      expect(lowVolumeRetries.filter(({ allowed }) => allowed)).toHaveLength(1);
    } finally {
      await secondRedis.quit();
    }
  });
});
