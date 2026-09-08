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
    const limiter = new RedisConcurrencyLimiter(redis, () => 10_000);

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
    expect(redis.evaluations[0]).toEqual({
      script: expect.stringMatching(/ZREMRANGEBYSCORE[\s\S]*EXPIRE/),
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

  it('rejects an atomic acquisition with the concurrency error hint', async () => {
    const redis = new FakeRedis();
    redis.nextEvaluation = 0;
    const limiter = new RedisConcurrencyLimiter(redis);

    await expect(
      limiter.acquire({
        organizationId: 'org_acme',
        maxConcurrent: 1,
        requestId: 'req_01JCONCURRENCYFULL000000000000',
      }),
    ).resolves.toEqual({ allowed: false, retryAfterMs: 500 });
  });

  it('uses a global process-local backstop and releases fallback leases', async () => {
    const limiter = new RedisConcurrencyLimiter(
      new FailingRedis(),
      () => 10_000,
    );

    const first = await limiter.acquire({
      organizationId: 'org_acme',
      maxConcurrent: 1,
      requestId: 'req_01JBACKSTOP00000000000000000',
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) {
      throw new Error('expected a fallback concurrency lease');
    }

    await first.lease.release();

    await expect(
      limiter.acquire({
        organizationId: 'org_other',
        maxConcurrent: 1,
        requestId: 'req_01JBACKSTOP00000000000000001',
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('prunes stale fallback leases before applying the process cap', async () => {
    let now = 120_000;
    const limiter = new RedisConcurrencyLimiter(new FailingRedis(), () => now);

    const first = await limiter.acquire({
      organizationId: 'org_acme',
      maxConcurrent: 1,
      requestId: 'req_01JSTALE0000000000000000000',
    });
    expect(first.allowed).toBe(true);

    now = 240_001;
    await expect(
      limiter.acquire({
        organizationId: 'org_acme',
        maxConcurrent: 1,
        requestId: 'req_01JSTALE0000000000000000001',
      }),
    ).resolves.toMatchObject({ allowed: true });
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
      Date.now,
      logger,
    );

    await limiter.acquire({
      organizationId: 'org_secret',
      maxConcurrent: 1,
      requestId: 'req_secret',
    });
    await limiter.acquire({
      organizationId: 'org_secret',
      maxConcurrent: 1,
      requestId: 'req_secret_2',
    });
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
  });
});
