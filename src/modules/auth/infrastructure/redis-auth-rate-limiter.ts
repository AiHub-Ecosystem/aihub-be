import { createHash } from 'node:crypto';

import Redis from 'ioredis';

import type {
  AuthRateLimitScope,
  AuthRateLimiterPort,
} from '../application/auth-rate-limiter.port';

const WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { current, redis.call('PTTL', KEYS[1]) }
`;

export const AUTH_RATE_LIMIT_WINDOW_SCRIPT = WINDOW_SCRIPT;

export function hashRateLimitKey(
  scope: AuthRateLimitScope,
  key: string,
): string {
  return createHash('sha256').update(`${scope}:${key}`, 'utf8').digest('hex');
}

interface CounterState {
  count: number;
  resetAt: number;
}

export interface AuthRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect(): void;
}

const MAX_FALLBACK_KEYS = 10_000;

export class RedisAuthRateLimiter implements AuthRateLimiterPort {
  private readonly redis: AuthRedisClient | undefined;
  private readonly fallback = new Map<string, CounterState>();
  private readonly now: () => number;
  private readonly maxFallbackKeys: number;

  constructor(
    redisUrl: string,
    now: () => number = Date.now,
    redisClient?: AuthRedisClient,
    maxFallbackKeys = MAX_FALLBACK_KEYS,
  ) {
    this.now = now;
    this.maxFallbackKeys = maxFallbackKeys;
    if (redisClient !== undefined) {
      redisClient.on('error', () => undefined);
      this.redis = redisClient;
      return;
    }
    if (redisUrl.trim().length === 0) {
      return;
    }
    const redis = new Redis(redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
    });
    redis.on('error', () => undefined);
    this.redis = redis;
  }

  async consume(input: Parameters<AuthRateLimiterPort['consume']>[0]) {
    const hashed = hashRateLimitKey(input.scope, input.key);
    if (this.redis !== undefined) {
      try {
        const result = await this.redis.eval(
          AUTH_RATE_LIMIT_WINDOW_SCRIPT,
          1,
          `aihub:auth:rate:${hashed}`,
          String(input.windowMs),
        );
        const [count, ttl] = Array.isArray(result) ? result : [];
        if (typeof count === 'number' && typeof ttl === 'number') {
          return {
            allowed: count <= input.limit,
            ...(count <= input.limit ? {} : { retryAfterMs: Math.max(0, ttl) }),
          };
        }
      } catch {
        // Redis is protection state; a bounded local fallback keeps auth
        // available while the shared counter recovers.
      }
    }
    return this.consumeFallback(hashed, input.limit, input.windowMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }

  private consumeFallback(
    hashed: string,
    limit: number,
    windowMs: number,
  ): { readonly allowed: boolean; readonly retryAfterMs?: number } {
    const now = this.now();
    const existing = this.fallback.get(hashed);
    const state =
      existing === undefined || existing.resetAt <= now
        ? { count: 0, resetAt: now + windowMs }
        : existing;
    state.count += 1;
    if (existing === undefined && this.fallback.size >= this.maxFallbackKeys) {
      // ponytail: fixed-cap eviction keeps outage memory bounded; Redis owns
      // the distributed counter once it is reachable again.
      const oldest = this.fallback.keys().next().value;
      if (typeof oldest === 'string') {
        this.fallback.delete(oldest);
      }
    }
    this.fallback.set(hashed, state);
    return state.count <= limit
      ? { allowed: true }
      : { allowed: false, retryAfterMs: Math.max(0, state.resetAt - now) };
  }
}
