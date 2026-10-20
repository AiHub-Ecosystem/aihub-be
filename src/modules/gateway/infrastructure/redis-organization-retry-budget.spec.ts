import type { IdempotencyOperation } from '@/modules/idempotency/application/idempotency-operation';
import {
  ORGANIZATION_RETRY_BUDGET_SCRIPT,
  ORGANIZATION_RETRY_SEEN_CAP,
  RedisOrganizationRetryBudget,
  type RedisOrganizationRetryBudgetClient,
} from './redis-organization-retry-budget';

class FakeRedis implements RedisOrganizationRetryBudgetClient {
  readonly first = new Map<string, number[]>();
  readonly repeats = new Map<string, number[]>();
  readonly seen = new Map<string, Map<string, number>>();
  now = 0;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script !== ORGANIZATION_RETRY_BUDGET_SCRIPT || numberOfKeys !== 3) {
      throw new Error('unexpected retry budget script');
    }
    const [firstKey, repeatKey, seenKey] = args.slice(0, 3).map(String);
    const [fingerprint, requestId, cap] = args.slice(3).map(String);
    const cutoff = this.now - 60_000;
    const first = (this.first.get(firstKey!) ?? []).filter(
      (time) => time > cutoff,
    );
    const repeats = (this.repeats.get(repeatKey!) ?? []).filter(
      (time) => time > cutoff,
    );
    this.first.set(firstKey!, first);
    this.repeats.set(repeatKey!, repeats);
    const seen = this.seen.get(seenKey!) ?? new Map<string, number>();
    for (const [key, expiresAt] of seen) {
      if (expiresAt <= this.now) seen.delete(key);
    }
    this.seen.set(seenKey!, seen);

    const expiresAt = seen.get(fingerprint!);
    if (expiresAt === undefined || expiresAt <= this.now) {
      seen.set(fingerprint!, this.now + 86_400_000);
      const limit = Number(cap ?? '0');
      if (Number.isSafeInteger(limit) && limit > 0) {
        while (seen.size > limit) {
          const oldest = seen.keys().next().value;
          if (oldest === undefined) break;
          seen.delete(oldest);
        }
      }
      first.push(this.now);
      return 1;
    }
    const allowance = Math.max(1, Math.floor(0.1 * first.length));
    if (repeats.length >= allowance) return 0;
    repeats.push(this.now + Number(requestId!.length) / 1_000_000);
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

const request = (key: string, operation = 'writing.task1.grade') => ({
  organizationId: 'org_acme',
  operation: operation as IdempotencyOperation,
  idempotencyKey: key,
  requestId: `req_${key}`,
});

describe('RedisOrganizationRetryBudget', () => {
  it('allows one repeat at low volume, leaves denied attempts uncounted, and rolls the window', async () => {
    const redis = new FakeRedis();
    const budget = new RedisOrganizationRetryBudget('', redis, () => 0);

    await expect(budget.consume(request('one'))).resolves.toEqual({
      allowed: true,
    });
    await expect(budget.consume(request('one'))).resolves.toEqual({
      allowed: true,
    });
    await expect(budget.consume(request('one'))).resolves.toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });

    for (let index = 1; index < 20; index += 1) {
      await budget.consume(request(`first-${index}`));
    }
    await expect(budget.consume(request('one'))).resolves.toEqual({
      allowed: true,
    });

    redis.now = 60_001;
    await expect(budget.consume(request('one'))).resolves.toEqual({
      allowed: true,
    });
  });

  it('limits concurrent admitted repeats to ten percent of first attempts across instances', async () => {
    const redis = new FakeRedis();
    const firstInstance = new RedisOrganizationRetryBudget('', redis);
    const secondInstance = new RedisOrganizationRetryBudget('', redis);

    for (let index = 0; index < 10; index += 1) {
      await firstInstance.consume(request(`first-${index}`));
    }
    const decisions = await Promise.all([
      firstInstance.consume(request('first-0')),
      secondInstance.consume(request('first-1')),
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toMatchObject([
      { allowed: false, retryAfterMs: expect.any(Number) },
    ]);
  });

  it('bounds the remembered keys and treats a dropped key as a first attempt', async () => {
    const redis = new FakeRedis();
    const budget = new RedisOrganizationRetryBudget('', redis, () => 0);
    const total = ORGANIZATION_RETRY_SEEN_CAP + 1;

    for (let index = 0; index < total; index += 1) {
      await budget.consume(request(`bounded-${index}`));
    }

    const seen = [...redis.seen.values()][0]!;
    expect(seen.size).toBe(ORGANIZATION_RETRY_SEEN_CAP);
    const firstCount = [...redis.first.values()][0]!.length;

    await budget.consume(request('bounded-0'));
    expect([...redis.first.values()][0]!.length).toBe(firstCount + 1);
    expect(seen.size).toBe(ORGANIZATION_RETRY_SEEN_CAP);

    await budget.consume(request(`bounded-${total - 1}`));
    expect([...redis.first.values()][0]!.length).toBe(firstCount + 1);
    expect([...redis.repeats.values()][0]).toHaveLength(1);
  });

  it('treats the same key on another operation as a new first attempt', async () => {
    const redis = new FakeRedis();
    const budget = new RedisOrganizationRetryBudget('', redis);

    await budget.consume(request('shared-key'));
    await expect(
      budget.consume(request('shared-key', 'writing.task2.grade')),
    ).resolves.toEqual({ allowed: true });
  });

  it('fails closed and reports Redis unavailability once', async () => {
    const failing: RedisOrganizationRetryBudgetClient = {
      eval: async () => {
        throw new Error('redis down');
      },
      quit: async () => 'OK',
    };
    const logger = { warn: jest.fn(), log: jest.fn() };
    const budget = new RedisOrganizationRetryBudget(
      '',
      failing,
      () => 0,
      logger,
    );

    await expect(budget.consume(request('unavailable'))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      retryable: true,
      message: 'Organization retry budget is unavailable',
    });
    await expect(budget.consume(request('unavailable'))).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Redis is not configured', async () => {
    const budget = new RedisOrganizationRetryBudget('');

    await expect(budget.consume(request('unconfigured'))).rejects.toMatchObject(
      {
        code: 'INTERNAL_ERROR',
        retryable: true,
      },
    );
  });
});
