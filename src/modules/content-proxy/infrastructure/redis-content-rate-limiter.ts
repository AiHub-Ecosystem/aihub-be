import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { AppError } from '@/common/errors/app-error';
import { outageRetryAfterMs } from '@/common/errors/retry-jitter';
import { recordRedisUnavailable } from '@/common/observability/metrics/redis-unavailable-metric';
import {
  REDIS_NO_REPLAY_OPTIONS,
  createRedisClient,
} from '@/common/redis/create-redis-client';
import {
  CONTENT_RATE_LIMIT,
  CONTENT_RATE_LIMIT_MAX_FALLBACK_KEYS,
  CONTENT_RATE_LIMIT_WINDOW_MS,
} from '@/modules/content-proxy/application/content-rate-limit';
import type {
  ContentRateLimitDecision,
  ContentRateLimiterPort,
} from '@/modules/content-proxy/application/content-rate-limiter.port';

const REDIS_COMMAND_TIMEOUT_MS = 400;

export const CONTENT_RATE_LIMIT_WINDOW_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 then
  local created = redis.call('SET', KEYS[1], '0', 'PX', ARGV[1], 'NX')
  if not created then
    return redis.error_reply('content rate limit window was not created')
  end
elseif ttl == -1 then
  local expiry_set = redis.call('PEXPIRE', KEYS[1], ARGV[1])
  if expiry_set ~= 1 then
    return redis.error_reply('content rate limit TTL was not set')
  end
end
local current = redis.call('INCR', KEYS[1])
return { current, redis.call('PTTL', KEYS[1]) }
`;

export function hashContentRateLimitKey(clientIp: string): string {
  return createHash('sha256').update(clientIp, 'utf8').digest('hex');
}

interface CounterState {
  count: number;
  expiresAt: number;
}

export interface ContentRateLimitRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  disconnect(): void;
  readonly status?: string;
  connect?(): Promise<void>;
}

export class RedisContentRateLimiter implements ContentRateLimiterPort {
  private readonly redis: ContentRateLimitRedisClient | undefined;
  private readonly fallback = new Map<string, CounterState>();
  private initialConnection: Promise<void> | undefined;

  constructor(
    redisUrl: string,
    private readonly now: () => number = Date.now,
    redisClient?: ContentRateLimitRedisClient,
  ) {
    if (redisClient !== undefined) {
      this.redis = redisClient;
    } else if (redisUrl.trim().length > 0) {
      this.redis = createRedisClient(redisUrl, {
        commandTimeoutMs: REDIS_COMMAND_TIMEOUT_MS,
        lazyConnect: true,
        ...REDIS_NO_REPLAY_OPTIONS,
      });
    }
  }

  async consume(clientIp: string): Promise<ContentRateLimitDecision> {
    const key = hashContentRateLimitKey(clientIp);
    if (this.redis !== undefined) {
      try {
        // With offline queuing disabled, wait briefly for the shared initial connection.
        if (this.redis.status === 'wait' && this.redis.connect !== undefined) {
          this.initialConnection = Promise.race([
            this.redis.connect(),
            delay(REDIS_COMMAND_TIMEOUT_MS, undefined, { ref: false }),
          ]).finally(() => {
            this.initialConnection = undefined;
          });
        }
        if (this.initialConnection !== undefined) await this.initialConnection;
        const result: unknown = await this.redis.eval(
          CONTENT_RATE_LIMIT_WINDOW_SCRIPT,
          1,
          `aihub:content:rate:${key}`,
          String(CONTENT_RATE_LIMIT_WINDOW_MS),
        );
        if (
          Array.isArray(result) &&
          typeof result[0] === 'number' &&
          Number.isSafeInteger(result[0]) &&
          typeof result[1] === 'number' &&
          Number.isSafeInteger(result[1]) &&
          result[1] >= 0
        ) {
          if (result[0] <= CONTENT_RATE_LIMIT) return { allowed: true };
          return { allowed: false, retryAfterMs: result[1] };
        }
      } catch {
        // The address-scoped local counter preserves the non-graded outage policy.
      }
      recordRedisUnavailable('content_rate_limit');
    } else {
      recordRedisUnavailable('content_rate_limit');
    }
    return this.consumeFallback(key);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis?.disconnect();
  }

  private consumeFallback(key: string): ContentRateLimitDecision {
    const now = this.now();
    let state = this.fallback.get(key);
    if (state !== undefined && state.expiresAt <= now) {
      this.fallback.delete(key);
      state = undefined;
    }
    if (state === undefined) {
      if (this.fallback.size >= CONTENT_RATE_LIMIT_MAX_FALLBACK_KEYS) {
        for (const [storedKey, storedState] of this.fallback) {
          if (storedState.expiresAt <= now) this.fallback.delete(storedKey);
        }
        if (this.fallback.size >= CONTENT_RATE_LIMIT_MAX_FALLBACK_KEYS) {
          throw new AppError({
            code: 'REDIS_UNAVAILABLE',
            message: 'Request rate limiting is temporarily unavailable',
            retryable: true,
            retryAfterMs: outageRetryAfterMs(),
          });
        }
      }
      state = { count: 0, expiresAt: now + CONTENT_RATE_LIMIT_WINDOW_MS };
    }
    state.count += 1;
    this.fallback.set(key, state);
    return state.count <= CONTENT_RATE_LIMIT
      ? { allowed: true }
      : {
          allowed: false,
          retryAfterMs: Math.max(0, state.expiresAt - now),
        };
  }
}
