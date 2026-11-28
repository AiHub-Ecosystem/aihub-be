import { once } from 'node:events';
import { createServer } from 'node:http';

import type Redis from 'ioredis';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { speakingV2ResponseGetAdapter } from '@/downstream/speaking/speaking-v2.adapters';
import { DownstreamCircuitBreakers } from '@/modules/gateway/infrastructure/dispatch/downstream-circuit-breakers';
import { DownstreamHttpClient } from '@/modules/gateway/infrastructure/dispatch/downstream-http.client';
import {
  RESERVE_DOWNSTREAM_RETRY_SCRIPT,
  RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT,
  RedisDownstreamRetryBudget,
} from '@/modules/gateway/infrastructure/redis-downstream-retry-budget';
import { noOpDispatchAttemptRecord } from '@/modules/metering/testing/no-op-dispatch-attempt-record';
import { createHttpOperationDispatcher } from '../../support/gateway/http-operation-dispatcher.testing';
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
const operationKeys = (operation: OperationId) => {
  const prefix = `aihub:v1:downstream-retry:{${OPERATION_CATALOG[operation].downstream}}:${operation}`;
  return [`${prefix}:first`, `${prefix}:retries`] as const;
};

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

async function advanceLedgerWindow(
  raw: Redis,
  operation: OperationId,
): Promise<void> {
  const [seconds] = await raw.time();
  await Promise.all(
    operationKeys(operation).map(async (key) => {
      await raw.zremrangebyscore(key, 0, '+inf');
      await raw.zadd(key, 'XX', (61 - Number(seconds)) * 1_000, ':started');
    }),
  );
}

async function warmLedger(
  budget: RedisDownstreamRetryBudget,
  operation: OperationId,
  prefix: string,
  count = 10,
  raw = redis,
): Promise<void> {
  await budget.recordFirstAttempt(operation, 'warmup');
  await advanceLedgerWindow(raw, operation);
  await recordFirstAttempts(budget, operation, prefix, count);
}

async function seedBucket(
  raw: Redis,
  service: string,
  tokens: number,
): Promise<void> {
  const [seconds, microseconds] = await raw.time();
  await raw.hset(
    serviceKey(service),
    'tokens',
    tokens,
    'updated',
    Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000),
  );
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
      warmLedger(instanceA, task1, 'instance-a-task1', 20),
      warmLedger(instanceB, task2, 'instance-b-task2', 20, replicaRedis),
      seedBucket(redis, 'ai-writing', 3),
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
    await warmLedger(slow, task1, 'slow-task1');
    await seedBucket(redis, 'ai-writing', 2);
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
    await warmLedger(slow, task2, 'slow-task2');
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
    await warmLedger(fast, speaking, 'fast-speaking');
    await seedBucket(redis, 'ai-speaking', 2);
    await expect(fast.reserveRetry(speaking, 'fast-retry', 1)).resolves.toBe(
      'admitted',
    );
    const fastTtlMs = await redis.pttl(serviceKey('ai-speaking'));
    expect(fastTtlMs).toBeGreaterThan(119_000);
    expect(fastTtlMs).toBeLessThanOrEqual(120_000);
  });

  it.each([
    ['operation', 'before execution', 0, 'admitted'],
    ['operation', 'after execution', 1, 'admitted'],
    ['service', 'before execution', 1, 'admitted'],
    ['service', 'after execution', 1, 'exhausted'],
  ] as const)(
    'refuses an unconfirmed %s reservation %s and preserves the Redis decision',
    async (stage, fault, spentOperationSlots, nextServiceDecision) => {
      const buckets = {
        'ai-writing': {
          ratePerSecond: 0.001,
          burst: 1,
          expectedAttemptMs: 100,
        },
      } as const;
      const targetScript =
        stage === 'operation'
          ? RESERVE_DOWNSTREAM_RETRY_SCRIPT
          : RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT;
      const budget = new RedisDownstreamRetryBudget(
        {
          async eval(script, numberOfKeys, ...args) {
            if (script !== targetScript) {
              return gateway.eval(script, numberOfKeys, ...args);
            }
            if (fault === 'after execution') {
              await gateway.eval(script, numberOfKeys, ...args);
            }
            throw new Error('Redis reservation was not confirmed');
          },
        },
        buckets,
      );
      await warmLedger(budget, task1, 'fault-task1');
      await warmLedger(budget, task2, 'replacement-task2');
      await seedBucket(redis, 'ai-writing', 1);

      await expect(
        budget.reserveRetry(task1, 'fault-task1-0', 1),
      ).resolves.toBe('unavailable');

      const [, retries] = operationKeys(task1);
      expect(await redis.zcount(retries, 0, '+inf')).toBe(spentOperationSlots);
      const replacement = new RedisDownstreamRetryBudget(
        replicaGateway,
        buckets,
      );
      await expect(
        replacement.reserveRetry(task2, 'replacement-task2-0', 1),
      ).resolves.toBe(nextServiceDecision);
    },
  );

  it('refills a lost service bucket from zero even when the operation ledger still allows retries', async () => {
    const buckets = {
      'ai-writing': { ratePerSecond: 0.001, burst: 1, expectedAttemptMs: 100 },
    } as const;
    const budget = new RedisDownstreamRetryBudget(gateway, buckets);
    const replacement = new RedisDownstreamRetryBudget(replicaGateway, buckets);
    const key = serviceKey('ai-writing');
    await warmLedger(budget, task1, 'bucket-loss', 30);
    await seedBucket(redis, 'ai-writing', 1);
    await expect(budget.reserveRetry(task1, 'before-loss', 1)).resolves.toBe(
      'admitted',
    );

    await redis.del(key);
    await expect(
      replacement.reserveRetry(task1, 'after-loss', 1),
    ).resolves.toBe('exhausted');
    expect(await redis.hget(key, 'tokens')).toBe('0');

    const [seconds] = await redis.time();
    await redis.hset(key, 'updated', (Number(seconds) - 1001) * 1_000);
    await expect(
      replacement.reserveRetry(task1, 'after-refill', 1),
    ).resolves.toBe('admitted');
  });

  it.each(['first', 'retries', 'both'] as const)(
    'rebuilds the operation ledger for a full window after losing %s',
    async (lost) => {
      const buckets = {
        'ai-writing': {
          ratePerSecond: 0.001,
          burst: 5,
          expectedAttemptMs: 100,
        },
      } as const;
      const budget = new RedisDownstreamRetryBudget(gateway, buckets);
      const replacement = new RedisDownstreamRetryBudget(
        replicaGateway,
        buckets,
      );
      await warmLedger(budget, task1, 'ledger-before-loss');
      await seedBucket(redis, 'ai-writing', 5);
      await expect(budget.reserveRetry(task1, 'before-loss', 1)).resolves.toBe(
        'admitted',
      );

      const keys = operationKeys(task1);
      await redis.del(
        ...(lost === 'both' ? keys : [keys[lost === 'first' ? 0 : 1]]),
      );
      await expect(
        replacement.reserveRetry(task1, 'uncertain-ledger', 1),
      ).resolves.toBe('unavailable');
      await recordFirstAttempts(replacement, task1, 'cold', 20);
      await expect(
        replacement.reserveRetry(task1, 'during-rebuild', 1),
      ).resolves.toBe('exhausted');

      await advanceLedgerWindow(redis, task1);
      await recordFirstAttempts(replacement, task1, 'rebuilt');
      await expect(
        replacement.reserveRetry(task1, 'after-rebuild', 1),
      ).resolves.toBe('admitted');
      await expect(
        replacement.reserveRetry(task1, 'over-budget', 1),
      ).resolves.toBe('exhausted');
    },
  );

  it.each([
    ['first', 'unavailable'],
    ['retries', 'unavailable'],
    ['service', 'exhausted'],
  ] as const)(
    'does not admit a retry when the %s key disappears between reservation scripts',
    async (lost, decision) => {
      const bucketKey = serviceKey('ai-writing');
      const [firstKey, retryKey] = operationKeys(task1);
      const keys = { first: firstKey, retries: retryKey, service: bucketKey };
      const budget = new RedisDownstreamRetryBudget(
        {
          async eval(script, numberOfKeys, ...args) {
            const result = await gateway.eval(script, numberOfKeys, ...args);
            if (script === RESERVE_DOWNSTREAM_RETRY_SCRIPT && result === 1) {
              await redis.del(keys[lost]);
            }
            return result;
          },
        },
        {
          'ai-writing': {
            ratePerSecond: 0.001,
            burst: 1,
            expectedAttemptMs: 100,
          },
        },
      );
      await warmLedger(budget, task1, 'between-commands');
      await seedBucket(redis, 'ai-writing', 1);

      await expect(
        budget.reserveRetry(task1, 'interrupted-reservation', 1),
      ).resolves.toBe(decision);
      expect(await redis.hget(bucketKey, 'tokens')).toBe(
        lost === 'service' ? '0' : '1',
      );
    },
  );

  it('keeps independently allocated tier budgets within one downstream burst before and after refill', async () => {
    const operation = 'speaking.v2.response-get';
    const bucketKey = serviceKey('ai-speaking');
    const keys = [bucketKey, ...operationKeys(operation)];
    const sandbox = createTenantIsolationRedisClients(14);
    const receipts = new Map<string, number>();
    const origin = createServer((request, response) => {
      const requestId = String(request.headers['x-request-id']);
      receipts.set(requestId, (receipts.get(requestId) ?? 0) + 1);
      response.writeHead(500, { 'content-type': 'application/json' }).end('{}');
    });
    origin.listen(0, '127.0.0.1');
    const httpClients: DownstreamHttpClient[] = [];
    const breakers: DownstreamCircuitBreakers[] = [];
    try {
      await Promise.all([
        once(origin, 'listening'),
        once(sandbox.raw, 'ready'),
      ]);
      const address = origin.address();
      if (address === null || typeof address === 'string') {
        throw new Error('AI Service stub did not bind');
      }
      await sandbox.raw.del(...keys);
      const allocation = {
        'ai-speaking': {
          ratePerSecond: 0.01,
          burst: 1,
          expectedAttemptMs: 100,
        },
      } as const;
      let admittedRetries = 0;
      const tiers = [
        { environment: 'production', client: gateway, raw: redis },
        { environment: 'sandbox', client: sandbox.gateway, raw: sandbox.raw },
      ].map((tier) => {
        const httpClient = new DownstreamHttpClient(
          `http://127.0.0.1:${address.port}`,
        );
        httpClients.push(httpClient);
        const budget = new RedisDownstreamRetryBudget(tier.client, allocation);
        const reserveRetry = budget.reserveRetry.bind(budget);
        jest
          .spyOn(budget, 'reserveRetry')
          .mockImplementation(async (...args) => {
            const decision = await reserveRetry(...args);
            if (decision === 'admitted') admittedRetries += 1;
            return decision;
          });
        const circuit = new DownstreamCircuitBreakers();
        breakers.push(circuit);
        const dispatcher = createHttpOperationDispatcher(
          httpClient,
          { mint: async () => 'internal-token' },
          [speakingV2ResponseGetAdapter],
          noOpDispatchAttemptRecord,
          {
            reserve: async () => true,
            release: async () => {},
            allowanceFor: async () => null,
          },
          budget,
          () => 0,
          circuit,
        );
        return { ...tier, budget, dispatcher };
      });

      for (const phase of ['initial', 'after-refill']) {
        await Promise.all(
          tiers.map(async ({ raw, budget, environment }) => {
            if (phase === 'initial') {
              await warmLedger(
                budget,
                operation,
                `${phase}-${environment}`,
                20,
                raw,
              );
              await seedBucket(raw, 'ai-speaking', 1);
            } else {
              // The operation window expires before the bucket has fully refilled.
              await advanceLedgerWindow(raw, operation);
              const [seconds] = await raw.time();
              await raw.hset(
                bucketKey,
                'updated',
                String((Number(seconds) - 101) * 1_000),
              );
              await recordFirstAttempts(
                budget,
                operation,
                `${phase}-${environment}`,
                20,
              );
            }
          }),
        );
        receipts.clear();
        admittedRetries = 0;
        const calls = tiers.flatMap(({ dispatcher, environment }) =>
          Array.from({ length: 4 }, (_, index) =>
            dispatcher.dispatch(
              operation,
              { response_id: 'retry-test' },
              createRequestContext({
                environment,
                requestId: `${environment}-${phase}-${index}`,
                organizationId: 'org_context',
                userId: 'student-1',
                identityMode: 'declared_id',
                deadlineMs: 10_000,
                receivedAt: new Date(),
                scopes: ['speaking.grade'],
              }),
            ),
          ),
        );
        const outcomes = await Promise.allSettled(calls);
        for (const outcome of outcomes) {
          expect(outcome).toMatchObject({
            status: 'rejected',
            reason: { downstreamStatus: 500 },
          });
        }
        expect(admittedRetries).toBe(2);
        expect(
          [...receipts.values()].sort((left, right) => left - right),
        ).toEqual([1, 1, 1, 1, 1, 1, 2, 2]);
      }
    } finally {
      for (const circuit of breakers) circuit.onModuleDestroy();
      await Promise.all(httpClients.map((client) => client.close()));
      const closed = once(origin, 'close');
      origin.close();
      await closed;
      await sandbox.raw.del(...keys);
      await sandbox.raw.quit();
      await redis.del(...keys);
    }
  });
});
