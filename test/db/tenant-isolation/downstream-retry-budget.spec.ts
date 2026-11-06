import { once } from 'node:events';

import type Redis from 'ioredis';

import type { OperationId } from '@/catalog/operation-id';
import { RedisDownstreamRetryBudget } from '@/modules/gateway/infrastructure/redis-downstream-retry-budget';
import { createTestPool } from '../shared/database';
import {
  createTenantIsolationRedisClients,
  resetTenantIsolation,
} from './fixtures';

const task1: OperationId = 'writing.task1.grade';
const task2: OperationId = 'writing.task2.grade';
const speaking: OperationId = 'speaking.grading';
const serviceKey = (service: string) =>
  `aihub:v1:downstream-retry-service:{${service}}`;
const operationKeys = (operation: OperationId) => [
  `aihub:v1:downstream-retry:{${operation}}:first`,
  `aihub:v1:downstream-retry:{${operation}}:retries`,
];

let redis: Redis;
let replicaRedis: Redis;
let gateway: ReturnType<typeof createTenantIsolationRedisClients>['gateway'];
let replicaGateway: ReturnType<
  typeof createTenantIsolationRedisClients
>['gateway'];
let pool: ReturnType<typeof createTestPool>;

async function recordFirstAttempts(
  budget: RedisDownstreamRetryBudget,
  operation: OperationId,
  prefix: string,
  count = 10,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await budget.recordFirstAttempt(operation, `${prefix}-${index}`);
  }
}

async function clearBudgetState(): Promise<void> {
  await redis.del(
    serviceKey('ai-writing'),
    serviceKey('ai-speaking'),
    ...operationKeys(task1),
    ...operationKeys(task2),
    ...operationKeys(speaking),
  );
}

beforeAll(async () => {
  pool = createTestPool();
  const clients = createTenantIsolationRedisClients();
  const replicaClients = createTenantIsolationRedisClients();
  redis = clients.raw;
  gateway = clients.gateway;
  replicaRedis = replicaClients.raw;
  replicaGateway = replicaClients.gateway;
  if (redis.status !== 'ready') await once(redis, 'ready');
  if (replicaRedis.status !== 'ready') await once(replicaRedis, 'ready');
});

beforeEach(async () => {
  await resetTenantIsolation(pool, redis);
});

afterAll(async () => {
  await clearBudgetState();
  await pool?.end();
  await Promise.all([redis?.quit(), replicaRedis?.quit()]);
});

describe('RedisDownstreamRetryBudget service bucket Lua', () => {
  it('bounds concurrent retries across operations, clients, and both budgets', async () => {
    const buckets = {
      'ai-writing': {
        ratePerSecond: 0.001,
        burst: 3,
        expectedAttemptMs: 100,
      },
    } as const;
    const instanceA = new RedisDownstreamRetryBudget(gateway, buckets);
    const instanceB = new RedisDownstreamRetryBudget(replicaGateway, buckets);
    await Promise.all([
      recordFirstAttempts(instanceA, task1, 'instance-a-task1', 20),
      recordFirstAttempts(instanceB, task2, 'instance-b-task2', 20),
    ]);

    const reservations = Array.from({ length: 20 }, (_, index) => {
      const operation = index % 2 === 0 ? task1 : task2;
      const budget = index % 2 === 0 ? instanceA : instanceB;
      return { operation, budget, requestId: `concurrent-retry-${index}` };
    });
    const decisions = await Promise.all(
      reservations.map(({ operation, budget, requestId }) =>
        budget.reserveRetry(operation, requestId, 1),
      ),
    );
    const admittedByOperation = [task1, task2].map(
      (operation) =>
        decisions.filter(
          (decision, index) =>
            decision === 'admitted' &&
            reservations[index]?.operation === operation,
        ).length,
    );

    expect(
      decisions.filter((decision) => decision === 'admitted'),
    ).toHaveLength(3);
    expect(admittedByOperation.sort((left, right) => left - right)).toEqual([
      1, 2,
    ]);
  });

  it('retains a slow bucket through its refill horizon and preserves fast-bucket expiry', async () => {
    const slow = new RedisDownstreamRetryBudget(gateway, {
      'ai-writing': {
        ratePerSecond: 0.001,
        burst: 2,
        expectedAttemptMs: 100,
      },
    });
    await recordFirstAttempts(slow, task1, 'slow-task1');
    await expect(slow.reserveRetry(task1, 'slow-retry-1', 1)).resolves.toBe(
      'admitted',
    );
    expect(await redis.pttl(serviceKey('ai-writing'))).toBeGreaterThan(
      1_999_000,
    );

    const [seconds, microseconds] = await redis.time();
    const nowMs =
      Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
    await redis.hset(
      serviceKey('ai-writing'),
      'tokens',
      '0',
      'updated',
      String(nowMs - 121_000),
    );
    await recordFirstAttempts(slow, task2, 'slow-task2');
    await expect(slow.reserveRetry(task2, 'slow-retry-2', 1)).resolves.toBe(
      'exhausted',
    );

    const fast = new RedisDownstreamRetryBudget(gateway, {
      'ai-speaking': {
        ratePerSecond: 1,
        burst: 2,
        expectedAttemptMs: 100,
      },
    });
    await recordFirstAttempts(fast, speaking, 'fast-speaking');
    await expect(fast.reserveRetry(speaking, 'fast-retry', 1)).resolves.toBe(
      'admitted',
    );
    const fastTtlMs = await redis.pttl(serviceKey('ai-speaking'));
    expect(fastTtlMs).toBeGreaterThan(119_000);
    expect(fastTtlMs).toBeLessThanOrEqual(120_000);
  });
});
