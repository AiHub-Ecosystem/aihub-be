import type { OperationId } from '@/catalog/operation-id';
import {
  RECORD_DOWNSTREAM_FIRST_ATTEMPT_SCRIPT,
  RESERVE_DOWNSTREAM_RETRY_SCRIPT,
  RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT,
  RedisDownstreamRetryBudget,
  type RedisDownstreamRetryBudgetClient,
} from './redis-downstream-retry-budget';

class FakeRedis implements RedisDownstreamRetryBudgetClient {
  private readonly sets = new Map<string, Map<string, number>>();
  private readonly hashes = new Map<
    string,
    { tokens: number; updatedAt: number }
  >();
  private readonly hashExpirations = new Map<string, number>();
  now = 0;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script === RESERVE_DOWNSTREAM_SERVICE_TOKEN_SCRIPT) {
      if (numberOfKeys !== 1)
        throw new Error('unexpected service bucket key count');
      const [key, rateRaw, burstRaw, ttlRaw] = args.map(String);
      const rate = Number(rateRaw);
      const burst = Number(burstRaw);
      if (key === undefined || Number(ttlRaw) <= 0) {
        throw new Error('invalid service bucket arguments');
      }
      if ((this.hashExpirations.get(key) ?? Infinity) <= this.now) {
        this.hashes.delete(key);
      }
      const state = this.hashes.get(key) ?? {
        tokens: burst,
        updatedAt: this.now,
      };
      const tokens = Math.min(
        burst,
        state.tokens + (Math.max(0, this.now - state.updatedAt) * rate) / 1_000,
      );
      this.hashes.set(key, {
        tokens: tokens < 1 ? tokens : tokens - 1,
        updatedAt: this.now,
      });
      this.hashExpirations.set(key, this.now + Number(ttlRaw) * 1_000);
      return tokens < 1 ? 0 : 1;
    }
    if (numberOfKeys !== 2) throw new Error('unexpected key count');
    const [firstKey, retriesKey] = args.slice(0, 2).map(String);
    const [member, windowMs, ttlSeconds, ratio] = args.slice(2).map(String);
    if (
      firstKey === undefined ||
      retriesKey === undefined ||
      member === undefined ||
      Number(ttlSeconds) <= 0
    ) {
      throw new Error('invalid command arguments');
    }
    const cutoff = this.now - Number(windowMs);
    const firsts = this.prune(firstKey, cutoff);
    const retries = this.prune(retriesKey, cutoff);

    if (script === RECORD_DOWNSTREAM_FIRST_ATTEMPT_SCRIPT) {
      firsts.set(member, this.now);
      return 1;
    }
    if (script !== RESERVE_DOWNSTREAM_RETRY_SCRIPT) {
      throw new Error('unexpected retry budget script');
    }

    const allowance = Math.floor(firsts.size * Number(ratio));
    if (firsts.size === 0 || retries.size >= allowance) return 0;
    retries.set(member, this.now);
    return 1;
  }

  private prune(key: string, cutoff: number): Map<string, number> {
    const entries = this.sets.get(key) ?? new Map<string, number>();
    for (const [member, score] of entries) {
      if (score <= cutoff) entries.delete(member);
    }
    this.sets.set(key, entries);
    return entries;
  }
}

const operation: OperationId = 'writing.task1.grade';
const retryServiceBuckets = {
  'ai-writing': { ratePerSecond: 1, burst: 1, expectedAttemptMs: 100 },
} as const;

describe('RedisDownstreamRetryBudget', () => {
  it('admits one retry after ten first attempts and bounds concurrent retries to ten percent', async () => {
    const redis = new FakeRedis();
    const first = new RedisDownstreamRetryBudget(redis, retryServiceBuckets);
    const second = new RedisDownstreamRetryBudget(redis, retryServiceBuckets);

    expect(first.isEnabled(operation)).toBe(true);

    for (let index = 0; index < 10; index += 1) {
      await first.recordFirstAttempt(operation, `first-${index}`);
    }
    const decisions = await Promise.all([
      first.reserveRetry(operation, 'retry-a', 1),
      second.reserveRetry(operation, 'retry-b', 1),
    ]);

    expect(decisions.sort()).toEqual(['admitted', 'exhausted']);
  });

  it('rolls first attempts and retries out of the shared window', async () => {
    const redis = new FakeRedis();
    const budget = new RedisDownstreamRetryBudget(redis, retryServiceBuckets);

    for (let index = 0; index < 10; index += 1) {
      await budget.recordFirstAttempt(operation, `first-old-${index}`);
    }
    await expect(budget.reserveRetry(operation, 'retry-old', 1)).resolves.toBe(
      'admitted',
    );
    redis.now = 60_001;
    for (let index = 0; index < 10; index += 1) {
      await budget.recordFirstAttempt(operation, `first-new-${index}`);
    }

    await expect(budget.reserveRetry(operation, 'retry-new', 1)).resolves.toBe(
      'admitted',
    );
  });

  it('does not use the Organization budget floor for an operation with fewer than ten attempts', async () => {
    const budget = new RedisDownstreamRetryBudget(
      new FakeRedis(),
      retryServiceBuckets,
    );
    await budget.recordFirstAttempt(operation, 'first-one');

    await expect(budget.reserveRetry(operation, 'retry-one', 1)).resolves.toBe(
      'exhausted',
    );
  });

  it('fails closed when Redis is absent or the command fails', async () => {
    const unavailable = new RedisDownstreamRetryBudget(
      undefined,
      retryServiceBuckets,
    );
    const broken = new RedisDownstreamRetryBudget(
      {
        eval: async () => {
          throw new Error('Redis unavailable');
        },
      },
      retryServiceBuckets,
    );

    await expect(
      unavailable.recordFirstAttempt(operation, 'request'),
    ).resolves.toBe(false);
    await expect(broken.reserveRetry(operation, 'request', 1)).resolves.toBe(
      'unavailable',
    );
  });

  it('shares the provider token bucket across operations', async () => {
    const redis = new FakeRedis();
    const task1 = new RedisDownstreamRetryBudget(redis, retryServiceBuckets);
    const task2 = new RedisDownstreamRetryBudget(redis, retryServiceBuckets);
    const otherOperation: OperationId = 'writing.task2.grade';

    for (let index = 0; index < 10; index += 1) {
      await task1.recordFirstAttempt(operation, `task1-first-${index}`);
      await task2.recordFirstAttempt(otherOperation, `task2-first-${index}`);
    }

    const decisions = await Promise.all([
      task1.reserveRetry(operation, 'task1-retry', 1),
      task2.reserveRetry(otherOperation, 'task2-retry', 1),
    ]);
    expect(decisions.sort()).toEqual(['admitted', 'exhausted']);
  });

  it('does not restore a slow service bucket before its natural refill', async () => {
    const redis = new FakeRedis();
    const slowBuckets = {
      'ai-writing': {
        ratePerSecond: 0.001,
        burst: 2,
        expectedAttemptMs: 100,
      },
    } as const;
    const task1 = new RedisDownstreamRetryBudget(redis, slowBuckets);
    const task2 = new RedisDownstreamRetryBudget(redis, slowBuckets);
    const task2Operation: OperationId = 'writing.task2.grade';

    for (let index = 0; index < 10; index += 1) {
      await task1.recordFirstAttempt(operation, `task1-first-old-${index}`);
      await task2.recordFirstAttempt(
        task2Operation,
        `task2-first-old-${index}`,
      );
    }
    await expect(
      task1.reserveRetry(operation, 'task1-retry-old', 1),
    ).resolves.toBe('admitted');
    await expect(
      task2.reserveRetry(task2Operation, 'task2-retry-old', 1),
    ).resolves.toBe('admitted');

    redis.now = 121_000;
    for (let index = 0; index < 10; index += 1) {
      await task1.recordFirstAttempt(operation, `task1-first-new-${index}`);
    }

    await expect(
      task1.reserveRetry(operation, 'task1-retry-new', 1),
    ).resolves.toBe('exhausted');
  });

  it('allows an idle fast service bucket after it has naturally refilled', async () => {
    const redis = new FakeRedis();
    const fastBudget = new RedisDownstreamRetryBudget(redis, {
      'ai-writing': { ratePerSecond: 1, burst: 2, expectedAttemptMs: 100 },
    });

    for (let index = 0; index < 10; index += 1) {
      await fastBudget.recordFirstAttempt(operation, `first-old-${index}`);
    }
    await expect(
      fastBudget.reserveRetry(operation, 'retry-old', 1),
    ).resolves.toBe('admitted');

    redis.now = 121_000;
    for (let index = 0; index < 10; index += 1) {
      await fastBudget.recordFirstAttempt(operation, `first-new-${index}`);
    }

    await expect(
      fastBudget.reserveRetry(operation, 'retry-new', 1),
    ).resolves.toBe('admitted');
  });

  it('keeps retries disabled until a service capacity bucket is configured', async () => {
    const redis = new FakeRedis();
    const budget = new RedisDownstreamRetryBudget(redis);

    expect(budget.isEnabled(operation)).toBe(false);
    await expect(budget.recordFirstAttempt(operation, 'request')).resolves.toBe(
      false,
    );
  });

  it('disables a bucket whose refill horizon exceeds Redis TTL precision', () => {
    const budget = new RedisDownstreamRetryBudget(new FakeRedis(), {
      'ai-writing': {
        ratePerSecond: 1e-13,
        burst: 1,
        expectedAttemptMs: 100,
      },
    });

    expect(budget.isEnabled(operation)).toBe(false);
  });
});
