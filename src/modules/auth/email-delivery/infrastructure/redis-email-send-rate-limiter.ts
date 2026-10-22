import type { OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import type {
  EmailSendRateLimiterPort,
  EmailSendRateReservation,
} from '@/modules/auth/email-delivery/application/email-send-rate-limiter.port';

const RETRY_WHEN_UNAVAILABLE_MS = 5_000;
export const EMAIL_SEND_RATE_RESERVATION_KEY =
  'aihub:resend:email-send-rate:last-reservation-ms';

export const EMAIL_SEND_RATE_RESERVATION_SCRIPT = `
local interval_ms = tonumber(ARGV[1])
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local previous_ms = tonumber(redis.call('GET', KEYS[1]) or '-1')
local next_ms = previous_ms + interval_ms
if previous_ms >= 0 and now_ms < next_ms then
  return { 0, next_ms - now_ms }
end
redis.call('SET', KEYS[1], now_ms)
return { 1, 0 }
`;

export interface EmailSendRateRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  disconnect(): void;
}

/** A fail-closed, no-burst reservation shared by all instances on one Redis URL. */
export class RedisEmailSendRateLimiter
  implements EmailSendRateLimiterPort, OnModuleDestroy
{
  private readonly redis: EmailSendRateRedisClient | undefined;
  private readonly intervalMs: number | undefined;

  constructor(
    redisUrl: string,
    limit: number | undefined,
    durationMs: number | undefined,
    redisClient?: EmailSendRateRedisClient,
  ) {
    if (
      Number.isSafeInteger(limit) &&
      Number.isSafeInteger(durationMs) &&
      limit !== undefined &&
      durationMs !== undefined &&
      limit > 0 &&
      durationMs > 0
    ) {
      const intervalMs = Math.ceil(durationMs / limit);
      if (Number.isSafeInteger(intervalMs) && intervalMs > 0) {
        this.intervalMs = intervalMs;
      }
    }

    if (redisClient !== undefined) {
      redisClient.on('error', () => undefined);
      this.redis = redisClient;
    } else if (redisUrl.trim().length > 0) {
      const redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        commandTimeout: 100,
      });
      redis.on('error', () => undefined);
      this.redis = redis;
    }
  }

  async reserve(): Promise<EmailSendRateReservation> {
    if (this.redis === undefined || this.intervalMs === undefined) {
      return this.unavailable();
    }
    try {
      const result = await this.redis.eval(
        EMAIL_SEND_RATE_RESERVATION_SCRIPT,
        1,
        EMAIL_SEND_RATE_RESERVATION_KEY,
        String(this.intervalMs),
      );
      const [reserved, retryAfterMs] = Array.isArray(result) ? result : [];
      if (
        (reserved === 0 || reserved === 1) &&
        typeof retryAfterMs === 'number' &&
        Number.isSafeInteger(retryAfterMs) &&
        retryAfterMs >= 0
      ) {
        return reserved === 1
          ? { reserved: true }
          : { reserved: false, retryAfterMs };
      }
    } catch {
      return this.unavailable();
    }
    return this.unavailable();
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  private unavailable(): EmailSendRateReservation {
    return {
      reserved: false,
      retryAfterMs: RETRY_WHEN_UNAVAILABLE_MS,
    };
  }
}
