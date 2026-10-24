import { once } from 'node:events';

import {
  EMAIL_PROVIDER_OUTAGE_FAILURE_SCRIPT,
  EMAIL_PROVIDER_OUTAGE_STATE_KEY,
  type EmailSendRateRedisClient,
  OUTAGE_PROBE_STALE_MS,
  RedisEmailSendRateLimiter,
} from '@/modules/auth/email-delivery/infrastructure/redis-email-send-rate-limiter';
import { createSandboxTestRedis } from '../shared/database';

/** Answers every script from Redis except the failure script, which throws. */
class FailureScriptRejectingRedis implements EmailSendRateRedisClient {
  constructor(
    private readonly redis: ReturnType<typeof createSandboxTestRedis>,
  ) {}

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown> {
    if (script === EMAIL_PROVIDER_OUTAGE_FAILURE_SCRIPT) {
      throw new Error('connection lost');
    }
    return this.redis.eval(script, numberOfKeys, ...args);
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    return this.redis.on(event, listener);
  }

  disconnect(): void {
    this.redis.disconnect();
  }
}

describe('shared email provider outage circuit in Redis', () => {
  let redisA: ReturnType<typeof createSandboxTestRedis>;
  let redisB: ReturnType<typeof createSandboxTestRedis>;
  let circuitA: RedisEmailSendRateLimiter;
  let circuitB: RedisEmailSendRateLimiter;

  beforeAll(async () => {
    redisA = createSandboxTestRedis();
    redisB = createSandboxTestRedis();
    await Promise.all(
      [redisA, redisB].map(async (redis) => {
        if (redis.status !== 'ready') await once(redis, 'ready');
      }),
    );
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

  it('releases a probe whose failure recording died on a Redis error, so the next acquire proceeds', async () => {
    await circuitA.recordProviderFailure(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const permit = await circuitA.acquireSendPermit();
    if (!permit.allowed || permit.probeToken === undefined) {
      throw new Error('the shared circuit did not grant a half-open probe');
    }

    const strandedOwner = new RedisEmailSendRateLimiter(
      '',
      1,
      1_000,
      new FailureScriptRejectingRedis(redisB),
      () => 0,
    );
    await expect(
      strandedOwner.recordProviderFailure(0, permit.probeToken),
    ).resolves.toBe(5_000);

    await expect(circuitB.acquireSendPermit()).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('takes over a probe held past the stale margin by an owner that never answered', async () => {
    await circuitA.recordProviderFailure(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const permit = await circuitA.acquireSendPermit();
    if (!permit.allowed || permit.probeToken === undefined) {
      throw new Error('the shared circuit did not grant a half-open probe');
    }

    // A fresh probe still belongs to its owner: everyone else waits.
    await expect(circuitB.acquireSendPermit()).resolves.toEqual({
      allowed: false,
      retryAfterMs: 5_000,
    });

    // The owner cannot record its outcome (#1113); once its grant ages past
    // the stated margin, the next acquire heals the stranded probe.
    await redisA.hset(
      EMAIL_PROVIDER_OUTAGE_STATE_KEY,
      'probe_granted_at_ms',
      String(Date.now() - OUTAGE_PROBE_STALE_MS - 1_000),
    );
    const takeover = await circuitB.acquireSendPermit();
    if (!takeover.allowed) {
      throw new Error('the stale probe was not taken over');
    }
    expect(takeover.probeToken).not.toBe(permit.probeToken);
  });
});
