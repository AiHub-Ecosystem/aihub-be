import { AppError } from '@/common/errors/app-error';
import {
  beginShutdown,
  waitForBackgroundWork,
} from '@/common/http/background-work-drain';
import {
  type RedisConcurrencyClient,
  RedisConcurrencyLimiter,
} from './redis-concurrency-limiter';

class FakeRedis implements RedisConcurrencyClient {
  readonly evaluations: Array<{
    readonly script: string;
    readonly numberOfKeys: number;
    readonly args: readonly (string | number)[];
  }> = [];
  readonly removals: Array<{ readonly key: string; readonly member: string }> =
    [];
  nextEvaluation = 1;

  eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    this.evaluations.push({ script, numberOfKeys, args });
    return Promise.resolve(this.nextEvaluation);
  }

  zrem(key: string, member: string): Promise<number> {
    this.removals.push({ key, member });
    return Promise.resolve(1);
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}

class FailingRedis implements RedisConcurrencyClient {
  eval(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  zrem(): Promise<number> {
    return Promise.reject(new Error('redis down'));
  }

  quit(): Promise<'OK'> {
    return Promise.resolve('OK');
  }
}

class FakeLogger {
  readonly warnings: string[] = [];
  readonly logs: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

describe('RedisConcurrencyLimiter', () => {
  it('atomically acquires an organization lease and releases its request member', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis);

    const decision = await limiter.acquire({
      organizationId: 'org_acme',
      maxConcurrent: 20,
      requestId: 'req_01JCONCURRENCYLEASE0000000000',
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error('expected a concurrency lease');
    }
    expect(redis.evaluations).toHaveLength(1);
    const evaluation = redis.evaluations[0];
    expect(evaluation?.script).toMatch(/ZREMRANGEBYSCORE[\s\S]*EXPIRE/);
    expect(evaluation).toEqual({
      script: evaluation?.script,
      numberOfKeys: 1,
      args: [
        'aihub:v1:inflight:org_acme',
        '20',
        'req_01JCONCURRENCYLEASE0000000000',
        '120000',
      ],
    });

    await decision.lease.release();
    await decision.lease.release();

    expect(redis.removals).toEqual([
      {
        key: 'aihub:v1:inflight:org_acme',
        member: 'req_01JCONCURRENCYLEASE0000000000',
      },
    ]);
  });

  it('rejects an atomic acquisition with a jittered concurrency hint', async () => {
    const redis = new FakeRedis();
    redis.nextEvaluation = 0;
    const limiter = new RedisConcurrencyLimiter(redis, undefined, () => 0.5);

    await expect(
      limiter.acquire({
        organizationId: 'org_acme',
        maxConcurrent: 1,
        requestId: 'req_01JCONCURRENCYFULL000000000000',
      }),
    ).resolves.toEqual({ allowed: false, retryAfterMs: 750 });
  });

  it('tells a burst refused together different instants between 500 and 1000 ms', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis);

    const hints: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      redis.nextEvaluation = 0;
      const decision = await limiter.acquire({
        organizationId: 'org_acme',
        maxConcurrent: 1,
        requestId: `req_01JCONCURRENCYFULL${String(index).padStart(12, '0')}`,
      });
      if (!decision.allowed) hints.push(decision.retryAfterMs);
    }

    expect(hints).toHaveLength(20);
    expect(new Set(hints).size).toBeGreaterThan(1);
    for (const hint of hints) {
      expect(hint).toBeGreaterThanOrEqual(500);
      expect(hint).toBeLessThan(1_000);
    }
  });

  it('atomically enforces Sandbox limits for the Organization and whole environment', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisConcurrencyLimiter(redis);
    const decision = await limiter.acquire({
      organizationId: 'org_customer',
      maxConcurrent: 99,
      requestId: 'req_sandbox',
      environment: 'sandbox',
    });

    expect(decision.allowed).toBe(true);
    const evaluation = redis.evaluations[0];
    expect(evaluation?.script).toContain("ZCARD', KEYS[2]");
    expect(evaluation).toEqual({
      script: evaluation?.script,
      numberOfKeys: 2,
      args: [
        'aihub:v1:inflight:org_customer',
        'aihub:v1:inflight:sandbox',
        '1',
        '10',
        'req_sandbox',
        '120000',
      ],
    });
    if (!decision.allowed) {
      throw new Error('expected a concurrency lease');
    }
    await decision.lease.release();
    expect(redis.removals).toEqual([
      { key: 'aihub:v1:inflight:org_customer', member: 'req_sandbox' },
      { key: 'aihub:v1:inflight:sandbox', member: 'req_sandbox' },
    ]);
  });

  it('returns retryable unavailable when Redis cannot acquire a permit', async () => {
    const limiter = new RedisConcurrencyLimiter(new FailingRedis());

    await expect(
      limiter.acquire({
        organizationId: 'org_acme',
        maxConcurrent: 1,
        requestId: 'req_01JBACKSTOP00000000000000000',
      }),
    ).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      // The hint is spread over [base, base + 1 s) (#1352).
      retryAfterMs: expect.closeTo(1_499.5, -3) as number,
    } satisfies Partial<AppError>);
    await limiter.onModuleDestroy();
  });

  it('returns retryable unavailable when releasing a permit has an ambiguous result', async () => {
    const redis = new FakeRedis();
    const zrem = jest.fn(() => Promise.reject(new Error('redis timeout')));
    redis.zrem = zrem;
    const limiter = new RedisConcurrencyLimiter(redis);
    const decision = await limiter.acquire({
      organizationId: 'org_acme',
      maxConcurrent: 1,
      requestId: 'req_release_timeout',
    });

    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error('expected a concurrency lease');

    await expect(decision.lease.release()).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
      // The hint is spread over [base, base + 1 s) (#1352).
      retryAfterMs: expect.closeTo(1_499.5, -3) as number,
    } satisfies Partial<AppError>);
    await expect(decision.lease.release()).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
    });
    expect(zrem).toHaveBeenCalledTimes(1);
    await limiter.onModuleDestroy();
  });

  it('keeps release recovery in the shutdown drain until Redis returns', async () => {
    jest.useFakeTimers();
    let available = false;
    const redis = new FakeRedis();
    const zrem = jest.fn(async () => {
      if (!available) throw new Error('redis down');
      return 1;
    });
    redis.zrem = zrem;
    const limiter = new RedisConcurrencyLimiter(redis);

    try {
      const decision = await limiter.acquire({
        organizationId: 'org_recovery',
        maxConcurrent: 1,
        requestId: 'req_recovery',
      });
      if (!decision.allowed) throw new Error('expected a concurrency lease');

      await expect(decision.lease.release()).rejects.toMatchObject({
        code: 'REDIS_UNAVAILABLE',
      });
      let drained = false;
      const drain = waitForBackgroundWork().then(() => (drained = true));
      await Promise.resolve();
      expect(drained).toBe(false);

      available = true;
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(drain).resolves.toBe(true);
      expect(zrem).toHaveBeenCalledTimes(2);
    } finally {
      await limiter.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('cancels delayed release retries before closing its Redis client', async () => {
    jest.useFakeTimers();
    const redis = new FakeRedis();
    const zrem = jest.fn(() => Promise.reject(new Error('redis down')));
    redis.zrem = zrem;
    const limiter = new RedisConcurrencyLimiter(redis);

    try {
      const decision = await limiter.acquire({
        organizationId: 'org_drain',
        maxConcurrent: 1,
        requestId: 'req_drain',
      });
      if (!decision.allowed) throw new Error('expected a concurrency lease');

      await expect(decision.lease.release()).rejects.toMatchObject({
        code: 'REDIS_UNAVAILABLE',
      });
      const drain = waitForBackgroundWork();
      await limiter.onModuleDestroy();
      await expect(drain).resolves.toBeUndefined();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(zrem).toHaveBeenCalledTimes(1);
    } finally {
      await limiter.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('logs one outage and one recovery without exposing request identifiers', async () => {
    const logger = new FakeLogger();
    const failing = new FailingRedis();
    const healthy = new FakeRedis();
    let current: RedisConcurrencyClient = failing;
    const limiter = new RedisConcurrencyLimiter(
      {
        eval: (
          script: string,
          numberOfKeys: number,
          ...args: readonly (string | number)[]
        ) => current.eval(script, numberOfKeys, ...args),
        zrem: (key: string, member: string) => current.zrem(key, member),
        quit: () => current.quit(),
      },
      logger,
    );

    await expect(
      limiter.acquire({
        organizationId: 'org_secret',
        maxConcurrent: 1,
        requestId: 'req_secret',
      }),
    ).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    await expect(
      limiter.acquire({
        organizationId: 'org_secret',
        maxConcurrent: 1,
        requestId: 'req_secret_2',
      }),
    ).rejects.toMatchObject({ code: 'REDIS_UNAVAILABLE' });
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).not.toContain('org_secret');
    expect(logger.warnings[0]).not.toContain('req_secret');

    current = healthy;
    await limiter.acquire({
      organizationId: 'org_secret',
      maxConcurrent: 1,
      requestId: 'req_secret_3',
    });
    expect(logger.logs).toHaveLength(1);
    await limiter.onModuleDestroy();
  });

  it('bounds release recovery to the graceful shutdown budget', async () => {
    jest.useFakeTimers();
    const redis = new FakeRedis();
    const zrem = jest.fn(() => Promise.reject(new Error('redis down')));
    redis.zrem = zrem;
    const limiter = new RedisConcurrencyLimiter(redis);

    try {
      const decision = await limiter.acquire({
        organizationId: 'org_shutdown_budget',
        maxConcurrent: 1,
        requestId: 'req_shutdown_budget',
      });
      if (!decision.allowed) throw new Error('expected a concurrency lease');

      await expect(decision.lease.release()).rejects.toMatchObject({
        code: 'REDIS_UNAVAILABLE',
      });
      const drain = waitForBackgroundWork();
      beginShutdown();

      await jest.advanceTimersByTimeAsync(61_000);
      await expect(drain).resolves.toBeUndefined();
      const attemptsAtDrain = zrem.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10_000);
      expect(zrem).toHaveBeenCalledTimes(attemptsAtDrain);
    } finally {
      await limiter.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});
