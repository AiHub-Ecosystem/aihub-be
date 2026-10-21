import {
  EMAIL_SEND_RATE_RESERVATION_KEY,
  RedisEmailSendRateLimiter,
} from '@/modules/auth/email-delivery/infrastructure/redis-email-send-rate-limiter';
import {
  createSandboxTestRedis,
  sandboxTestRedisUrl,
} from '../shared/database';

describe('shared email send rate limiter', () => {
  const firstRedis = createSandboxTestRedis();
  const secondRedis = createSandboxTestRedis();
  const first = new RedisEmailSendRateLimiter(
    sandboxTestRedisUrl(),
    10,
    1_000,
    firstRedis,
  );
  const second = new RedisEmailSendRateLimiter(
    sandboxTestRedisUrl(),
    10,
    1_000,
    secondRedis,
  );

  beforeEach(async () => {
    await firstRedis.del(EMAIL_SEND_RATE_RESERVATION_KEY);
  });

  afterAll(async () => {
    await firstRedis.del(EMAIL_SEND_RATE_RESERVATION_KEY);
    first.onModuleDestroy();
    second.onModuleDestroy();
  });

  it('shares one no-burst reservation across two independent Redis clients', async () => {
    const initial = await Promise.all([first.reserve(), second.reserve()]);

    expect(initial.filter((reservation) => reservation.reserved)).toHaveLength(
      1,
    );
    const retryDelays = initial.flatMap((reservation) =>
      reservation.reserved ? [] : [reservation.retryAfterMs],
    );
    expect(retryDelays).toHaveLength(1);
    expect(retryDelays[0]).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect((await second.reserve()).reserved).toBe(true);
  });

  it('fails closed when the shared Redis endpoint is unreachable', async () => {
    const unavailable = new RedisEmailSendRateLimiter(
      'redis://127.0.0.1:1/14',
      10,
      1_000,
    );

    try {
      await expect(unavailable.reserve()).resolves.toEqual({
        reserved: false,
        retryAfterMs: 5_000,
      });
    } finally {
      unavailable.onModuleDestroy();
    }
  });
});
