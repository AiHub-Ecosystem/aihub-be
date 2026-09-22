import {
  AUTH_RATE_LIMIT_WINDOW_SCRIPT,
  type AuthRedisClient,
  RedisAuthRateLimiter,
  hashRateLimitKey,
} from './redis-auth-rate-limiter';

class FakeRedis implements AuthRedisClient {
  call:
    | { script: string; numberOfKeys: number; args: readonly string[] }
    | undefined;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown> {
    this.call = { script, numberOfKeys, args };
    return [3, 2_500];
  }

  on(): void {}

  disconnect(): void {}
}

describe('RedisAuthRateLimiter', () => {
  it('hashes identity-bearing keys before using the protection store', () => {
    const email = 'person@example.com';
    const hashed = hashRateLimitKey('resend_email', email);

    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain(email);
  });

  it.each([
    ['organization_invitation_user', 'usr_owner'],
    ['organization_invitation_organization', 'org_acme'],
    ['organization_invitation_email', 'person@example.com'],
  ] as const)(
    '%s uses the distributed Redis window with the configured TTL',
    async (scope, key) => {
      const redis = new FakeRedis();
      const limiter = new RedisAuthRateLimiter(
        'redis://test',
        () => 1_000,
        redis,
      );

      await expect(
        limiter.consume({
          scope,
          key,
          limit: 2,
          windowMs: 60_000,
        }),
      ).resolves.toEqual({ allowed: false, retryAfterMs: 2_500 });
      expect(redis.call?.script).toBe(AUTH_RATE_LIMIT_WINDOW_SCRIPT);
      expect(redis.call?.script).toContain('ARGV[1]');
      expect(redis.call?.numberOfKeys).toBe(1);
      expect(redis.call?.args).toEqual([
        `aihub:auth:rate:${hashRateLimitKey(scope, key)}`,
        '60000',
      ]);
    },
  );

  it('uses the distributed Redis window with the configured TTL', async () => {
    const redis = new FakeRedis();
    const limiter = new RedisAuthRateLimiter(
      'redis://test',
      () => 1_000,
      redis,
    );

    await expect(
      limiter.consume({
        scope: 'resend_email',
        key: 'person@example.com',
        limit: 2,
        windowMs: 60_000,
      }),
    ).resolves.toEqual({ allowed: false, retryAfterMs: 2_500 });
    expect(redis.call?.script).toBe(AUTH_RATE_LIMIT_WINDOW_SCRIPT);
    expect(redis.call?.script).toContain('ARGV[1]');
    expect(redis.call?.numberOfKeys).toBe(1);
    expect(redis.call?.args).toEqual([
      `aihub:auth:rate:${hashRateLimitKey('resend_email', 'person@example.com')}`,
      '60000',
    ]);
  });

  it('keeps a bounded process-local fallback when Redis is unavailable', async () => {
    let now = 1_000;
    const limiter = new RedisAuthRateLimiter('', () => now);

    await expect(
      limiter.consume({
        scope: 'verify_ip',
        key: '203.0.113.7',
        limit: 2,
        windowMs: 1_000,
      }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({
        scope: 'verify_ip',
        key: '203.0.113.7',
        limit: 2,
        windowMs: 1_000,
      }),
    ).resolves.toEqual({ allowed: true });
    await expect(
      limiter.consume({
        scope: 'verify_ip',
        key: '203.0.113.7',
        limit: 2,
        windowMs: 1_000,
      }),
    ).resolves.toMatchObject({ allowed: false });

    now += 1_001;
    await expect(
      limiter.consume({
        scope: 'verify_ip',
        key: '203.0.113.7',
        limit: 2,
        windowMs: 1_000,
      }),
    ).resolves.toEqual({ allowed: true });
  });

  it('keeps an invitation scope available through fallback and resets its window', async () => {
    let now = 1_000;
    const limiter = new RedisAuthRateLimiter('', () => now);
    const input = {
      scope: 'organization_invitation_email' as const,
      key: 'person@example.com',
      limit: 1,
      windowMs: 1_000,
    };

    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toMatchObject({
      allowed: false,
    });
    now += 1_001;
    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
  });

  it('evicts the oldest fallback key at the hard cap', async () => {
    const limiter = new RedisAuthRateLimiter('', Date.now, undefined, 2);
    const consume = (key: string) =>
      limiter.consume({
        scope: 'verify_ip',
        key,
        limit: 1,
        windowMs: 60_000,
      });

    await expect(consume('first')).resolves.toEqual({ allowed: true });
    await expect(consume('second')).resolves.toEqual({ allowed: true });
    await expect(consume('third')).resolves.toEqual({ allowed: true });
    await expect(consume('first')).resolves.toEqual({ allowed: true });
  });
});
