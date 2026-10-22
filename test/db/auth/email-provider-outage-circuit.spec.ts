import {
  EMAIL_PROVIDER_OUTAGE_STATE_KEY,
  RedisEmailSendRateLimiter,
} from '@/modules/auth/email-delivery/infrastructure/redis-email-send-rate-limiter';
import { createSandboxTestRedis } from '../shared/database';

describe('shared email provider outage circuit in Redis', () => {
  let redisA: ReturnType<typeof createSandboxTestRedis>;
  let redisB: ReturnType<typeof createSandboxTestRedis>;
  let circuitA: RedisEmailSendRateLimiter;
  let circuitB: RedisEmailSendRateLimiter;

  beforeAll(async () => {
    redisA = createSandboxTestRedis();
    redisB = createSandboxTestRedis();
    await Promise.all([redisA.ping(), redisB.ping()]);
    circuitA = new RedisEmailSendRateLimiter('', 1, 1_000, redisA, () => 0);
    circuitB = new RedisEmailSendRateLimiter('', 1, 1_000, redisB, () => 0);
  });

  beforeEach(async () => {
    await redisA.del(EMAIL_PROVIDER_OUTAGE_STATE_KEY);
  });

  afterAll(async () => {
    await redisA.del(EMAIL_PROVIDER_OUTAGE_STATE_KEY).catch(() => 0);
    redisA.disconnect();
    redisB.disconnect();
  });

  it('preserves the longest cooldown and allows one shared half-open probe', async () => {
    const startedAt = Date.now();
    await expect(circuitA.recordProviderFailure(1_500)).resolves.toBe(1_500);
    const extendedDelay = await circuitB.recordProviderFailure(0);
    const minimumRemaining = Math.max(
      0,
      1_500 - (Date.now() - startedAt) - 100,
    );
    expect(extendedDelay).toBeGreaterThanOrEqual(minimumRemaining);
    await expect(circuitA.acquireSendPermit()).resolves.toMatchObject({
      allowed: false,
    });

    let permit = await circuitA.acquireSendPermit();
    const deadline = Date.now() + 3_000;
    while (!permit.allowed && Date.now() < deadline) {
      const waitMs = Math.min(permit.retryAfterMs, 50);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      permit = await circuitA.acquireSendPermit();
    }
    if (!permit.allowed || permit.probeToken === undefined) {
      throw new Error('the shared circuit did not grant a half-open probe');
    }

    // An older in-flight request may fail after this probe has started.
    await circuitB.recordProviderFailure(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(circuitB.acquireSendPermit()).resolves.toMatchObject({
      allowed: false,
      retryAfterMs: 5_000,
    });

    await circuitA.recordProviderFailure(5_000, permit.probeToken);
    await expect(circuitB.acquireSendPermit()).resolves.toMatchObject({
      allowed: false,
    });
    await circuitA.recordProviderReachable();
    await expect(circuitB.acquireSendPermit()).resolves.toEqual({
      allowed: true,
    });
  });
});
