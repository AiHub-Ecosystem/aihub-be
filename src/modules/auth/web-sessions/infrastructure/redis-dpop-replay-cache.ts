import { createHash } from 'node:crypto';

import { AppError } from '@/common/errors/app-error';
import { recordRedisUnavailable } from '@/common/observability/metrics/redis-unavailable-metric';
import type {
  DpopReplayCachePort,
  DpopReplayKey,
} from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';

/** The slice of the Redis client this cache uses. */
export interface DpopReplayRedis {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    seconds: number,
    condition: 'NX',
  ): Promise<'OK' | null>;
  quit(): Promise<unknown>;
}

/**
 * Anti-replay state for DPoP proofs. Redis is only protection state here: a
 * lost entry can let a replay through inside the proof window, which is why the
 * guard refuses when Redis cannot be reached at all.
 */
export class RedisDpopReplayCache implements DpopReplayCachePort {
  constructor(private readonly redis: DpopReplayRedis) {}

  async claim(key: DpopReplayKey, ttlSeconds: number): Promise<boolean> {
    // Hashing bounds the key length and keeps client-chosen `jti` text out of Redis keys.
    const digest = createHash('sha256')
      .update(`${key.issuer}\n${key.jkt}\n${key.jti}`)
      .digest('hex');
    try {
      const result = await this.redis.set(
        `aihub:auth:dpop-replay:${digest}`,
        '1',
        'EX',
        ttlSeconds,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      // The guard refuses the request; this makes the outage visible.
      recordRedisUnavailable('dpop_replay');
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

/** Used when Redis is not configured: every claim fails, so DPoP refuses instead of skipping replay checks. */
export const UNAVAILABLE_DPOP_REPLAY_CACHE: DpopReplayCachePort = {
  claim: () =>
    Promise.reject(
      new AppError({
        code: 'REDIS_UNAVAILABLE',
        message: 'User access controls are temporarily unavailable',
        retryable: true,
        diagnostic: 'dpop-replay-cache-not-configured',
      }),
    ),
};
