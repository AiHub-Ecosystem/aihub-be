import { randomUUID } from 'node:crypto';

import { admitGradedRequest } from '@/modules/gateway/application/admit-graded-request';
import { RedisDownstreamRetryBudget } from '@/modules/gateway/infrastructure/redis-downstream-retry-budget';
import { createRedisGatewayClient } from '@/modules/gateway/infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from '@/modules/gateway/infrastructure/redis-graded-admission';

import { redisAnswers, redisThroughProxy } from './fault-targets';

describe('Graded admission through a Redis fault proxy', () => {
  it('fails closed on Redis disconnects and slow commands, then recovers', async () => {
    const { proxy, url } = await redisThroughProxy(400);
    const client = createRedisGatewayClient(url);
    if (client === undefined)
      throw new Error('Retry-budget Redis client was not created');
    const admission = new RedisGradedAdmission(client);
    const downstream = jest.fn();
    const organizationId = `org_retry_fault_${randomUUID().replaceAll('-', '')}`;
    const run = async (requestId: string, key: string): Promise<void> => {
      const decision = await admitGradedRequest(admission, {
        apiKeyId: 'ak_retry_fault_test',
        rateLimitRpm: 10_000,
        organizationId,
        requestId,
        operation: 'writing.task1.grade',
        idempotencyKey: key,
        environment: 'production',
        monthlyRequestQuota: null,
        hardStopOnQuota: false,
      });
      expect(decision.stage).toBe('admitted');
      downstream();
    };

    try {
      await redisAnswers(client);

      const retryBucketKeys = [
        'aihub:v1:downstream-retry:{writing.task1.grade}:first',
        'aihub:v1:downstream-retry:{writing.task1.grade}:retries',
        'aihub:v1:downstream-retry:{writing.task2.grade}:first',
        'aihub:v1:downstream-retry:{writing.task2.grade}:retries',
        'aihub:v1:downstream-retry-service:{ai-writing}',
      ];
      const clearRetryBuckets = async (): Promise<void> => {
        await client.eval(
          'return redis.call("DEL", unpack(KEYS))',
          retryBucketKeys.length,
          ...retryBucketKeys,
        );
      };
      await clearRetryBuckets();
      try {
        const retryBudget = new RedisDownstreamRetryBudget(client, {
          'ai-writing': {
            ratePerSecond: 0.00001,
            burst: 1,
            expectedAttemptMs: 100,
          },
        });
        for (let index = 0; index < 10; index += 1) {
          await retryBudget.recordFirstAttempt(
            'writing.task1.grade',
            `${organizationId}-task1-${index}`,
          );
          await retryBudget.recordFirstAttempt(
            'writing.task2.grade',
            `${organizationId}-task2-${index}`,
          );
        }
        const decisions = await Promise.all([
          retryBudget.reserveRetry(
            'writing.task1.grade',
            `${organizationId}-task1-retry`,
            1,
          ),
          retryBudget.reserveRetry(
            'writing.task2.grade',
            `${organizationId}-task2-retry`,
            1,
          ),
        ]);
        expect(decisions.sort()).toEqual(['admitted', 'exhausted']);
      } finally {
        await clearRetryBuckets();
      }

      await run('retry-fault-seed', 'retry-fault-seed-key');

      await proxy.setMode('refuse');
      for (const [requestId, key] of [
        ['retry-fault-first-down', 'retry-fault-fresh-down-key'],
        ['retry-fault-repeat-down', 'retry-fault-seed-key'],
      ] as const) {
        await expect(run(requestId, key)).rejects.toMatchObject({
          code: 'REDIS_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      expect(downstream).toHaveBeenCalledTimes(1);

      await proxy.setMode('normal');
      await redisAnswers(client);
      await run('retry-fault-recovered', 'retry-fault-recovered-key');

      await run('retry-fault-slow-seed', 'retry-fault-slow-seed-key');
      await proxy.setMode('slow');
      for (const [requestId, key] of [
        ['retry-fault-first-slow', 'retry-fault-fresh-slow-key'],
        ['retry-fault-repeat-slow', 'retry-fault-slow-seed-key'],
      ] as const) {
        await expect(run(requestId, key)).rejects.toMatchObject({
          code: 'REDIS_UNAVAILABLE',
          httpStatus: 503,
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      expect(downstream).toHaveBeenCalledTimes(3);

      await new Promise((resolve) => setTimeout(resolve, 800));
      await proxy.setMode('normal');
      await redisAnswers(client);
      await run('retry-fault-slow-recovered', 'retry-fault-slow-recovered-key');
      expect(downstream).toHaveBeenCalledTimes(4);
    } finally {
      await proxy.setMode('normal');
      await client.quit();
      await proxy.close();
    }
  });
});
