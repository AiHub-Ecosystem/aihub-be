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
let gateway: ReturnType<typeof createTenantIsolationRedisClients>['gateway'];
let pool: ReturnType<typeof createTestPool>;

async function recordFirstAttempts(
  budget: RedisDownstreamRetryBudget,
  operation: OperationId,
  prefix: string,
): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
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
  redis = clients.raw;
  gateway = clients.gateway;
  if (redis.status !== 'ready') await once(redis, 'ready');
});

beforeEach(async () => {
  await resetTenantIsolation(pool, redis);
});

afterAll(async () => {
  await clearBudgetState();
  await pool?.end();
  await redis?.quit();
});

describe('RedisDownstreamRetryBudget service bucket Lua', () => {
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
