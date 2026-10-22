import { INCREMENT_WITH_EXPIRY_SCRIPT } from '@/common/redis/increment-with-expiry';
import { rateLimitWindow } from '@/modules/gateway/application/rate-limit-window';
import {
  type RedisRateLimitClient,
  RedisRateLimiter,
} from './redis-rate-limiter';

class FakeRedis implements RedisRateLimitClient {
  readonly values = new Map<string, number>();
  readonly expirations = new Map<string, number>();
  failTtlSetup = false;

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: readonly (string | number)[]
  ): Promise<number> {
    if (script !== INCREMENT_WITH_EXPIRY_SCRIPT || numberOfKeys !== 1) {
      throw new Error('unexpected Redis script');
    }
    const key = String(args[0]);
    const ttlSeconds = Number(args[1]);
    if (!this.expirations.has(key)) {
      if (this.failTtlSetup) {
        throw new Error('Redis could not set the counter TTL');
      }
      this.values.set(key, this.values.get(key) ?? 0);
      this.expirations.set(key, ttlSeconds);
    }
    const next = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, next);
    return next;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

class FailingRedis implements RedisRateLimitClient {
  eval(): Promise<number> {
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

const NOW = 61_234;
const WINDOW = rateLimitWindow('ak_backend', NOW);
const BUCKET = `aihub:v1:rl:ak_backend:${WINDOW.index}`;
const noJitter = (): number => 0;

describe('RedisRateLimiter', () => {
  it("uses a namespaced bucket for the key's own one-minute window with a two-minute TTL", async () => {
    const redis = new FakeRedis();
    const limiter = new RedisRateLimiter(
      '',
      redis,
      () => NOW,
      undefined,
      noJitter,
    );

    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({
      allowed: true,
      standing: { limit: 2, remaining: 1, resetInMs: WINDOW.resetInMs },
    });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toMatchObject({ allowed: true, standing: { remaining: 0 } });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toEqual({
      allowed: false,
      retryAfterMs: WINDOW.resetInMs,
      standing: { limit: 2, remaining: 0, resetInMs: WINDOW.resetInMs },
    });

    expect(redis.expirations.get(BUCKET)).toBe(120);
  });

  it('tells keys refused in the same millisecond different instants after the window resets', async () => {
    const limiter = new RedisRateLimiter('', new FakeRedis(), () => NOW);
    await limiter.consume({ keyId: 'ak_backend', limit: 0 });

    const hints: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const decision = await limiter.consume({ keyId: 'ak_backend', limit: 0 });
      hints.push(decision.retryAfterMs ?? -1);
    }

    expect(new Set(hints).size).toBeGreaterThan(1);
    for (const hint of hints) {
      expect(hint).toBeGreaterThanOrEqual(WINDOW.resetInMs);
      expect(hint).toBeLessThan(WINDOW.resetInMs + 1_000);
    }
  });

  it.each(['new', 'legacy'])(
    'does not increment a %s bucket when setting its TTL fails',
    async (kind) => {
      const redis = new FakeRedis();
      const bucket = BUCKET;
      if (kind === 'legacy') {
        redis.values.set(bucket, 4);
      }
      redis.failTtlSetup = true;
      const limiter = new RedisRateLimiter('', redis, () => NOW);

      await expect(
        limiter.consume({ keyId: 'ak_backend', limit: 10 }),
      ).resolves.toMatchObject({ allowed: true });

      expect(redis.values.get(bucket)).toBe(kind === 'legacy' ? 4 : undefined);
      expect(redis.expirations.has(bucket)).toBe(false);
    },
  );

  it('allows traffic when Redis is unavailable so authorization remains independent', async () => {
    await expect(
      new RedisRateLimiter('', new FailingRedis()).consume({
        keyId: 'ak_backend',
        limit: 1,
      }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('still applies a ceiling in-process once Redis is unavailable', async () => {
    const limiter = new RedisRateLimiter(
      '',
      new FailingRedis(),
      () => NOW,
      undefined,
      noJitter,
    );

    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 2 }),
    ).resolves.toMatchObject({
      allowed: false,
      retryAfterMs: WINDOW.resetInMs,
    });
  });

  it('keeps the process-local ceiling separate per API key', async () => {
    const limiter = new RedisRateLimiter('', new FailingRedis(), () => NOW);

    await limiter.consume({ keyId: 'ak_one', limit: 1 });

    await expect(
      limiter.consume({ keyId: 'ak_two', limit: 1 }),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('keeps each key counted in-process when keys are in different windows', async () => {
    // Keys' windows are offset, so at one instant two keys can be in
    // consecutive windows; neither may reset the other's count.
    const MID_MINUTE = 1_782_000_030_000;
    const keys = Array.from({ length: 50 }, (_, key) => `ak_${key}`);
    const index = (keyId: string): number =>
      rateLimitWindow(keyId, MID_MINUTE).index;
    const behind = keys.find((keyId) => index(keyId) < index('ak_backend'));
    const ahead = keys.find((keyId) => index(keyId) > index('ak_backend'));
    const other = behind ?? ahead;
    expect(other).toBeDefined();
    const limiter = new RedisRateLimiter(
      '',
      new FailingRedis(),
      () => MID_MINUTE,
    );

    await limiter.consume({ keyId: 'ak_backend', limit: 1 });
    await limiter.consume({ keyId: String(other), limit: 1 });

    await expect(
      limiter.consume({ keyId: 'ak_backend', limit: 1 }),
    ).resolves.toMatchObject({ allowed: false });
    await expect(
      limiter.consume({ keyId: String(other), limit: 1 }),
    ).resolves.toMatchObject({ allowed: false });
  });

  it('warns once when Redis becomes unreachable, not on every request', async () => {
    const logger = new FakeLogger();
    const limiter = new RedisRateLimiter(
      '',
      new FailingRedis(),
      Date.now,
      logger,
    );

    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });

    expect(logger.warnings).toHaveLength(1);
  });

  it('logs recovery once Redis answers again, and can warn again on a later outage', async () => {
    const logger = new FakeLogger();
    const redis = new FakeRedis();
    const failing = new FailingRedis();
    let current: RedisRateLimitClient = failing;
    const limiter = new RedisRateLimiter(
      '',
      {
        eval: (...args) => current.eval(...args),
        quit: () => current.quit(),
      },
      Date.now,
      logger,
    );

    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.warnings).toHaveLength(1);

    current = redis;
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.logs).toHaveLength(1);

    current = failing;
    await limiter.consume({ keyId: 'ak_backend', limit: 10 });
    expect(logger.warnings).toHaveLength(2);
  });
});
