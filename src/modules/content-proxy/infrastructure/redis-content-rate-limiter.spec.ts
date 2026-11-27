import {
  RedisContentRateLimiter,
  hashContentRateLimitKey,
} from './redis-content-rate-limiter';

class FakeRedis {
  call:
    | { script: string; numberOfKeys: number; args: readonly string[] }
    | undefined;
  readonly counts = new Map<string, number>();
  fail = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown> {
    this.call = { script, numberOfKeys, args };
    if (this.fail) throw new Error('Redis unavailable');
    const key = args[0];
    if (key === undefined) throw new Error('Redis key is missing');
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return [count, 24_500];
  }

  on(): void {}

  disconnect(): void {}
}

describe('RedisContentRateLimiter', () => {
  it('shares a first-request Redis window and returns its remaining TTL', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisContentRateLimiter(
      'redis://test',
      () => 1_000,
      redis,
    );
    redis.counts.set(
      `aihub:content:rate:${hashContentRateLimitKey('203.0.113.7')}`,
      30,
    );

    await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
      allowed: false,
      retryAfterMs: 24_500,
    });

    const hashedIp = hashContentRateLimitKey('203.0.113.7');
    expect(hashedIp).toMatch(/^[0-9a-f]{64}$/);
    expect(redis.call?.numberOfKeys).toBe(1);
    expect(redis.call?.args).toEqual([
      `aihub:content:rate:${hashedIp}`,
      '60000',
    ]);
    expect(redis.call?.script).toContain("redis.call('PTTL'");
    expect(redis.call?.script).toContain("redis.call('INCR'");
  });

  it('uses a per-address local window when Redis is unavailable', async () => {
    let now = 1_000;
    const limiter = new RedisContentRateLimiter('', () => now);

    for (let request = 0; request < 30; request += 1) {
      await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
        allowed: true,
      });
    }
    await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });
    await expect(limiter.consume('198.51.100.8')).resolves.toEqual({
      allowed: true,
    });

    now += 60_001;
    await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
      allowed: true,
    });
  });

  it('refuses new addresses at local-map capacity until entries expire', async () => {
    let now = 1_000;
    const limiter = new RedisContentRateLimiter('', () => now);

    for (let address = 0; address < 10_000; address += 1) {
      await limiter.consume(`2001:db8::${address.toString(16)}`);
    }

    await expect(limiter.consume('2001:db8::ffff')).rejects.toMatchObject({
      code: 'REDIS_UNAVAILABLE',
      retryable: true,
    });
    now += 60_001;
    await expect(limiter.consume('2001:db8::ffff')).resolves.toEqual({
      allowed: true,
    });
  });

  it('returns to the shared Redis counter after a local fallback', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisContentRateLimiter(
      'redis://test',
      () => 1_000,
      redis,
    );
    redis.fail = true;

    await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
      allowed: true,
    });
    redis.fail = false;

    await expect(limiter.consume('203.0.113.7')).resolves.toEqual({
      allowed: true,
    });
    expect(redis.counts.size).toBe(1);
  });
});
