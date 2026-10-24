import { randomUUID } from 'node:crypto';
import type { OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { recordRedisUnavailable } from '@/common/observability/redis-unavailable-metric';
import type {
  EmailProviderOutageCircuitPort,
  EmailProviderSendPermit,
} from '@/modules/auth/email-delivery/application/email-provider-outage-circuit.port';
import type {
  EmailSendRateLimiterPort,
  EmailSendRateReservation,
} from '@/modules/auth/email-delivery/application/email-send-rate-limiter.port';

const RETRY_WHEN_UNAVAILABLE_MS = 5_000;
// The shared Redis host is a separate machine, about 100 ms away from the
// application. The dispatcher runs in the background, so the wait costs no
// request; a shorter timeout fails every permit and reservation and nothing is sent.
const REDIS_COMMAND_TIMEOUT_MS = 500;
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

export const EMAIL_PROVIDER_OUTAGE_STATE_KEY =
  'aihub:resend:email-provider-outage';
const EMAIL_PROVIDER_OUTAGE_MAX_COOLDOWN_MS = 300_000;
const OUTAGE_STATE_TTL_MARGIN_MS = 60_000;
// shortcut: six-minute probe recovery TTL, raise it if a bounded dispatch can exceed that.
const OUTAGE_PROBE_STATE_TTL_MS =
  EMAIL_PROVIDER_OUTAGE_MAX_COOLDOWN_MS + OUTAGE_STATE_TTL_MARGIN_MS;
// A probe owner answers within one attempt (its 5-second provider timeout) plus
// the reservation round-trips around it. A probe still held past this margin
// belongs to an owner that could not record its outcome (#1113), so the next
// acquire takes it over instead of waiting out the state key's TTL.
export const OUTAGE_PROBE_STALE_MS = 30_000;

export const EMAIL_PROVIDER_OUTAGE_ACQUIRE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'started_at_ms', 'open_until_ms', 'probe_token', 'probe_granted_at_ms')
if not state[1] then return { 1, 0, '' } end
local open_until_ms = tonumber(state[2] or '0')
if now_ms < open_until_ms then return { 0, open_until_ms - now_ms, '' } end
if state[3] then
  local granted_at_ms = tonumber(state[4] or '0')
  if granted_at_ms <= 0 or now_ms - granted_at_ms < tonumber(ARGV[4]) then
    return { 0, tonumber(ARGV[3]), '' }
  end
end
redis.call('HSET', KEYS[1], 'probe_token', ARGV[1], 'probe_granted_at_ms', now_ms)
redis.call('PEXPIRE', KEYS[1], math.max(open_until_ms - now_ms, 0) + tonumber(ARGV[2]))
return { 1, 0, ARGV[1] }
`;

export const EMAIL_PROVIDER_OUTAGE_RELEASE_PROBE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
if redis.call('HGET', KEYS[1], 'probe_token') ~= ARGV[1] then return 0 end
redis.call('HDEL', KEYS[1], 'probe_token', 'probe_granted_at_ms')
local open_until_ms = tonumber(redis.call('HGET', KEYS[1], 'open_until_ms') or '0')
redis.call('PEXPIRE', KEYS[1], math.max(open_until_ms - now_ms, 0) + tonumber(ARGV[2]))
return 1
`;

export const EMAIL_PROVIDER_OUTAGE_FAILURE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'started_at_ms', 'failure_count', 'open_until_ms', 'probe_token')
local started_at_ms = tonumber(state[1] or tostring(now_ms))
local failure_count = tonumber(state[2] or '0') + 1
local exponent = math.min(failure_count - 1, 16)
local ceiling_ms = math.min(5000 * (2 ^ exponent), 300000)
local jitter = tonumber(ARGV[1])
if not jitter or jitter < 0 or jitter >= 1 then jitter = 0.5 end
local jitter_ms = math.max(1, math.floor(ceiling_ms * jitter))
local retry_after_ms = math.max(0, tonumber(ARGV[2]) or 0)
local delay_ms = math.max(jitter_ms, retry_after_ms)
local open_until_ms = math.max(tonumber(state[3] or '0'), now_ms + delay_ms)
redis.call('HSET', KEYS[1], 'started_at_ms', started_at_ms, 'failure_count', failure_count, 'open_until_ms', open_until_ms)
local owns_probe = state[4] and state[4] == ARGV[4]
if owns_probe then redis.call('HDEL', KEYS[1], 'probe_token', 'probe_granted_at_ms') end
local effective_delay_ms = math.max(0, open_until_ms - now_ms)
local ttl_ms = effective_delay_ms + tonumber(ARGV[3])
if state[4] and not owns_probe then ttl_ms = math.max(ttl_ms, tonumber(ARGV[5])) end
redis.call('PEXPIRE', KEYS[1], ttl_ms)
return effective_delay_ms
`;

export const EMAIL_PROVIDER_OUTAGE_REACHABLE_SCRIPT = `
return redis.call('DEL', KEYS[1])
`;

export const EMAIL_PROVIDER_OUTAGE_DURATION_SCRIPT = `
local started_at_ms = tonumber(redis.call('HGET', KEYS[1], 'started_at_ms') or '0')
if started_at_ms == 0 then return 0 end
local redis_time = redis.call('TIME')
local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)
return math.max(0, now_ms - started_at_ms)
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
  implements
    EmailSendRateLimiterPort,
    EmailProviderOutageCircuitPort,
    OnModuleDestroy
{
  private readonly redis: EmailSendRateRedisClient | undefined;
  private readonly intervalMs: number | undefined;

  constructor(
    redisUrl: string,
    limit: number | undefined,
    durationMs: number | undefined,
    redisClient?: EmailSendRateRedisClient,
    private readonly random: () => number = Math.random,
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
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
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

  async acquireSendPermit(): Promise<EmailProviderSendPermit> {
    if (this.redis === undefined) return this.unavailablePermit();
    const probeToken = randomUUID();
    try {
      const result = await this.redis.eval(
        EMAIL_PROVIDER_OUTAGE_ACQUIRE_SCRIPT,
        1,
        EMAIL_PROVIDER_OUTAGE_STATE_KEY,
        probeToken,
        String(OUTAGE_PROBE_STATE_TTL_MS),
        String(RETRY_WHEN_UNAVAILABLE_MS),
        String(OUTAGE_PROBE_STALE_MS),
      );
      const [allowed, retryAfterMs, acquiredToken] = Array.isArray(result)
        ? result
        : [];
      if (
        (allowed === 0 || allowed === 1) &&
        typeof retryAfterMs === 'number' &&
        Number.isSafeInteger(retryAfterMs) &&
        retryAfterMs >= 0
      ) {
        if (allowed === 0) {
          return {
            allowed: false as const,
            retryAfterMs: Math.max(1, retryAfterMs),
          };
        }
        return typeof acquiredToken === 'string' && acquiredToken.length > 0
          ? { allowed: true as const, probeToken: acquiredToken }
          : { allowed: true as const };
      }
    } catch {
      // Redis outage coordination fails closed; the existing limiter does too.
    }
    return this.unavailablePermit();
  }

  async releaseProbe(probeToken: string): Promise<void> {
    if (this.redis === undefined) return;
    await this.redis.eval(
      EMAIL_PROVIDER_OUTAGE_RELEASE_PROBE_SCRIPT,
      1,
      EMAIL_PROVIDER_OUTAGE_STATE_KEY,
      probeToken,
      String(OUTAGE_STATE_TTL_MARGIN_MS),
    );
  }

  async recordProviderFailure(
    retryAfterMs: number,
    probeToken?: string,
  ): Promise<number> {
    if (this.redis === undefined) return this.localPause(retryAfterMs);
    const sample = this.random();
    const jitter =
      Number.isFinite(sample) && sample >= 0 && sample < 1 ? sample : 0.5;
    try {
      const result = await this.redis.eval(
        EMAIL_PROVIDER_OUTAGE_FAILURE_SCRIPT,
        1,
        EMAIL_PROVIDER_OUTAGE_STATE_KEY,
        String(jitter),
        String(Math.max(0, retryAfterMs)),
        String(OUTAGE_STATE_TTL_MARGIN_MS),
        probeToken ?? '',
        String(OUTAGE_PROBE_STATE_TTL_MS),
      );
      const delayMs = Array.isArray(result) ? result[0] : result;
      if (
        typeof delayMs === 'number' &&
        Number.isSafeInteger(delayMs) &&
        delayMs >= 0
      ) {
        return delayMs;
      }
    } catch {
      // No recording was confirmed; fall through to the local pause below.
    }
    // A probe this far down may still be live, and a live one strands every
    // other instance until the state key expires, so hand it back while Redis
    // will still take it. A probe the failure script already consumed makes
    // the release a no-op, and a release that itself fails is healed by the
    // acquire script's stale takeover (#1113).
    if (probeToken !== undefined) {
      try {
        await this.releaseProbe(probeToken);
      } catch {
        // The stale takeover bounds a probe this could not release.
      }
    }
    return this.localPause(retryAfterMs);
  }

  async recordProviderReachable(): Promise<void> {
    if (this.redis === undefined) return;
    await this.redis.eval(
      EMAIL_PROVIDER_OUTAGE_REACHABLE_SCRIPT,
      1,
      EMAIL_PROVIDER_OUTAGE_STATE_KEY,
    );
  }

  async readOutageDurationMs(): Promise<number> {
    if (this.redis === undefined) return 0;
    try {
      const duration = await this.redis.eval(
        EMAIL_PROVIDER_OUTAGE_DURATION_SCRIPT,
        1,
        EMAIL_PROVIDER_OUTAGE_STATE_KEY,
      );
      if (
        typeof duration === 'number' &&
        Number.isSafeInteger(duration) &&
        duration >= 0
      ) {
        return duration;
      }
    } catch {
      return 0;
    }
    return 0;
  }

  onModuleDestroy(): void {
    this.redis?.disconnect();
  }

  // Each answer below stands for shared state this limiter could not read or
  // write, as opposed to a real denial from Redis. They are counted because the
  // dispatcher only sees "deferred" and nothing says why (#1010).
  private unavailable(): EmailSendRateReservation {
    recordRedisUnavailable('email_send_rate');
    return {
      reserved: false,
      retryAfterMs: RETRY_WHEN_UNAVAILABLE_MS,
    };
  }

  private unavailablePermit(): EmailProviderSendPermit {
    recordRedisUnavailable('email_send_rate');
    return { allowed: false as const, retryAfterMs: RETRY_WHEN_UNAVAILABLE_MS };
  }

  private localPause(retryAfterMs: number): number {
    recordRedisUnavailable('email_send_rate');
    return Math.max(RETRY_WHEN_UNAVAILABLE_MS, retryAfterMs);
  }
}
